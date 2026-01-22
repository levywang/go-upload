package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed web/dist/*
var staticFS embed.FS

type Config struct {
	Server struct {
		Addr string `yaml:"addr"`
	} `yaml:"server"`
	Static struct {
		Enable bool   `yaml:"enable"`
		Dir    string `yaml:"dir"`
	} `yaml:"static"`
	Storage struct {
		RootDir  string `yaml:"root_dir"`
		StateDir string `yaml:"state_dir"`
	} `yaml:"storage"`
	Limits struct {
		MaxChunkBytes int64 `yaml:"max_chunk_bytes"`
		MaxFileBytes  int64 `yaml:"max_file_bytes"`
	} `yaml:"limits"`
}

type UploadMeta struct {
	UploadID     string    `json:"upload_id"`
	CreatedAt    time.Time `json:"created_at"`
	Filename     string    `json:"filename"`
	RelPath      string    `json:"rel_path"` // 相对 root_dir 的子路径（可包含子目录）
	TotalSize    int64     `json:"total_size"`
	ChunkSize    int64     `json:"chunk_size"`
	UploadedSize int64     `json:"uploaded_size"`
	Completed    bool      `json:"completed"`
}

type Server struct {
	cfg              Config
	rootAbs          string
	stateAbs         string
	muByUpload       sync.Map // uploadId -> *sync.Mutex
	lastSaved        sync.Map // uploadId -> int64 已落盘的 uploaded_size
	staticOn         bool
	metaSaveInterval int64 // 达到该增量或完成时才落盘一次元数据，减少频繁写盘
}

func main() {
	var cfgPath string
	flag.StringVar(&cfgPath, "config", "config.yaml", "配置文件路径")
	flag.Parse()

	cfg, err := loadConfig(cfgPath)
	if err != nil {
		log.Fatalf("load config failed: %v", err)
	}

	srv, err := newServer(cfg)
	if err != nil {
		log.Fatalf("init server failed: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", srv.handleHealth)
	mux.HandleFunc("/api/v1/storage/tree", srv.handleStorageTree)
	mux.HandleFunc("/api/v1/uploads/init", srv.handleInit)
	mux.HandleFunc("/api/v1/uploads/status", srv.handleStatus)
	mux.HandleFunc("/api/v1/uploads/chunk", srv.handleChunk)
	mux.HandleFunc("/api/v1/uploads/complete", srv.handleComplete)
	mux.HandleFunc("/api/v1/uploads/cancel", srv.handleCancel)
	if srv.staticOn {
		// 使用嵌入的静态文件系统
		embeddedFS, err := fs.Sub(staticFS, "web/dist")
		if err != nil {
			log.Printf("failed to create embedded filesystem: %v", err)
		} else {
			fileServer := http.FileServer(http.FS(embeddedFS))
			mux.Handle("/", fileServer)
			log.Printf("serving embedded static files")
		}
	}

	log.Printf("go-upload backend listening on %s (root=%s)", cfg.Server.Addr, srv.rootAbs)
	httpSrv := &http.Server{
		Addr:              cfg.Server.Addr,
		Handler:           withCORS(withRequestID(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(httpSrv.ListenAndServe())
}

func loadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(cfg.Server.Addr) == "" {
		cfg.Server.Addr = "127.0.0.1:8088"
	}
	if strings.TrimSpace(cfg.Static.Dir) == "" {
		cfg.Static.Dir = "../web/dist"
	}
	if strings.TrimSpace(cfg.Storage.RootDir) == "" {
		cfg.Storage.RootDir = "../uploads"
	}
	if strings.TrimSpace(cfg.Storage.StateDir) == "" {
		cfg.Storage.StateDir = ".go-upload_state"
	}
	if cfg.Limits.MaxChunkBytes <= 0 {
		cfg.Limits.MaxChunkBytes = 128 * 1024 * 1024
	}
	return cfg, nil
}

func newServer(cfg Config) (*Server, error) {
	rootAbs, err := filepath.Abs(cfg.Storage.RootDir)
	if err != nil {
		return nil, err
	}
	stateAbs := filepath.Join(rootAbs, cfg.Storage.StateDir)
	if err := os.MkdirAll(rootAbs, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stateAbs, 0o755); err != nil {
		return nil, err
	}
	s := &Server{
		cfg:              cfg,
		rootAbs:          rootAbs,
		stateAbs:         stateAbs,
		metaSaveInterval: maxInt64(64*1024*1024, cfg.Limits.MaxChunkBytes/2),
	}

	// 配置静态资源服务，使用嵌入的文件系统
	if cfg.Static.Enable {
		s.staticOn = true
		log.Printf("static files enabled, using embedded filesystem")
	}

	return s, nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type DirNode struct {
	Name     string    `json:"name"`
	RelPath  string    `json:"rel_path"` // 相对 root_dir 的路径（目录）
	Children []DirNode `json:"children,omitempty"`
}

type treeResp struct {
	Root DirNode `json:"root"`
}

// GET /api/v1/storage/tree?max_depth=3&max_entries=5000
// 返回 root_dir 下的目录结构（不含文件），用于前端目录选择器。
func (s *Server) handleStorageTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	maxDepth := int64(4)
	maxEntries := int64(5000)
	if v := strings.TrimSpace(r.URL.Query().Get("max_depth")); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 && n <= 20 {
			maxDepth = n
		}
	}
	if v := strings.TrimSpace(r.URL.Query().Get("max_entries")); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 1 && n <= 200000 {
			maxEntries = n
		}
	}

	var entries int64
	var build func(absDir, relDir string, depth int64) (DirNode, error)
	build = func(absDir, relDir string, depth int64) (DirNode, error) {
		name := filepath.Base(absDir)
		if relDir == "" {
			name = filepath.Base(s.rootAbs)
		}
		node := DirNode{Name: name, RelPath: relDir}
		if depth >= maxDepth {
			return node, nil
		}

		d, err := os.Open(absDir)
		if err != nil {
			return node, err
		}
		defer d.Close()

		kids, err := d.ReadDir(-1)
		if err != nil {
			return node, err
		}

		for _, de := range kids {
			if entries >= maxEntries {
				break
			}
			if !de.IsDir() {
				continue
			}
			// 跳过状态目录，避免暴露内部文件
			if relDir == "" && de.Name() == s.cfg.Storage.StateDir {
				continue
			}
			if de.Name() == s.cfg.Storage.StateDir {
				continue
			}
			entries++

			childAbs := filepath.Join(absDir, de.Name())
			childRel := de.Name()
			if relDir != "" {
				childRel = filepath.Join(relDir, de.Name())
			}
			// 防御：确保仍然在 rootAbs 下
			childAbs2, err := filepath.Abs(childAbs)
			if err != nil || !isSubpath(childAbs2, s.rootAbs) {
				continue
			}
			childNode, err := build(childAbs2, childRel, depth+1)
			if err != nil {
				// 单个子目录错误不致命：跳过
				continue
			}
			node.Children = append(node.Children, childNode)
		}
		return node, nil
	}

	rootNode, err := build(s.rootAbs, "", 0)
	if err != nil {
		http.Error(w, "scan failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, treeResp{Root: rootNode})
}

// ===== API 协议 =====
//
// 1) Init
// POST /api/v1/uploads/init
// body: { "filename": "a.bin", "path": "subdir/a.bin", "total_size": 123, "chunk_size": 5242880 }
// resp: { "upload_id": "...", "uploaded_size": 0 }
//
// 2) Status
// GET /api/v1/uploads/status?upload_id=...
// resp: UploadMeta
//
// 3) Chunk
// PUT /api/v1/uploads/chunk?upload_id=...
// headers:
// - X-Chunk-Offset: <int64>  // 本分片在文件中的起始偏移
// - Content-Length: <bytes>
// body: raw bytes
// resp: { "uploaded_size": <int64> }
//
// 4) Complete
// POST /api/v1/uploads/complete?upload_id=...
// resp: { "completed": true, "path": "<final_abs_path>" }

type initReq struct {
	Filename  string `json:"filename"`
	Path      string `json:"path"` // 用户期望的“上传路径”，服务端会约束到 root_dir 内
	TotalSize int64  `json:"total_size"`
	ChunkSize int64  `json:"chunk_size"`
}

type initResp struct {
	UploadID     string `json:"upload_id"`
	UploadedSize int64  `json:"uploaded_size"`
}

func (s *Server) handleInit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req initReq
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req.Filename = strings.TrimSpace(req.Filename)
	req.Path = strings.TrimSpace(req.Path)
	if req.Path == "" {
		req.Path = req.Filename
	}
	if req.Filename == "" {
		req.Filename = filepath.Base(req.Path)
	}
	if req.TotalSize <= 0 {
		http.Error(w, "total_size must be > 0", http.StatusBadRequest)
		return
	}
	if s.cfg.Limits.MaxFileBytes > 0 && req.TotalSize > s.cfg.Limits.MaxFileBytes {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	if req.ChunkSize <= 0 || req.ChunkSize > s.cfg.Limits.MaxChunkBytes {
		http.Error(w, "invalid chunk_size", http.StatusBadRequest)
		return
	}

	rel, err := sanitizeRelPath(req.Path)
	if err != nil {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	// 强制使用传入 filename 的扩展名猜 MIME（可选：仅用于展示/未来扩展）
	_ = mime.TypeByExtension(filepath.Ext(req.Filename))

	uploadID := newUploadID()
	meta := UploadMeta{
		UploadID:     uploadID,
		CreatedAt:    time.Now().UTC(),
		Filename:     req.Filename,
		RelPath:      rel,
		TotalSize:    req.TotalSize,
		ChunkSize:    req.ChunkSize,
		UploadedSize: 0,
		Completed:    false,
	}

	if err := s.saveMeta(meta); err != nil {
		http.Error(w, "save meta failed", http.StatusInternalServerError)
		return
	}
	// 预创建 .part 文件并设置长度，便于 WriteAt 随机写入
	partPath := s.partPath(uploadID)
	if err := ensureParentDir(partPath); err != nil {
		http.Error(w, "mkdir failed", http.StatusInternalServerError)
		return
	}
	f, err := os.OpenFile(partPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		http.Error(w, "create part failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	if err := f.Truncate(req.TotalSize); err != nil {
		http.Error(w, "truncate failed", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, initResp{UploadID: uploadID, UploadedSize: 0})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uploadID := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if uploadID == "" {
		http.Error(w, "missing upload_id", http.StatusBadRequest)
		return
	}
	meta, err := s.loadMeta(uploadID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "load failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) handleChunk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uploadID := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if uploadID == "" {
		http.Error(w, "missing upload_id", http.StatusBadRequest)
		return
	}
	offsetStr := strings.TrimSpace(r.Header.Get("X-Chunk-Offset"))
	if offsetStr == "" {
		http.Error(w, "missing X-Chunk-Offset", http.StatusBadRequest)
		return
	}
	offset, err := strconv.ParseInt(offsetStr, 10, 64)
	if err != nil || offset < 0 {
		http.Error(w, "invalid offset", http.StatusBadRequest)
		return
	}
	chunkLen := r.ContentLength
	if chunkLen <= 0 {
		http.Error(w, "missing/invalid Content-Length", http.StatusBadRequest)
		return
	}
	if chunkLen > s.cfg.Limits.MaxChunkBytes {
		http.Error(w, "chunk too large", http.StatusRequestEntityTooLarge)
		return
	}

	mu := s.lock(uploadID)
	mu.Lock()
	defer mu.Unlock()

	meta, err := s.loadMeta(uploadID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "load failed", http.StatusInternalServerError)
		return
	}
	if meta.Completed {
		http.Error(w, "already completed", http.StatusConflict)
		return
	}
	if offset+chunkLen > meta.TotalSize {
		http.Error(w, "chunk out of range", http.StatusBadRequest)
		return
	}

	partPath := s.partPath(uploadID)
	f, err := os.OpenFile(partPath, os.O_RDWR, 0o644)
	if err != nil {
		http.Error(w, "open part failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	// 限制读取，避免客户端不守规矩多发数据
	lr := io.LimitReader(r.Body, chunkLen)
	wrote, err := copyToWriterAt(f, lr, offset)
	if err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	if wrote != chunkLen {
		http.Error(w, "short write", http.StatusInternalServerError)
		return
	}

	// 断点续传的“已上传大小”这里做保守计算：取当前文件的最大连续写入前缀。
	// 为了保持简单，这里不维护位图；改为维护 uploaded_size = max(uploaded_size, offset+chunkLen)
	// 注意：这允许乱序分片，但 uploaded_size 只是“已接收的最大偏移”，不代表连续性。
	if end := offset + chunkLen; end > meta.UploadedSize {
		meta.UploadedSize = end
	}
	lastSavedAny, _ := s.lastSaved.LoadOrStore(uploadID, int64(0))
	lastSaved := lastSavedAny.(int64)
	needPersist := meta.UploadedSize == meta.TotalSize || meta.UploadedSize-lastSaved >= s.metaSaveInterval
	if needPersist {
		if err := s.saveMeta(meta); err != nil {
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		s.lastSaved.Store(uploadID, meta.UploadedSize)
	}
	writeJSON(w, http.StatusOK, map[string]any{"uploaded_size": meta.UploadedSize})
}

func (s *Server) handleComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uploadID := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if uploadID == "" {
		http.Error(w, "missing upload_id", http.StatusBadRequest)
		return
	}

	mu := s.lock(uploadID)
	mu.Lock()
	defer mu.Unlock()

	meta, err := s.loadMeta(uploadID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "load failed", http.StatusInternalServerError)
		return
	}
	if meta.Completed {
		finalPath, _ := s.finalAbsPath(meta.RelPath)
		writeJSON(w, http.StatusOK, map[string]any{"completed": true, "path": finalPath})
		return
	}
	if meta.UploadedSize < meta.TotalSize {
		http.Error(w, fmt.Sprintf("not fully uploaded: %d/%d", meta.UploadedSize, meta.TotalSize), http.StatusConflict)
		return
	}

	finalAbs, err := s.finalAbsPath(meta.RelPath)
	if err != nil {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	if err := ensureParentDir(finalAbs); err != nil {
		http.Error(w, "mkdir failed", http.StatusInternalServerError)
		return
	}
	partPath := s.partPath(uploadID)
	if err := os.Rename(partPath, finalAbs); err != nil {
		http.Error(w, "finalize failed", http.StatusInternalServerError)
		return
	}
	meta.Completed = true
	if err := s.saveMeta(meta); err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"completed": true, "path": finalAbs})
}

// POST/DELETE /api/v1/uploads/cancel?upload_id=...
// 取消上传：清理元数据与临时分片文件，后续分片请求将收到 404。
func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uploadID := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if uploadID == "" {
		http.Error(w, "missing upload_id", http.StatusBadRequest)
		return
	}

	mu := s.lock(uploadID)
	mu.Lock()
	defer mu.Unlock()

	meta, err := s.loadMeta(uploadID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "load failed", http.StatusInternalServerError)
		return
	}
	if meta.Completed {
		http.Error(w, "already completed", http.StatusConflict)
		return
	}

	// 清理元数据与临时分片
	_ = os.Remove(s.partPath(uploadID))
	_ = os.Remove(s.metaPath(uploadID))
	s.lastSaved.Delete(uploadID)
	s.muByUpload.Delete(uploadID)

	writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
}

// ===== 存储与状态 =====

func (s *Server) metaPath(uploadID string) string {
	return filepath.Join(s.stateAbs, uploadID+".json")
}

func (s *Server) partPath(uploadID string) string {
	return filepath.Join(s.stateAbs, uploadID+".part")
}

func (s *Server) loadMeta(uploadID string) (UploadMeta, error) {
	b, err := os.ReadFile(s.metaPath(uploadID))
	if err != nil {
		return UploadMeta{}, err
	}
	var meta UploadMeta
	if err := json.Unmarshal(b, &meta); err != nil {
		return UploadMeta{}, err
	}
	return meta, nil
}

func (s *Server) saveMeta(meta UploadMeta) error {
	tmp := s.metaPath(meta.UploadID) + ".tmp"
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.metaPath(meta.UploadID))
}

func (s *Server) finalAbsPath(rel string) (string, error) {
	rel, err := sanitizeRelPath(rel)
	if err != nil {
		return "", err
	}
	abs := filepath.Join(s.rootAbs, rel)
	abs, err = filepath.Abs(abs)
	if err != nil {
		return "", err
	}
	// 根目录约束：禁止写到 rootAbs 之外
	if !isSubpath(abs, s.rootAbs) {
		return "", fmt.Errorf("path escapes root")
	}
	return abs, nil
}

func (s *Server) lock(uploadID string) *sync.Mutex {
	v, _ := s.muByUpload.LoadOrStore(uploadID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// ===== 工具函数 =====

func newUploadID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func ensureParentDir(path string) error {
	return os.MkdirAll(filepath.Dir(path), 0o755)
}

func sanitizeRelPath(p string) (string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "/")
	p = strings.TrimPrefix(p, "./")
	if p == "" {
		return "", fmt.Errorf("empty path")
	}
	clean := filepath.Clean(p)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid path")
	}
	// Windows volume / 盘符防护
	if filepath.VolumeName(clean) != "" {
		return "", fmt.Errorf("invalid path")
	}
	return clean, nil
}

func isSubpath(childAbs, rootAbs string) bool {
	rootAbs = filepath.Clean(rootAbs)
	childAbs = filepath.Clean(childAbs)
	rel, err := filepath.Rel(rootAbs, childAbs)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func copyToWriterAt(f *os.File, r io.Reader, offset int64) (int64, error) {
	// 手动循环，避免大 buffer；同时保证按 offset 写入
	buf := make([]byte, 1<<20) // 1MB 缓冲，减少 syscalls 提升吞吐
	var total int64
	for {
		n, err := r.Read(buf)
		if n > 0 {
			wn, werr := f.WriteAt(buf[:n], offset+total)
			total += int64(wn)
			if werr != nil {
				return total, werr
			}
			if wn != n {
				return total, io.ErrShortWrite
			}
		}
		if err != nil {
			if err == io.EOF {
				return total, nil
			}
			return total, err
		}
	}
}

func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = newUploadID()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r)
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,X-Chunk-Offset,X-Request-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

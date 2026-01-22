# go-upload - 断点续传文件上传系统

一个**简单可运行**的文件上传系统，支持：

- **断点续传**：根据 `upload_id` 持久化上传会话与进度，支持网络中断后恢复上传
- **大文件分片上传**：支持大文件分片上传（`PUT chunk`），按偏移 `WriteAt` 写入 `.part` 临时文件
- **取消与恢复**：支持取消上传任务，并可从取消状态恢复继续上传
- **安全路径约束**：通过配置文件绑定上传根目录，所有用户路径都被约束在 `root_dir` 内，防止路径遍历攻击
- **目录树选择器**：提供目录树接口用于前端目录选择弹窗，模拟文件管理器选目录的体验
- **一体化部署**：支持后端 + 前端静态文件一体化部署，也可作为纯 API 服务使用

## 快速开始

### 方式一：一体化部署（推荐）

1) **构建前端静态资源**：

```bash
cd web
npm install
npm run build   # 产物在 web/dist
cd ..
```

2) **配置后端**：

```bash
cp config.example.yaml config.yaml
# 根据需要修改 config.yaml 中的配置
```

3) **启动服务**：

```bash
go run . -config config.yaml
```

访问 `http://127.0.0.1:5000/` 即可使用完整的上传界面。

### 方式二：纯后端 API 服务

1) **配置后端**：

```bash
cp config.example.yaml config.yaml
# 修改 config.yaml，设置 static.enable = false
```

2) **启动后端**：

```bash
go run . -config config.yaml
```

3) **启动前端开发服务器**（另一个终端）：

```bash
cd web
npm install
npm run dev
```

前端会通过 `VITE_API_BASE_URL=http://127.0.0.1:5000` 进行跨域访问后端 API。

## 健康检查

`GET /healthz` - 返回服务状态

## 配置说明

### config.yaml 配置选项

```yaml
# 服务器配置
server:
  addr: "127.0.0.1:5000"  # 监听地址

# 静态文件服务（可选）
static:
  enable: true             # 是否启用静态文件服务（前端已嵌入到可执行文件）

# 存储配置
storage:
  root_dir: "./uploads"    # 上传根目录（所有文件都被约束在此目录内）
  state_dir: ".go-upload_state"  # 上传会话状态存储目录

# 限制配置
limits:
  max_chunk_bytes: 33554432  # 单次分片最大大小（32MB）
  max_file_bytes: 0          # 单文件最大大小（0=不限制）
```

### 部署模式

**一体化模式**（`static.enable: true`）：
- 访问 `http://127.0.0.1:5000/` 获得完整的前端界面
- 前端静态文件已嵌入到可执行文件中，无需额外部署
- API 服务在 `/api/...` 路径下
- 适合生产环境单机部署

打包命令：`go build -o go-upload .`

**纯 API 模式**（`static.enable: false`）：
- 仅提供 API 服务
- 前端需要单独部署或通过开发服务器访问
- 适合前后端分离部署

## API 接口文档

### 核心上传接口

#### 1) 初始化上传会话

`POST /api/v1/uploads/init`

**请求体**：
```json
{
  "filename": "example.zip",
  "path": "uploads/2024/example.zip",
  "total_size": 104857600,
  "chunk_size": 5242880
}
```

**响应**：
```json
{
  "upload_id": "a1b2c3d4e5f6",
  "uploaded_size": 0
}
```

#### 2) 查询上传进度

`GET /api/v1/uploads/status?upload_id=...`

**响应**：
```json
{
  "upload_id": "a1b2c3d4e5f6",
  "created_at": "2024-01-01T12:00:00Z",
  "filename": "example.zip",
  "rel_path": "uploads/2024/example.zip",
  "total_size": 104857600,
  "chunk_size": 5242880,
  "uploaded_size": 5242880,
  "completed": false
}
```

#### 3) 上传分片

`PUT /api/v1/uploads/chunk?upload_id=...`

**请求头**：
- `X-Chunk-Offset`: 分片起始偏移（字节）
- `Content-Length`: 分片长度（字节）
- `Content-Type: application/octet-stream`

**请求体**：原始二进制数据

**响应**：
```json
{
  "uploaded_size": 10485760
}
```

#### 4) 完成上传

`POST /api/v1/uploads/complete?upload_id=...`

**响应**：
```json
{
  "completed": true,
  "path": "/full/path/to/uploads/2024/example.zip"
}
```

#### 5) 取消上传

`POST /api/v1/uploads/cancel?upload_id=...` 或 `DELETE /api/v1/uploads/cancel?upload_id=...`

**响应**：
```json
{
  "cancelled": true
}
```

### 辅助接口

#### 6) 获取目录树

`GET /api/v1/storage/tree?max_depth=4&max_entries=5000`

**功能**：返回 `storage.root_dir` 下的目录结构（仅目录，不含文件）

**响应**：
```json
{
  "root": {
    "name": "uploads",
    "rel_path": "",
    "children": [
      {
        "name": "2024",
        "rel_path": "2024",
        "children": [
          { "name": "january", "rel_path": "2024/january" }
        ]
      }
    ]
  }
}
```

## 构建与部署

### 开发环境构建

```bash
# 构建前端
cd web
npm install
npm run build
cd ..

# 运行后端（开发模式）
go run . -config config.yaml
```

### 生产环境构建

### 方式一：构建一体化可执行文件（推荐）

```bash
# 1. 构建前端
cd web
npm install
npm run build
cd ..

# 2. 构建 Go 可执行文件（前端已嵌入）
go build -o go-upload .

# 3. 运行
./go-upload -config config.yaml
```

**特点**：
- 前端静态文件已嵌入到可执行文件中
- 单文件部署，无需额外的静态文件目录
- 访问 `http://127.0.0.1:5000/` 获得完整界面

#### 方式二：跨平台构建

```bash
# 构建前端（同上）
cd web && npm run build && cd ..

# Linux 64位
GOOS=linux GOARCH=amd64 go build -o go-upload-linux-amd64 .

# Windows 64位
GOOS=windows GOARCH=amd64 go build -o go-upload-windows-amd64.exe .

# macOS 64位
GOOS=darwin GOARCH=amd64 go build -o go-upload-darwin-amd64 .

# macOS ARM64
GOOS=darwin GOARCH=arm64 go build -o go-upload-darwin-arm64 .
```

#### 方式三：Docker 部署

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN apk add --no-cache nodejs npm
RUN cd web && npm install && npm run build
RUN go build -o go-upload .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/go-upload .
COPY --from=builder /app/config.example.yaml ./config.yaml
EXPOSE 5000
CMD ["./go-upload", "-config", "config.yaml"]
```

**注意**：前端静态文件已嵌入到可执行文件中，无需复制 `web/dist` 目录。

### 部署建议

1. **生产环境配置**：
   - 设置合适的 `root_dir` 到数据盘
   - 配置 `max_file_bytes` 限制文件大小
   - 考虑使用反向代理（nginx）处理 HTTPS

2. **安全考虑**：
   - 确保 `root_dir` 目录权限正确
   - 定期清理 `state_dir` 中的过期上传会话
   - 在反向代理层面添加速率限制

## 使用示例

### curl 命令行示例

假设你有一个 10MB 文件 `big.bin`：

**1) 初始化上传**：

```bash
UPLOAD_ID=$(curl -sS -X POST "http://127.0.0.1:5000/api/v1/uploads/init" \
  -H "Content-Type: application/json" \
  -d '{"filename":"big.bin","path":"demo/big.bin","total_size":10485760,"chunk_size":5242880}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["upload_id"])')
echo "Upload ID: $UPLOAD_ID"
```

**2) 上传第一片（0~5MB）**：

```bash
dd if=big.bin bs=1 count=5242880 2>/dev/null | \
curl -sS -X PUT "http://127.0.0.1:5000/api/v1/uploads/chunk?upload_id=$UPLOAD_ID" \
  -H "X-Chunk-Offset: 0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @-
```

**3) 查询进度**：

```bash
curl -sS "http://127.0.0.1:5000/api/v1/uploads/status?upload_id=$UPLOAD_ID"
```

**4) 上传第二片（5MB~10MB）**：

```bash
dd if=big.bin bs=1 skip=5242880 count=5242880 2>/dev/null | \
curl -sS -X PUT "http://127.0.0.1:5000/api/v1/uploads/chunk?upload_id=$UPLOAD_ID" \
  -H "X-Chunk-Offset: 5242880" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @-
```

**5) 完成上传**：

```bash
curl -sS -X POST "http://127.0.0.1:5000/api/v1/uploads/complete?upload_id=$UPLOAD_ID"
```

**6) 取消上传**（如需要）：

```bash
curl -sS -X POST "http://127.0.0.1:5000/api/v1/uploads/cancel?upload_id=$UPLOAD_ID"
```

### 断点续传示例

如果上传过程中断，可以重新查询状态并继续上传：

```bash
# 重新查询状态
STATUS=$(curl -sS "http://127.0.0.1:5000/api/v1/uploads/status?upload_id=$UPLOAD_ID")
UPLOADED_SIZE=$(echo $STATUS | python3 -c 'import sys,json; print(json.load(sys.stdin)["uploaded_size"])')

# 从已上传的位置继续上传
dd if=big.bin bs=1 skip=$UPLOADED_SIZE count=5242880 2>/dev/null | \
curl -sS -X PUT "http://127.0.0.1:5000/api/v1/uploads/chunk?upload_id=$UPLOAD_ID" \
  -H "X-Chunk-Offset: $UPLOADED_SIZE" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @-
```

## 技术特性

- **Go 1.22+** 后端，高性能并发处理
- **React + TypeScript** 前端，现代化用户界面
- **断点续传**：支持网络中断后恢复上传
- **分片上传**：支持大文件分片并行上传
- **安全防护**：路径约束，防止目录遍历攻击
- **状态持久化**：上传会话信息持久化存储
- **跨平台支持**：支持 Linux、Windows、macOS
- **容器化部署**：提供 Docker 部署方案


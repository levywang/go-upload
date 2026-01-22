import { UploadStatus } from '../types';

type ProgressCallback = (progress: number, speed: string) => void;
type StatusCallback = (status: UploadStatus, error?: string) => void;

// 注意：如果 VITE_API_BASE_URL 配成 "/"，直接拼接会产生 "//api/..."，浏览器会把 "api" 当成域名。
// 这里统一去掉末尾的 "/"，让 "/" 变成空串，从而请求走当前域名的 "/api/..."
const rawApiBase = (import.meta as any).env?.VITE_API_BASE_URL;
const API_BASE =
  rawApiBase === undefined
    ? 'http://127.0.0.1:8088'
    : String(rawApiBase).replace(/\/+$/, '');

// 分片大小（MB），可通过 VITE_CHUNK_SIZE_MB 配置；默认 16MB
const chunkSizeMBEnv = Number((import.meta as any).env?.VITE_CHUNK_SIZE_MB);
const CHUNK_SIZE =
  Number.isFinite(chunkSizeMBEnv) && chunkSizeMBEnv > 0
    ? Math.min(chunkSizeMBEnv, 512) * 1024 * 1024 // 避免意外超大
    : 16 * 1024 * 1024;

interface InitResp {
  upload_id: string;
  uploaded_size: number;
}

interface StatusResp {
  upload_id: string;
  total_size: number;
  uploaded_size: number;
  completed: boolean;
}

const buildRelativePath = (directory: string, filename: string) => {
  const dir = directory.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
  if (!dir) return filename;
  return `${dir}/${filename}`;
};

const resumeKey = (relPath: string, size: number) =>
  `go-upload:upload:${relPath}:${size}`;

export const uploadFileWithResume = (
  file: File,
  targetDirectory: string,
  onProgress: ProgressCallback,
  onStatusChange: StatusCallback
): () => void => {
  let aborted = false;
  const controller = new AbortController();
  let uploadId: string | null = null;
  let resumeStorageKey: string | null = null;
  let cancelNotified = false;

  const notifyCancel = async () => {
    if (cancelNotified) return;
    cancelNotified = true;
    if (uploadId) {
      try {
        await fetch(
          `${API_BASE}/api/v1/uploads/cancel?upload_id=${encodeURIComponent(
            uploadId
          )}`,
          { method: 'POST' }
        );
      } catch {
        // 后端清理失败不阻塞前端取消
      }
    }
    if (resumeStorageKey) {
      localStorage.removeItem(resumeStorageKey);
    }
  };

  const abort = () => {
    aborted = true;
    controller.abort(); // 立即中断当前 fetch
    void notifyCancel();
  };

  // 异步执行上传逻辑，函数立即返回 abort，确保 UI 能马上获得取消句柄
  (async () => {
  const totalSize = file.size;
  const relPath = buildRelativePath(targetDirectory, file.name);
    resumeStorageKey = resumeKey(relPath, totalSize);

  try {
    onStatusChange(UploadStatus.UPLOADING);

    // 尝试从 localStorage 恢复 upload_id
      uploadId = localStorage.getItem(resumeStorageKey);
    let uploadedSize = 0;

    if (uploadId) {
      // 查询已有进度
      try {
        const statusResp = await fetch(
          `${API_BASE}/api/v1/uploads/status?upload_id=${encodeURIComponent(
            uploadId
            )}`,
            { signal: controller.signal }
        );
        if (statusResp.ok) {
          const statusJson = (await statusResp.json()) as StatusResp;
          uploadedSize = statusJson.uploaded_size || 0;
          if (statusJson.completed) {
            onProgress(100, '0 MB/s');
            onStatusChange(UploadStatus.COMPLETED);
              return;
          }
        } else if (statusResp.status === 404) {
          // 服务端没有记录了，重新开始
          uploadId = null;
            if (resumeStorageKey) localStorage.removeItem(resumeStorageKey);
        }
      } catch {
        // status 查询失败时，不强制中断，稍后会覆盖 upload_id
      }
    }

    if (!uploadId) {
      // 初始化新的上传会话
      const initResp = await fetch(`${API_BASE}/api/v1/uploads/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          path: relPath,
          total_size: totalSize,
          chunk_size: CHUNK_SIZE,
        }),
          signal: controller.signal,
      });
      if (!initResp.ok) {
        const text = await initResp.text();
        throw new Error(text || 'init upload failed');
      }
      const initJson = (await initResp.json()) as InitResp;
      uploadId = initJson.upload_id;
      uploadedSize = initJson.uploaded_size || 0;
        if (resumeStorageKey) localStorage.setItem(resumeStorageKey, uploadId);
    }

    let sentBytes = uploadedSize;
    let lastTime = performance.now();
    let lastBytes = sentBytes;

    onProgress(
      totalSize > 0 ? (sentBytes / totalSize) * 100 : 0,
      '0 MB/s'
    );

    while (sentBytes < totalSize) {
      if (aborted) {
          await notifyCancel();
          onStatusChange(UploadStatus.CANCELLED, 'Upload cancelled');
          return;
      }

      const chunkEnd = Math.min(sentBytes + CHUNK_SIZE, totalSize);
      const chunk = file.slice(sentBytes, chunkEnd);
      const offset = sentBytes;

      const resp = await fetch(
        `${API_BASE}/api/v1/uploads/chunk?upload_id=${encodeURIComponent(
          uploadId!
        )}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Offset': String(offset),
          },
          body: chunk,
            signal: controller.signal,
        }
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || 'chunk upload failed');
      }

      sentBytes = chunkEnd;

      const now = performance.now();
      const deltaMs = now - lastTime;
      const deltaBytes = sentBytes - lastBytes;
      let speed = '0 MB/s';
      if (deltaMs > 0 && deltaBytes > 0) {
        const bytesPerSec = (deltaBytes / deltaMs) * 1000;
        const mbPerSec = bytesPerSec / 1024 / 1024;
        speed = `${mbPerSec.toFixed(1)} MB/s`;
      }
      lastTime = now;
      lastBytes = sentBytes;

      const progress =
        totalSize > 0 ? (sentBytes / totalSize) * 100 : 0;
      onProgress(progress, speed);
    }

    // 所有分片发送完毕，通知 complete
    const completeResp = await fetch(
      `${API_BASE}/api/v1/uploads/complete?upload_id=${encodeURIComponent(
        uploadId!
      )}`,
      {
        method: 'POST',
          signal: controller.signal,
      }
    );

    if (!completeResp.ok) {
      const text = await completeResp.text();
      throw new Error(text || 'complete upload failed');
    }

      if (resumeStorageKey) localStorage.removeItem(resumeStorageKey);
    onProgress(100, '0 MB/s');
    onStatusChange(UploadStatus.COMPLETED);
  } catch (err: any) {
      if (aborted || err?.name === 'AbortError') {
        await notifyCancel();
        onStatusChange(UploadStatus.CANCELLED, 'Upload cancelled');
        return;
      }
    console.error('upload error', err);
    onStatusChange(
      UploadStatus.ERROR,
      err?.message || 'Upload failed'
    );
  }
  })();

  return abort;
};


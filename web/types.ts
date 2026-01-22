export enum UploadStatus {
  IDLE = 'IDLE',
  PENDING = 'PENDING',
  UPLOADING = 'UPLOADING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
  CANCELLED = 'CANCELLED',
}

export interface FileUpload {
  id: string;
  file: File;
  path: string;
  progress: number; // 0 to 100
  status: UploadStatus;
  errorMessage?: string;
  uploadSpeed?: string; // e.g., "2.4 MB/s"
}

export interface ServerLocation {
  id: string;
  name: string;
  path: string;
}

export interface DirNode {
  name: string;
  rel_path: string; // 相对后端 root_dir 的目录路径；根目录为 ""
  children?: DirNode[];
}
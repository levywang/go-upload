import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Server, FolderOpen, History, Settings } from 'lucide-react';
import Header from './components/Header';
import UploadZone from './components/UploadZone';
import FileItem from './components/FileItem';
import DirectoryPickerDialog from './components/DirectoryPickerDialog';
import { FileUpload, UploadStatus, DirNode } from './types';
import { uploadFileWithResume } from './services/uploadService';
import { fetchStorageTree } from './services/storageService';

const App: React.FC = () => {
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [targetPath, setTargetPath] = useState<string>(''); // 目录相对路径（根目录为 ""）
  const [isProcessing, setIsProcessing] = useState(false);
  const [dirTree, setDirTree] = useState<DirNode | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [dirDialogOpen, setDirDialogOpen] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  // 防止同一个文件任务被重复触发多次上传（会导致取消只中断其中一次）
  const inFlightRef = useRef<Set<string>>(new Set());
  // 存储每个上传任务的取消句柄，防止 state 未及时更新导致拿不到 cancel
  const cancelMapRef = useRef<Record<string, () => void>>({});
  // 记录已点击取消但当下拿不到 cancel 句柄的任务，稍后补偿调用
  const pendingCancelRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setDirLoading(true);
    setDirError(null);
    fetchStorageTree({ maxDepth: 6, maxEntries: 20000 })
      .then((resp) => {
        if (cancelled) return;
        setDirTree(resp.root);
        // 默认选根目录
        setTargetPath('');
      })
      .catch((e: any) => {
        if (cancelled) return;
        setDirError(e?.message || '加载目录失败');
      })
      .finally(() => {
        if (cancelled) return;
        setDirLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDirLabel = useMemo(() => {
    if (!dirTree) return targetPath || '（根目录）';
    return targetPath === '' ? `${dirTree.name}（根目录）` : targetPath;
  }, [dirTree, targetPath]);

  // Handle new file selection
  const handleFilesSelected = (newFiles: File[]) => {
    setPendingFiles(newFiles);
    setConfirmDialogOpen(true);
  };

  const confirmUploadNow = () => {
    if (pendingFiles.length === 0) {
      setConfirmDialogOpen(false);
      return;
    }

    const newUploads: FileUpload[] = pendingFiles.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      file,
      path: targetPath,
      progress: 0,
      status: UploadStatus.PENDING,
    }));

    setFiles(prev => [...newUploads, ...prev]);

    setPendingFiles([]);
    setConfirmDialogOpen(false);
  };

  const cancelUploadSelection = () => {
    setPendingFiles([]);
    setConfirmDialogOpen(false);
  };

  // 当 files 变化时，自动启动所有 PENDING 且未在飞的任务，避免使用旧快照重复触发
  useEffect(() => {
    files.forEach(item => {
      if (item.status === UploadStatus.PENDING && !inFlightRef.current.has(item.id)) {
        startUpload(item);
      }
      // 如果之前点击了取消但当时还没有 cancel 句柄，这里补偿调用
      if (
        item.status === UploadStatus.CANCELLED &&
        pendingCancelRef.current.has(item.id) &&
        cancelMapRef.current[item.id]
      ) {
        cancelMapRef.current[item.id]!();
        pendingCancelRef.current.delete(item.id);
        delete cancelMapRef.current[item.id];
      }
    });
  }, [files]);

  const startUpload = (item: FileUpload) => {
    // 去重：同一个 id 的上传只能启动一次
    if (inFlightRef.current.has(item.id)) return;
    inFlightRef.current.add(item.id);

    // Update status to uploading immediately to prevent double-trigger
    setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: UploadStatus.UPLOADING } : f));
    setIsProcessing(true);

    // 调用真实后端进行分片上传 + 断点续传
    const cancel = uploadFileWithResume(
      item.file,
      item.path,
      (progress, speed) => {
        setFiles(prev =>
          prev.map(f =>
            f.id === item.id ? { ...f, progress, uploadSpeed: speed } : f
          )
        );
      },
      (status, errorMessage) => {
        setFiles(prev =>
          prev.map(f =>
            f.id === item.id ? { ...f, status, errorMessage } : f
          )
        );

        // 结束态释放 in-flight 锁
        if (
          status === UploadStatus.COMPLETED ||
          status === UploadStatus.ERROR ||
          status === UploadStatus.CANCELLED
        ) {
          inFlightRef.current.delete(item.id);
        }

        // 检查是否所有任务都结束
        setFiles(currentFiles => {
          const allDone = currentFiles.every(f =>
            f.status === UploadStatus.COMPLETED ||
            f.status === UploadStatus.ERROR ||
            f.status === UploadStatus.CANCELLED ||
            f.status === UploadStatus.IDLE
          );
          if (allDone) setIsProcessing(false);
          return currentFiles;
        });
      }
    );

    // 将取消句柄存入对应项
    cancelMapRef.current[item.id] = cancel;
      setFiles(prev => prev.map(f => f.id === item.id ? { ...f, cancel } : f));
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const cancelUpload = (id: string) => {
    // 优先立即调用已存在的 cancel 句柄，避免等待状态更新
    const instantCancel = cancelMapRef.current[id];
    if (instantCancel) {
      instantCancel();
    } else {
      pendingCancelRef.current.add(id);
    }

    // 用函数式 setState，避免闭包拿到旧的 files
    setFiles(prev =>
      prev.map(f => (f.id === id ? { ...f, status: UploadStatus.CANCELLED } : f))
    );

    // 取消也释放 in-flight 锁，避免后续队列逻辑误触发
    inFlightRef.current.delete(id);
    delete cancelMapRef.current[id];
  };

  const resumeUpload = (id: string) => {
    setFiles(prev =>
      prev.map(f => (f.id === id ? { ...f, status: UploadStatus.PENDING } : f))
    );
  };

  const activeUploads = files.filter(f => f.status === UploadStatus.UPLOADING || f.status === UploadStatus.PENDING);
  const historyFiles = files.filter(
    f =>
      f.status === UploadStatus.COMPLETED ||
      f.status === UploadStatus.ERROR ||
      f.status === UploadStatus.CANCELLED
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
      <Header />

      <main className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Column: Configuration & Upload */}
          <div className="lg:col-span-7 space-y-6">
            
            {/* Server Path Configuration Card */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Server className="w-5 h-5 text-slate-500" />
                  <h2 className="font-semibold text-slate-800">Destination Configuration</h2>
                </div>
                <Settings className="w-4 h-4 text-slate-400 cursor-pointer hover:text-slate-600" />
              </div>
              
              <div className="p-6 space-y-4">
                <div>
                  <label htmlFor="path-input" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Upload Directory
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <FolderOpen className="h-5 w-5 text-slate-400" />
                    </div>
                    <button
                      id="path-input"
                      type="button"
                      onClick={() => setDirDialogOpen(true)}
                      disabled={dirLoading || !!dirError}
                      className="block w-full text-left pl-10 pr-3 py-2.5 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm transition-shadow shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="text-slate-700">{selectedDirLabel}</span>
                      <span className="ml-2 text-xs text-slate-400">(点击选择)</span>
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    目录来自后端 `root_dir` 下的真实结构；上传将写入你选择的目录中。
                  </p>
                  {dirError && (
                    <p className="mt-2 text-xs text-red-600">
                      {dirError}（请确认后端已启动且 `VITE_API_BASE_URL` 指向正确地址）
                    </p>
                  )}
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => setTargetPath('')}
                    className="text-xs px-3 py-1.5 rounded-full border transition-all duration-200 bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                    disabled={dirLoading || !!dirError}
                  >
                    Use Root Directory
                  </button>
                </div>
              </div>
            </div>

            {/* Upload Zone */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                Upload Files
              </h2>
              <UploadZone onFilesSelected={handleFilesSelected} targetPath={targetPath} />
            </div>

          </div>

          {/* Right Column: Active & History */}
          <div className="lg:col-span-5 space-y-6">
            
            {/* Active Transfers */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col h-[500px]">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`}></div>
                  <h2 className="font-semibold text-slate-800">Transfer Status</h2>
                </div>
                <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full">
                  {activeUploads.length} Active
                </span>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                {files.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-3 opacity-60">
                    <History className="w-12 h-12" />
                    <p className="text-sm">No recent transfers</p>
                  </div>
                ) : (
                  <>
                    {/* Active Uploads First */}
                    {activeUploads.map(file => (
                      <FileItem key={file.id} item={file} onRemove={removeFile} onCancel={cancelUpload} onResume={resumeUpload} />
                    ))}
                    
                    {/* Completed/History Header if needed */}
                    {historyFiles.length > 0 && activeUploads.length > 0 && (
                       <div className="relative py-2">
                         <div className="absolute inset-0 flex items-center" aria-hidden="true">
                           <div className="w-full border-t border-slate-100"></div>
                         </div>
                         <div className="relative flex justify-center">
                           <span className="bg-white px-2 text-xs text-slate-400 uppercase tracking-widest">History</span>
                         </div>
                       </div>
                    )}

                    {/* History */}
                    {historyFiles.map(file => (
                      <FileItem key={file.id} item={file} onRemove={removeFile} onCancel={cancelUpload} onResume={resumeUpload} />
                    ))}
                  </>
                )}
              </div>
              
              <div className="bg-slate-50 p-3 border-t border-slate-100 text-xs text-center text-slate-400">
                Only Upload Files, No Download Files
              </div>
            </div>

          </div>
        </div>
      </main>

      <DirectoryPickerDialog
        open={dirDialogOpen}
        root={dirTree}
        value={targetPath}
        loading={dirLoading}
        error={dirError}
        onClose={() => setDirDialogOpen(false)}
        onConfirm={(p) => setTargetPath(p)}
      />

      {/* 上传确认弹窗 */}
      {confirmDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-lg shadow-lg max-w-md w-full border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-800">立即上传？</h3>
              <p className="text-sm text-slate-500 mt-1">
                已选择 {pendingFiles.length} 个文件，目标目录：{targetPath || '（根目录）'}
              </p>
            </div>
            <div className="px-6 py-4 space-y-2 max-h-60 overflow-y-auto">
              {pendingFiles.map((f, idx) => (
                <div key={idx} className="text-sm text-slate-700 truncate">
                  • {f.name}
                </div>
              ))}
            </div>
            <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-end gap-3 bg-slate-50/60">
              <button
                onClick={cancelUploadSelection}
                className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmUploadNow}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
                disabled={pendingFiles.length === 0}
              >
                立即上传
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
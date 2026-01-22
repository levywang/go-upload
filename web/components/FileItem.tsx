import React from 'react';
import { File, CheckCircle2, AlertCircle, X, Loader2, FolderInput, Play } from 'lucide-react';
import { FileUpload, UploadStatus } from '../types';

interface FileItemProps {
  item: FileUpload;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
  onResume?: (id: string) => void;
}

const FileItem: React.FC<FileItemProps> = ({ item, onRemove, onCancel, onResume }) => {
  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusIcon = () => {
    switch (item.status) {
      case UploadStatus.COMPLETED:
        return <CheckCircle2 className="w-5 h-5 text-emerald-500" />;
      case UploadStatus.ERROR:
        return <AlertCircle className="w-5 h-5 text-red-500" />;
      case UploadStatus.UPLOADING:
        return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
      default:
        return <File className="w-5 h-5 text-slate-400" />;
    }
  };

  const getStatusColor = () => {
    switch (item.status) {
      case UploadStatus.COMPLETED: return 'bg-emerald-500';
      case UploadStatus.ERROR: return 'bg-red-500';
      case UploadStatus.UPLOADING: return 'bg-blue-500';
      default: return 'bg-slate-300';
    }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-100 shadow-sm hover:shadow-md transition-shadow duration-200 p-4 group">
      <div className="flex items-start justify-between gap-4">
        {/* Icon */}
        <div className="flex-shrink-0 mt-1">
          <div className="w-10 h-10 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center">
            {getStatusIcon()}
          </div>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-sm font-semibold text-slate-800 truncate pr-2" title={item.file.name}>
              {item.file.name}
            </h4>
            <div className="flex items-center gap-1">
              {item.status === UploadStatus.UPLOADING || item.status === UploadStatus.PENDING ? (
                <button
                  onClick={() => onCancel(item.id)}
                  className="text-slate-400 hover:text-amber-500 transition-colors"
                  title="取消上传"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : item.status === UploadStatus.CANCELLED && onResume ? (
                <>
                  <button
                    onClick={() => onResume(item.id)}
                    className="text-slate-400 hover:text-green-500 transition-colors"
                    title="恢复上传"
                  >
                    <Play className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => onRemove(item.id)}
                    className="text-slate-400 hover:text-red-500 transition-colors"
                    title="移除记录"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <button 
                  onClick={() => onRemove(item.id)}
                  className="text-slate-400 hover:text-red-500 transition-colors"
                  title="移除记录"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-3 text-xs text-slate-500 mb-2">
            <span>{formatSize(item.file.size)}</span>
            <span className="w-1 h-1 rounded-full bg-slate-300"></span>
            <div className="flex items-center gap-1 truncate max-w-[150px] sm:max-w-xs" title={item.path}>
               <FolderInput className="w-3 h-3 text-slate-400" />
               <span className="truncate">{item.path}</span>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="relative w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div 
              className={`absolute left-0 top-0 h-full rounded-full transition-all duration-300 ease-out ${getStatusColor()}`}
              style={{ width: `${item.progress}%` }}
            />
          </div>

          {/* Progress Detail */}
          <div className="flex justify-between mt-1.5 h-4">
             <span className="text-xs font-medium text-slate-600">
               {item.status === UploadStatus.UPLOADING && `${Math.round(item.progress)}%`}
               {item.status === UploadStatus.COMPLETED && 'Upload Complete'}
               {item.status === UploadStatus.ERROR && 'Upload Failed'}
               {item.status === UploadStatus.CANCELLED && 'Upload Cancelled'}
               {item.status === UploadStatus.PENDING && 'Waiting...'}
             </span>
             {item.status === UploadStatus.UPLOADING && (
               <span className="text-xs text-slate-400 font-mono">{item.uploadSpeed}</span>
             )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FileItem;
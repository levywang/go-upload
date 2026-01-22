import React, { useCallback, useRef } from 'react';
import { UploadCloud, FileUp } from 'lucide-react';

interface UploadZoneProps {
  onFilesSelected: (files: File[]) => void;
  targetPath: string;
  disabled?: boolean;
}

const UploadZone: React.FC<UploadZoneProps> = ({ onFilesSelected, targetPath, disabled }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFilesSelected(Array.from(e.dataTransfer.files));
    }
  }, [onFilesSelected, disabled]);

  const handleClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
      // Reset input value to allow selecting the same file again if needed
      e.target.value = '';
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={handleClick}
      className={`
        group relative w-full h-64 rounded-xl border-2 border-dashed 
        transition-all duration-300 ease-in-out cursor-pointer flex flex-col items-center justify-center
        ${disabled ? 'opacity-50 cursor-not-allowed bg-slate-50 border-slate-200' : 'bg-white border-slate-300 hover:border-blue-500 hover:bg-blue-50/30'}
      `}
    >
      <input
        type="file"
        multiple
        ref={fileInputRef}
        className="hidden"
        onChange={handleInputChange}
        disabled={disabled}
      />
      
      <div className="flex flex-col items-center gap-4 text-center px-4">
        <div className={`
          p-4 rounded-full transition-colors duration-300
          ${disabled ? 'bg-slate-100 text-slate-400' : 'bg-slate-50 text-blue-600 group-hover:bg-blue-100 group-hover:text-blue-700'}
        `}>
          <UploadCloud className="w-8 h-8" />
        </div>
        
        <div className="space-y-1">
          <p className="text-lg font-medium text-slate-700">
            Click or drag files to upload
          </p>
          <p className="text-sm text-slate-500">
            Files will be uploaded to <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-600 font-mono text-xs border border-slate-200">{targetPath}</code>
          </p>
        </div>
        
        <div className="flex items-center gap-2 mt-2">
           <span className="text-xs text-slate-400 font-medium px-2 py-1 rounded-md bg-slate-50 border border-slate-100">
             Max Size: No Limit
           </span>
           <span className="text-xs text-slate-400 font-medium px-2 py-1 rounded-md bg-slate-50 border border-slate-100">
             Any Format
           </span>
        </div>
      </div>
    </div>
  );
};

export default UploadZone;
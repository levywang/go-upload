import React from 'react';
import { Cloud, ShieldCheck } from 'lucide-react';

const Header: React.FC = () => {
  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="bg-slate-900 p-1.5 rounded-lg">
            <Cloud className="w-5 h-5 text-white" />
          </div>
          <span className="font-semibold text-slate-800 text-lg tracking-tight">Go Upload</span>
        </div>
      </div>
    </header>
  );
};

export default Header;
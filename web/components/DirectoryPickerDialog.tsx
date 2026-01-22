import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, ChevronRight, ArrowLeft, X } from 'lucide-react';
import { DirNode } from '../types';

type Props = {
  open: boolean;
  root: DirNode | null;
  value: string; // 当前选中的 rel_path（目录）；根目录为 ""
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (relPath: string) => void;
};

type Crumb = { name: string; relPath: string };

function findPath(root: DirNode, targetRelPath: string): Crumb[] | null {
  const stack: Crumb[] = [];
  const dfs = (n: DirNode): boolean => {
    stack.push({ name: n.name, relPath: n.rel_path });
    if (n.rel_path === targetRelPath) return true;
    for (const c of n.children || []) {
      if (dfs(c)) return true;
    }
    stack.pop();
    return false;
  };
  return dfs(root) ? [...stack] : null;
}

function findNode(root: DirNode, relPath: string): DirNode | null {
  if (root.rel_path === relPath) return root;
  for (const c of root.children || []) {
    const hit = findNode(c, relPath);
    if (hit) return hit;
  }
  return null;
}

export default function DirectoryPickerDialog({
  open,
  root,
  value,
  loading,
  error,
  onClose,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [cursor, setCursor] = useState<string>(value || '');
  const [pending, setPending] = useState<string>(value || '');

  useEffect(() => {
    setCursor(value || '');
    setPending(value || '');
  }, [value, open]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else {
      if (el.open) el.close();
    }
  }, [open]);

  const crumbs = useMemo(() => {
    if (!root) return [];
    const p = findPath(root, cursor);
    if (p) return p;
    // 找不到时回到根
    return [{ name: root.name, relPath: '' }];
  }, [root, cursor]);

  const currentNode = useMemo(() => {
    if (!root) return null;
    return findNode(root, cursor) || root;
  }, [root, cursor]);

  const children = useMemo(() => {
    const cs = currentNode?.children || [];
    return [...cs].sort((a, b) => a.name.localeCompare(b.name));
  }, [currentNode]);

  const canGoBack = crumbs.length > 1;

  const close = () => {
    onClose();
  };

  const confirm = () => {
    onConfirm(pending);
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="w-[min(720px,95vw)] rounded-xl p-0 backdrop:bg-black/40"
      onClose={close}
    >
      <div className="bg-white rounded-xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-slate-500" />
            <h3 className="font-semibold text-slate-800">选择上传目录</h3>
          </div>
          <button
            onClick={close}
            className="text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Breadcrumbs */}
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <button
              onClick={() => {
                if (!canGoBack) return;
                const parent = crumbs[crumbs.length - 2];
                setCursor(parent.relPath);
              }}
              disabled={!canGoBack}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs transition-colors ${
                canGoBack
                  ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  : 'border-slate-100 text-slate-300 cursor-not-allowed'
              }`}
              title="返回上一级"
            >
              <ArrowLeft className="w-4 h-4" />
              返回
            </button>

            <div className="flex items-center flex-wrap gap-1 text-slate-600">
              {crumbs.map((c, idx) => (
                <React.Fragment key={c.relPath || '__root__'}>
                  {idx > 0 && <ChevronRight className="w-4 h-4 text-slate-300" />}
                  <button
                    onClick={() => setCursor(c.relPath)}
                    className={`px-2 py-1 rounded-md text-xs border transition-colors ${
                      c.relPath === cursor
                        ? 'border-blue-200 bg-blue-50 text-blue-700'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                    title={c.relPath || 'root'}
                  >
                    {c.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* List */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 text-xs text-slate-500 border-b border-slate-100">
              {error
                ? `目录加载失败：${error}`
                : loading
                ? '目录加载中...'
                : `当前目录：${cursor || '（根目录）'}`}
            </div>

            <div className="max-h-[360px] overflow-y-auto">
              {(!root || loading) && (
                <div className="p-4 text-sm text-slate-400">加载中...</div>
              )}
              {!loading && root && children.length === 0 && (
                <div className="p-4 text-sm text-slate-400">没有子目录</div>
              )}
              {!loading &&
                root &&
                children.map((d) => {
                  const selected = pending === d.rel_path;
                  return (
                    <div
                      key={d.rel_path}
                      className={`flex items-center justify-between px-4 py-2 border-b border-slate-50 hover:bg-slate-50 ${
                        selected ? 'bg-blue-50/40' : ''
                      }`}
                    >
                      {/* 模拟文件管理器：单击选中，双击进入 */}
                      <div
                        role="button"
                        tabIndex={0}
                        className="flex items-center gap-2 min-w-0 text-left flex-1 cursor-default select-none"
                        onClick={() => setPending(d.rel_path)}
                        onDoubleClick={() => {
                          setPending(d.rel_path);
                          setCursor(d.rel_path);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setPending(d.rel_path);
                            setCursor(d.rel_path);
                          }
                        }}
                        title={d.rel_path || d.name}
                      >
                        <FolderOpen className="w-4 h-4 text-slate-400 flex-shrink-0" />
                        <span
                          className={`text-sm truncate ${
                            selected ? 'text-blue-700 font-medium' : 'text-slate-700'
                          }`}
                        >
                          {d.name}
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Selected + Hint */}
          <div className="space-y-1">
            <div className="text-xs text-slate-500">
              已选目录：<span className="font-mono text-slate-700">{pending || '（根目录）'}</span>
            </div>
            <div className="text-[11px] text-slate-400">
              提示：单击可选中目录，<span className="font-medium">双击目录行可进入子目录</span>。
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-100 bg-white flex items-center justify-end gap-2">
          <button
            onClick={close}
            className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
          >
            取消
          </button>
          <button
            onClick={confirm}
            disabled={!root || !!error || !!loading}
            className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            选择此目录
          </button>
        </div>
      </div>
    </dialog>
  );
}


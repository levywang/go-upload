import { DirNode } from '../types';

// 注意：如果 VITE_API_BASE_URL 配成 "/"，直接拼接会产生 "//api/..."，浏览器会把 "api" 当成域名。
// 这里统一去掉末尾的 "/"，让 "/" 变成空串，从而请求走当前域名的 "/api/..."
const rawApiBase = (import.meta as any).env?.VITE_API_BASE_URL;
const API_BASE =
  rawApiBase === undefined
    ? 'http://127.0.0.1:8088'
    : String(rawApiBase).replace(/\/+$/, '');

export interface StorageTreeResp {
  root: DirNode;
}

export async function fetchStorageTree(params?: {
  maxDepth?: number;
  maxEntries?: number;
}): Promise<StorageTreeResp> {
  const q = new URLSearchParams();
  if (params?.maxDepth !== undefined) q.set('max_depth', String(params.maxDepth));
  if (params?.maxEntries !== undefined)
    q.set('max_entries', String(params.maxEntries));

  const url = `${API_BASE}/api/v1/storage/tree${q.toString() ? `?${q}` : ''}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || 'fetch storage tree failed');
  }
  return (await resp.json()) as StorageTreeResp;
}


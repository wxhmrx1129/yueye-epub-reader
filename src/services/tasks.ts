export interface TaskOptions { signal?: AbortSignal; onStage?: (stage: string) => void }
export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('操作已取消。', 'AbortError');
}
export const FILE_LIMIT = 150 * 1024 ** 2;
export function safeHttpUrl(value:unknown):string|undefined {
  if(typeof value!=='string')return;
  try {const url=new URL(value);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{/* Invalid document links never leave the reader. */}
}
export function validateFileSize(size: number) {
  if (!size) throw new Error('文件为空，请选择有效图书。');
  if (size > FILE_LIMIT) throw new Error('文件超过单本 150MiB 上限，未导入。');
}

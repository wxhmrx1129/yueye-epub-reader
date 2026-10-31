import { unzipSync } from 'fflate';
import { checkCancelled } from '../tasks';

/** Keeps compressed data in a worker; only requested entries cross to the UI. */
export function openArchive(bytes: Uint8Array, resourceLimit: number, unpackedLimit: number, signal?: AbortSignal) {
  let disposed = false, serial = 0;
  const pending = new Map<number, {resolve:(files:Record<string,Uint8Array>)=>void; reject:(error:Error)=>void}>();
  const worker = typeof Worker === 'undefined' ? undefined : new Worker(new URL('./archive.worker.ts', import.meta.url), {type:'module'});
  function dispose() {
    if (disposed) return;
    disposed = true; worker?.terminate(); signal?.removeEventListener('abort', dispose);
    for (const item of pending.values()) item.reject(new DOMException('操作已取消。', 'AbortError'));
    pending.clear(); bytes = new Uint8Array();
  }
  worker?.addEventListener('message', ({data}) => {
    const item = pending.get(data.id); if (!item) return;
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error)); else item.resolve(data.files ?? {});
  });
  worker?.addEventListener('error', () => {
    for (const item of pending.values()) item.reject(new Error('EPUB 后台解压失败，请重新打开。'));
    pending.clear(); dispose();
  });
  function request(data: object, transfer: Transferable[] = []) {
    checkCancelled(signal);
    if (disposed) return Promise.reject(new DOMException('操作已取消。', 'AbortError'));
    return new Promise<Record<string,Uint8Array>>((resolve,reject) => {
      const id = ++serial; pending.set(id,{resolve,reject}); worker!.postMessage({id,...data},transfer);
    });
  }
  signal?.addEventListener('abort', dispose, {once:true});
  const ready = worker ? request({bytes},[bytes.buffer as ArrayBuffer]) : Promise.resolve({});
  return {
    dispose,
    async read(names: string[]) {
      checkCancelled(signal); await ready;
      if (worker) return request({names,resourceLimit,unpackedLimit});
      if (disposed) throw new DOMException('操作已取消。', 'AbortError');
      const wanted = new Set(names);
      return unzipSync(bytes,{filter:entry=>wanted.has(entry.name)});
    },
  };
}

import { unzipSync } from 'fflate';

let archive: Uint8Array;
self.onmessage = ({data}) => {
  const {id, bytes, names, resourceLimit, unpackedLimit} = data;
  try {
    if (bytes) { archive = bytes; self.postMessage({id}); return; }
    const wanted = new Set<string>(names);
    let total = 0;
    const files = unzipSync(archive, {filter: entry => {
      total += entry.originalSize;
      if (entry.originalSize > resourceLimit || total > unpackedLimit) throw new Error('EPUB 资源超过安全解压限制。');
      return wanted.has(entry.name);
    }});
    if(Object.values(files).some(file=>file.length>resourceLimit)||Object.values(files).reduce((sum,file)=>sum+file.length,0)>unpackedLimit)throw new Error('EPUB 资源超过安全解压限制。');
    self.postMessage({id, files}, {transfer:Object.values(files).map(file => file.buffer as ArrayBuffer)});
  } catch (error) { self.postMessage({id, error:error instanceof Error ? error.message : 'EPUB 解压失败。'}); }
};

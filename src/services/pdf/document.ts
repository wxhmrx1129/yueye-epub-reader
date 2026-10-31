import { getDocument, GlobalWorkerOptions, PermissionFlag } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { checkCancelled, validateFileSize, type TaskOptions } from '../tasks';
import { readBlobBytes } from '../epub/import';

GlobalWorkerOptions.workerSrc = workerUrl;
export interface PdfDocument {
  document: PDFDocumentProxy; title: string; author: string; language: string;
  coverBlob?: Blob; canCopy: boolean; dispose: () => Promise<void>;
}
export async function openPdf(blob: Blob, name: string, options:TaskOptions & {bytes?:Uint8Array; cover?:boolean} = {}):Promise<PdfDocument> {
  validateFileSize(blob.size); checkCancelled(options.signal);
  options.onStage?.('校验 PDF 文件');
  const bytes = options.bytes ?? await readBlobBytes(blob);
  checkCancelled(options.signal);
  if (!new TextDecoder('ascii').decode(bytes.subarray(0,1024)).includes('%PDF-')) throw new Error('文件内容不是可识别的 PDF。');
  const base = new URL('pdfjs/',document.baseURI).href;
  const task = getDocument({
    data:bytes, cMapUrl:base+'cmaps/', cMapPacked:true, standardFontDataUrl:base+'standard_fonts/',
    wasmUrl:base+'wasm/', iccUrl:base+'iccs/', useWorkerFetch:true,
    enableXfa:false, maxImageSize:32*1024*1024,
    canvasMaxAreaInBytes:64*1024*1024, verbosity:0,
  });
  let passwordRequired = false;
  task.onPassword = () => { passwordRequired = true; void task.destroy(); };
  const cancel = () => { void task.destroy(); };
  options.signal?.addEventListener('abort',cancel,{once:true});
  const dispose = async()=>{options.signal?.removeEventListener('abort',cancel);await task.destroy();};
  try {
    options.onStage?.('解析 PDF');
    const pdf = await task.promise; checkCancelled(options.signal);
    const [metadata,permissions] = await Promise.all([pdf.getMetadata(),pdf.getPermissions()]);
    const info = metadata.info as Record<string,unknown>;
    const clean = (value:unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g,'').trim().slice(0,500) : '';
    let coverBlob:Blob|undefined;
    if (options.cover) {
      options.onStage?.('生成 PDF 封面');
      const page = await pdf.getPage(1), view = page.getViewport({scale:1});
      const scale = Math.min(1,280/Math.max(view.width,view.height));
      const viewport = page.getViewport({scale});
      const canvas = document.createElement('canvas'); canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      try {
        await page.render({canvas,viewport,annotationMode:0}).promise;
        coverBlob = await new Promise<Blob|undefined>(resolve=>canvas.toBlob(value=>resolve(value??undefined),'image/png'));
      } catch { checkCancelled(options.signal); /* A failed thumbnail does not reject an otherwise readable PDF. */ }
      finally { canvas.width=canvas.height=0; page.cleanup(); }
    }
    checkCancelled(options.signal);
    return {document:pdf,title:clean(info.Title)||name.replace(/\.pdf$/i,'')||'未命名 PDF',author:clean(info.Author)||'未知作者',language:clean(info.Language)||'und',coverBlob,canCopy:!permissions||permissions.has(PermissionFlag.COPY),dispose};
  } catch (error) {
    await dispose(); checkCancelled(options.signal);
    if (passwordRequired || error instanceof Error && error.name==='PasswordException') throw new Error('此 PDF 需要打开密码，V1.1 暂不支持。');
    throw new Error(error instanceof Error && /PDF|安全|资源/.test(error.message) ? error.message : 'PDF 损坏或无法解析，请检查文件。');
  }
}

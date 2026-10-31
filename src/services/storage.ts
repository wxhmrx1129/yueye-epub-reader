import Dexie, { type Table } from 'dexie';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../preferences';
import type { Annotation, BookRecord, Bookmark, PageIndex, Preferences, ReadingProgress, PdfProgress, PdfBookmark, PdfAnnotation, PdfPreferences } from '../types';
import { parseEpub, readBlobBytes } from './epub/import';
import { checkCancelled, validateFileSize, type TaskOptions } from './tasks';

interface BookFile { bookId: string; blob: Blob }
class ReaderDatabase extends Dexie {
  books!: Table<BookRecord,string>;
  bookFiles!: Table<BookFile,string>;
  readingProgress!: Table<ReadingProgress,string>;
  bookmarks!: Table<Bookmark,string>;
  annotations!: Table<Annotation,string>;
  preferences!: Table<Preferences,string>;
  readerIndexes!: Table<PageIndex,string>;
  pdfProgress!: Table<PdfProgress,string>;
  pdfBookmarks!: Table<PdfBookmark,string>;
  pdfAnnotations!: Table<PdfAnnotation,string>;
  pdfPreferences!: Table<PdfPreferences,string>;
  constructor() {
    super('yueye-reader');
    this.version(1).stores({
      books:'id,&fileHash,lastReadAt,importedAt,title',
      bookFiles:'bookId', readingProgress:'bookId',
      bookmarks:'id,bookId,[bookId+cfi]', annotations:'id,bookId,updatedAt',
      preferences:'id', readerIndexes:'id,bookId,&[bookId+signature]',
    });
    this.version(2).stores({
      books:'id,&fileHash,lastReadAt,importedAt,title,format',
      pdfProgress:'bookId', pdfBookmarks:'id,bookId,&[bookId+page]',
    }).upgrade(transaction=>transaction.table('books').toCollection().modify(book=>{book.format??='epub';}));
    this.version(3).stores({pdfAnnotations:'id,bookId,page,[bookId+page],updatedAt',pdfPreferences:'id'});
  }
}
export const db = new ReaderDatabase();

/** A readwrite transaction across every table waits for earlier writes to finish. */
export async function flushPendingWrites():Promise<void> {
  await db.transaction('rw',db.tables,async()=>{ await db.books.get(''); });
}

export async function listBooks():Promise<BookRecord[]> { return db.books.toArray(); }
export async function getBookFile(id:string):Promise<Blob> {
  const record = await db.bookFiles.get(id);
  if (!record) throw new Error('找不到原书文件，可能已被移除。请重新导入。');
  return record.blob;
}
export async function importBook(file:File, options:TaskOptions = {}):Promise<{book:BookRecord;duplicate:boolean}> {
  const format = /\.pdf$/i.test(file.name) ? 'pdf' : /\.epub$/i.test(file.name) ? 'epub' : undefined;
  if (!format) throw new Error('请选择 .epub 或 .pdf 格式的图书。');
  validateFileSize(file.size); checkCancelled(options.signal); options.onStage?.('读取文件与检查重复');
  const bytes = await readBlobBytes(file);
  checkCancelled(options.signal);
  const digest = await crypto.subtle.digest('SHA-256',bytes.buffer as ArrayBuffer);
  checkCancelled(options.signal);
  const fileHash = Array.from(new Uint8Array(digest), byte=>byte.toString(16).padStart(2,'0')).join('');
  const existing = await db.books.where('fileHash').equals(fileHash).first();
  if (existing) return {book:existing,duplicate:true};
  const parsed = format==='pdf'
    ? await (await import('./pdf/document')).openPdf(file,file.name,{...options,bytes,cover:true})
    : await parseEpub(file,file.name,{...options,bytes,lazy:true});
  const pdf = 'document' in parsed ? parsed : undefined;
  const now = Date.now();
  const book:BookRecord = {
    id:crypto.randomUUID(),fileHash,title:parsed.title,author:parsed.author,language:parsed.language,
    originalFileName:file.name,fileSize:file.size,format,epubVersion:'version' in parsed?parsed.version:'',pageCount:pdf?.document.numPages,
    importedAt:now,lastReadAt:0,progression:0,chapterTitle:'',isFinished:false,coverBlob:parsed.coverBlob,
  };
  try {
    checkCancelled(options.signal); options.onStage?.('正在完成保存（此阶段等待提交完成）');
    await db.transaction('rw',db.books,db.bookFiles,async()=>{
      await db.books.add(book);
      await db.bookFiles.add({bookId:book.id,blob:new Blob([file],{type:format==='pdf'?'application/pdf':'application/epub+zip'})});
    });
    return {book,duplicate:false};
  } catch (error) {
    // A simultaneous import can win the unique hash index while parsing finishes.
    if (error instanceof Error && /ConstraintError/.test(error.name)) {
      const duplicate = await db.books.where('fileHash').equals(fileHash).first();
      if (duplicate) return {book:duplicate,duplicate:true};
    }
    throw error;
  } finally { await parsed.dispose?.(); }
}
export async function removeBook(id:string) {
  await db.transaction('rw',[db.books,db.bookFiles,db.readingProgress,db.bookmarks,db.annotations,db.readerIndexes,db.pdfProgress,db.pdfBookmarks,db.pdfAnnotations],async()=>{
    await db.books.delete(id); await db.bookFiles.delete(id); await db.readingProgress.delete(id);
    await db.bookmarks.where('bookId').equals(id).delete();
    await db.annotations.where('bookId').equals(id).delete();
    await db.readerIndexes.where('bookId').equals(id).delete();
    await db.pdfProgress.delete(id); await db.pdfBookmarks.where('bookId').equals(id).delete();
    await db.pdfAnnotations.where('bookId').equals(id).delete();
  });
}
export function getPdfProgress(id:string) { return db.pdfProgress.get(id); }
export async function savePdfProgress(progress:PdfProgress) {
  await db.transaction('rw',db.books,db.pdfProgress,async()=>{
    if (!await db.books.get(progress.bookId)) throw new Error('图书已被移除，无法保存阅读位置。');
    const previous = await db.pdfProgress.get(progress.bookId);
    if (previous && previous.updatedAt > progress.updatedAt) return;
    const normalized = {...progress,progression:Math.min(1,Math.max(0,progress.progression))};
    await db.pdfProgress.put(normalized);
    await db.books.update(progress.bookId,{lastReadAt:progress.updatedAt,progression:normalized.progression,chapterTitle:progress.chapterTitle,isFinished:progress.isFinished});
  });
}
export async function listPdfBookmarks(bookId:string) { return (await db.pdfBookmarks.where('bookId').equals(bookId).toArray()).sort((a,b)=>a.page-b.page); }
export async function putPdfBookmark(mark:PdfBookmark) {
  await db.transaction('rw',db.books,db.pdfBookmarks,async()=>{
    if (!await db.books.get(mark.bookId)) throw new Error('图书已被移除，无法保存书签。');
    const existing = await db.pdfBookmarks.where('[bookId+page]').equals([mark.bookId,mark.page]).first();
    if (!existing) await db.pdfBookmarks.add(mark);
  });
}
export async function deletePdfBookmark(id:string) { await db.pdfBookmarks.delete(id); }
export async function getPdfPreferences(seed:Preferences=DEFAULT_PREFERENCES):Promise<PdfPreferences> {
  const saved=await db.pdfPreferences.get('global');
  return {...normalizePreferences(saved??seed),viewMode:saved?.viewMode==='text'?'text':'original'};
}
export async function savePdfPreferences(value:PdfPreferences) {
  await db.pdfPreferences.put({...normalizePreferences(value),viewMode:value.viewMode==='text'?'text':'original'});
}
export async function listPdfAnnotations(bookId:string) { return db.pdfAnnotations.where('bookId').equals(bookId).sortBy('createdAt'); }
export async function putPdfAnnotation(note:PdfAnnotation) {
  await db.transaction('rw',db.books,db.pdfAnnotations,async()=>{
    const book=await db.books.get(note.bookId);
    if(!book||book.format!=='pdf')throw new Error('PDF 图书已被移除，无法保存笔记。');
    if(!Number.isInteger(note.page)||note.page<1||book.pageCount&&note.page>book.pageCount)throw new Error('笔记页码超出 PDF 范围。');
    if(!['text','region'].includes(note.kind)||!Number.isInteger(note.start)||!Number.isInteger(note.end)||note.start<0||note.end<note.start||note.kind==='text'&&note.end===note.start)throw new Error('笔记选区无效，请重新选择。');
    if(!/^#[0-9a-f]{6}$/i.test(note.color)||note.note.length>20000||note.quote.length>100000)throw new Error('笔记内容或颜色无效。');
    if(!note.rects.length||note.rects.some(rect=>![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)||rect.x<0||rect.y<0||rect.width<=0||rect.height<=0||rect.x+rect.width>1.001||rect.y+rect.height>1.001))throw new Error('笔记区域无效，请重新选择。');
    await db.pdfAnnotations.put(note);
  });
}
export async function deletePdfAnnotation(id:string) { await db.pdfAnnotations.delete(id); }
export function getProgress(id:string) { return db.readingProgress.get(id); }
export async function saveProgress(progress:ReadingProgress) {
  await db.transaction('rw',db.books,db.readingProgress,async()=>{
    if (!await db.books.get(progress.bookId)) throw new Error('图书已被移除，无法保存阅读位置。');
    const previous = await db.readingProgress.get(progress.bookId);
    if (previous && previous.updatedAt > progress.updatedAt) return;
    const normalized = {...progress,progression:Math.min(1,Math.max(0,progress.progression))};
    await db.readingProgress.put(normalized);
    await db.books.update(progress.bookId,{
      lastReadAt:progress.updatedAt,progression:normalized.progression,
      chapterTitle:progress.chapterTitle,isFinished:progress.isFinished,
    });
  });
}
export async function getPreferences():Promise<Preferences> { return normalizePreferences(await db.preferences.get('global') ?? DEFAULT_PREFERENCES); }
export async function savePreferences(preferences:Preferences) { await db.preferences.put(normalizePreferences(preferences)); }
export async function listBookmarks(bookId:string) {
  const records = await db.bookmarks.where('bookId').equals(bookId).toArray();
  return records.sort((a,b)=>a.cfi.localeCompare(b.cfi,undefined,{numeric:true}));
}
export async function putBookmark(bookmark:Bookmark) {
  await db.transaction('rw',db.books,db.bookmarks,async()=>{
    if (!await db.books.get(bookmark.bookId)) throw new Error('图书已被移除，无法保存书签。');
    const duplicate = await db.bookmarks.where('[bookId+cfi]').equals([bookmark.bookId,bookmark.cfi]).first();
    if (duplicate && duplicate.id !== bookmark.id) return;
    await db.bookmarks.put(bookmark);
  });
}
export async function deleteBookmark(id:string) { await db.bookmarks.delete(id); }
export function listAnnotations(bookId:string) { return db.annotations.where('bookId').equals(bookId).reverse().sortBy('updatedAt'); }
export async function putAnnotation(annotation:Annotation) {
  await db.transaction('rw',db.books,db.annotations,async()=>{
    if (!await db.books.get(annotation.bookId)) throw new Error('图书已被移除，无法保存笔记。');
    await db.annotations.put(annotation);
  });
}
export async function deleteAnnotation(id:string) { await db.annotations.delete(id); }
export function getPageIndex(bookId:string,signature:string) { return db.readerIndexes.where('[bookId+signature]').equals([bookId,signature]).first(); }
export async function putPageIndex(index:PageIndex) {
  await db.transaction('rw',db.books,db.readerIndexes,async()=>{
    if (!await db.books.get(index.bookId)) return;
    const old = await db.readerIndexes.where('[bookId+signature]').equals([index.bookId,index.signature]).first();
    await db.readerIndexes.put({...index,id:old?.id ?? index.id});
    const rows = await db.readerIndexes.where('bookId').equals(index.bookId).primaryKeys();
    if (rows.length > 4) await db.readerIndexes.bulkDelete(rows.filter(id=>id!==(old?.id ?? index.id)).slice(0,rows.length-4));
  });
}

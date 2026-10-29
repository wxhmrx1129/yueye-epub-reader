import Dexie, { type Table } from 'dexie';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../preferences';
import type { Annotation, BookRecord, Bookmark, PageIndex, Preferences, ReadingProgress } from '../types';
import { EPUB_LIMITS, parseEpub, readBlobBytes } from './epub/import';

interface BookFile { bookId: string; blob: Blob }
class ReaderDatabase extends Dexie {
  books!: Table<BookRecord,string>;
  bookFiles!: Table<BookFile,string>;
  readingProgress!: Table<ReadingProgress,string>;
  bookmarks!: Table<Bookmark,string>;
  annotations!: Table<Annotation,string>;
  preferences!: Table<Preferences,string>;
  readerIndexes!: Table<PageIndex,string>;
  constructor() {
    super('yueye-reader');
    this.version(1).stores({
      books:'id,&fileHash,lastReadAt,importedAt,title',
      bookFiles:'bookId', readingProgress:'bookId',
      bookmarks:'id,bookId,[bookId+cfi]', annotations:'id,bookId,updatedAt',
      preferences:'id', readerIndexes:'id,bookId,&[bookId+signature]',
    });
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
export async function importBook(file:File):Promise<{book:BookRecord;duplicate:boolean}> {
  if (!/\.epub$/i.test(file.name)) throw new Error('请选择 .epub 格式的图书。');
  if (file.size > EPUB_LIMITS.archive) throw new Error('文件超过 50MiB 限制，请选择较小的 EPUB。');
  const bytes = await readBlobBytes(file);
  const digest = await crypto.subtle.digest('SHA-256',bytes.buffer as ArrayBuffer);
  const fileHash = Array.from(new Uint8Array(digest), byte=>byte.toString(16).padStart(2,'0')).join('');
  const existing = await db.books.where('fileHash').equals(fileHash).first();
  if (existing) return {book:existing,duplicate:true};
  const parsed = await parseEpub(file,file.name);
  const now = Date.now();
  const book:BookRecord = {
    id:crypto.randomUUID(),fileHash,title:parsed.title,author:parsed.author,language:parsed.language,
    originalFileName:file.name,fileSize:file.size,epubVersion:parsed.version,
    importedAt:now,lastReadAt:0,progression:0,chapterTitle:'',isFinished:false,coverBlob:parsed.coverBlob,
  };
  try {
    await db.transaction('rw',db.books,db.bookFiles,async()=>{
      await db.books.add(book);
      await db.bookFiles.add({bookId:book.id,blob:new Blob([bytes.buffer as ArrayBuffer],{type:'application/epub+zip'})});
    });
    return {book,duplicate:false};
  } catch (error) {
    // A simultaneous import can win the unique hash index while parsing finishes.
    if (error instanceof Error && /ConstraintError/.test(error.name)) {
      const duplicate = await db.books.where('fileHash').equals(fileHash).first();
      if (duplicate) return {book:duplicate,duplicate:true};
    }
    throw error;
  }
}
export async function removeBook(id:string) {
  await db.transaction('rw',[db.books,db.bookFiles,db.readingProgress,db.bookmarks,db.annotations,db.readerIndexes],async()=>{
    await db.books.delete(id); await db.bookFiles.delete(id); await db.readingProgress.delete(id);
    await db.bookmarks.where('bookId').equals(id).delete();
    await db.annotations.where('bookId').equals(id).delete();
    await db.readerIndexes.where('bookId').equals(id).delete();
  });
}
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

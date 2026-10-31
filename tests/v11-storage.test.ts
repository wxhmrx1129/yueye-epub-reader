import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getBookFile, getPdfProgress, getProgress, importBook, listAnnotations, listBooks, listBookmarks, listPdfBookmarks, putPdfBookmark, removeBook, savePdfProgress } from '../src/services/storage';
import { FILE_LIMIT, checkCancelled, safeHttpUrl, validateFileSize } from '../src/services/tasks';
import { EPUB_LIMITS, parseEpub } from '../src/services/epub/import';
import type { BookRecord, PdfProgress, PdfAnnotation } from '../src/types';
import { deletePdfAnnotation, getPdfPreferences, getPreferences, listPdfAnnotations, putPdfAnnotation, savePdfPreferences, savePreferences } from '../src/services/storage';
import { DEFAULT_PREFERENCES } from '../src/preferences';
import { validateImagePixels } from '../src/services/epub/image-limits';

beforeAll(()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('Blob',NodeBlob);vi.stubGlobal('File',NodeFile);});
beforeEach(async()=>{await db.delete();await db.open();});
afterAll(async()=>{await db.delete();vi.unstubAllGlobals();});
const bytes=readFileSync('tests/fixtures/epub3.epub');
const file=()=>new NodeFile([bytes],'test.epub',{type:'application/epub+zip'}) as unknown as File;

describe('V1.1 limits and cancellation',()=>{
  it('accepts exact 150MiB, rejects +1 before reading, and rejects empty files',async()=>{
    expect(EPUB_LIMITS.archive).toBe(157286400);expect(FILE_LIMIT).toBe(EPUB_LIMITS.archive);
    expect(()=>validateFileSize(FILE_LIMIT)).not.toThrow();expect(()=>validateFileSize(0)).toThrow('为空');
    const read=vi.fn();
    await expect(importBook({name:'large.epub',size:FILE_LIMIT+1,arrayBuffer:read} as unknown as File)).rejects.toThrow('150MiB');
    await expect(importBook({name:'large.pdf',size:FILE_LIMIT+1,arrayBuffer:read} as unknown as File)).rejects.toThrow('150MiB');
    expect(read).not.toHaveBeenCalled();expect(await listBooks()).toHaveLength(0);
  });
  it('aborts before import/parse without leaving records',async()=>{
    const controller=new AbortController();controller.abort();
    expect(()=>checkCancelled(controller.signal)).toThrow('取消');
    await expect(importBook(file(),{signal:controller.signal})).rejects.toHaveProperty('name','AbortError');
    await expect(parseEpub(file(),'test.epub',{signal:controller.signal,lazy:true})).rejects.toHaveProperty('name','AbortError');
    expect(await listBooks()).toHaveLength(0);
  });
  it('aborts parsing safely, but finishes an already-started atomic commit',async()=>{
    const early=new AbortController();
    await expect(importBook(file(),{signal:early.signal,onStage:stage=>{if(stage==='解析首章')early.abort();}})).rejects.toHaveProperty('name','AbortError');
    expect(await listBooks()).toHaveLength(0);
    const late=new AbortController();
    const result=await importBook(file(),{signal:late.signal,onStage:stage=>{if(stage.startsWith('正在完成保存'))late.abort();}});
    expect(late.signal.aborted).toBe(true);expect(result.duplicate).toBe(false);expect((await getBookFile(result.book.id)).size).toBe(bytes.length);
  });
  it('ignores unsafe or credentialed document links',()=>{
    expect(safeHttpUrl('https://example.com/book')).toBe('https://example.com/book');
    for(const value of ['file:///C:/test','javascript:alert(1)','https://user:pass@example.com','data:text/html,test','bad'])expect(safeHttpUrl(value)).toBeUndefined();
  });
  it('rejects giant raster dimensions before image decoding',()=>{
    const png=new Uint8Array(24),view=new DataView(png.buffer);view.setUint32(0,0x89504e47);view.setUint32(16,50000);view.setUint32(20,50000);
    expect(()=>validateImagePixels(png,'image/png')).toThrow('32 兆像素');view.setUint32(16,2048);view.setUint32(20,1536);expect(()=>validateImagePixels(png,'image/png')).not.toThrow();
  });
});

describe('V1.0 migration and PDF data isolation',()=>{
  it('upgrades v2 and keeps existing EPUB and PDF records and bookmarks unchanged',async()=>{
    await db.delete();const previous=new Dexie('yueye-reader');
    previous.version(2).stores({books:'id,&fileHash,lastReadAt,importedAt,title,format',bookFiles:'bookId',readingProgress:'bookId',bookmarks:'id,bookId,[bookId+cfi]',annotations:'id,bookId,updatedAt',preferences:'id',readerIndexes:'id,bookId,&[bookId+signature]',pdfProgress:'bookId',pdfBookmarks:'id,bookId,&[bookId+page]'});
    await previous.open();
    const epub={id:'old-epub',format:'epub',fileHash:'old-epub-hash'},pdf={id:'old-pdf',format:'pdf',fileHash:'old-pdf-hash'};
    const progress={bookId:'old-pdf',page:3,offsetY:.6,zoom:1.5},bookmark={id:'saved-page',bookId:'old-pdf',page:3};
    await previous.table('books').bulkAdd([epub,pdf]);await previous.table('pdfProgress').add(progress);await previous.table('pdfBookmarks').add(bookmark);
    await previous.table('annotations').add({id:'old-note',bookId:'old-epub',note:'kept'});await previous.table('preferences').add({...DEFAULT_PREFERENCES,fontSize:28});previous.close();
    await db.open();expect(await db.books.get(epub.id)).toEqual(epub);expect(await db.books.get(pdf.id)).toEqual(pdf);
    expect(await getPdfProgress(pdf.id)).toEqual(progress);expect(await listPdfBookmarks(pdf.id)).toEqual([bookmark]);
    expect((await listAnnotations(epub.id))[0].note).toBe('kept');expect((await getPreferences()).fontSize).toBe(28);expect(await listPdfAnnotations(pdf.id)).toEqual([]);
  });
  it('stores PDF preferences separately from EPUB and normalizes only PDF settings',async()=>{
    const epub={...DEFAULT_PREFERENCES,fontSize:28,theme:'sand' as const};await savePreferences(epub);
    const seed=await getPdfPreferences(epub);expect(seed).toMatchObject({...epub,viewMode:'original'});
    await savePdfPreferences({...seed,fontSize:40,theme:'night',readingMode:'scrolled',viewMode:'text'});
    expect(await getPreferences()).toEqual(epub);expect(await getPdfPreferences()).toMatchObject({fontSize:40,theme:'night',readingMode:'scrolled',viewMode:'text'});
    await savePdfPreferences({...seed,fontSize:200,contentWidth:10});expect(await getPdfPreferences()).toMatchObject({fontSize:40,contentWidth:480});
    expect(await getPreferences()).toEqual(epub);
  });
  it('persists, edits and deletes text and region notes and removes only their book data',async()=>{
    const book={id:'pdf',format:'pdf',pageCount:3,fileHash:'annotation-test'} as BookRecord;await db.books.add(book);
    const note:PdfAnnotation={id:'text',bookId:book.id,page:2,kind:'text',start:0,end:5,quote:'hello',prefix:'',suffix:' world',rects:[{x:.1,y:.2,width:.3,height:.04}],note:'thought',color:'#e8c96d',createdAt:1,updatedAt:1};
    await putPdfAnnotation(note);await putPdfAnnotation({...note,note:'edited',color:'#a9cba0',updatedAt:2});
    const region:PdfAnnotation={...note,id:'region',kind:'region',start:0,end:0,quote:'第 2 页的框选区域'};await putPdfAnnotation(region);
    expect(await listPdfAnnotations(book.id)).toHaveLength(2);expect((await db.pdfAnnotations.get(note.id))?.note).toBe('edited');
    for(const invalid of [{...note,page:4},{...note,start:-1},{...note,color:'bad'},{...note,note:'a'.repeat(20001)},{...note,rects:[{x:.9,y:0,width:.2,height:.1}]}])await expect(putPdfAnnotation(invalid)).rejects.toThrow();
    await deletePdfAnnotation(note.id);expect(await listPdfAnnotations(book.id)).toEqual([region]);await putPdfAnnotation(note);
    await db.annotations.put({id:'epub-note',bookId:'epub',note:'kept'} as never);await removeBook(book.id);
    expect(await listPdfAnnotations(book.id)).toEqual([]);expect((await listAnnotations('epub'))[0].note).toBe('kept');await expect(putPdfAnnotation(note)).rejects.toThrow('已被移除');
  });
  it('upgrades schema v1 without changing old files, CFI, notes or settings',async()=>{
    await db.delete();
    const legacy=new Dexie('yueye-reader');
    legacy.version(1).stores({books:'id,&fileHash,lastReadAt,importedAt,title',bookFiles:'bookId',readingProgress:'bookId',bookmarks:'id,bookId,[bookId+cfi]',annotations:'id,bookId,updatedAt',preferences:'id',readerIndexes:'id,bookId,&[bookId+signature]'});
    await legacy.open();
    const old={id:'old',fileHash:'original-hash',title:'Old book',author:'Author',language:'zh-CN',originalFileName:'old.epub',fileSize:bytes.length,epubVersion:'3.0',importedAt:1,lastReadAt:2,progression:.4,chapterTitle:'Chapter',isFinished:false};
    await legacy.table('books').add(old);await legacy.table('bookFiles').add({bookId:'old',blob:file()});
    await legacy.table('readingProgress').add({bookId:'old',cfi:'epubcfi(/6/2!/4/2:1)',progression:.4});
    await legacy.table('bookmarks').add({id:'mark',bookId:'old',cfi:'epubcfi(/6/2!/4/2:1)'});
    await legacy.table('annotations').add({id:'note',bookId:'old',note:'Private note',updatedAt:1});
    await legacy.table('preferences').add({id:'global',fontSize:28});legacy.close();
    await db.open();expect((await listBooks())[0]).toEqual({...old,format:'epub'});
    expect((await getBookFile('old')).size).toBe(bytes.length);expect((await getProgress('old'))?.cfi).toBe('epubcfi(/6/2!/4/2:1)');
    expect(await listBookmarks('old')).toHaveLength(1);expect((await listAnnotations('old'))[0].note).toBe('Private note');
    expect((await db.preferences.get('global'))?.fontSize).toBe(28);expect(await getPdfProgress('old')).toBeUndefined();
  });
  it('persists independent PDF locations, deduplicates page bookmarks, and removes atomically',async()=>{
    const book:BookRecord={id:'pdf',format:'pdf',pageCount:1000,fileHash:'pdf-hash',title:'PDF',author:'Author',language:'und',originalFileName:'test.pdf',fileSize:123,epubVersion:'',importedAt:1,lastReadAt:0,progression:0,chapterTitle:'',isFinished:false};
    await db.books.add(book);await db.bookFiles.add({bookId:book.id,blob:new Blob(['PDF'])});
    const progress:PdfProgress={format:'pdf',bookId:book.id,page:500,totalPages:1000,offsetX:.2,offsetY:.7,zoom:1.5,zoomMode:'custom',progression:.499,chapterTitle:'第 500 页',isFinished:false,updatedAt:10};
    await savePdfProgress(progress);await savePdfProgress({...progress,page:1,updatedAt:9});
    expect(await getPdfProgress(book.id)).toEqual(progress);expect(await getProgress(book.id)).toBeUndefined();
    const mark={id:'page500',bookId:book.id,page:500,createdAt:1};await putPdfBookmark(mark);await putPdfBookmark({...mark,id:'duplicate'});
    expect(await listPdfBookmarks(book.id)).toEqual([mark]);await removeBook(book.id);
    expect(await getPdfProgress(book.id)).toBeUndefined();expect(await listPdfBookmarks(book.id)).toEqual([]);await expect(getBookFile(book.id)).rejects.toThrow('找不到');
    await expect(savePdfProgress(progress)).rejects.toThrow('已被移除');
  });
});

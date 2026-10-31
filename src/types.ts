export type ThemeId = 'paper' | 'sand' | 'sage' | 'graphite' | 'night' | 'custom';
export interface Preferences {
  id: 'global'; theme: ThemeId; customBackground: string; customText: string;
  fontSize: number; contentWidth: number; fontFamily: 'serif' | 'sans' | 'original';
  lineHeight: number; readingMode: 'paginated' | 'scrolled'; sidebarOpen: boolean;
}
export interface BookRecord {
  format?: 'epub' | 'pdf'; pageCount?: number;
  id: string; fileHash: string; title: string; author: string; language: string;
  originalFileName: string; fileSize: number; epubVersion: string;
  importedAt: number; lastReadAt: number; progression: number;
  chapterTitle: string; isFinished: boolean; coverBlob?: Blob;
}
export interface TocItem { id: string; label: string; href: string; children: TocItem[] }
export interface Chapter { id: string; href: string; title: string; cfiBase: string; html: string }
export interface ParsedBook {
  loadChapter?: (index: number) => Promise<Chapter>;
  releaseChapter?: (index: number) => void;
  dispose?: () => void;
  title: string; author: string; language: string; version: string;
  chapters: Chapter[]; toc: TocItem[]; coverBlob?: Blob;
}
export interface ReadingProgress {
  bookId: string; cfi: string; href: string; spineIndex: number; progression: number;
  quoteContext: string; chapterTitle: string; isFinished: boolean; updatedAt: number;
}
export interface ReaderPosition extends Omit<ReadingProgress, 'bookId' | 'updatedAt'> {
  page: number; totalPages: number;
}
export interface Bookmark {
  id: string; bookId: string; cfi: string; href: string; chapterTitle: string;
  excerpt: string; createdAt: number;
}
export interface Annotation {
  id: string; bookId: string; rangeCfi: string; href: string; chapterTitle: string;
  quote: string; prefix: string; suffix: string; note: string; color: string;
  createdAt: number; updatedAt: number;
}
export interface TextSelection {
  rangeCfi: string; href: string; chapterTitle: string; quote: string;
  prefix: string; suffix: string; x: number; y: number;
}
export interface PageEntry { chapter: number; localPage: number; cfi: string }
export interface PageIndex { id: string; bookId: string; signature: string; pages: PageEntry[] }
export interface PdfProgress {
  format: 'pdf'; bookId: string; page: number; totalPages: number;
  offsetX: number; offsetY: number; zoom: number; zoomMode: 'page' | 'width' | 'custom';
  progression: number; chapterTitle: string; isFinished: boolean; updatedAt: number;
}
export interface PdfBookmark { id: string; bookId: string; page: number; createdAt: number }
export interface PdfRect { x:number; y:number; width:number; height:number }
export interface PdfAnnotation {
  id:string; bookId:string; page:number; kind:'text'|'region';
  start:number; end:number; quote:string; prefix:string; suffix:string;
  rects:PdfRect[]; note:string; color:string; createdAt:number; updatedAt:number;
}
export interface PdfSelection extends Pick<PdfAnnotation,'page'|'kind'|'start'|'end'|'quote'|'prefix'|'suffix'|'rects'> { x:number; y:number }
export interface PdfPreferences extends Preferences { viewMode:'original'|'text' }

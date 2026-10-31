import EpubCFI from 'epubjs/lib/epubcfi';
import { themeFor } from '../../preferences';
import type { Annotation, Chapter, PageEntry, ParsedBook, Preferences, ReaderPosition, ReadingProgress, TextSelection } from '../../types';

interface ReaderEvents {
  position: (position: ReaderPosition) => void;
  index: (pages: PageEntry[] | null, completed: number, total: number) => void;
  selection: (selection: TextSelection | null) => void;
  annotation: (ids: string[]) => void;
  error: (message: string) => void;
  loadIndex?: (signature: string) => Promise<PageEntry[] | undefined>;
  saveIndex?: (signature: string, pages: PageEntry[]) => Promise<void>;
}
type FrameWindow = Window & { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: Map<string, unknown> } };

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function textNodes(doc: Document): Text[] {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (text.data.trim() && !text.parentElement?.closest('style,script,noscript,svg')) nodes.push(text);
  }
  return nodes;
}
function characterRect(node: Text, offset: number) {
  const range = node.ownerDocument.createRange();
  range.setStart(node, Math.min(offset, Math.max(0, node.length - 1)));
  range.setEnd(node, Math.min(node.length, offset + 1));
  return range.getBoundingClientRect();
}
function rangeRect(range: Range) {
  const copy = range.cloneRange();
  if (copy.collapsed && copy.startContainer.nodeType === Node.TEXT_NODE) {
    const node = copy.startContainer as Text;
    if (copy.startOffset < node.length) copy.setEnd(node, copy.startOffset + 1);
    else if (node.length) copy.setStart(node, node.length - 1);
  } else if (copy.collapsed && copy.startContainer.nodeType === Node.ELEMENT_NODE) {
    const element = copy.startContainer as Element;
    if (element.matches('img,svg')) return element.getBoundingClientRect();
    const child = element.childNodes[copy.startOffset];
    if (child) copy.selectNode(child);
    else return element.getBoundingClientRect();
  }
  return copy.getClientRects()[0] ?? copy.getBoundingClientRect();
}
function pointRange(doc: Document, coordinate: number, axis: 'x' | 'y'): Range {
  const win = doc.defaultView!;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let current: Node | null, fallback: Range | undefined;
  while ((current = walker.nextNode())) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as Element;
      if (!element.matches('img,svg') || element.parentElement?.closest('svg')) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const range = doc.createRange(); range.setStartBefore(element); range.collapse(true);
      fallback = range;
      const end = axis === 'x' ? rect.right + win.scrollX : rect.bottom + win.scrollY;
      if (end >= coordinate + 1) return range;
      continue;
    }
    const node = current as Text;
    if (!node.data.trim() || node.parentElement?.closest('style,script,noscript,svg')) continue;
    const last = characterRect(node, node.length - 1);
    if (!last.width && !last.height) continue;
    fallback = doc.createRange(); fallback.setStart(node, Math.max(0, node.length - 1)); fallback.collapse(true);
    const end = axis === 'x' ? last.right + win.scrollX : last.bottom + win.scrollY;
    if (end < coordinate + 1) continue;
    let low = 0, high = node.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const rect = characterRect(node, mid);
      const far = axis === 'x' ? rect.right + win.scrollX : rect.bottom + win.scrollY;
      if (far < coordinate + 1) low = mid + 1;
      else high = mid;
    }
    const range = doc.createRange();
    range.setStart(node, low); range.collapse(true);
    return range;
  }
  const range = doc.createRange();
  if (fallback) return fallback;
  range.selectNodeContents(doc.body);
  range.collapse(true);
  return range;
}
function textOffset(doc: Document, range: Range): number {
  let count = 0;
  for (const node of textNodes(doc)) {
    if (node === range.startContainer) return count + range.startOffset;
    if (range.comparePoint(node, 0) >= 0) return count;
    count += node.length;
  }
  return 0;
}
function atOffset(doc: Document, offset: number): Range {
  const nodes = textNodes(doc);
  let remaining = Math.max(0, offset);
  for (const node of nodes) {
    if (remaining < node.length) {
      const range = doc.createRange(); range.setStart(node, remaining); range.collapse(true); return range;
    }
    remaining -= node.length;
  }
  const range = doc.createRange(), last = nodes.at(-1);
  if (last) range.setStart(last, Math.max(0, last.length - 1));
  else range.selectNodeContents(doc.body);
  range.collapse(true); return range;
}
function cfiFor(range: Range, chapter: Chapter) {
  // epub.js encodes Range offsets as text offsets, so element anchors use its Node constructor.
  const anchor = range.collapsed && range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer.childNodes[range.startOffset] ?? range.startContainer : range;
  return new EpubCFI(anchor, chapter.cfiBase).toString();
}

/** Owns isolated chapter documents. Page maps are measured CSS columns, never text-location counts. */
export class ReaderAdapter {
  private frame: HTMLIFrameElement;
  private measure: HTMLIFrameElement;
  private preferences: Preferences;
  private chapter = 0;
  private localPage = 0;
  private width = 0;
  private height = 0;
  private revision = 0;
  private destroyed = false;
  private pages: PageEntry[] = [];
  private annotations: Annotation[] = [];
  private observer: ResizeObserver;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private lengths: number[];
  private positionValue?: ReaderPosition;
  private lastSelection: TextSelection | null = null;
  private renderingChapter = -1;
  private measuringChapter = -1;
  private indexWork = Promise.resolve();
  private pendingLoads = new Set<()=>void>();
  private scrollHandler?: () => void;

  constructor(private host: HTMLElement, private book: ParsedBook, preferences: Preferences, private events: ReaderEvents) {
    this.preferences = preferences;
    this.frame = this.makeFrame('书籍正文');
    this.measure = this.makeFrame('分页测量');
    this.measure.setAttribute('aria-hidden', 'true'); this.measure.tabIndex = -1;
    this.measure.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;border:0;';
    host.append(this.frame, this.measure);
    this.lengths = book.chapters.map(ch => {
      if (book.releaseChapter) return 1;
      const doc = new DOMParser().parseFromString(ch.html, 'text/html');
      return Math.max(1, textNodes(doc).reduce((n, t) => n + t.length, 0));
    });
    this.observer = new ResizeObserver(() => {
      const rect = this.host.getBoundingClientRect();
      if (Math.round(rect.width) !== this.width || Math.round(rect.height) !== this.height) this.scheduleLayout();
    });
    this.observer.observe(host);
  }
  get position() { return this.positionValue; }
  get selection() { return this.lastSelection; }
  private makeFrame(title: string) {
    const frame = document.createElement('iframe');
    frame.title = title; frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer'); frame.className = 'book-frame';
    return frame;
  }
  async open(initial?: ReadingProgress) {
    this.dimensions();
    const target = initial?.cfi || initial?.href;
    try { await this.navigate(target, initial?.quoteContext); }
    catch {
      const chapter = this.book.chapters.findIndex(c => c.href === initial?.href);
      await this.renderChapter(Math.max(0, chapter));
      this.events.error('已恢复到原章节开头，原阅读位置暂时无法精确定位。');
    }
    void this.buildIndex();
  }
  private dimensions() {
    const rect = this.host.getBoundingClientRect();
    this.width = Math.max(220, Math.round(rect.width)); this.height = Math.max(180, Math.round(rect.height));
    this.measure.style.width = `${this.width}px`; this.measure.style.height = `${this.height}px`;
  }
  private html(chapter: Chapter, forcePaginated = false) {
    const doc = new DOMParser().parseFromString(chapter.html, 'text/html');
    const theme = themeFor(this.preferences), p = this.preferences;
    const paginated = forcePaginated || p.readingMode === 'paginated';
    const inset = this.width < 600 ? 24 : 48;
    const family = p.fontFamily === 'serif' ? '"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif' : '"Segoe UI","Microsoft YaHei",sans-serif';
    const style = doc.createElement('style'); style.dataset.reader = 'layout';
    style.textContent = `
      :root{color-scheme:${['night','graphite'].includes(p.theme)?'dark':'light'};scroll-behavior:auto!important}
      html{margin:0!important;padding:0!important;width:${this.width}px!important;height:${this.height}px!important;background:${theme.background}!important;overflow-x:hidden!important;overflow-y:${paginated?'hidden':'auto'}!important}
      body{box-sizing:border-box!important;margin:28px ${inset}px!important;padding:0!important;border:0!important;width:${this.width-inset*2}px!important;max-width:none!important;min-width:0!important;background:transparent!important;color:${theme.text}!important;font-size:${p.fontSize}px!important;line-height:${p.lineHeight}!important;${p.fontFamily==='original'?'':`font-family:${family}!important;`}
      ${paginated?`height:${this.height-56}px!important;min-height:0!important;column-width:${this.width-inset*2}px!important;column-gap:${inset*2}px!important;column-fill:auto!important;`:'height:auto!important;columns:auto!important;'}
      }
      body *{max-width:100%!important;box-sizing:border-box;${p.fontFamily==='original'?'':`font-family:inherit!important;`}color:inherit!important;background-color:transparent!important;}
      p,li,blockquote,dd,dt{font-size:1em!important;line-height:${p.lineHeight}!important;orphans:2;widows:2}
      p{margin-block:0 1em}h1{font-size:1.65em!important}h2{font-size:1.4em!important}h3{font-size:1.2em!important}
      h1,h2,h3,h4{line-height:1.45!important;break-after:avoid}img,svg{max-height:${this.height-100}px!important;object-fit:contain;break-inside:avoid}img{height:auto}
      pre{white-space:pre-wrap!important;overflow-wrap:anywhere}table{max-width:100%;font-size:.85em;overflow-wrap:anywhere}a{color:${theme.text}!important;text-decoration:underline;text-underline-offset:3px}
      ::selection{background:#b4ca8a88}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:${theme.border};border-radius:8px}
    `;
    doc.head.append(style);
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }
  private load(frame: HTMLIFrameElement, html: string): Promise<Document> {
    return new Promise((resolve, reject) => {
      let settled=false,resourceTimer:ReturnType<typeof setTimeout>|undefined;
      let stopWait!:()=>void;const stopped=new Promise<void>(done=>{stopWait=done;});
      const finish=(error?:Error,doc?:Document)=>{
        if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(resourceTimer);stopWait();
        frame.removeEventListener('load',loaded);this.pendingLoads.delete(cancel);
        if(error)reject(error);else resolve(doc!);
      };
      const cancel=()=>finish(new Error('阅读已关闭'));
      const timeout = setTimeout(() => finish(new Error('正文加载超时，请重试。')), 12000);
      const loaded = async () => {
        if (this.destroyed) { cancel(); return; }
        const doc = frame.contentDocument;
        if (!doc?.body) { finish(new Error('无法加载书籍正文。')); return; }
        await Promise.race([Promise.all([
          doc.fonts?.ready,
          ...Array.from(doc.images).filter(img=>!img.complete).map(img=>new Promise<void>(r=>{img.onload=()=>r();img.onerror=()=>r();})),
        ]),new Promise(r=>{resourceTimer=setTimeout(r,2500);}),stopped]);
        if(settled)return;
        await pause(); finish(undefined,doc);
      };
      this.pendingLoads.add(cancel);
      frame.addEventListener('load', loaded, {once:true}); frame.srcdoc = html;
    });
  }
  private enqueue(action: () => Promise<void>) {
    const result = this.pending.then(() => { if (!this.destroyed) return action(); });
    this.pending = result.catch(error => { if(!this.destroyed) this.events.error(error instanceof Error?error.message:'阅读操作失败，请重试。'); });
    return result;
  }
  async goTo(target: string, quote?: string) { return this.enqueue(() => this.navigate(target, quote)); }
  private chapterForCfi(target: string) {
    const index = this.book.chapters.findIndex(ch => target.startsWith(`epubcfi(${ch.cfiBase}!`));
    if (index < 0) throw new Error('暂时无法定位到原文，记录已保留。');
    return index;
  }
  private async navigate(target?: string, quote?: string) {
    if (!target) { await this.renderChapter(0); return; }
    if (target.startsWith('epubcfi(')) {
      const index = this.chapterForCfi(target);
      if(index!==this.chapter || !this.frame.contentDocument?.body?.textContent) await this.renderChapter(index, target, quote);
      else { this.locate(this.frame.contentDocument, target, quote); this.emitPosition(); }
      return;
    }
    const [href, hash] = target.split('#');
    const index = href ? this.book.chapters.findIndex(ch=>ch.href===href) : this.chapter;
    if(index < 0) throw new Error('目录指向的章节不存在。');
    if(index!==this.chapter || !this.frame.contentDocument?.body?.textContent) await this.renderChapter(index);
    const doc = this.frame.contentDocument!;
    if(hash) {
      let id = hash; try{id=decodeURIComponent(hash);}catch{/* keep literal fragment */}
      const element = doc.getElementById(id) || doc.getElementsByName(id)[0];
      if(!element)throw new Error('书内目标位置不存在。');
      const range=doc.createRange();range.selectNodeContents(element); this.showRange(range);
    } else this.scroll(0);
    this.emitPosition();
  }
  private async renderChapter(index: number, cfi?: string, quote?: string, last = false) {
    this.renderingChapter=index;
    try {
    await this.book.loadChapter?.(index);
    if (this.destroyed) return;
    const previous = this.chapter;
    const doc = await this.load(this.frame, this.html(this.book.chapters[index]));
    if (this.destroyed) return;
    this.chapter=index; this.localPage=0;
    if (previous !== index && previous !== this.measuringChapter) this.book.releaseChapter?.(previous);
    this.bind(doc); this.paintAnnotations();
    if(cfi) this.locate(doc,cfi,quote);
    else if(last) this.scroll(this.preferences.readingMode==='paginated'?this.pageCount(doc)-1:doc.documentElement.scrollHeight);
    else this.scroll(0);
    this.emitPosition();
    } finally {this.renderingChapter=-1;this.releaseIdleChapters();}
  }
  private releaseIdleChapters() {
    if(!this.book.releaseChapter)return;
    this.book.chapters.forEach((chapter,index)=>{if(chapter.html&&index!==this.chapter&&index!==this.renderingChapter&&index!==this.measuringChapter)this.book.releaseChapter!(index);});
  }
  private locate(doc: Document, target: string, quote?: string) {
    let range:Range|undefined;
    try { range=new EpubCFI(target).toRange(doc); if(!range?.startContainer.isConnected)range=undefined; } catch { /* recover by unique text */ }
    if(!range && quote) {
      const nodes=textNodes(doc),text=nodes.map(n=>n.data).join('');
      const offset=text.indexOf(quote);
      if(offset>=0 && text.indexOf(quote,offset+1)<0)range=atOffset(doc,offset);
    }
    if(!range)throw new Error('暂时无法定位到原文，记录与摘录已保留。');
    this.showRange(range);
  }
  private showRange(range: Range) {
    const rect=rangeRect(range),win=this.frame.contentWindow!;
    if(this.preferences.readingMode==='paginated')this.scroll(Math.max(0,Math.floor((rect.left+win.scrollX)/this.width)));
    else win.scrollTo(0,Math.max(0,rect.top+win.scrollY-28));
  }
  private scroll(value:number) {
    const win=this.frame.contentWindow!;
    if(this.preferences.readingMode==='paginated') {this.localPage=Math.max(0,value);win.scrollTo(this.localPage*this.width,0);}
    else win.scrollTo(0,value);
  }
  private pageCount(doc:Document) { return Math.max(1,Math.ceil((doc.documentElement.scrollWidth-2)/this.width)); }
  async next() { return this.enqueue(async()=>{
    const doc=this.frame.contentDocument; if(!doc)return;
    if(this.preferences.readingMode==='paginated'&&this.localPage<this.pageCount(doc)-1){this.scroll(this.localPage+1);this.emitPosition();}
    else if(this.chapter<this.book.chapters.length-1)await this.renderChapter(this.chapter+1);
  }); }
  async previous() { return this.enqueue(async()=>{
    if(this.preferences.readingMode==='paginated'&&this.localPage>0){this.scroll(this.localPage-1);this.emitPosition();}
    else if(this.chapter>0)await this.renderChapter(this.chapter-1,undefined,undefined,true);
  }); }
  async goToPage(page:number) {
    if(!Number.isInteger(page)||page<1||page>this.pages.length)throw new Error(`请输入 1–${this.pages.length} 之间的整数页码。`);
    const entry=this.pages[page-1];
    return this.enqueue(async()=>{
      if(entry.chapter!==this.chapter)await this.renderChapter(entry.chapter);
      this.scroll(entry.localPage);this.emitPosition();
    });
  }
  async goToProgress(progression:number) { return this.enqueue(async()=>{
    if (this.book.releaseChapter) {
      const target = Math.min(this.book.chapters.length - .00001,Math.max(0,progression * this.book.chapters.length));
      const index = Math.floor(target);
      if (index !== this.chapter) await this.renderChapter(index);
      const doc = this.frame.contentDocument!;
      const length = textNodes(doc).reduce((sum,node)=>sum+node.length,0);
      this.showRange(atOffset(doc,Math.floor((target-index)*length))); this.emitPosition(); return;
    }
    const total=this.lengths.reduce((a,b)=>a+b,0),target=Math.min(total-1,Math.max(0,Math.round(total*progression)));
    let offset=target,index=0;while(index<this.lengths.length-1&&offset>=this.lengths[index])offset-=this.lengths[index++];
    if(index!==this.chapter)await this.renderChapter(index);
    this.showRange(atOffset(this.frame.contentDocument!,offset));this.emitPosition();
  }); }
  setPreferences(preferences:Preferences) {
    const old=this.preferences;this.preferences=preferences;
    const layoutChanged=['fontSize','contentWidth','fontFamily','lineHeight','readingMode'].some(key=>old[key as keyof Preferences]!==preferences[key as keyof Preferences]);
    if(layoutChanged)this.scheduleLayout();
    else {
      const doc=this.frame.contentDocument;if(doc){
        const fresh=new DOMParser().parseFromString(this.html(this.book.chapters[this.chapter]),'text/html');
        const style=doc.querySelector('style[data-reader="layout"]');if(style)style.textContent=fresh.querySelector('style[data-reader="layout"]')?.textContent??'';
      }
    }
  }
  private scheduleLayout() {
    clearTimeout(this.resizeTimer);this.revision++;this.pages=[];this.events.index(null,0,this.book.chapters.length);
    this.resizeTimer=setTimeout(()=>{
      const target=this.positionValue?.cfi;
      this.dimensions();
      void this.enqueue(async()=>{await this.renderChapter(this.chapter,target);void this.buildIndex();});
    },180);
  }
  private async buildIndex() {
    const revision=++this.revision;
    const previous=this.indexWork;let finish!:()=>void;
    this.indexWork=new Promise<void>(resolve=>{finish=resolve;});
    await previous;
    try {
    if(this.destroyed||revision!==this.revision)return;
    if(this.preferences.readingMode==='scrolled'){this.pages=[];this.events.index(null,0,0);return;}
    const signature=JSON.stringify(['columns-v2',this.width,this.height,this.preferences.fontSize,this.preferences.fontFamily,this.preferences.lineHeight,navigator.userAgent]);
    const cache=await this.events.loadIndex?.(signature).catch(()=>undefined);
    if(this.destroyed||revision!==this.revision)return;
    if(cache?.length){this.pages=cache;this.events.index(cache,this.book.chapters.length,this.book.chapters.length);this.emitPosition();return;}
    const pages:PageEntry[]=[];
    try {
      for(let chapter=0;chapter<this.book.chapters.length;chapter++){
        if(this.destroyed||revision!==this.revision)return;
        this.measuringChapter=chapter;
        await this.book.loadChapter?.(chapter);
        if(this.destroyed||revision!==this.revision)return;
        const doc=await this.load(this.measure,this.html(this.book.chapters[chapter],true));
        if(this.destroyed||revision!==this.revision)return;
        const count=this.pageCount(doc);
        for(let localPage=0;localPage<count;localPage++){
          pages.push({chapter,localPage,cfi:cfiFor(pointRange(doc,localPage*this.width,'x'),this.book.chapters[chapter])});
          if(localPage%20===19){await pause();if(this.destroyed||revision!==this.revision)return;}
        }
        this.measuringChapter=-1;this.releaseIdleChapters();
        this.events.index(null,chapter+1,this.book.chapters.length);await pause();
      }
      if(this.destroyed||revision!==this.revision)return;
      this.pages=pages;this.events.index(pages,this.book.chapters.length,this.book.chapters.length);this.emitPosition();
      void this.events.saveIndex?.(signature,pages).catch(()=>{});
    }catch(error){if(!this.destroyed&&revision===this.revision)this.events.error(error instanceof Error?error.message:'页码计算失败，请调整设置后重试。');}
    } finally {this.measuringChapter=-1;this.releaseIdleChapters();finish();}
  }
  private emitPosition() {
    const doc=this.frame.contentDocument;if(!doc?.body||this.destroyed)return;
    const paginated=this.preferences.readingMode==='paginated';
    const win=this.frame.contentWindow!;
    if(paginated)this.localPage=Math.round(win.scrollX/this.width);
    const range=pointRange(doc,paginated?this.localPage*this.width:win.scrollY,paginated?'x':'y');
    const node=range.startContainer;
    const quoteContext=node.nodeType===Node.TEXT_NODE?(node.textContent??'').slice(range.startOffset,range.startOffset+80):'';
    const count=this.lengths.reduce((a,b)=>a+b,0);
    const done=this.chapter===this.book.chapters.length-1&&(paginated?this.localPage===this.pageCount(doc)-1:win.scrollY+this.height>=doc.documentElement.scrollHeight-4);
    const within = textOffset(doc,range) / Math.max(1,textNodes(doc).reduce((sum,node)=>sum+node.length,0));
    const progression=done?1:Math.min(.9999,this.book.releaseChapter ? (this.chapter+within)/this.book.chapters.length : (this.lengths.slice(0,this.chapter).reduce((a,b)=>a+b,0)+textOffset(doc,range))/count);
    const page=this.pages.findIndex(p=>p.chapter===this.chapter&&p.localPage===this.localPage)+1;
    this.positionValue={cfi:cfiFor(range,this.book.chapters[this.chapter]),href:this.book.chapters[this.chapter].href,spineIndex:this.chapter,progression,quoteContext,chapterTitle:this.book.chapters[this.chapter].title,isFinished:done,page,totalPages:this.pages.length};
    this.events.position(this.positionValue);
  }
  private bind(doc:Document) {
    this.lastSelection=null;this.events.selection(null);
    doc.addEventListener('mouseup',()=>this.captureSelection(doc));
    doc.addEventListener('keyup',()=>this.captureSelection(doc));
    doc.addEventListener('keydown',event=>{
      if(this.preferences.readingMode!=='paginated'||event.ctrlKey||event.metaKey||event.altKey||doc.getSelection()?.toString())return;
      if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();void this.next();}
      if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();void this.previous();}
    });
    doc.addEventListener('click',event=>{
      const link=(event.target as Element).closest?.('a');
      if(link){event.preventDefault();const href=link.getAttribute('data-epub-href')||link.getAttribute('href');if(!href)return;
        if(/^https?:\/\//i.test(href))window.open(href,'_blank','noopener,noreferrer');
        else void this.goTo(href.startsWith('#')?this.book.chapters[this.chapter].href+href:href).catch(()=>{});
        return;
      }
      if(doc.getSelection()?.toString())return;
      const hit=this.annotations.filter(a=>a.href===this.book.chapters[this.chapter].href).filter(a=>{
        try{return Array.from(new EpubCFI(a.rangeCfi).toRange(doc).getClientRects()).some(rect=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom);}catch{return false;}
      });
      if(hit.length)this.events.annotation(hit.map(a=>a.id));
    });
    this.scrollHandler=()=>{clearTimeout(this.scrollTimer);this.scrollTimer=setTimeout(()=>this.emitPosition(),100);};
    doc.defaultView?.addEventListener('scroll',this.scrollHandler,{passive:true});
  }
  private captureSelection(doc:Document) {
    const selection=doc.getSelection();
    if(!selection||selection.isCollapsed||!selection.rangeCount||!selection.toString().trim()) {this.lastSelection=null;this.events.selection(null);return;}
    const range=selection.getRangeAt(0),quote=selection.toString();
    const before=doc.createRange();before.selectNodeContents(doc.body);before.setEnd(range.startContainer,range.startOffset);
    const after=doc.createRange();after.selectNodeContents(doc.body);after.setStart(range.endContainer,range.endOffset);
    const rect=range.getBoundingClientRect(),frame=this.frame.getBoundingClientRect();
    this.lastSelection={rangeCfi:cfiFor(range,this.book.chapters[this.chapter]),href:this.book.chapters[this.chapter].href,chapterTitle:this.book.chapters[this.chapter].title,quote,prefix:before.toString().slice(-48),suffix:after.toString().slice(0,48),x:frame.left+Math.max(0,Math.min(rect.left,this.width-200)),y:frame.top+Math.min(rect.bottom,this.height-70)};
    this.events.selection(this.lastSelection);
  }
  clearSelection(){this.frame.contentDocument?.getSelection()?.removeAllRanges();this.lastSelection=null;this.events.selection(null);}
  setAnnotations(annotations:Annotation[]){this.annotations=annotations;this.paintAnnotations();}
  private paintAnnotations(){
    const doc=this.frame.contentDocument,win=this.frame.contentWindow as FrameWindow|null;
    if(this.destroyed||!doc?.head||!doc.body||!win?.Highlight||!win.CSS?.highlights)return;
    win.CSS.highlights.clear();doc.querySelector('style[data-reader="annotations"]')?.remove();
    const style=doc.createElement('style');style.dataset.reader='annotations';
    for(const annotation of this.annotations.filter(a=>a.href===this.book.chapters[this.chapter].href)){
      try{
        const range=new EpubCFI(annotation.rangeCfi).toRange(doc),name='note-'+annotation.id.replace(/[^a-z0-9-]/gi,'');
        win.CSS.highlights.set(name,new win.Highlight(range));
        const color=/^#[0-9a-f]{6}$/i.test(annotation.color)?annotation.color:'#e8cf81';
        style.textContent+=`::highlight(${name}){background-color:${color}99;color:inherit;text-decoration:underline;text-decoration-color:${color};text-decoration-thickness:2px;}`;
      }catch{/* Preserve orphaned notes; navigation reports failure instead of discarding them. */}
    }
    doc.head.append(style);
  }
  destroy(){this.destroyed=true;this.revision++;for(const cancel of this.pendingLoads)cancel();this.pendingLoads.clear();clearTimeout(this.resizeTimer);clearTimeout(this.scrollTimer);this.observer.disconnect();this.frame.remove();this.measure.remove();}
}

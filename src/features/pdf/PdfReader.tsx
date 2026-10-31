import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, BookOpen, Bookmark, ChevronLeft, ChevronRight, List, Maximize, Minus, Plus, Trash2 } from 'lucide-react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { BookRecord, PdfBookmark, PdfProgress, Preferences } from '../../types';
import type { PdfDocument } from '../../services/pdf/document';
import { themeFor, THEMES } from '../../preferences';
import * as storage from '../../services/storage';
import { registerBeforeClose } from '../../services/desktop';
import { safeHttpUrl } from '../../services/tasks';
import 'pdfjs-dist/web/pdf_viewer.css';
import '../reader/reader.css';
import './pdf.css';

interface Props { book:BookRecord; pdf:PdfDocument; initialProgress?:PdfProgress; preferences:Preferences; onPreferences:(p:Preferences)=>void; onBack:()=>void; onError:(text:string)=>void }
type Outline = Awaited<ReturnType<PdfDocument['document']['getOutline']>>;
export function PdfReader({book,pdf,initialProgress,preferences,onPreferences,onBack,onError}:Props) {
  const root = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null);
  const [page,setPage] = useState(Math.min(pdf.document.numPages,Math.max(1,initialProgress?.page??1)));
  const [zoom,setZoom] = useState(Math.min(3,Math.max(.5,initialProgress?.zoom??1)));
  const [mode,setMode] = useState<PdfProgress['zoomMode']>(initialProgress?.zoomMode??'page');
  const [size,setSize] = useState({width:800,height:700});
  const [loading,setLoading] = useState(true), [pageError,setPageError] = useState(''), [reduced,setReduced] = useState(false);
  const [input,setInput] = useState(String(page)), [inputError,setInputError] = useState('');
  const [tab,setTab] = useState<'toc'|'bookmarks'|null>(null), [outline,setOutline] = useState<Outline>([]);
  const [marks,setMarks] = useState<PdfBookmark[]>([]), [saveState,setSaveState] = useState('已保存');
  const position = useRef<PdfProgress|undefined>(initialProgress), restore = useRef(initialProgress);
  const rendering = useRef(true), saving = useRef(Promise.resolve()), jobs = useRef(new Set<Promise<unknown>>());
  const timer = useRef<ReturnType<typeof setTimeout>|undefined>(undefined), version = useRef(0);
  const callbacks=useRef({onError}); callbacks.current={onError};
  function report(error:unknown) { callbacks.current.onError(error instanceof Error?error.message:'PDF 操作失败，请重试。'); }
  function track<T,>(job:Promise<T>) { jobs.current.add(job); void job.finally(()=>jobs.current.delete(job)).catch(()=>{}); return job; }
  async function persist() {
    clearTimeout(timer.current);
    const progress=position.current; if (!progress) return;
    const serial=++version.current;
    setSaveState('保存中');
    const job=saving.current.catch(()=>{}).then(()=>storage.savePdfProgress({...progress,updatedAt:Date.now()}));
    saving.current=job;
    try {await job;if(serial===version.current)setSaveState('已保存');}
    catch(error){setSaveState('保存失败 · 点击重试');throw error;}
  }
  const persistRef=useRef(persist);persistRef.current=persist;
  function schedule() {clearTimeout(timer.current);setSaveState('待保存');timer.current=setTimeout(()=>{void persistRef.current().catch(report);},350);}
  useEffect(()=>registerBeforeClose(async()=>{await persistRef.current();await Promise.all([...jobs.current]);await saving.current;}),[]);
  useEffect(()=>{
    let active=true;
    void pdf.document.getOutline().then(items=>{if(active)setOutline(items);}).catch(report);
    void storage.listPdfBookmarks(book.id).then(items=>{if(active)setMarks(items);}).catch(report);
    const observer=new ResizeObserver(entries=>{
      const rect=entries[0].contentRect;
      setSize(previous=>Math.abs(previous.width-rect.width)<1&&Math.abs(previous.height-rect.height)<1?previous:{width:rect.width,height:rect.height});
    });
    if(host.current)observer.observe(host.current);
    const visibility=()=>{if(document.visibilityState==='hidden')void persistRef.current().catch(report);};
    document.addEventListener('visibilitychange',visibility);
    return()=>{active=false;observer.disconnect();clearTimeout(timer.current);document.removeEventListener('visibilitychange',visibility);};
  },[book.id,pdf]);
  useEffect(()=>{
    let active=true, render:RenderTask|undefined, text:TextLayer|undefined, current:PDFPageProxy|undefined;
    rendering.current=true; setLoading(true);setPageError('');setInput(String(page));
    const previous=restore.current?.page===page?restore.current:position.current?.page===page?position.current:undefined;
    void (async()=>{
      const item=await pdf.document.getPage(page);current=item;
      if(!active)return;
      const original=item.getViewport({scale:1});
      const scale=mode==='custom'?zoom:mode==='width'?Math.max(.05,(size.width-48)/original.width):Math.max(.05,Math.min((size.width-48)/original.width,(size.height-48)/original.height));
      const viewport=item.getViewport({scale});
      if(viewport.width>32700||viewport.height>32700)throw new Error('此页面尺寸过大，请降低缩放或选择适合页面。');
      const requested=Math.min(2,window.devicePixelRatio||1);
      const ratio=Math.min(requested,Math.sqrt(16*1024*1024/(viewport.width*viewport.height)),32700/viewport.width,32700/viewport.height);
      const wrapper=document.createElement('div');wrapper.className='pdf-page';wrapper.style.width=`${viewport.width}px`;wrapper.style.height=`${viewport.height}px`;
      wrapper.style.setProperty('--scale-factor',String(scale));wrapper.style.setProperty('--total-scale-factor',String(scale));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(viewport.width*ratio));canvas.height=Math.max(1,Math.floor(viewport.height*ratio));
      canvas.setAttribute('aria-label',`PDF 第 ${page} 页`);wrapper.append(canvas);
      render=item.render({canvas,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0],annotationMode:0});
      await render.promise; if(!active)return;
      if(pdf.canCopy){
        const layer=document.createElement('div');layer.className='textLayer';wrapper.append(layer);
        text=new TextLayer({textContentSource:await item.getTextContent(),container:layer,viewport});
        await text.render();if(!active)return;
      }
      const annotations=await item.getAnnotations({intent:'display'});if(!active)return;
      for(const annotation of annotations){
        if(annotation.subtype!=='Link'||!Array.isArray(annotation.rect))continue;
        const external=safeHttpUrl(annotation.url);
        if(!external&&!annotation.dest)continue;
        const rectangle=[...viewport.convertToViewportPoint(annotation.rect[0],annotation.rect[1]),...viewport.convertToViewportPoint(annotation.rect[2],annotation.rect[3])];
        const link=document.createElement('a');link.className='pdf-link';link.setAttribute('aria-label',external?'打开外部链接':'跳转 PDF 页面');
        Object.assign(link.style,{left:`${Math.min(rectangle[0],rectangle[2])}px`,top:`${Math.min(rectangle[1],rectangle[3])}px`,width:`${Math.abs(rectangle[2]-rectangle[0])}px`,height:`${Math.abs(rectangle[3]-rectangle[1])}px`});
        if(external){link.href=external;link.target='_blank';link.rel='noopener noreferrer';}
        else {link.href='#';link.onclick=event=>{event.preventDefault();void destination(annotation.dest).catch(report);};}
        wrapper.append(link);
      }
      surface.current!.replaceChildren(wrapper);setReduced(ratio<requested-.001);
      position.current={format:'pdf',bookId:book.id,page,totalPages:pdf.document.numPages,offsetX:previous?.offsetX??0,offsetY:previous?.offsetY??0,zoom,zoomMode:mode,progression:page===pdf.document.numPages?1:(page-1)/pdf.document.numPages,chapterTitle:`第 ${page} 页`,isFinished:page===pdf.document.numPages,updatedAt:Date.now()};
      restore.current=undefined;
      const area=host.current!;area.scrollLeft=(area.scrollWidth-area.clientWidth)*(previous?.offsetX??0);area.scrollTop=(area.scrollHeight-area.clientHeight)*(previous?.offsetY??0);
      rendering.current=false;setLoading(false);schedule();
    })().catch(error=>{if(active){setLoading(false);setPageError(error instanceof Error?error.message:'页面渲染失败');report(error);}});
    return()=>{active=false;rendering.current=true;render?.cancel();text?.cancel();current?.cleanup();};
  },[page,mode,zoom,size.width,size.height,pdf,book.id]);
  async function destination(target:unknown) {
    const dest=typeof target==='string'?await pdf.document.getDestination(target):target;
    if(!Array.isArray(dest)||!dest.length)throw new Error('该 PDF 目录没有有效的页面位置。');
    const index=typeof dest[0]==='number'?dest[0]:await pdf.document.getPageIndex(dest[0]);
    if(index<0||index>=pdf.document.numPages)throw new Error('目录页码超出 PDF 范围。');setPage(index+1);
  }
  function navigate(next:number) {if(next>=1&&next<=pdf.document.numPages){setPage(next);setInputError('');}}
  function jump() {const value=Number(input);if(!input.trim()||!Number.isInteger(value)||value<1||value>pdf.document.numPages){setInputError(`请输入 1–${pdf.document.numPages} 之间的整数页码。`);return;}navigate(value);}
  async function toggleBookmark() {
    const old=marks.find(item=>item.page===page);
    await track(old?storage.deletePdfBookmark(old.id):storage.putPdfBookmark({id:crypto.randomUUID(),bookId:book.id,page,createdAt:Date.now()}));
    setMarks(await storage.listPdfBookmarks(book.id));
  }
  async function back() {try {await persist();await Promise.all([...jobs.current]);if(document.fullscreenElement)await document.exitFullscreen();onBack();}catch(error){report(error);}}
  async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await root.current?.requestFullscreen();}catch(error){report(error);}}
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.ctrlKey||event.metaKey||event.altKey||(event.target as HTMLElement).closest('input,select,textarea,button,a')||window.getSelection()?.toString())return;
      if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();navigate(page+1);}
      if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();navigate(page-1);}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  });
  function outlineItems(items:NonNullable<Outline>,depth=0):React.ReactNode {
    return <ul>{items.map((item,index)=><li key={index}><button style={{paddingLeft:14+Math.min(depth,8)*12}} disabled={!item.dest&&!item.url} onClick={()=>{
      if(item.dest)void destination(item.dest).catch(report);
      else {const url=safeHttpUrl(item.url);if(url)window.open(url,'_blank','noopener,noreferrer');}
    }}>{item.title||'未命名目录项'}</button>{!!item.items?.length&&depth<30&&outlineItems(item.items,depth+1)}</li>)}</ul>;
  }
  const theme=themeFor(preferences);
  const variables={'--reader-bg':theme.background,'--reader-ink':theme.text,'--reader-surface':theme.surface,'--reader-muted':theme.muted,'--reader-border':theme.border} as CSSProperties;
  return <div className="reader pdf-reader" ref={root} style={variables} data-testid="pdf-reader">
    <header className="reader-toolbar">
      <div className="reader-identity"><button className="reader-tool" aria-label="返回书架" onClick={()=>void back()}><ArrowLeft size={19}/></button><span className="reader-brand"><BookOpen size={20}/>阅野</span><span className="toolbar-book-title" title={book.title}>{book.title}</span><small>PDF</small></div>
      <div className="toolbar-section"><button className="reader-tool" aria-label="目录" aria-pressed={tab==='toc'} onClick={()=>setTab(tab==='toc'?null:'toc')}><List size={19}/></button><button className="reader-tool" aria-label="书签列表" aria-pressed={tab==='bookmarks'} onClick={()=>setTab(tab==='bookmarks'?null:'bookmarks')}><Bookmark size={18}/></button></div>
      <div className="pdf-zoom"><button className="reader-tool" aria-label="缩小" onClick={()=>{setZoom(Math.max(.5,zoom-.25));setMode('custom');}}><Minus size={17}/></button><select aria-label="PDF 缩放" value={mode==='custom'?String(zoom):mode} onChange={event=>{const value=event.target.value;if(value==='page'||value==='width')setMode(value);else{setZoom(Number(value));setMode('custom');}}}><option value="page">适合页面</option><option value="width">适合宽度</option>{[.5,.75,1,1.25,1.5,1.75,2,2.25,2.5,2.75,3].map(value=><option key={value} value={value}>{Math.round(value*100)}%</option>)}</select><button className="reader-tool" aria-label="放大" onClick={()=>{setZoom(Math.min(3,zoom+.25));setMode('custom');}}><Plus size={17}/></button></div>
      <div className="toolbar-section quick-themes">{THEMES.map(item=><button className="theme-dot" key={item.id} style={{background:item.background}} title={item.name} aria-label={`${item.name}配色`} aria-pressed={preferences.theme===item.id} onClick={()=>onPreferences({...preferences,theme:item.id})}/>)}</div>
      <button className={`reader-tool ${marks.some(mark=>mark.page===page)?'active':''}`} aria-label="添加或移除页面书签" disabled={loading||!!pageError} onClick={()=>void toggleBookmark().catch(report)}><Bookmark size={18}/></button><button className="reader-tool" aria-label="全屏阅读" onClick={()=>void fullscreen()}><Maximize size={18}/></button>
    </header>
    <div className="pdf-layout">
      {tab&&<aside className="pdf-sidebar" aria-label={tab==='toc'?'PDF 目录':'PDF 书签'}><h2>{tab==='toc'?'目录':'页面书签'}</h2>{tab==='toc'?(outline?.length?outlineItems(outline):<p>此 PDF 没有目录</p>):marks.length?<ul>{marks.map(mark=><li className="pdf-bookmark" key={mark.id}><button onClick={()=>navigate(mark.page)}>第 {mark.page} 页</button><button aria-label={`删除第 ${mark.page} 页书签`} onClick={()=>void track(storage.deletePdfBookmark(mark.id)).then(()=>storage.listPdfBookmarks(book.id)).then(setMarks).catch(report)}><Trash2 size={15}/></button></li>)}</ul>:<p>还没有页面书签</p>}</aside>}
      <main className="pdf-viewport" ref={host} aria-label="PDF 阅读区域" onScroll={()=>{
        if(rendering.current||!position.current||!host.current)return;const area=host.current;
        position.current={...position.current,offsetX:area.scrollLeft/Math.max(1,area.scrollWidth-area.clientWidth),offsetY:area.scrollTop/Math.max(1,area.scrollHeight-area.clientHeight)};schedule();
      }}><div ref={surface} className="pdf-surface"/>{loading&&<div className="pdf-loading" role="status">正在渲染第 {page} 页…</div>}{pageError&&<div className="pdf-page-error" role="alert">{pageError}<button onClick={()=>setSize(value=>({...value,width:value.width+.01}))}>重试页面</button></div>}</main>
    </div>
    <footer className="pdf-footer"><button className="reader-tool" aria-label="上一页" disabled={page<=1} onClick={()=>navigate(page-1)}><ChevronLeft size={19}/></button><form onSubmit={event=>{event.preventDefault();jump();}}><label>页码 <input aria-label="PDF 页码" inputMode="numeric" value={input} onChange={event=>setInput(event.target.value)}/></label><span>/ {pdf.document.numPages}</span><button type="submit">跳转</button></form><button className="reader-tool" aria-label="下一页" disabled={page>=pdf.document.numPages} onClick={()=>navigate(page+1)}><ChevronRight size={19}/></button><span className="pdf-footer-note">{inputError|| (reduced?'大页面已降低渲染分辨率':pdf.canCopy?'原始版面 · 扫描页面无 OCR':'此文件限制文字复制')}</span><button className="pdf-save" onClick={()=>void persist().catch(report)}>{saveState}</button></footer>
  </div>;
}

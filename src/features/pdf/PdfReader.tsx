import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowLeft, Bookmark, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, Highlighter, List, Maximize, Minimize, Minus, PanelLeftClose, Plus, ScanLine, Settings2, StickyNote, Trash2, X } from 'lucide-react';
import type { BookRecord, PdfAnnotation, PdfBookmark, PdfPreferences, PdfProgress, PdfSelection, Preferences } from '../../types';
import type { PdfDocument } from '../../services/pdf/document';
import { DEFAULT_PREFERENCES, THEMES, contrast, normalizePreferences, themeFor } from '../../preferences';
import * as storage from '../../services/storage';
import { registerBeforeClose } from '../../services/desktop';
import { safeHttpUrl } from '../../services/tasks';
import { Modal } from '../../components/Modal';
import { PdfDocumentView, type PdfNavigation, type PdfViewPosition } from './PdfDocumentView';
import '../reader/reader.css';
import './pdf.css';

interface Props { book:BookRecord; pdf:PdfDocument; initialProgress?:PdfProgress; preferences:Preferences; onPreferences:(p:Preferences)=>void; onBack:()=>void; onError:(text:string)=>void }
interface OutlineItem { id:string; title:string; page?:number; dest?:unknown; url?:string; children:OutlineItem[] }
const COLORS=['#e8c96d','#a9cba0','#c1b1de'];
function Tool({label,children,onClick,active,disabled,className=''}:{label:string;children:ReactNode;onClick:()=>void;active?:boolean;disabled?:boolean;className?:string}) {
  return <button type="button" className={`reader-tool ${active?'active':''} ${className}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}
function NumericSetting({label,value,min,max,step=1,disabled,onCommit}:{label:string;value:number;min:number;max:number;step?:number;disabled?:boolean;onCommit:(value:number)=>void}) {
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  function commit(){const number=Number(draft);const next=draft.trim()&&Number.isFinite(number)?Math.max(min,Math.min(max,Math.round(number/step)*step)):value;setDraft(String(next));if(next!==value)onCommit(next);}
  return <input aria-label={label} type="number" min={min} max={max} step={step} disabled={disabled} value={draft} onChange={event=>setDraft(event.target.value)} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit();}if(event.key==='Escape')setDraft(String(value));}}/>;
}
function flatten(items:OutlineItem[]):OutlineItem[]{return items.flatMap(item=>[item,...flatten(item.children)]);}
function Toc({items,current,closed,toggle,onGo,depth=0}:{items:OutlineItem[];current:string;closed:Set<string>;toggle:(id:string)=>void;onGo:(item:OutlineItem)=>void;depth?:number}) {
  return <ul className="toc-list">{items.map(item=><li key={item.id}><div className={`toc-row ${item.id===current?'current':''}`} style={{paddingLeft:12+depth*15}}>
    {item.children.length?<button aria-expanded={!closed.has(item.id)} aria-label={`${closed.has(item.id)?'展开':'折叠'}${item.title}`} className={`toc-arrow ${closed.has(item.id)?'closed':''}`} onClick={()=>toggle(item.id)}><ChevronDown size={14}/></button>:<span className="toc-indent"/>}
    <button className="toc-title" aria-current={item.id===current?'location':undefined} title={item.title} onClick={()=>item.dest||item.url?onGo(item):toggle(item.id)}>{item.title}</button></div>
    {!!item.children.length&&!closed.has(item.id)&&<Toc items={item.children} current={current} closed={closed} toggle={toggle} onGo={onGo} depth={depth+1}/>}
  </li>)}</ul>;
}

export function PdfReader({book,pdf,initialProgress,preferences:seed,onBack,onError}:Props) {
  const root=useRef<HTMLDivElement>(null),sidebar=useRef<HTMLElement>(null);
  const [preferences,setPreferences]=useState<PdfPreferences>({...seed,viewMode:'original'}),[prefsReady,setPrefsReady]=useState(false);
  const prefsRef=useRef(preferences);prefsRef.current=preferences;
  const [page,setPage]=useState(Math.min(pdf.document.numPages,Math.max(1,initialProgress?.page??1)));
  const [zoom,setZoom]=useState(Math.min(3,Math.max(.5,initialProgress?.zoom??1))),[zoomMode,setZoomMode]=useState<PdfProgress['zoomMode']>(initialProgress?.zoomMode??'page');
  const [navigation,setNavigation]=useState<PdfNavigation>({page,serial:0});
  const [loading,setLoading]=useState(true),[pageInfo,setPageInfo]=useState({hasText:true,reduced:false});
  const [input,setInput]=useState(String(page)),[inputError,setInputError]=useState('');
  const [tab,setTab]=useState<'toc'|'bookmarks'|'notes'>('toc'),[outline,setOutline]=useState<OutlineItem[]>([]),[closed,setClosed]=useState(new Set<string>());
  const [marks,setMarks]=useState<PdfBookmark[]>([]),[notes,setNotes]=useState<PdfAnnotation[]>([]);
  const [settings,setSettings]=useState(false),[full,setFull]=useState(false),[regionMode,setRegionMode]=useState(false);
  const [selection,setSelection]=useState<PdfSelection|null>(null),[matching,setMatching]=useState<string[]|null>(null);
  const [editor,setEditor]=useState<{existing?:PdfAnnotation;selection?:PdfSelection}|null>(null),[draft,setDraft]=useState(''),[color,setColor]=useState(COLORS[0]);
  const [noteSaving,setNoteSaving]=useState(false),[markSaving,setMarkSaving]=useState(false),[storageUsage,setStorageUsage]=useState('正在估算本地存储…');
  const [saveState,setSaveState]=useState('已保存'),[prefsError,setPrefsError]=useState(false),[slider,setSlider]=useState<number|null>(null);
  const [undo,setUndo]=useState<{label:string;action:()=>Promise<void>}|null>(null);
  const position=useRef<PdfProgress|undefined>(initialProgress),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),version=useRef(0);
  const saving=useRef(Promise.resolve()),prefsQueue=useRef(Promise.resolve()),jobs=useRef(new Set<Promise<unknown>>());
  const callbacks=useRef({onError});callbacks.current={onError};
  function report(error:unknown){callbacks.current.onError(error instanceof Error?error.message:'PDF 操作失败，请重试。');}
  function run(job:Promise<unknown>){void job.catch(report);}
  function track<T,>(job:Promise<T>){jobs.current.add(job);void job.finally(()=>jobs.current.delete(job)).catch(()=>{});return job;}
  function updatePrefs(patch:Partial<PdfPreferences>){
    const next={...normalizePreferences({...prefsRef.current,...patch}),viewMode:patch.viewMode??prefsRef.current.viewMode};
    prefsRef.current=next;setPreferences(next);clearSelection();
    if(patch.viewMode==='text')setRegionMode(false);
    if(patch.contentWidth!==undefined&&next.viewMode==='original')setZoomMode('width');
    const job=prefsQueue.current.catch(()=>{}).then(()=>storage.savePdfPreferences(next));prefsQueue.current=job;
    void job.then(()=>{if(prefsQueue.current===job)setPrefsError(false);}).catch(error=>{setPrefsError(true);report(error);});
  }
  async function persist(){
    clearTimeout(timer.current);const value=position.current;if(!value)return;
    const serial=++version.current;setSaveState('保存中');
    const job=saving.current.catch(()=>{}).then(()=>storage.savePdfProgress({...value,updatedAt:Date.now()}));saving.current=job;
    try{await job;if(serial===version.current)setSaveState('已保存');}catch(error){setSaveState('保存失败 · 点击重试');throw error;}
  }
  const persistRef=useRef(persist);persistRef.current=persist;
  function schedule(){clearTimeout(timer.current);setSaveState('待保存');timer.current=setTimeout(()=>run(persistRef.current()),350);}
  async function drain(){await persistRef.current();await Promise.all([...jobs.current]);await prefsQueue.current;await saving.current;}
  const drainRef=useRef(drain);drainRef.current=drain;
  useEffect(()=>registerBeforeClose(()=>drainRef.current()),[]);
  useEffect(()=>{
    let active=true;
    void storage.getPdfPreferences(seed).then(value=>{if(active){prefsRef.current=value;setPreferences(value);setPrefsReady(true);}}).catch(report);
    void Promise.all([storage.listPdfBookmarks(book.id),storage.listPdfAnnotations(book.id)]).then(([bookmarks,annotations])=>{if(active){setMarks(bookmarks);setNotes(annotations);}}).catch(report);
    void pdf.document.getOutline().then(async items=>{
      function tree(entries:NonNullable<typeof items>,path='',depth=0):OutlineItem[]{return entries.map((item,index)=>({id:`${path}${index}`,title:item.title||'未命名目录项',dest:item.dest,url:item.url??undefined,children:depth<30?tree(item.items??[],`${path}${index}.`,depth+1):[]}));}
      const result=tree(items??[]);if(active)setOutline(result);
      await Promise.all(flatten(result).map(async item=>{if(item.dest)try{item.page=await destinationPage(item.dest);}catch{/* Invalid entries must not stop reading. */}}));
      if(active)setOutline([...result]);
    }).catch(report);
    const visibility=()=>{if(document.visibilityState==='hidden')run(persistRef.current());};document.addEventListener('visibilitychange',visibility);
    return()=>{active=false;clearTimeout(timer.current);document.removeEventListener('visibilitychange',visibility);};
  },[book.id,pdf]);
  useEffect(()=>{setInput(String(page));setInputError('');},[page]);
  useEffect(()=>{const change=()=>setFull(document.fullscreenElement===root.current);document.addEventListener('fullscreenchange',change);return()=>document.removeEventListener('fullscreenchange',change);},[]);
  useEffect(()=>{if(!undo)return;const timeout=setTimeout(()=>setUndo(null),8000);return()=>clearTimeout(timeout);},[undo]);
  useEffect(()=>{
    if(!settings)return;
    if(!navigator.storage?.estimate){setStorageUsage('当前环境无法估算存储用量');return;}
    void navigator.storage.estimate().then(estimate=>setStorageUsage(`本地数据约占用 ${((estimate.usage??0)/1024/1024).toFixed(1)} MB · 可用配额约 ${((estimate.quota??0)/1024/1024/1024).toFixed(1)} GB`)).catch(()=>setStorageUsage('暂时无法估算本地存储用量'));
  },[settings]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(settings||editor||matching||selection||regionMode||preferences.readingMode!=='paginated'||event.ctrlKey||event.metaKey||event.altKey||(event.target as HTMLElement).closest('input,select,textarea,button,a,[contenteditable="true"],dialog')||window.getSelection()?.toString())return;
      if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();navigate(page+1);}
      if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();navigate(page-1);}
    };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  });
  const activeOutline=flatten(outline).filter(item=>item.page!==undefined&&item.page<=page).sort((a,b)=>(b.page??0)-(a.page??0))[0];
  useEffect(()=>{if(tab==='toc'&&preferences.sidebarOpen)sidebar.current?.querySelector('.toc-row.current')?.scrollIntoView({block:'nearest'});},[activeOutline?.id,tab,preferences.sidebarOpen]);
  function clearSelection(){setSelection(null);window.getSelection()?.removeAllRanges();}
  function navigate(next:number,annotation?:PdfAnnotation){
    if(next<1||next>pdf.document.numPages)return;
    clearSelection();setRegionMode(false);setInputError('');setPage(next);setNavigation(old=>({page:next,serial:old.serial+1,annotation}));
    if(window.innerWidth<1024&&preferences.sidebarOpen)updatePrefs({sidebarOpen:false});
  }
  function jump(){const value=Number(input);if(!/^\d+$/.test(input.trim())||!Number.isInteger(value)||value<1||value>pdf.document.numPages){setInputError(`请输入 1–${pdf.document.numPages} 之间的整数页码。`);return;}navigate(value);}
  async function destinationPage(target:unknown){
    const dest=typeof target==='string'?await pdf.document.getDestination(target):target;
    if(!Array.isArray(dest)||!dest.length)throw new Error('该 PDF 目录没有有效的页面位置。');
    const index=typeof dest[0]==='number'?dest[0]:await pdf.document.getPageIndex(dest[0]);
    if(index<0||index>=pdf.document.numPages)throw new Error('目录页码超出 PDF 范围。');return index+1;
  }
  async function destination(target:unknown){navigate(await destinationPage(target));}
  function showTab(next:typeof tab){clearSelection();if(tab===next&&preferences.sidebarOpen)updatePrefs({sidebarOpen:false});else{setTab(next);updatePrefs({sidebarOpen:true});}}
  function onPosition(value:PdfViewPosition){
    position.current={format:'pdf',bookId:book.id,...value,totalPages:pdf.document.numPages,zoom,zoomMode,progression:value.page===pdf.document.numPages?1:(value.page-1)/pdf.document.numPages,chapterTitle:`第 ${value.page} 页`,isFinished:value.page===pdf.document.numPages,updatedAt:Date.now()};schedule();
  }
  async function removeBookmark(mark:PdfBookmark){
    await track(storage.deletePdfBookmark(mark.id));setMarks(all=>all.filter(item=>item.id!==mark.id));
    setUndo({label:'书签已移除',action:async()=>{await track(storage.putPdfBookmark(mark));setMarks(await storage.listPdfBookmarks(book.id));}});
  }
  async function toggleBookmark(){
    if(markSaving)return;setMarkSaving(true);
    try{const old=marks.find(mark=>mark.page===page);if(old)await removeBookmark(old);else{await track(storage.putPdfBookmark({id:crypto.randomUUID(),bookId:book.id,page,createdAt:Date.now()}));setMarks(await storage.listPdfBookmarks(book.id));}}finally{setMarkSaving(false);}
  }
  function edit(note:PdfAnnotation){clearSelection();setEditor({existing:note});setDraft(note.note);setColor(note.color);}
  function newNote(){if(!selection)return;setEditor({selection});setDraft('');setColor(COLORS[0]);clearSelection();}
  function closeEditor(){if(noteSaving)return;if((draft!==(editor?.existing?.note??'')||color!==(editor?.existing?.color??COLORS[0]))&&!window.confirm('笔记尚未保存，确定放弃修改吗？'))return;setEditor(null);}
  async function saveNote(highlightOnly=false){
    const existing=editor?.existing,selected=highlightOnly?selection:editor?.selection;if(noteSaving||!existing&&!selected)return;
    setNoteSaving(true);
    try{
      const now=Date.now();const note:PdfAnnotation=existing?{...existing,note:draft,color,updatedAt:now}:{page:selected!.page,kind:selected!.kind,start:selected!.start,end:selected!.end,quote:selected!.quote,prefix:selected!.prefix,suffix:selected!.suffix,rects:selected!.rects,id:crypto.randomUUID(),bookId:book.id,note:highlightOnly?'':draft,color:highlightOnly?COLORS[0]:color,createdAt:now,updatedAt:now};
      await track(storage.putPdfAnnotation(note));setNotes(all=>existing?all.map(item=>item.id===note.id?note:item):[...all,note]);setEditor(null);clearSelection();
    }finally{setNoteSaving(false);}
  }
  async function removeNote(note:PdfAnnotation){
    await track(storage.deletePdfAnnotation(note.id));setNotes(all=>all.filter(item=>item.id!==note.id));setEditor(null);
    setUndo({label:'笔记与高亮已移除',action:async()=>{await track(storage.putPdfAnnotation(note));setNotes(all=>[...all.filter(item=>item.id!==note.id),note]);}});
  }
  function goNote(note:PdfAnnotation){if(note.kind==='region'&&preferences.viewMode==='text')updatePrefs({viewMode:'original'});navigate(note.page,note);}
  async function back(){try{await drain();if(document.fullscreenElement)await document.exitFullscreen();onBack();}catch(error){report(error);}}
  async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await root.current?.requestFullscreen();}catch{onError('未能进入全屏，请重试或最大化窗口。');}}
  async function retrySave(){if(prefsError){await storage.savePdfPreferences(prefsRef.current);prefsQueue.current=Promise.resolve();setPrefsError(false);}await persist();}
  const theme=themeFor(preferences),hasBookmark=marks.some(mark=>mark.page===page),textMode=preferences.viewMode==='text';
  const variables={'--reader-bg':theme.background,'--reader-ink':theme.text,'--reader-surface':theme.surface,'--reader-muted':theme.muted,'--reader-border':theme.border,colorScheme:['night','graphite'].includes(preferences.theme)?'dark':'light'} as CSSProperties;
  const progression=page===pdf.document.numPages?1:(page-1)/pdf.document.numPages;
  const hint=inputError||(pageInfo.reduced?'大页面已降低渲染分辨率':regionMode?'拖动框选区域，添加高亮或笔记':!pdf.canCopy?'此文件限制文字复制，可使用区域笔记':!pageInfo.hasText?'此页无可提取文字，可使用区域笔记':textMode?'文字重排 · 页码仍按 PDF 原页':'原始版面 · 可选中文字记笔记');
  function progressJump(value:string){navigate(Math.max(1,Math.min(pdf.document.numPages,Math.floor(Number(value)/1000*pdf.document.numPages)+1)));setSlider(null);}
  return <div className="reader pdf-reader" ref={root} style={variables} data-testid="pdf-reader" data-view-mode={preferences.viewMode}>
    <header className="reader-toolbar">
      <div className="reader-identity"><Tool label="返回书架" onClick={()=>void back()}><ArrowLeft size={19}/></Tool><span className="reader-brand"><BookOpen size={21}/>阅野</span><span className="toolbar-book-title" title={book.title}>{book.title}</span></div>
      <div className="toolbar-section sidebar-tools"><Tool label="目录" active={preferences.sidebarOpen&&tab==='toc'} onClick={()=>showTab('toc')}><List size={19}/></Tool><Tool label="书签列表" active={preferences.sidebarOpen&&tab==='bookmarks'} onClick={()=>showTab('bookmarks')}><Bookmark size={18}/></Tool><Tool label="笔记列表" active={preferences.sidebarOpen&&tab==='notes'} onClick={()=>showTab('notes')}><StickyNote size={18}/></Tool></div>
      <div className="toolbar-section quick-themes"><span className="toolbar-caption">配色</span>{THEMES.map(item=><button className={`theme-dot ${preferences.theme===item.id?'selected':''}`} key={item.id} style={{background:item.background}} title={item.name} aria-label={`${item.name}配色`} aria-pressed={preferences.theme===item.id} onClick={()=>updatePrefs({theme:item.id})}>{preferences.theme===item.id&&<Check size={11} color={item.text}/>}</button>)}</div>
      <div className="toolbar-section font-control" title={textMode?'字号':'在设置中切换到文字重排后调整字号'}><span className="toolbar-caption">字号</span><Tool label="减小字号" disabled={!textMode||preferences.fontSize<=14} onClick={()=>updatePrefs({fontSize:preferences.fontSize-1})}><Minus size={14}/></Tool><NumericSetting label="字号" min={14} max={40} value={preferences.fontSize} disabled={!textMode} onCommit={value=>updatePrefs({fontSize:value})}/><Tool label="增大字号" disabled={preferences.fontSize>=40||!textMode} onClick={()=>updatePrefs({fontSize:preferences.fontSize+1})}><Plus size={14}/></Tool></div>
      <div className="toolbar-section width-control"><span className="toolbar-caption">宽度</span><Tool label="减小宽度" disabled={preferences.contentWidth<=480} onClick={()=>updatePrefs({contentWidth:preferences.contentWidth-20})}><Minus size={14}/></Tool><NumericSetting label="正文宽度" min={480} max={1400} step={20} value={preferences.contentWidth} onCommit={value=>updatePrefs({contentWidth:value})}/><Tool label="增大宽度" disabled={preferences.contentWidth>=1400} onClick={()=>updatePrefs({contentWidth:preferences.contentWidth+20})}><Plus size={14}/></Tool></div>
      <div className="toolbar-section pdf-zoom"><Tool label="缩小" disabled={textMode||zoomMode==='custom'&&zoom<=.5} onClick={()=>{clearSelection();setZoom(Math.max(.5,zoom-.25));setZoomMode('custom');}}><Minus size={14}/></Tool><select aria-label="PDF 缩放" disabled={textMode} value={zoomMode==='custom'?String(zoom):zoomMode} onChange={event=>{clearSelection();const value=event.target.value;if(value==='page'||value==='width')setZoomMode(value);else{setZoom(Number(value));setZoomMode('custom');}}}><option value="page">适合页面</option><option value="width">适合宽度</option>{[.5,.75,1,1.25,1.5,1.75,2,2.25,2.5,2.75,3].map(value=><option key={value} value={value}>{Math.round(value*100)}%</option>)}</select><Tool label="放大" disabled={textMode||zoomMode==='custom'&&zoom>=3} onClick={()=>{clearSelection();setZoom(Math.min(3,zoom+.25));setZoomMode('custom');}}><Plus size={14}/></Tool></div>
      <div className="toolbar-section page-control"><Tool label="上一页" disabled={page<=1||loading} onClick={()=>navigate(page-1)}><ChevronLeft size={18}/></Tool><form onSubmit={event=>{event.preventDefault();jump();}}><input aria-label="PDF 页码" inputMode="numeric" value={input} onChange={event=>{setInput(event.target.value);setInputError('');}} onBlur={()=>setInput(String(page))} onKeyDown={event=>{if(event.key==='Escape'){setInput(String(page));setInputError('');}}}/><span className="page-total">/ {pdf.document.numPages}</span><button className="pdf-jump" type="submit" onMouseDown={event=>event.preventDefault()}>跳转</button></form><Tool label="下一页" disabled={page>=pdf.document.numPages||loading} onClick={()=>navigate(page+1)}><ChevronRight size={18}/></Tool>{inputError&&<div className="page-error" role="alert">{inputError}</div>}</div>
      <div className="toolbar-section toolbar-end"><Tool label="添加或移除页面书签" active={hasBookmark} disabled={loading||markSaving} onClick={()=>run(toggleBookmark())}><Bookmark size={18} fill={hasBookmark?'currentColor':'none'}/></Tool><Tool label="区域笔记" active={regionMode} disabled={textMode||loading} onClick={()=>{clearSelection();setRegionMode(!regionMode);}}><ScanLine size={18}/></Tool><Tool label="阅读设置" active={settings} disabled={!prefsReady} onClick={()=>{clearSelection();setSettings(true);}}><Settings2 size={19}/><span className="setting-label">设置</span></Tool><Tool label={full?'退出全屏':'进入全屏'} onClick={()=>run(fullscreen())}>{full?<Minimize size={18}/>:<Maximize size={18}/>}</Tool></div>
    </header>
    <div className="reader-workspace pdf-layout">
      {preferences.sidebarOpen&&<><button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={()=>updatePrefs({sidebarOpen:false})}/><aside className="reader-sidebar pdf-sidebar">
        <div className="sidebar-heading"><span>{tab==='toc'?'目 录':tab==='bookmarks'?'书 签':'笔 记'}<small>{tab==='toc'?flatten(outline).length:tab==='bookmarks'?marks.length:notes.length}</small></span>{tab==='bookmarks'&&<Tool label={hasBookmark?'移除这一页的书签':'记录这一页'} active={hasBookmark} disabled={loading||markSaving} onClick={()=>run(toggleBookmark())}><Bookmark size={17}/></Tool>}<Tool label="收起侧栏" onClick={()=>updatePrefs({sidebarOpen:false})}><PanelLeftClose size={17}/></Tool></div>
        <div className="sidebar-book"><span>{book.title}</span><small>{book.author} · PDF · {pdf.document.numPages} 页</small></div>
        <nav className="sidebar-content" ref={sidebar} aria-label={tab==='toc'?'书籍目录':tab==='bookmarks'?'书签':'笔记'}>
          {tab==='toc'?outline.length?<Toc items={outline} current={activeOutline?.id??''} closed={closed} toggle={id=>setClosed(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;})} onGo={item=>{if(item.dest)run(destination(item.dest));else{const url=safeHttpUrl(item.url);if(url)window.open(url,'_blank','noopener,noreferrer');}}}/>:<div className="sidebar-empty"><List size={28}/><p>此 PDF 没有目录</p><small>可使用页码或阅读进度定位。</small></div>:tab==='bookmarks'?marks.length?marks.map(mark=><article className="saved-item" key={mark.id}><button className="saved-content" onClick={()=>navigate(mark.page)}><span className="saved-chapter"><Bookmark size={13}/>第 {mark.page} 页</span><p>第 {mark.page} 页</p><time>{new Date(mark.createdAt).toLocaleDateString('zh-CN')}</time></button><button className="saved-delete" aria-label={`删除第 ${mark.page} 页书签`} onClick={()=>run(removeBookmark(mark))}><Trash2 size={14}/></button></article>):<div className="sidebar-empty"><Bookmark size={28}/><p>留住想再读的一页</p><small>点击工具栏的书签图标，即可记录当前位置。</small></div>:notes.length?[...notes].sort((a,b)=>b.createdAt-a.createdAt).map(note=><article className="saved-item note-item" key={note.id}><button className="saved-content" onClick={()=>goNote(note)}><span className="saved-chapter"><i style={{background:note.color}}/>第 {note.page} 页{note.kind==='region'?' · 区域笔记':''}</span><blockquote>{note.quote}</blockquote>{note.note&&<p>{note.note}</p>}<time>{new Date(note.updatedAt).toLocaleDateString('zh-CN')}</time></button><div className="note-item-actions"><button onClick={()=>edit(note)}>编辑</button><button aria-label="删除笔记" onClick={()=>run(removeNote(note))}><Trash2 size={14}/></button></div></article>):<div className="sidebar-empty"><Highlighter size={28}/><p>让想法在这里生长</p><small>选中正文文字，添加高亮或写下你的笔记。扫描页可点击“区域笔记”后拖动框选。</small></div>}
        </nav><div className="sidebar-bottom"><span className="quiet-dot"/>只在你的设备中保存</div>
      </aside></>}
      <div className="pdf-reading-canvas">{prefsReady&&<PdfDocumentView pdf={pdf} page={page} navigation={navigation} zoom={zoom} zoomMode={zoomMode} preferences={preferences} initialProgress={initialProgress} annotations={notes} regionMode={regionMode} onPage={setPage} onPosition={onPosition} onSelection={value=>{setSelection(value);if(value?.kind==='region')setRegionMode(false);}} onAnnotation={ids=>{if(ids.length===1){const note=notes.find(item=>item.id===ids[0]);if(note)edit(note);}else setMatching(ids);}} onLoading={setLoading} onPageInfo={setPageInfo} onDestination={target=>run(destination(target))} onError={onError}/>}{loading&&<div className="pdf-loading" role="status"><span className="spinner"/>正在渲染第 {page} 页…</div>}</div>
    </div>
    <footer className="reader-footer pdf-footer"><span className="footer-chapter" title={`第 ${page} / ${pdf.document.numPages} 页 · ${textMode?'文字重排':'PDF 原始版面'}`}>第 {page} / {pdf.document.numPages} 页 · {textMode?'文字重排':'PDF 原始版面'}</span><div className="progress-navigation"><span>{Math.round((slider??progression)*100)}%</span><input aria-label="阅读进度" type="range" min="0" max="1000" step="1" value={Math.round((slider??progression)*1000)} disabled={!prefsReady} onChange={event=>setSlider(Number(event.target.value)/1000)} onPointerUp={event=>progressJump(event.currentTarget.value)} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key))progressJump(event.currentTarget.value);}}/></div><div className="reader-save-info"><span className="layout-hint" title={hint}>{hint}</span><button className={`pdf-save ${prefsError||saveState.startsWith('保存失败')?'save-failed':''}`} onClick={()=>run(retrySave())}><span className="quiet-dot"/>{prefsError?'设置保存失败 · 点击重试':saveState}</button></div></footer>
    {selection&&!editor&&<div className="selection-toolbar" style={{left:Math.max(8,Math.min(selection.x,window.innerWidth-240)),top:Math.max(64,Math.min(selection.y+10,window.innerHeight-62))}} onMouseDown={event=>event.preventDefault()}><button onClick={()=>run(saveNote(true))} disabled={noteSaving}><Highlighter size={16}/>高亮</button><button onClick={newNote}><StickyNote size={16}/>添加笔记</button><button aria-label="关闭选区操作" onClick={clearSelection}><X size={14}/></button></div>}
    {undo&&<div className="undo-toast" role="status">{undo.label}<button onClick={()=>{const action=undo.action;setUndo(null);run(action());}}>撤销</button></div>}
    {settings&&<Modal title="阅读设置" onClose={()=>setSettings(false)}><div className="reading-settings">
      <div className="setting-intro"><Columns2 size={20}/><p>找到属于你的阅读节奏。<small>设置自动应用于 PDF 图书，独立保存。</small></p></div>
      <fieldset><legend>阅读配色</legend><div className="theme-cards">{THEMES.map(item=><button key={item.id} aria-label={`选择${item.name}`} aria-pressed={preferences.theme===item.id} className={preferences.theme===item.id?'chosen':''} style={{background:item.background,color:item.text}} onClick={()=>updatePrefs({theme:item.id})}><span>阅</span><small>{item.name}</small>{preferences.theme===item.id&&<Check size={14}/>}</button>)}</div></fieldset>
      <div className="custom-colors"><label>自定义背景<input type="color" aria-label="自定义背景颜色" value={preferences.customBackground} onChange={event=>updatePrefs({theme:'custom',customBackground:event.target.value})}/></label><label>文字颜色<select aria-label="文字颜色模式" value={preferences.customText==='auto'?'auto':'custom'} onChange={event=>updatePrefs({theme:'custom',customText:event.target.value==='auto'?'auto':'#344535'})}><option value="auto">自动适配</option><option value="custom">自选颜色</option></select></label>{preferences.customText!=='auto'&&<input type="color" aria-label="自定义文字颜色" value={preferences.customText} onChange={event=>updatePrefs({theme:'custom',customText:event.target.value})}/>}</div>
      {preferences.theme==='custom'&&<small className={contrast(theme.background,theme.text)<4.5?'contrast-low':'setting-help'}>文字对比度 {contrast(theme.background,theme.text).toFixed(1)}:1{contrast(theme.background,theme.text)<4.5?' · 建议使用自动文字颜色，提高可读性':' · 清晰可读'}</small>}
      <fieldset className="pdf-view-options"><legend>PDF 版式</legend><div className="mode-options"><button aria-pressed={!textMode} className={!textMode?'chosen':''} onClick={()=>updatePrefs({viewMode:'original'})}><BookOpen size={19}/><span>原始版面<small>保留图像、表格与文件原有排版</small></span></button><button aria-pressed={textMode} className={textMode?'chosen':''} disabled={!pdf.canCopy} onClick={()=>updatePrefs({viewMode:'text'})}><List size={19}/><span>文字重排<small>提取文字，调整字号、字体和行距</small></span></button></div><p className="setting-help">{textMode?'文字重排按 PDF 提取顺序展示正文，不保留复杂表格与图片；扫描页请切回原始版面。':'PDF 原始版面保持固定字体和文档配色。切换文字重排后可调整字体、字号、行距与正文配色；扫描页使用区域笔记。'}</p></fieldset>
      <div className="setting-grid"><label>字号 <output>{preferences.fontSize}px</output><input aria-label="设置字号" type="range" min="14" max="40" disabled={!textMode} value={preferences.fontSize} onChange={event=>updatePrefs({fontSize:Number(event.target.value)})}/></label><label>正文宽度 <output>{preferences.contentWidth}px</output><input aria-label="设置正文宽度" type="range" min="480" max="1400" step="20" value={preferences.contentWidth} onChange={event=>updatePrefs({contentWidth:Number(event.target.value)})}/></label><label>字体<select aria-label="字体" disabled={!textMode} value={preferences.fontFamily} onChange={event=>updatePrefs({fontFamily:event.target.value as Preferences['fontFamily']})}><option value="serif">系统宋体</option><option value="sans">系统黑体</option><option value="original">系统默认</option></select></label><label>行间距<select aria-label="行间距" disabled={!textMode} value={preferences.lineHeight} onChange={event=>updatePrefs({lineHeight:Number(event.target.value)})}>{[1.4,1.6,1.8,2,2.2].map(value=><option key={value} value={value}>{value} 倍</option>)}</select></label></div>
      <fieldset><legend>阅读模式</legend><div className="mode-options"><button aria-pressed={preferences.readingMode==='paginated'} className={preferences.readingMode==='paginated'?'chosen':''} onClick={()=>updatePrefs({readingMode:'paginated'})}><Columns2 size={19}/><span>分页阅读<small>按 PDF 原页逐页阅读</small></span></button><button aria-pressed={preferences.readingMode==='scrolled'} className={preferences.readingMode==='scrolled'?'chosen':''} onClick={()=>updatePrefs({readingMode:'scrolled'})}><List size={19}/><span>纵向滚动<small>连续阅读，按需渲染相邻书页</small></span></button></div></fieldset>
      <p className="storage-usage">{storageUsage}<small>图书、书签与笔记保存在本机。清除本地应用或站点数据会删除这些内容。</small></p><div className="settings-bottom"><button className="text-button" onClick={()=>updatePrefs({...DEFAULT_PREFERENCES,viewMode:'original'})}>恢复默认设置</button><button className="primary-button" onClick={()=>setSettings(false)}>完成</button></div>
    </div></Modal>}
    {editor&&<Modal title={editor.existing?'编辑笔记':'写下此刻的想法'} onClose={closeEditor}><div className="note-editor"><blockquote>{editor.existing?.quote??editor.selection?.quote}</blockquote><label htmlFor="pdf-note-text">我的笔记</label><textarea id="pdf-note-text" aria-label="笔记内容" autoFocus maxLength={20000} value={draft} placeholder="这一段，让你想到了什么？" onChange={event=>setDraft(event.target.value)}/><div className="note-colors"><span>高亮颜色</span>{COLORS.map(value=><button key={value} aria-label={`高亮颜色${value}`} aria-pressed={color===value} style={{background:value}} onClick={()=>setColor(value)}>{color===value&&<Check size={14}/>}</button>)}<small>{draft.length}/20000</small></div><div className="note-editor-actions">{editor.existing&&<button className="danger-text" onClick={()=>run(removeNote(editor.existing!))} disabled={noteSaving}><Trash2 size={15}/><span>删除记录</span></button>}<button className="secondary-button" disabled={noteSaving} onClick={closeEditor}>取消</button><button className="primary-button" disabled={noteSaving} onClick={()=>run(saveNote())}>{noteSaving?'保存中…':'保存笔记'}</button></div></div></Modal>}
    {matching&&<Modal title="这里记录了这些想法" onClose={()=>setMatching(null)}><div className="overlap-notes">{matching.map(id=>notes.find(note=>note.id===id)).filter((note):note is PdfAnnotation=>!!note).map(note=><button key={note.id} onClick={()=>{setMatching(null);edit(note);}}><blockquote>{note.quote}</blockquote><p>{note.note||'仅高亮'}</p></button>)}</div></Modal>}
  </div>;
}

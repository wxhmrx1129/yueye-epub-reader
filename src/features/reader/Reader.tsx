import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowLeft, Bookmark as BookmarkIcon, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, Highlighter, List, Maximize, Minimize, Minus, PanelLeftClose, Plus, Settings2, StickyNote, Trash2, X } from 'lucide-react';
import type { Annotation, BookRecord, Bookmark, PageEntry, ParsedBook, Preferences, ReaderPosition, ReadingProgress, TextSelection, TocItem } from '../../types';
import { DEFAULT_PREFERENCES, THEMES, contrast, normalizePreferences, themeFor } from '../../preferences';
import { ReaderAdapter } from '../../services/epub/reader';
import * as storage from '../../services/storage';
import { registerBeforeClose } from '../../services/desktop';
import { Modal } from '../../components/Modal';
import './reader.css';

interface Props { book:BookRecord; parsed:ParsedBook; initialProgress?:ReadingProgress; preferences:Preferences; onPreferences:(p:Preferences)=>void; onBack:()=>void; onError:(message:string)=>void }
const COLORS=['#e8c96d','#a9cba0','#c1b1de'];
function Tool({label,children,onClick,active,disabled,className=''}:{label:string;children:ReactNode;onClick:()=>void;active?:boolean;disabled?:boolean;className?:string}){
  return <button type="button" className={`reader-tool ${active?'active':''} ${className}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}
function NumericSetting({label,value,min,max,step=1,onCommit}:{label:string;value:number;min:number;max:number;step?:number;onCommit:(value:number)=>void}){
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  function commit(){const number=Number(draft);const next=draft.trim()&&Number.isFinite(number)?Math.max(min,Math.min(max,Math.round(number/step)*step)):value;setDraft(String(next));onCommit(next);}
  return <input aria-label={label} type="number" min={min} max={max} step={step} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commit();}if(e.key==='Escape')setDraft(String(value));}}/>;
}
function flattenToc(items:TocItem[]):TocItem[]{return items.flatMap(item=>[item,...flattenToc(item.children)]);}
function Toc({items,current,onGo,closed,toggle,depth=0}:{items:TocItem[];current:string;onGo:(href:string)=>void;closed:Set<string>;toggle:(id:string)=>void;depth?:number}){
  return <ul className="toc-list">{items.map(item=><li key={item.id}>
    <div className={`toc-row ${item.id===current?'current':''}`} style={{paddingLeft:12+depth*15}}>
      {item.children.length>0?<button aria-expanded={!closed.has(item.id)} aria-label={`${closed.has(item.id)?'展开':'折叠'}${item.label}`} className={`toc-arrow ${closed.has(item.id)?'closed':''}`} onClick={()=>toggle(item.id)}><ChevronDown size={14}/></button>:<span className="toc-indent"/>}
      <button className="toc-title" aria-current={item.id===current?'location':undefined} title={item.label} onClick={()=>item.href?onGo(item.href):toggle(item.id)}>{item.label}</button>
    </div>
    {!!item.children.length&&!closed.has(item.id)&&<Toc items={item.children} current={current} onGo={onGo} closed={closed} toggle={toggle} depth={depth+1}/>}
  </li>)}</ul>;
}

export function Reader({book,parsed,initialProgress,preferences,onPreferences,onBack,onError}:Props){
  const root=useRef<HTMLDivElement>(null),host=useRef<HTMLDivElement>(null),adapter=useRef<ReaderAdapter|null>(null);
  const callbacks=useRef({onError,onPreferences});callbacks.current={onError,onPreferences};
  const [position,setPosition]=useState<ReaderPosition>();
  const currentPosition=useRef<ReaderPosition|undefined>(undefined);
  const [tab,setTab]=useState<'toc'|'bookmarks'|'notes'>('toc');
  const [closedToc,setClosedToc]=useState<Set<string>>(new Set());
  const navigation=useRef<HTMLElement>(null);
  const [storageUsage,setStorageUsage]=useState('正在估算本地存储…');
  const [bookmarks,setBookmarks]=useState<Bookmark[]>([]),[notes,setNotes]=useState<Annotation[]>([]);
  const [pages,setPages]=useState<PageEntry[]|null>(null),[indexCount,setIndexCount]=useState([0,parsed.chapters.length]);
  const [pageInput,setPageInput]=useState(''),[pageError,setPageError]=useState('');
  const [settings,setSettings]=useState(false),[full,setFull]=useState(false),[loading,setLoading]=useState(true);
  const [selection,setSelection]=useState<TextSelection|null>(null);
  const [editor,setEditor]=useState<{existing?:Annotation;selection?:TextSelection}|null>(null);
  const [draft,setDraft]=useState(''),[color,setColor]=useState(COLORS[0]),[noteSaving,setNoteSaving]=useState(false);
  const [matching,setMatching]=useState<string[]|null>(null);
  const [saveState,setSaveState]=useState('已保存'),[slider,setSlider]=useState<number|null>(null);
  const [undo,setUndo]=useState<{label:string;action:()=>Promise<void>}|null>(null);
  const saveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),saveQueue=useRef(Promise.resolve()),saveVersion=useRef(0);
  const prefsRef=useRef(preferences);prefsRef.current=preferences;
  const notesRef=useRef(notes);notesRef.current=notes;

  function updatePrefs(patch:Partial<Preferences>){onPreferences(normalizePreferences({...preferences,...patch}));}
  function report(error:unknown){onError(error instanceof Error?error.message:'操作失败，请重试。');}
  function run(promise:Promise<unknown>|undefined){void promise?.catch(report);}
  async function persist(){
    clearTimeout(saveTimer.current);
    const value=currentPosition.current;if(!value)return;
    const version=++saveVersion.current;
    const progress:ReadingProgress={bookId:book.id,cfi:value.cfi,href:value.href,spineIndex:value.spineIndex,progression:value.progression,quoteContext:value.quoteContext,chapterTitle:value.chapterTitle,isFinished:value.isFinished,updatedAt:Date.now()};
    setSaveState('保存中');
    const job=saveQueue.current.catch(()=>{}).then(()=>storage.saveProgress(progress));saveQueue.current=job;
    try{await job;if(version===saveVersion.current)setSaveState('已保存');}
    catch(error){setSaveState('尚未保存 · 点击重试');throw error;}
  }
  const persistRef=useRef(persist);persistRef.current=persist;
  useEffect(()=>registerBeforeClose(()=>persistRef.current()),[]);
  useEffect(()=>{
    let active=true;
    void Promise.all([storage.listBookmarks(book.id),storage.listAnnotations(book.id)]).then(([marks,annotations])=>{if(active){setBookmarks(marks);setNotes(annotations);adapter.current?.setAnnotations(annotations);}}).catch(error=>callbacks.current.onError(String(error)));
    const reader=new ReaderAdapter(host.current!,parsed,prefsRef.current,{
      position:value=>{
        if(!active)return;currentPosition.current=value;setPosition(value);setLoading(false);
        setPageInput(value.page?String(value.page):'');setSaveState('待保存');clearTimeout(saveTimer.current);
        saveTimer.current=setTimeout(()=>{void persistRef.current().catch(error=>callbacks.current.onError(error instanceof Error?error.message:'进度保存失败'));},350);
      },
      index:(value,done,total)=>{if(active){setPages(value);setIndexCount([done,total]);}},
      selection:value=>{if(active)setSelection(value);},
      annotation:ids=>{if(!active)return;if(ids.length===1){const note=notesRef.current.find(n=>n.id===ids[0]);if(note){setEditor({existing:note});setDraft(note.note);setColor(note.color);}}else setMatching(ids);},
      error:message=>{if(active){setLoading(false);callbacks.current.onError(message);}},
      loadIndex:async signature=>(await storage.getPageIndex(book.id,signature))?.pages,
      saveIndex:async(signature,entries)=>storage.putPageIndex({id:book.id,bookId:book.id,signature,pages:entries}),
    });
    adapter.current=reader;reader.setAnnotations(notesRef.current);
    void reader.open(initialProgress).catch(error=>{if(active){setLoading(false);callbacks.current.onError(error instanceof Error?error.message:'无法打开正文');}});
    const visibility=()=>{if(document.visibilityState==='hidden')void persistRef.current().catch(()=>{});};
    document.addEventListener('visibilitychange',visibility);
    return()=>{active=false;clearTimeout(saveTimer.current);document.removeEventListener('visibilitychange',visibility);reader.destroy();adapter.current=null;};
  },[book.id,parsed,initialProgress]);
  useEffect(()=>{adapter.current?.setPreferences(preferences);},[preferences]);
  useEffect(()=>{adapter.current?.setAnnotations(notes);},[notes]);
  useEffect(()=>{
    if(tab==='toc'&&preferences.sidebarOpen)navigation.current?.querySelector('.toc-row.current')?.scrollIntoView({block:'nearest'});
  },[position?.href,tab,preferences.sidebarOpen]);
  useEffect(()=>{
    if(!settings)return;
    if(!navigator.storage?.estimate){setStorageUsage('当前环境无法估算存储用量');return;}
    void navigator.storage.estimate().then(estimate=>setStorageUsage(`本地数据约占用 ${((estimate.usage??0)/1024/1024).toFixed(1)} MB · 可用配额约 ${((estimate.quota??0)/1024/1024/1024).toFixed(1)} GB`)).catch(()=>setStorageUsage('暂时无法估算本地存储用量'));
  },[settings]);
  useEffect(()=>{if(!undo)return;const timer=setTimeout(()=>setUndo(null),8000);return()=>clearTimeout(timer);},[undo]);
  useEffect(()=>{
    const change=()=>setFull(document.fullscreenElement===root.current);document.addEventListener('fullscreenchange',change);return()=>document.removeEventListener('fullscreenchange',change);
  },[]);
  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      if(settings||editor||matching||selection||preferences.readingMode!=='paginated'||event.metaKey||event.ctrlKey||event.altKey)return;
      if((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"],dialog'))return;
      if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();run(adapter.current?.next());}
      if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();run(adapter.current?.previous());}
    };
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  });
  async function back(){try{await persist();if(document.fullscreenElement)await document.exitFullscreen();onBack();}catch(error){report(error);}}
  async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else if(root.current?.requestFullscreen)await root.current.requestFullscreen();else onError('当前环境不支持阅读全屏，请尝试最大化窗口。');}catch{onError('未能进入全屏，请重试或最大化窗口。');}}
  function showTab(next:typeof tab){if(tab===next&&preferences.sidebarOpen)updatePrefs({sidebarOpen:false});else{setTab(next);updatePrefs({sidebarOpen:true});}}
  function go(target:string,quote?:string){run(adapter.current?.goTo(target,quote));if(window.innerWidth<1024)updatePrefs({sidebarOpen:false});}
  async function toggleBookmark(){
    if(!position)return;
    const old=bookmarks.find(b=>b.cfi===position.cfi);
    try{
      if(old){await storage.deleteBookmark(old.id);setBookmarks(all=>all.filter(b=>b.id!==old.id));setUndo({label:'书签已移除',action:async()=>{await storage.putBookmark(old);setBookmarks(all=>[...all,old]);}});}
      else{const mark:Bookmark={id:crypto.randomUUID(),bookId:book.id,cfi:position.cfi,href:position.href,chapterTitle:position.chapterTitle,excerpt:position.quoteContext||position.chapterTitle,createdAt:Date.now()};await storage.putBookmark(mark);setBookmarks(all=>[...all,mark]);}
    }catch(error){report(error);}
  }
  async function removeBookmark(mark:Bookmark){try{await storage.deleteBookmark(mark.id);setBookmarks(all=>all.filter(b=>b.id!==mark.id));setUndo({label:'书签已移除',action:async()=>{await storage.putBookmark(mark);setBookmarks(all=>[...all,mark]);}});}catch(error){report(error);}}
  function edit(note:Annotation){setEditor({existing:note});setDraft(note.note);setColor(note.color);}
  function newNote(){if(!selection)return;setEditor({selection});setDraft('');setColor(COLORS[0]);setSelection(null);}
  function closeEditor(){if(noteSaving)return;if((draft!==(editor?.existing?.note??'')||color!==(editor?.existing?.color??COLORS[0]))&&!window.confirm('笔记尚未保存，确定放弃修改吗？'))return;setEditor(null);}
  async function saveNote(highlightOnly=false){
    const existing=editor?.existing,selected=highlightOnly?selection:editor?.selection;
    if(!existing&&!selected)return;
    setNoteSaving(true);
    try{
      const now=Date.now();
      const note:Annotation=existing?{...existing,note:draft,color,updatedAt:now}:{...selected!,id:crypto.randomUUID(),bookId:book.id,note:highlightOnly?'':draft,color:highlightOnly?COLORS[0]:color,createdAt:now,updatedAt:now};
      await storage.putAnnotation(note);setNotes(all=>existing?all.map(n=>n.id===note.id?note:n):[...all,note]);setEditor(null);adapter.current?.clearSelection();
    }catch(error){report(error);}finally{setNoteSaving(false);}
  }
  async function removeNote(note:Annotation){try{await storage.deleteAnnotation(note.id);setNotes(all=>all.filter(n=>n.id!==note.id));setEditor(null);setUndo({label:'笔记与高亮已移除',action:async()=>{await storage.putAnnotation(note);setNotes(all=>[...all,note]);}});}catch(error){report(error);}}
  const theme=themeFor(preferences);
  const variables={'--reader-bg':theme.background,'--reader-ink':theme.text,'--reader-surface':theme.surface,'--reader-muted':theme.muted,'--reader-border':theme.border,colorScheme:['night','graphite'].includes(preferences.theme)?'dark':'light'} as CSSProperties;
  const hasBookmark=bookmarks.some(mark=>mark.cfi===position?.cfi);
  const chapterItems=flattenToc(parsed.toc).filter(item=>item.href?.split('#')[0]===position?.href);
  const currentTocId=(chapterItems.find(item=>!item.href.includes('#'))??chapterItems[0])?.id??'';
  function toggleToc(id:string){setClosedToc(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});}
  const sortedMarks=[...bookmarks].sort((a,b)=>new Date(a.createdAt).getTime()-new Date(b.createdAt).getTime());
  sortedMarks.sort((a,b)=>{try{return parsed.chapters.findIndex(c=>c.href===a.href)-parsed.chapters.findIndex(c=>c.href===b.href)||a.cfi.localeCompare(b.cfi,undefined,{numeric:true});}catch{return 0;}});
  return <div ref={root} className="reader" style={variables} data-testid="reader">
    <header className="reader-toolbar">
      <div className="reader-identity"><Tool label="返回书架" onClick={()=>void back()}><ArrowLeft size={19}/></Tool><span className="reader-brand"><BookOpen size={21}/>阅野</span><span className="toolbar-book-title" title={book.title}>{book.title}</span></div>
      <div className="toolbar-section sidebar-tools">
        <Tool label="目录" active={preferences.sidebarOpen&&tab==='toc'} onClick={()=>showTab('toc')}><List size={19}/></Tool>
        <Tool label="书签列表" active={preferences.sidebarOpen&&tab==='bookmarks'} onClick={()=>showTab('bookmarks')}><BookmarkIcon size={18}/></Tool>
        <Tool label="笔记列表" active={preferences.sidebarOpen&&tab==='notes'} onClick={()=>showTab('notes')}><StickyNote size={18}/></Tool>
      </div>
      <div className="toolbar-section quick-themes"><span className="toolbar-caption">配色</span>{THEMES.map(t=><button key={t.id} className={`theme-dot ${preferences.theme===t.id?'selected':''}`} style={{background:t.background}} title={t.name} aria-label={`${t.name}配色`} aria-pressed={preferences.theme===t.id} onClick={()=>updatePrefs({theme:t.id})}>{preferences.theme===t.id&&<Check size={11} color={t.text}/>}</button>)}</div>
      <div className="toolbar-section font-control"><span className="toolbar-caption">字号</span><Tool label="减小字号" disabled={preferences.fontSize<=14} onClick={()=>updatePrefs({fontSize:preferences.fontSize-1})}><Minus size={14}/></Tool><NumericSetting label="字号" min={14} max={40} value={preferences.fontSize} onCommit={value=>updatePrefs({fontSize:value})}/><Tool label="增大字号" disabled={preferences.fontSize>=40} onClick={()=>updatePrefs({fontSize:preferences.fontSize+1})}><Plus size={14}/></Tool></div>
      <div className="toolbar-section width-control"><span className="toolbar-caption">宽度</span><Tool label="减小宽度" disabled={preferences.contentWidth<=480} onClick={()=>updatePrefs({contentWidth:preferences.contentWidth-20})}><Minus size={14}/></Tool><NumericSetting label="正文宽度" min={480} max={1400} step={20} value={preferences.contentWidth} onCommit={value=>updatePrefs({contentWidth:value})}/><Tool label="增大宽度" disabled={preferences.contentWidth>=1400} onClick={()=>updatePrefs({contentWidth:preferences.contentWidth+20})}><Plus size={14}/></Tool></div>
      <div className="toolbar-section page-control">
        <Tool label="上一页" disabled={loading} onClick={()=>run(adapter.current?.previous())}><ChevronLeft size={18}/></Tool>
        {preferences.readingMode==='paginated'?<form onSubmit={e=>{e.preventDefault();if(!/^\d+$/.test(pageInput)||Number(pageInput)<1||Number(pageInput)>(pages?.length??0)){setPageError(`请输入 1–${pages?.length??0} 之间的整数页码`);return;}setPageError('');run(adapter.current?.goToPage(Number(pageInput)));}}>
          <input aria-label="跳转页码" title="输入页码后按 Enter，页码随排版变化" inputMode="numeric" disabled={!pages} value={pageInput} placeholder="—" onChange={e=>{setPageInput(e.target.value);setPageError('');}}/><span className="page-total">/ {pages?.length??'—'}</span>
        </form>:<span className="scroll-mode-label">滚动阅读</span>}
        <Tool label="下一页" disabled={loading} onClick={()=>run(adapter.current?.next())}><ChevronRight size={18}/></Tool>
        {pageError&&<div className="page-error" role="alert">{pageError}</div>}
      </div>
      <div className="toolbar-section toolbar-end"><Tool label={hasBookmark?'取消当前位置书签':'添加书签'} active={hasBookmark} disabled={!position} onClick={()=>void toggleBookmark()}><BookmarkIcon size={18} fill={hasBookmark?'currentColor':'none'}/></Tool><Tool label="阅读设置" active={settings} onClick={()=>setSettings(true)}><Settings2 size={19}/><span className="setting-label">设置</span></Tool><Tool label={full?'退出全屏':'进入全屏'} onClick={()=>void fullscreen()}>{full?<Minimize size={18}/>:<Maximize size={18}/>}</Tool></div>
    </header>
    <div className="reader-workspace">
      {preferences.sidebarOpen&&<><button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={()=>updatePrefs({sidebarOpen:false})}/><aside className="reader-sidebar">
        <div className="sidebar-heading"><span>{tab==='toc'?'目 录':tab==='bookmarks'?'书 签':'笔 记'}<small>{tab==='toc'?parsed.chapters.length:tab==='bookmarks'?bookmarks.length:notes.length}</small></span>{tab==='bookmarks'&&<Tool label={hasBookmark?'移除这一页的书签':'记录这一页'} active={hasBookmark} disabled={!position} onClick={()=>void toggleBookmark()}><BookmarkIcon size={17}/></Tool>}<Tool label="收起侧栏" onClick={()=>updatePrefs({sidebarOpen:false})}><PanelLeftClose size={17}/></Tool></div>
        <div className="sidebar-book"><span>{book.title}</span><small>{book.author}</small></div>
        <nav ref={navigation} className="sidebar-content" aria-label={tab==='toc'?'书籍目录':tab==='bookmarks'?'书签':'笔记'}>
          {tab==='toc'?<Toc items={parsed.toc} current={currentTocId} onGo={go} closed={closedToc} toggle={toggleToc}/>:tab==='bookmarks'?sortedMarks.length?sortedMarks.map(mark=><article className="saved-item" key={mark.id}><button className="saved-content" onClick={()=>go(mark.cfi,mark.excerpt)}><span className="saved-chapter"><BookmarkIcon size={13}/>{mark.chapterTitle}</span><p>{mark.excerpt}</p><time>{new Date(mark.createdAt).toLocaleDateString('zh-CN')}</time></button><button className="saved-delete" aria-label="删除书签" onClick={()=>void removeBookmark(mark)}><Trash2 size={14}/></button></article>):<div className="sidebar-empty"><BookmarkIcon size={28}/><p>留住想再读的一页</p><small>点击工具栏的书签图标，即可记录当前位置。</small></div>:notes.length?[...notes].sort((a,b)=>b.createdAt-a.createdAt).map(note=><article className="saved-item note-item" key={note.id}><button className="saved-content" onClick={()=>{go(note.rangeCfi,note.quote);}}><span className="saved-chapter"><i style={{background:note.color}}/>{note.chapterTitle}</span><blockquote>{note.quote}</blockquote>{note.note&&<p>{note.note}</p>}<time>{new Date(note.updatedAt).toLocaleDateString('zh-CN')}</time></button><div className="note-item-actions"><button onClick={()=>edit(note)}>编辑</button><button aria-label="删除笔记" onClick={()=>void removeNote(note)}><Trash2 size={14}/></button></div></article>):<div className="sidebar-empty"><Highlighter size={28}/><p>让想法在这里生长</p><small>选中正文文字，添加高亮或写下你的笔记。</small></div>}
        </nav>
        <div className="sidebar-bottom"><span className="quiet-dot"/>只在你的设备中保存</div>
      </aside></>}
      <main className="reading-canvas"><div className="reading-paper" style={{width:preferences.contentWidth}}><div className="book-host" ref={host}/>{loading&&<div className="reader-loading"><span className="spinner"/>正在打开书页…</div>}</div></main>
    </div>
    <footer className="reader-footer"><span className="footer-chapter" title={position?.chapterTitle}>{position?.chapterTitle??book.title}</span><div className="progress-navigation"><span>{Math.round((slider??position?.progression??0)*100)}%</span><input type="range" aria-label="阅读进度" min="0" max="1000" step="1" disabled={!position} value={Math.round((slider??position?.progression??0)*1000)} onChange={e=>setSlider(Number(e.target.value)/1000)} onPointerUp={e=>{run(adapter.current?.goToProgress(Number(e.currentTarget.value)/1000));setSlider(null);}} onKeyUp={e=>{if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key)){run(adapter.current?.goToProgress(Number(e.currentTarget.value)/1000));setSlider(null);}}}/></div><div className="reader-save-info">{preferences.readingMode==='paginated'&&!pages&&indexCount[1]>0?<span className="index-state">计算页码 {indexCount[0]}/{indexCount[1]}</span>:<span className="layout-hint">{preferences.readingMode==='paginated'?'页码随排版变化':'纵向滚动'}</span>}<button onClick={()=>run(persist())} className={saveState.startsWith('尚未')?'save-failed':''}><span className="quiet-dot"/>{saveState}</button></div></footer>
    {selection&&!editor&&<div className="selection-toolbar" style={{left:Math.min(selection.x,window.innerWidth-240),top:Math.max(64,Math.min(selection.y+10,window.innerHeight-62))}} onMouseDown={e=>e.preventDefault()}><button onClick={()=>void saveNote(true)} disabled={noteSaving}><Highlighter size={16}/>高亮</button><button onClick={newNote}><StickyNote size={16}/>添加笔记</button><button aria-label="关闭选区操作" onClick={()=>adapter.current?.clearSelection()}><X size={14}/></button></div>}
    {undo&&<div className="undo-toast" role="status">{undo.label}<button onClick={()=>{const action=undo.action;setUndo(null);run(action());}}>撤销</button></div>}
    {settings&&<Modal title="阅读设置" onClose={()=>setSettings(false)}><div className="reading-settings">
      <div className="setting-intro"><Columns2 size={20}/><p>找到属于你的阅读节奏。<small>设置自动应用于所有图书。</small></p></div>
      <fieldset><legend>阅读配色</legend><div className="theme-cards">{THEMES.map(t=><button key={t.id} aria-label={`选择${t.name}`} aria-pressed={preferences.theme===t.id} className={preferences.theme===t.id?'chosen':''} style={{background:t.background,color:t.text}} onClick={()=>updatePrefs({theme:t.id})}><span>阅</span><small>{t.name}</small>{preferences.theme===t.id&&<Check size={14}/>}</button>)}</div></fieldset>
      <div className="custom-colors"><label>自定义背景<input type="color" aria-label="自定义背景颜色" value={preferences.customBackground} onChange={e=>updatePrefs({theme:'custom',customBackground:e.target.value})}/></label><label>文字颜色<select aria-label="文字颜色模式" value={preferences.customText==='auto'?'auto':'custom'} onChange={e=>updatePrefs({theme:'custom',customText:e.target.value==='auto'?'auto':'#344535'})}><option value="auto">自动适配</option><option value="custom">自选颜色</option></select></label>{preferences.customText!=='auto'&&<input type="color" aria-label="自定义文字颜色" value={preferences.customText} onChange={e=>updatePrefs({theme:'custom',customText:e.target.value})}/>}</div>
      {preferences.theme==='custom'&&<small className={contrast(theme.background,theme.text)<4.5?'contrast-low':'setting-help'}>文字对比度 {contrast(theme.background,theme.text).toFixed(1)}:1{contrast(theme.background,theme.text)<4.5?' · 建议使用自动文字颜色，提高可读性':' · 清晰可读'}</small>}
      <div className="setting-grid"><label>字号 <output>{preferences.fontSize}px</output><input aria-label="设置字号" type="range" min="14" max="40" value={preferences.fontSize} onChange={e=>updatePrefs({fontSize:Number(e.target.value)})}/></label><label>正文宽度 <output>{preferences.contentWidth}px</output><input aria-label="设置正文宽度" type="range" min="480" max="1400" step="20" value={preferences.contentWidth} onChange={e=>updatePrefs({contentWidth:Number(e.target.value)})}/></label><label>字体<select aria-label="字体" value={preferences.fontFamily} onChange={e=>updatePrefs({fontFamily:e.target.value as Preferences['fontFamily']})}><option value="serif">系统宋体</option><option value="sans">系统黑体</option><option value="original">跟随原书</option></select></label><label>行间距<select aria-label="行间距" value={preferences.lineHeight} onChange={e=>updatePrefs({lineHeight:Number(e.target.value)})}>{[1.4,1.6,1.8,2,2.2].map(v=><option key={v} value={v}>{v} 倍</option>)}</select></label></div>
      <fieldset><legend>阅读模式</legend><div className="mode-options"><button aria-pressed={preferences.readingMode==='paginated'} className={preferences.readingMode==='paginated'?'chosen':''} onClick={()=>updatePrefs({readingMode:'paginated'})}><Columns2 size={19}/><span>分页阅读<small>一页一页，从容读下去</small></span></button><button aria-pressed={preferences.readingMode==='scrolled'} className={preferences.readingMode==='scrolled'?'chosen':''} onClick={()=>updatePrefs({readingMode:'scrolled'})}><List size={19}/><span>纵向滚动<small>连续阅读当前章节</small></span></button></div></fieldset>
      <p className="storage-usage">{storageUsage}<small>图书与记录保存在本机。清除本地应用或站点数据会删除这些内容。</small></p><div className="settings-bottom"><button className="text-button" onClick={()=>onPreferences({...DEFAULT_PREFERENCES})}>恢复默认设置</button><button className="primary-button" onClick={()=>setSettings(false)}>完成</button></div>
    </div></Modal>}
    {editor&&<Modal title={editor.existing?'编辑笔记':'写下此刻的想法'} onClose={closeEditor}><div className="note-editor"><blockquote>{editor.existing?.quote??editor.selection?.quote}</blockquote><label htmlFor="note-text">我的笔记</label><textarea id="note-text" aria-label="笔记内容" value={draft} autoFocus maxLength={20000} placeholder="这一段，让你想到了什么？" onChange={e=>setDraft(e.target.value)}/><div className="note-colors"><span>高亮颜色</span>{COLORS.map(value=><button key={value} aria-label={`高亮颜色${value}`} aria-pressed={color===value} style={{background:value}} onClick={()=>setColor(value)}>{color===value&&<Check size={14}/>}</button>)}<small>{draft.length}/20000</small></div><div className="note-editor-actions">{editor.existing&&<button className="danger-text" onClick={()=>void removeNote(editor.existing!)} disabled={noteSaving}><Trash2 size={15}/>删除记录</button>}<button className="secondary-button" onClick={closeEditor}>取消</button><button className="primary-button" disabled={noteSaving} onClick={()=>void saveNote()}>{noteSaving?'保存中…':'保存笔记'}</button></div></div></Modal>}
    {matching&&<Modal title="这里记录了这些想法" onClose={()=>setMatching(null)}><div className="overlap-notes">{matching.map(id=>notes.find(n=>n.id===id)).filter((note):note is Annotation=>!!note).map(note=><button key={note.id} onClick={()=>{setMatching(null);edit(note);}}><blockquote>{note.quote}</blockquote><p>{note.note||'仅高亮'}</p></button>)}</div></Modal>}
  </div>;
}

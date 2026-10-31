import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, BookOpen, Check, Trash2, X } from 'lucide-react';
import { Library } from './features/library/Library';
import { Reader } from './features/reader/Reader';
import { Modal } from './components/Modal';
import type { BookRecord, ParsedBook, Preferences, ReadingProgress, PdfProgress } from './types';
import type { PdfDocument } from './services/pdf/document';
import { DEFAULT_PREFERENCES } from './preferences';
import * as storage from './services/storage';
import { parseEpub } from './services/epub/import';
import { demoFile } from './demo';
import { registerBeforeClose } from './services/desktop';

const PdfReader = lazy(()=>import('./features/pdf/PdfReader').then(module=>({default:module.PdfReader})));
type OpenBook = {format:'epub';book:BookRecord;parsed:ParsedBook;progress?:ReadingProgress} | {format:'pdf';book:BookRecord;pdf:PdfDocument;progress?:PdfProgress};
function errorMessage(error:unknown){
  if(error instanceof Error){if(error.name==='QuotaExceededError')return '本地存储空间不足，请移除暂不阅读的图书后重试。';return error.message;}
  return '操作未完成，请重试。';
}
function Toast({message,onClose}:{message:{text:string;error:boolean};onClose:()=>void}){
  const [target,setTarget]=useState<Element>(document.fullscreenElement??document.body);
  useEffect(()=>{const handler=()=>setTarget(document.fullscreenElement??document.body);document.addEventListener('fullscreenchange',handler);return()=>document.removeEventListener('fullscreenchange',handler);},[]);
  return createPortal(<div className={`app-toast ${message.error?'error':''}`} role={message.error?'alert':'status'}>{message.error?<AlertCircle size={17}/>:<Check size={17}/>}<span>{message.text}</span><button aria-label="关闭提示" onClick={onClose}><X size={15}/></button></div>,target);
}
async function acquireBook(id:string):Promise<()=>void>{
  if(!navigator.locks)throw new Error('当前环境不支持安全的阅读会话，请更新客户端，或使用新版 Chrome / Edge 通过本地服务器打开网页版。');
  return new Promise((resolve,reject)=>{
    void navigator.locks.request(`yueye-book-${id}`,{ifAvailable:true},async lock=>{
      if(!lock){reject(new Error('这本书已在另一个页面打开，请返回原页面，或关闭原页面后重试。'));return;}
      await new Promise<void>(release=>resolve(release));
    }).catch(reject);
  });
}

export default function App(){
  const [books,setBooks]=useState<BookRecord[]>([]),[preferences,setPreferences]=useState<Preferences>(DEFAULT_PREFERENCES);
  const [current,setCurrent]=useState<OpenBook|null>(null),[ready,setReady]=useState(false),[opening,setOpening]=useState(false);
  const [importing,setImporting]=useState(false),[importStatus,setImportStatus]=useState('');
  const [removing,setRemoving]=useState<BookRecord|null>(null),[deleting,setDeleting]=useState(false);
  const [message,setMessage]=useState<{text:string;error:boolean}|null>(null);
  const currentRef=useRef<OpenBook|null>(null);currentRef.current=current;
  const importController=useRef<AbortController|null>(null),openController=useRef<AbortController|null>(null);
  const [openStatus,setOpenStatus]=useState('正在打开书籍…');
  const release=useRef<(()=>void)|null>(null),settingsQueue=useRef(Promise.resolve()),openingRef=useRef(false),importingRef=useRef(false);
  const pendingOperations=useRef(new Set<Promise<void>>());
  function beginOperation(){
    let finish!:()=>void;
    const operation=new Promise<void>(resolve=>{finish=resolve;});
    pendingOperations.current.add(operation);
    return ()=>{pendingOperations.current.delete(operation);finish();};
  }
  useEffect(()=>registerBeforeClose(async()=>{
    importController.current?.abort();openController.current?.abort();
    while(pendingOperations.current.size)await Promise.all([...pendingOperations.current]);
    await settingsQueue.current;
    await storage.flushPendingWrites();
  }),[]);
  const notify=(text:string,error=false)=>setMessage({text,error});
  const refresh=async()=>{setBooks(await storage.listBooks());};
  async function open(book:BookRecord){
    if(openingRef.current)return;openingRef.current=true;setOpening(true);
    const finishOperation=beginOperation();
    let unlock:(()=>void)|undefined;
    const controller=new AbortController();openController.current=controller;setOpenStatus('正在读取图书…');
    try{
      unlock=await acquireBook(book.id);
      const file=await storage.getBookFile(book.id);
      const options={signal:controller.signal,onStage:setOpenStatus};
      let opened:OpenBook;
      if(book.format==='pdf'){
        const progress=await storage.getPdfProgress(book.id);
        const pdf=await (await import('./services/pdf/document')).openPdf(file,book.originalFileName,options);
        opened={format:'pdf',book,pdf,progress};
      }else{
        const progress=await storage.getProgress(book.id);
        const parsed=await parseEpub(file,book.originalFileName,{...options,lazy:true});
        opened={format:'epub',book,parsed,progress};
      }
      release.current?.();release.current=unlock;setCurrent(opened);
      window.history.replaceState(null,'',`#book/${book.id}`);document.title=`${book.title} · 阅野`;
    }catch(error){unlock?.();if(!(error instanceof Error&&error.name==='AbortError'))notify(errorMessage(error),true);window.history.replaceState(null,'',window.location.pathname);}
    finally{openController.current=null;setOpening(false);openingRef.current=false;finishOperation();}
  }
  useEffect(()=>{
    let active=true;
    void Promise.all([storage.listBooks(),storage.getPreferences()]).then(([all,prefs])=>{
      if(!active)return;setBooks(all);setPreferences(prefs);setReady(true);
      const id=window.location.hash.match(/^#book\/(.+)$/)?.[1];
      const book=id?all.find(b=>b.id===id):undefined;if(book)void open(book);
    }).catch(error=>{if(active){setReady(true);notify(`无法读取本地书架：${errorMessage(error)}`,true);}});
    return()=>{active=false;release.current?.();const value=currentRef.current;if(value?.format==='epub')value.parsed.dispose?.();else if(value)void value.pdf.dispose();};
  },[]);
  useEffect(()=>{if(!message)return;const timer=setTimeout(()=>setMessage(null),message.error?9000:5000);return()=>clearTimeout(timer);},[message]);
  function changePreferences(value:Preferences){
    setPreferences(value);const job=settingsQueue.current.catch(()=>{}).then(()=>storage.savePreferences(value));settingsQueue.current=job;
    void job.catch(error=>notify(`设置尚未保存：${errorMessage(error)}`,true));
  }
  async function importFiles(files:File[],demo=false){
    if(importingRef.current||!files.length)return;importingRef.current=true;setImporting(true);
    const controller=new AbortController();importController.current=controller;
    const finishOperation=beginOperation();
    try{
    let successful=0,duplicates=0;const failures:string[]=[];let imported:BookRecord|undefined;
    for(let i=0;i<files.length;i++){
      if(controller.signal.aborted)break;
      setImportStatus(`正在导入 ${i+1}/${files.length} · ${files[i].name}`);
      try{const result=await storage.importBook(files[i],{signal:controller.signal,onStage:stage=>setImportStatus(`${i+1}/${files.length} · ${files[i].name} · ${stage}`)});imported=result.book;if(result.duplicate)duplicates++;else successful++;await refresh();}
      catch(error){if(error instanceof Error&&error.name==='AbortError')break;failures.push(`${files[i].name}：${errorMessage(error)}`);}
    }
    const summary=[successful?`已导入 ${successful} 本`:'',duplicates?`${duplicates} 本已在书架`:'',failures.length?`${failures.length} 本导入失败`:'',controller.signal.aborted?'已停止后续导入（已成功保存的图书保留）':''].filter(Boolean).join('，');
    setImportStatus(summary);setImporting(false);importingRef.current=false;
    notify(failures.length?`${summary}。${failures.join('；')}`:summary,failures.length>0);
    if(demo&&imported&&!controller.signal.aborted)await open(imported);
    }finally{importController.current=null;setImporting(false);importingRef.current=false;finishOperation();}
  }
  async function loadDemo(){const finishOperation=beginOperation();try{await importFiles([await demoFile()],true);}catch(error){notify(errorMessage(error),true);}finally{finishOperation();}}
  function back(){const value=currentRef.current;setCurrent(null);if(value?.format==='epub')value.parsed.dispose?.();else if(value)void value.pdf.dispose().catch(error=>notify(errorMessage(error),true));release.current?.();release.current=null;window.history.replaceState(null,'',window.location.pathname);document.title='阅野 · EPUB / PDF 阅读器';void refresh().catch(error=>notify(errorMessage(error),true));}
  async function remove(){if(!removing)return;setDeleting(true);const finishOperation=beginOperation();let unlock:(()=>void)|undefined;try{unlock=await acquireBook(removing.id);await storage.removeBook(removing.id);await refresh();notify(`已从书架移除《${removing.title}》`);setRemoving(null);}catch(error){notify(errorMessage(error),true);}finally{unlock?.();setDeleting(false);finishOperation();}}
  return <>
    {!ready?<div className="app-loading"><BookOpen size={30}/><span>正在整理你的书架…</span></div>:current?current.format==='pdf'?<Suspense fallback={<div className="app-loading">正在加载 PDF 阅读器…</div>}><PdfReader book={current.book} pdf={current.pdf} initialProgress={current.progress} preferences={preferences} onPreferences={changePreferences} onBack={back} onError={text=>notify(text,true)}/></Suspense>:<Reader book={current.book} parsed={current.parsed} initialProgress={current.progress} preferences={preferences} onPreferences={changePreferences} onBack={back} onError={text=>notify(text,true)}/>:<Library books={books} onOpen={book=>void open(book)} onImport={files=>void importFiles(files)} onRemove={setRemoving} importing={importing} importStatus={importStatus} onCancelImport={()=>importController.current?.abort()} onDemo={()=>void loadDemo()}/>}
    {opening&&<div className="app-opening" role="status"><span className="spinner"/><span>{openStatus}</span><button className="app-secondary" onClick={()=>openController.current?.abort()}>取消打开</button></div>}
    {removing&&<Modal title="从书架移除图书？" onClose={()=>!deleting&&setRemoving(null)}><div className="remove-dialog"><span className="remove-icon"><Trash2 size={24}/></span><h3>《{removing.title}》</h3><p>这本书的文件、阅读进度、书签和笔记将一起移除。其他图书和阅读设置会保留。</p><div><button className="app-secondary" disabled={deleting} onClick={()=>setRemoving(null)}>保留图书</button><button className="app-danger" disabled={deleting} onClick={()=>void remove()}>{deleting?'正在移除…':'确认移除'}</button></div></div></Modal>}
    {message&&<Toast message={message} onClose={()=>setMessage(null)}/>}
  </>;
}

export class ErrorBoundary extends Component<{children:ReactNode},{error:boolean}>{
  state={error:false};
  static getDerivedStateFromError(){return {error:true};}
  componentDidCatch(error:Error,info:ErrorInfo){console.error('Reader error',error,info.componentStack);}
  render(){return this.state.error?<div className="app-loading"><BookOpen size={32}/><h2>书页暂时遇到了一点问题</h2><p>已保存的图书和记录仍在本地。</p><button className="app-secondary" onClick={()=>window.location.reload()}>重新打开</button></div>:this.props.children;}
}

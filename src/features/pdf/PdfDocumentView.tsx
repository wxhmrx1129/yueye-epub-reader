import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFPageProxy, RenderTask, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfDocument } from '../../services/pdf/document';
import type { PdfAnnotation, PdfPreferences, PdfProgress, PdfSelection } from '../../types';
import { capturePdfSelection, paintPdfAnnotations } from '../../services/pdf/annotations';
import { safeHttpUrl } from '../../services/tasks';
import 'pdfjs-dist/web/pdf_viewer.css';

export interface PdfNavigation { page:number; serial:number; annotation?:PdfAnnotation }
export interface PdfViewPosition { page:number; offsetX:number; offsetY:number }
interface Props {
  pdf:PdfDocument; page:number; navigation:PdfNavigation; zoom:number; zoomMode:PdfProgress['zoomMode']; preferences:PdfPreferences;
  initialProgress?:PdfProgress; annotations:PdfAnnotation[]; regionMode:boolean;
  onPage:(page:number)=>void; onPosition:(value:PdfViewPosition)=>void;
  onSelection:(value:PdfSelection|null)=>void; onAnnotation:(ids:string[])=>void;
  onLoading:(loading:boolean)=>void; onPageInfo:(info:{hasText:boolean;reduced:boolean})=>void;
  onDestination:(target:unknown)=>void; onError:(message:string)=>void;
}
interface PageProps {
  pdf:PdfDocument; number:number; width:number; height:number; zoom:number; zoomMode:PdfProgress['zoomMode']; preferences:PdfPreferences;
  annotations:PdfAnnotation[]; regionMode:boolean;
  onReady:(number:number,size:{width:number;height:number},info:{hasText:boolean;reduced:boolean})=>void;
  onLoading:(number:number)=>void; onError:(number:number,message:string)=>void;
  onSelection:(selection:PdfSelection)=>void; onDestination:(target:unknown)=>void;
}
function PdfPage({pdf,number,width,height,zoom,zoomMode,preferences,annotations,regionMode,...events}:PageProps) {
  const mount=useRef<HTMLDivElement>(null),wrapper=useRef<HTMLElement|null>(null);
  const callbacks=useRef(events);callbacks.current=events;
  const notes=useRef(annotations);notes.current=annotations;
  const [revision,setRevision]=useState(0),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const lifecycle=callbacks.current;
    let active=true,render:RenderTask|undefined,text:TextLayer|undefined,current:PDFPageProxy|undefined;
    let canvas:HTMLCanvasElement|undefined;
    lifecycle.onLoading(number);setError('');mount.current?.replaceChildren();wrapper.current=null;
    void (async()=>{
      const item=await pdf.document.getPage(number);current=item;if(!active)return;
      const original=item.getViewport({scale:1});
      const availableWidth=Math.min(preferences.contentWidth,Math.max(1,width-48));
      const scale=zoomMode==='custom'?zoom:zoomMode==='width'?Math.max(.05,availableWidth/original.width):Math.max(.05,Math.min(availableWidth/original.width,(height-48)/original.height));
      const viewport=item.getViewport({scale});
      if(viewport.width>32700||viewport.height>32700)throw new Error('此页面尺寸过大，请降低缩放或选择适合页面。');
      const page=document.createElement('div');page.className='pdf-page';page.dataset.pdfPage=String(number);
      let reduced=false,hasText=false;
      if(preferences.viewMode==='text'){
        page.classList.add('pdf-reflow-page');page.setAttribute('aria-label',`PDF 第 ${number} 页文字重排`);
        page.style.width=`${Math.max(200,Math.min(preferences.contentWidth,width-48))}px`;
        page.style.minHeight=`${Math.max(180,height-48)}px`;
        Object.assign(page.style,{fontSize:`${preferences.fontSize}px`,lineHeight:String(preferences.lineHeight),fontFamily:preferences.fontFamily==='serif'?'"Noto Serif SC","SimSun",serif':preferences.fontFamily==='sans'?'"Segoe UI","Microsoft YaHei",sans-serif':'inherit'});
        if(!pdf.canCopy){const help=document.createElement('p');help.className='pdf-text-empty';help.textContent='此文件限制文字复制，请使用原始版面阅读或添加区域笔记。';page.append(help);}
        else {
          const content=await item.getTextContent();if(!active)return;
          const body=document.createElement('div');body.className='pdf-reflow-content';body.dataset.pdfText='';
          let paragraph=document.createElement('p');body.append(paragraph);
          for(const value of content.items){
            if(!('str' in value))continue;const entry=value as TextItem;
            const span=document.createElement('span');span.textContent=entry.str;span.dir=entry.dir;paragraph.append(span);
            if(entry.hasEOL){paragraph=document.createElement('p');body.append(paragraph);}
          }
          hasText=!!body.textContent?.trim();
          if(hasText)page.append(body);
          else {const help=document.createElement('p');help.className='pdf-text-empty';help.textContent='此页没有可提取文字，可能是扫描页。切回原始版面后，可使用区域笔记框选记录。';page.append(help);}
        }
      }else{
        page.style.width=`${viewport.width}px`;page.style.height=`${viewport.height}px`;
        page.style.setProperty('--scale-factor',String(scale));page.style.setProperty('--total-scale-factor',String(scale));
        const requested=Math.min(2,window.devicePixelRatio||1);
        const ratio=Math.min(requested,Math.sqrt(16*1024*1024/(viewport.width*viewport.height)),32700/viewport.width,32700/viewport.height);
        reduced=ratio<requested-.001;
        canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(viewport.width*ratio));canvas.height=Math.max(1,Math.floor(viewport.height*ratio));
        canvas.setAttribute('aria-label',`PDF 第 ${number} 页`);page.append(canvas);
        render=item.render({canvas,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0],annotationMode:0});
        await render.promise;if(!active)return;
        if(pdf.canCopy){
          const layer=document.createElement('div');layer.className='textLayer';layer.dataset.pdfText='';page.append(layer);
          const content=await item.getTextContent();if(!active)return;
          hasText=content.items.some(item=>'str' in item&&item.str.trim());
          text=new TextLayer({textContentSource:content,container:layer,viewport});await text.render();if(!active)return;
        }
        const links=await item.getAnnotations({intent:'display'});if(!active)return;
        for(const annotation of links){
          if(annotation.subtype!=='Link'||!Array.isArray(annotation.rect))continue;
          const external=safeHttpUrl(annotation.url);if(!external&&!annotation.dest)continue;
          const rectangle=[...viewport.convertToViewportPoint(annotation.rect[0],annotation.rect[1]),...viewport.convertToViewportPoint(annotation.rect[2],annotation.rect[3])];
          const link=document.createElement('a');link.className='pdf-link';link.setAttribute('aria-label',external?'打开外部链接':'跳转 PDF 页面');
          Object.assign(link.style,{left:`${Math.min(rectangle[0],rectangle[2])}px`,top:`${Math.min(rectangle[1],rectangle[3])}px`,width:`${Math.abs(rectangle[2]-rectangle[0])}px`,height:`${Math.abs(rectangle[3]-rectangle[1])}px`});
          if(external){link.href=external;link.target='_blank';link.rel='noopener noreferrer';}
          else {link.href='#';link.onclick=event=>{event.preventDefault();callbacks.current.onDestination(annotation.dest);};}
          page.append(link);
        }
      }
      if(!active)return;
      mount.current!.replaceChildren(page);wrapper.current=page;
      paintPdfAnnotations(page,notes.current,preferences.viewMode==='text');
      setRevision(value=>value+1);
      lifecycle.onReady(number,{width:page.getBoundingClientRect().width,height:page.getBoundingClientRect().height},{hasText,reduced});
    })().catch(error=>{if(active){const message=error instanceof Error?error.message:'PDF 页面渲染失败';setError(message);callbacks.current.onError(number,message);}});
    return()=>{active=false;render?.cancel();text?.cancel();current?.cleanup();if(canvas)canvas.width=canvas.height=0;wrapper.current=null;};
  },[pdf,number,width,height,zoom,zoomMode,preferences.viewMode,preferences.fontSize,preferences.contentWidth,preferences.fontFamily,preferences.lineHeight,retry]);
  useEffect(()=>{if(wrapper.current)paintPdfAnnotations(wrapper.current,annotations,preferences.viewMode==='text');},[annotations,revision,preferences.viewMode]);
  useEffect(()=>{
    const page=wrapper.current;if(!page||!regionMode||preferences.viewMode!=='original')return;
    const capture=document.createElement('div');capture.className='pdf-region-capture';capture.setAttribute('aria-label',`框选第 ${number} 页区域`);
    const draft=document.createElement('div');draft.className='pdf-region-draft';capture.append(draft);
    let origin:{x:number;y:number}|undefined;
    const point=(event:PointerEvent)=>{const rect=page.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width)),y:Math.min(1,Math.max(0,(event.clientY-rect.top)/rect.height))};};
    capture.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();window.getSelection()?.removeAllRanges();origin=point(event);capture.setPointerCapture(event.pointerId);};
    capture.onpointermove=event=>{if(!origin)return;const end=point(event);Object.assign(draft.style,{display:'block',left:`${Math.min(origin.x,end.x)*100}%`,top:`${Math.min(origin.y,end.y)*100}%`,width:`${Math.abs(end.x-origin.x)*100}%`,height:`${Math.abs(end.y-origin.y)*100}%`});};
    capture.onpointercancel=()=>{origin=undefined;draft.style.display='none';};
    capture.onpointerup=event=>{
      event.preventDefault();event.stopPropagation();if(!origin)return;
      const end=point(event),rect={x:Math.min(origin.x,end.x),y:Math.min(origin.y,end.y),width:Math.abs(end.x-origin.x),height:Math.abs(end.y-origin.y)};
      origin=undefined;draft.style.display='none';if(rect.width<.005||rect.height<.005)return;
      callbacks.current.onSelection({page:number,kind:'region',start:0,end:0,quote:`第 ${number} 页的框选区域`,prefix:'',suffix:'',rects:[rect],x:event.clientX,y:event.clientY});
    };
    page.append(capture);return()=>capture.remove();
  },[regionMode,revision,number,preferences.viewMode]);
  return <div className="pdf-page-content"><div ref={mount}/>{error&&<div className="pdf-page-error" role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>重试页面</button></div>}</div>;
}

export function PdfDocumentView(props:Props) {
  const {pdf,page,navigation,zoom,zoomMode,preferences,initialProgress,annotations,regionMode}=props;
  const host=useRef<HTMLElement>(null),slots=useRef(new Map<number,HTMLDivElement>());
  const sizes=useRef(new Map<number,{width:number;height:number;key:string}>()),ready=useRef(new Map<number,{key:string;info:{hasText:boolean;reduced:boolean}}>());
  const current=useRef(page),position=useRef<PdfViewPosition>({page,offsetX:initialProgress?.offsetX??0,offsetY:initialProgress?.offsetY??0});
  const callbacks=useRef(props);callbacks.current=props;
  const [size,setSize]=useState({width:800,height:700}),[layout,setLayout]=useState(0);
  const pending=useRef<{page:number;offsetX:number;offsetY:number;annotation?:PdfAnnotation}|null>(null);
  const lastNavigation=useRef(-1),frame=useRef<number|undefined>(undefined);
  const continuous=preferences.readingMode==='scrolled';
  const renderKey=JSON.stringify([zoom,zoomMode,preferences.viewMode,preferences.fontSize,preferences.fontFamily,preferences.lineHeight,preferences.contentWidth,size.width,size.height]);
  function isReady(number:number){return ready.current.get(number)?.key===renderKey&&!!slots.current.get(number)?.querySelector('[data-pdf-page]');}
  const availableWidth=Math.min(preferences.contentWidth,Math.max(1,size.width-48));
  const customScale=zoomMode==='custom'?zoom:zoomMode==='width'?Math.max(.05,availableWidth/612):Math.max(.05,Math.min(availableWidth/612,(size.height-48)/792));
  const estimated=preferences.viewMode==='text'?{width:Math.max(200,Math.min(preferences.contentWidth,size.width-48)),height:Math.max(300,size.height-48)}:{width:612*customScale,height:792*customScale};
  function snapshot(number=current.current):PdfViewPosition {
    const area=host.current,slot=slots.current.get(number);if(!area||!slot)return position.current;
    return {page:number,offsetX:area.scrollLeft/Math.max(1,area.scrollWidth-area.clientWidth),offsetY:continuous?Math.min(1,Math.max(0,(area.scrollTop+24-slot.offsetTop)/Math.max(1,slot.clientHeight))):area.scrollTop/Math.max(1,area.scrollHeight-area.clientHeight)};
  }
  function publish(number=current.current) {
    const info=ready.current.get(number)?.info;if(!info||!isReady(number))return;
    position.current=snapshot(number);callbacks.current.onPosition(position.current);callbacks.current.onPageInfo(info);callbacks.current.onLoading(false);
  }
  function applyRestore() {
    const target=pending.current,area=host.current;if(!target||!area)return;
    const slot=slots.current.get(target.page);if(!slot)return;
    area.scrollLeft=Math.max(0,area.scrollWidth-area.clientWidth)*target.offsetX;
    area.scrollTop=continuous?Math.max(0,slot.offsetTop+slot.clientHeight*target.offsetY-24):Math.max(0,area.scrollHeight-area.clientHeight)*target.offsetY;
    if(target.annotation){
      const wrapper=slot.querySelector<HTMLElement>('[data-pdf-page]');
      const mark=wrapper?.querySelector<HTMLElement>(`[data-pdf-note-id="${CSS.escape(target.annotation.id)}"]`);
      if(mark){
        const box=mark.getBoundingClientRect(),areaBox=area.getBoundingClientRect();
        area.scrollTop+=box.top-areaBox.top-80;
        if(box.left<areaBox.left||box.right>areaBox.right)area.scrollLeft+=box.left-areaBox.left-40;
      }
    }
    const neighbors=continuous?[target.page-1,target.page,target.page+1].filter(value=>value>=1&&value<=pdf.document.numPages):[target.page];
    if(neighbors.every(isReady)){pending.current=null;publish(target.page);}
  }
  useEffect(()=>{
    const area=host.current!;
    const observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;setSize(old=>Math.abs(old.width-rect.width)<1&&Math.abs(old.height-rect.height)<1?old:{width:rect.width,height:rect.height});});
    observer.observe(area);return()=>{observer.disconnect();if(frame.current!==undefined)cancelAnimationFrame(frame.current);};
  },[]);
  useLayoutEffect(()=>{
    const explicit=navigation.serial!==lastNavigation.current;
    lastNavigation.current=navigation.serial;
    const previous=position.current;
    const target=explicit?navigation.page:current.current;
    pending.current={page:target,offsetX:explicit&&navigation.serial>0?0:previous.offsetX,offsetY:explicit&&navigation.serial>0?0:previous.offsetY,annotation:explicit?navigation.annotation:undefined};
    current.current=target;callbacks.current.onLoading(true);applyRestore();
  },[navigation.serial,zoom,zoomMode,preferences.viewMode,preferences.readingMode,preferences.fontSize,preferences.fontFamily,preferences.lineHeight,preferences.contentWidth,size.width,size.height]);
  useLayoutEffect(()=>{applyRestore();},[layout]);
  function scroll() {
    if(frame.current!==undefined)cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{
      frame.current=undefined;if(pending.current){applyRestore();return;}
      const area=host.current;if(!area)return;
      let next=current.current;
      if(continuous){
        const coordinate=area.scrollTop+24;let low=1,high=pdf.document.numPages;
        while(low<high){const mid=Math.floor((low+high)/2),slot=slots.current.get(mid);if(!slot)break;if(slot.offsetTop+slot.clientHeight<coordinate)low=mid+1;else high=mid;}
        next=low;
      }
      if(next!==current.current){current.current=next;callbacks.current.onPage(next);callbacks.current.onSelection(null);callbacks.current.onLoading(!isReady(next));}
      publish(next);
    });
  }
  function selection() {
    if(regionMode)return;
    const value=host.current?capturePdfSelection(host.current):null;
    if(value&&value.quote.length>100000){callbacks.current.onError('一次最多选取 10 万字符，请缩小选区。');return;}
    callbacks.current.onSelection(value);
  }
  const numbers=continuous?Array.from({length:pdf.document.numPages},(_,index)=>index+1):[page];
  return <main className={`pdf-viewport ${continuous?'pdf-continuous':''}`} aria-label="PDF 阅读区域" ref={host} onScroll={scroll} onMouseUp={selection} onKeyUp={selection} onClick={event=>{
    if(regionMode||window.getSelection()?.toString()||(event.target as Element).closest('a,button,input'))return;
    const wrapper=(event.target as Element).closest('[data-pdf-page]');if(!wrapper)return;
    const ids=new Set<string>();
    wrapper.querySelectorAll<HTMLElement>('[data-pdf-note-id]').forEach(mark=>{const rect=mark.getBoundingClientRect();if(event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom)ids.add(mark.dataset.pdfNoteId!);});
    if(ids.size)callbacks.current.onAnnotation([...ids]);
  }}>
    <div className="pdf-surface">{numbers.map(number=>{
      const near=!continuous||Math.abs(number-page)<=1,cached=sizes.current.get(number),measured=cached?.key===renderKey?cached:estimated;
      return <div key={number} ref={element=>{if(element)slots.current.set(number,element);else slots.current.delete(number);}} className="pdf-page-slot" data-page-slot={number} style={{width:measured.width,minHeight:measured.height}}>
        {near?<PdfPage pdf={pdf} number={number} width={size.width} height={size.height} zoom={zoom} zoomMode={zoomMode} preferences={preferences} annotations={annotations.filter(note=>note.page===number)} regionMode={regionMode}
          onDestination={target=>callbacks.current.onDestination(target)} onSelection={value=>callbacks.current.onSelection(value)}
          onLoading={value=>{ready.current.delete(value);if(value===current.current)callbacks.current.onLoading(true);}}
          onError={(value,message)=>{if(value===current.current){pending.current=null;callbacks.current.onLoading(false);}callbacks.current.onError(message);}}
          onReady={(value,measured,info)=>{if(continuous&&!pending.current)pending.current={...position.current};sizes.current.set(value,{...measured,key:renderKey});ready.current.set(value,{key:renderKey,info});const slot=slots.current.get(value);if(slot){slot.style.width=`${measured.width}px`;slot.style.minHeight=`${measured.height}px`;}setLayout(old=>old+1);if(value===current.current&&!pending.current)publish(value);}}
        />:<div className="pdf-page-placeholder" aria-hidden="true">第 {number} 页</div>}
      </div>;
    })}</div>
  </main>;
}

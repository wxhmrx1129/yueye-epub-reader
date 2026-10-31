import type { PdfAnnotation, PdfRect, PdfSelection } from '../../types';

function textNodes(root:Element):Text[] {
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes:Text[]=[];
  let node:Node|null;
  while((node=walker.nextNode()))nodes.push(node as Text);
  return nodes;
}
export function normalizedRects(range:Range,page:Element):PdfRect[] {
  const bounds=page.getBoundingClientRect(),seen=new Set<string>();
  if(!bounds.width||!bounds.height)return [];
  return Array.from(range.getClientRects()).flatMap(rect=>{
    const left=Math.max(bounds.left,rect.left),top=Math.max(bounds.top,rect.top);
    const right=Math.min(bounds.right,rect.right),bottom=Math.min(bounds.bottom,rect.bottom);
    if(right-left<.5||bottom-top<.5)return [];
    const item={x:(left-bounds.left)/bounds.width,y:(top-bounds.top)/bounds.height,width:(right-left)/bounds.width,height:(bottom-top)/bounds.height};
    const key=[item.x,item.y,item.width,item.height].map(value=>value.toFixed(5)).join(',');
    if(seen.has(key))return [];seen.add(key);return [item];
  });
}
export function capturePdfSelection(area:Element):PdfSelection|null {
  const selection=window.getSelection();
  if(!selection||selection.isCollapsed||!selection.rangeCount)return null;
  const range=selection.getRangeAt(0);
  const element=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer as Element:range.startContainer.parentElement;
  const root=element?.closest('[data-pdf-text]'),page=root?.closest<HTMLElement>('[data-pdf-page]');
  if(!root||!page||!area.contains(page)||!root.contains(range.endContainer))return null;
  const before=range.cloneRange();before.selectNodeContents(root);before.setEnd(range.startContainer,range.startOffset);
  const start=before.toString().length,quote=range.toString(),text=textNodes(root).map(node=>node.data).join('');
  const rects=normalizedRects(range,page),bounds=range.getBoundingClientRect();
  if(!quote.trim()||!rects.length)return null;
  return {page:Number(page.dataset.pdfPage),kind:'text',start,end:start+quote.length,quote,prefix:text.slice(Math.max(0,start-48),start),suffix:text.slice(start+quote.length,start+quote.length+48),rects,x:bounds.left,y:bounds.bottom};
}
export function pdfAnnotationRange(note:Pick<PdfAnnotation,'start'|'end'|'quote'|'prefix'|'suffix'>,root:Element):Range|null {
  const nodes=textNodes(root),text=nodes.map(node=>node.data).join('');
  let start=note.start,end=note.end;
  if(text.slice(start,end)!==note.quote){
    // Recover only a unique quote or the uniquely matching surrounding context.
    const matches:number[]=[];let offset=text.indexOf(note.quote);
    while(note.quote&&offset>=0){matches.push(offset);offset=text.indexOf(note.quote,offset+1);}
    const matching=matches.filter(index=>(!note.prefix||text.slice(Math.max(0,index-note.prefix.length),index)===note.prefix)&&(!note.suffix||text.slice(index+note.quote.length,index+note.quote.length+note.suffix.length)===note.suffix));
    if(matches.length===1)start=matches[0];else if(matching.length===1)start=matching[0];else return null;
    end=start+note.quote.length;
  }
  if(start<0||end<=start||end>text.length)return null;
  const range=document.createRange();let offset=0,started=false;
  for(const node of nodes){
    const next=offset+node.length;
    if(!started&&start<next){range.setStart(node,start-offset);started=true;}
    if(started&&end<=next){range.setEnd(node,end-offset);return range;}
    offset=next;
  }
  return null;
}
export function paintPdfAnnotations(wrapper:HTMLElement,notes:PdfAnnotation[],textMode:boolean) {
  wrapper.querySelector('[data-pdf-highlights]')?.remove();
  const overlay=document.createElement('div');overlay.className='pdf-highlights';overlay.dataset.pdfHighlights='';
  const root=wrapper.querySelector('[data-pdf-text]');
  for(const note of notes){
    if(note.kind==='region'&&textMode)continue;
    const range=note.kind==='text'&&root?pdfAnnotationRange(note,root):null;
    const rects=range?normalizedRects(range,wrapper):textMode?[]:note.rects;
    for(const rect of rects){
      const mark=document.createElement('span');mark.className='pdf-highlight';mark.dataset.pdfNoteId=note.id;
      mark.setAttribute('role','mark');mark.setAttribute('aria-label',note.note||'高亮');
      Object.assign(mark.style,{left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`,backgroundColor:note.color});
      overlay.append(mark);
    }
  }
  wrapper.append(overlay);
}

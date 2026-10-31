import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePdfSelection, normalizedRects, paintPdfAnnotations, pdfAnnotationRange } from '../src/services/pdf/annotations';
import type { PdfAnnotation } from '../src/types';

Range.prototype.getClientRects??=function(){return [] as unknown as DOMRectList;};
Range.prototype.getBoundingClientRect??=function(){return new DOMRect();};

const note:PdfAnnotation={id:'note',bookId:'pdf',page:1,kind:'text',start:6,end:11,quote:'world',prefix:'Hello ',suffix:' again',rects:[{x:.1,y:.2,width:.3,height:.1}],note:'A thought',color:'#e8c96d',createdAt:1,updatedAt:1};
afterEach(()=>{document.body.replaceChildren();window.getSelection()?.removeAllRanges();vi.restoreAllMocks();});
function layer(){document.body.innerHTML='<main><div data-pdf-page="1"><div data-pdf-text><span>Hello </span><span>world</span><br><span> again</span></div></div></main>';return document.querySelector<HTMLElement>('[data-pdf-text]')!;}

describe('PDF annotation anchors',()=>{
  it('reconstructs a range across text nodes without changing document content',()=>{
    const root=layer(),before=root.innerHTML;
    const range=pdfAnnotationRange(note,root)!;expect(range.toString()).toBe('world');
    expect(pdfAnnotationRange({...note,start:3,end:14,quote:'lo world ag'},root)?.toString()).toBe('lo world ag');
    expect(root.innerHTML).toBe(before);
  });
  it('recovers shifted unique text and disambiguates repeated quotes by context',()=>{
    const root=layer();root.prepend(document.createTextNode('New prefix. '));
    expect(pdfAnnotationRange(note,root)?.toString()).toBe('world');
    root.textContent='left word right and word other';
    const repeated={...note,start:100,end:104,quote:'word',prefix:'left ',suffix:' right'};
    const range=pdfAnnotationRange(repeated,root)!;expect(range.startOffset).toBe(5);
    expect(pdfAnnotationRange({...repeated,prefix:'',suffix:''},root)).toBeNull();
    expect(pdfAnnotationRange({...repeated,quote:'missing'},root)).toBeNull();
  });
  it('clamps, normalizes and deduplicates visible highlight rectangles',()=>{
    const root=layer(),page=root.parentElement!,range=pdfAnnotationRange(note,root)!;
    vi.spyOn(page,'getBoundingClientRect').mockReturnValue(new DOMRect(100,100,400,600));
    Object.defineProperty(range,'getClientRects',{value:()=>[new DOMRect(80,220,140,60),new DOMRect(80,220,140,60),new DOMRect(900,0,10,10)]});
    expect(normalizedRects(range,page)).toEqual([{x:0,y:.2,width:.3,height:.1}]);
  });
  it('captures stable page, text offsets and context and rejects cross-page selections',()=>{
    const root=layer(),page=root.parentElement!;
    vi.spyOn(page,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,400,600));
    vi.spyOn(Range.prototype,'getClientRects').mockImplementation(()=>[new DOMRect(40,120,120,60)] as unknown as DOMRectList);
    vi.spyOn(Range.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(40,120,120,60));
    const range=pdfAnnotationRange(note,root)!;window.getSelection()!.addRange(range);
    expect(capturePdfSelection(document.querySelector('main')!)).toMatchObject({page:1,start:6,end:11,quote:'world',prefix:'Hello ',suffix:' again',rects:note.rects});
    const outside=document.createTextNode('other page');document.body.append(outside);range.setEnd(outside,5);
    window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);
    expect(capturePdfSelection(document.querySelector('main')!)).toBeNull();
  });
  it('paints region notes in original layout and does not invent text anchors in reflow',()=>{
    const root=layer(),page=root.parentElement!;root.textContent='changed';
    paintPdfAnnotations(page,[note,{...note,id:'region',kind:'region'}],false);
    expect(page.querySelectorAll('[data-pdf-note-id]')).toHaveLength(2);
    paintPdfAnnotations(page,[note,{...note,id:'region',kind:'region'}],true);
    expect(page.querySelectorAll('[data-pdf-note-id]')).toHaveLength(0);
    expect(page.querySelectorAll('[data-pdf-highlights]')).toHaveLength(1);
  });
});

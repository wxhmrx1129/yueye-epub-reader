import { expect, test } from '@playwright/test';
import type { ReaderAdapter } from '../../src/services/epub/reader';
import type { PageEntry, Preferences, ReaderPosition, TextSelection } from '../../src/types';

type Harness = Window & {
  __reader: ReaderAdapter;
  __pages: PageEntry[] | null;
  __position: ReaderPosition;
  __errors: string[];
  __preferences: Preferences;
  __selection: TextSelection | null;
};

test.beforeEach(async ({ page }) => {
  await page.route('**/__reader_harness__', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>body{margin:0}.book-frame{display:block;border:0;width:100%;height:100%}</style></head><body><div id="reader" style="width:1000px;height:700px"></div></body></html>'}));
  await page.goto('/__reader_harness__');
  await page.evaluate(async () => {
    const parserPath = '/src/services/epub/import.ts';
    const readerPath = '/src/services/epub/reader.ts';
    const preferencesPath = '/src/preferences.ts';
    const {parseEpub} = await import(parserPath);
    const {ReaderAdapter} = await import(readerPath);
    const {DEFAULT_PREFERENCES} = await import(preferencesPath);
    const book = await parseEpub(await (await fetch('/tests/fixtures/epub3.epub')).blob());
    const harness = window as unknown as Harness;
    harness.__errors = [];
    harness.__pages = null;
    harness.__preferences = {...DEFAULT_PREFERENCES};
    harness.__reader = new ReaderAdapter(document.getElementById('reader')!,book,harness.__preferences,{
      position:(position: ReaderPosition)=>{harness.__position=position;},
      index:(pages: PageEntry[] | null)=>{harness.__pages=pages;},
      selection:(selection: TextSelection | null)=>{harness.__selection=selection;},
      annotation:()=>{},error:(message: string)=>{harness.__errors.push(message);},
    });
    await harness.__reader.open();
  });
  await expect.poll(()=>page.evaluate(()=>(window as unknown as Harness).__pages?.length || 0)).toBeGreaterThan(5);
});

test('全书页码对应真实分页，首中末页与逐页翻阅保持一致', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const harness = window as unknown as Harness;
    const total = harness.__pages!.length;
    const states = [];
    for (let page = 1; page <= total; page++) {
      await harness.__reader.goToPage(page);
      const state = harness.__reader.position!;
      const frame=document.querySelector<HTMLIFrameElement>('iframe[title="书籍正文"]')!;
      const mediaVisible = [...frame.contentDocument!.querySelectorAll('img,svg')].some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < frame.clientWidth && rect.bottom > 0 && rect.top < frame.clientHeight;
      });
      let restoreError = '';
      try { await harness.__reader.goTo(state.cfi); } catch (error) { restoreError = String(error); }
      states.push({requested:page,actual:state.page,restored:harness.__reader.position!.page,cfi:state.cfi,restoreError,chapter:state.spineIndex,scrollX:frame.contentWindow!.scrollX,text:state.quoteContext,mediaVisible});
    }
    await harness.__reader.goToPage(1);
    const sequential = [harness.__reader.position!.page];
    for(let index=1;index<total;index++){await harness.__reader.next();sequential.push(harness.__reader.position!.page);}
    return {total,states,sequential,errors:harness.__errors,finished:harness.__reader.position!.isFinished};
  });
  expect(result.states.filter(state => state.restoreError)).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.states.map(state=>state.actual)).toEqual(Array.from({length:result.total},(_,index)=>index+1));
  expect(result.states.map(state=>state.restored)).toEqual(Array.from({length:result.total},(_,index)=>index+1));
  expect(result.sequential).toEqual(Array.from({length:result.total},(_,index)=>index+1));
  expect(result.finished).toBe(true);
  expect(result.states.every(state=>state.text.trim().length>0 || state.mediaVisible)).toBe(true);
});

test('CFI 续读、字号重排与滚动模式切换保持内容位置', async ({ page }) => {
  const before=await page.evaluate(async()=>{
    const harness=window as unknown as Harness;
    await harness.__reader.goToPage(5);
    const previous={...harness.__reader.position!};
    harness.__preferences={...harness.__preferences,fontSize:30};
    harness.__reader.setPreferences(harness.__preferences);
    return previous;
  });
  await expect.poll(()=>page.evaluate(()=>(window as unknown as Harness).__pages?.length||0)).toBeGreaterThan(5);
  const after=await page.evaluate(()=>({position:(window as unknown as Harness).__reader.position!,errors:(window as unknown as Harness).__errors}));
  expect(after.errors).toEqual([]);
  expect(after.position.href).toBe(before.href);
  expect(Math.abs(after.position.progression-before.progression)).toBeLessThan(.12);
  await page.evaluate(()=>{
    const harness=window as unknown as Harness;harness.__preferences={...harness.__preferences,readingMode:'scrolled'};harness.__reader.setPreferences(harness.__preferences);
  });
  await expect.poll(()=>page.evaluate(()=>(window as unknown as Harness).__reader.position!.totalPages)).toBe(0);
  const scroll=await page.evaluate(()=>({position:(window as unknown as Harness).__reader.position!,scrollY:document.querySelector<HTMLIFrameElement>('iframe[title="书籍正文"]')!.contentWindow!.scrollY}));
  expect(scroll.position.href).toBe(before.href);
  expect(scroll.scrollY).toBeGreaterThan(0);
  expect(Math.abs(scroll.position.progression-before.progression)).toBeLessThan(.15);
});

test('文字选区产生稳定 CFI，批注高亮不改变原文字节点', async ({ page }) => {
  const result=await page.evaluate(async()=>{
    const harness=window as unknown as Harness;
    await harness.__reader.goTo('OEBPS/Text/chapter1.xhtml#window');
    const frame=document.querySelector<HTMLIFrameElement>('iframe[title="书籍正文"]')!;
    const doc=frame.contentDocument!,node=doc.querySelector('#p-0-0-0')!.firstChild!;
    const range=doc.createRange();range.setStart(node,0);range.setEnd(node,35);
    doc.getSelection()!.removeAllRanges();doc.getSelection()!.addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    const selection=harness.__selection!;
    const beforeChildren=doc.body.querySelectorAll('*').length;
    harness.__reader.setAnnotations([{id:'note-1',bookId:'test',...selection,note:'窗边的清晨',color:'#e8cf81',createdAt:Date.now(),updatedAt:Date.now()}]);
    const highlights=(frame.contentWindow as Window & {CSS:{highlights:Map<string,unknown>}}).CSS.highlights.size;
    const afterChildren=doc.body.querySelectorAll('*').length;
    harness.__reader.clearSelection();
    await harness.__reader.goToPage(harness.__pages!.length);
    await harness.__reader.goTo(selection.rangeCfi);
    return {selection,beforeChildren,afterChildren,highlights,position:harness.__reader.position!,errors:harness.__errors};
  });
  expect(result.selection.quote).toContain('天刚亮');
  expect(result.selection.rangeCfi).toMatch(/^epubcfi\(/);
  expect(result.highlights).toBe(1);
  expect(result.beforeChildren).toBe(result.afterChildren);
  expect(result.position.href).toBe('OEBPS/Text/chapter1.xhtml');
  expect(result.errors).toEqual([]);
});

test('书内脚注与跨章链接遵守导入器的本地导航契约', async ({ page }) => {
  const initial = await page.evaluate(async () => {
    const harness = window as unknown as Harness;
    await harness.__reader.goTo('OEBPS/Text/chapter1.xhtml#morning');
    const position = {...harness.__reader.position!};
    const doc = document.querySelector<HTMLIFrameElement>('iframe[title="书籍正文"]')!.contentDocument!;
    const footnote = doc.querySelector<HTMLAnchorElement>('a[data-epub-href$="#note-1"]')!;
    footnote.click();
    return position;
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Harness).__reader.position!.page)).toBeGreaterThan(initial.page);
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe[title="书籍正文"]')!.contentDocument!;
    doc.querySelector<HTMLAnchorElement>('a[data-epub-href$="chapter2.xhtml#river"]')!.click();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Harness).__reader.position!.href)).toBe('OEBPS/Text/chapter2.xhtml');
  expect(await page.evaluate(() => (window as unknown as Harness).__errors)).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { makePdf } from '../pdf-fixture';

async function openPdf(page:Page,options:Parameters<typeof makePdf>[0]={}) {
  await page.goto('/');
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles({name:'parity.pdf',mimeType:'application/pdf',buffer:makePdf(options)});
  await page.getByRole('button',{name:`打开《${options.scan?'Synthetic scanned PDF':'Offline PDF sample'}》`,exact:true}).click();
  await expect(page.getByTestId('pdf-reader')).toBeVisible();
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
}
async function selectText(page:Page) {
  const text=page.locator('[data-pdf-text] span').filter({hasText:'Yueye PDF - Page'}).first();
  await text.scrollIntoViewIfNeeded();const rect=(await text.boundingBox())!;
  await page.mouse.move(rect.x+1,rect.y+rect.height/2);await page.mouse.down();
  await page.mouse.move(rect.x+rect.width*.65,rect.y+rect.height/2,{steps:12});await page.mouse.up();
  await expect(page.locator('.selection-toolbar')).toBeVisible();
  expect(await page.evaluate(()=>window.getSelection()?.toString())).toContain('Yueye');
}
async function settings(page:Page){await page.getByRole('button',{name:'阅读设置',exact:true}).click();return page.getByRole('dialog',{name:'阅读设置',exact:true});}
async function mode(page:Page,name:'文字重排'|'原始版面'|'纵向滚动'|'分页阅读') {
  const dialog=await settings(page);await dialog.getByRole('button',{name:new RegExp(`^${name}`)}).click();await dialog.getByRole('button',{name:'完成',exact:true}).click();await expect(page.locator('.pdf-loading')).toHaveCount(0);
}
async function pageNumber(page:Page,value:string){await page.getByLabel('PDF 页码',{exact:true}).fill(value);await page.getByLabel('PDF 页码',{exact:true}).press('Enter');await expect(page.locator('.pdf-loading')).toHaveCount(0);}
async function epubRecords(page:Page){return page.evaluate(async()=>{const source='/src/services/storage.ts';const storage=await import(source);return {preferences:await storage.getPreferences(),bookmarks:await storage.db.bookmarks.toArray(),annotations:await storage.db.annotations.toArray(),progress:await storage.db.readingProgress.toArray()};});}

test('PDF 与 EPUB 共用界面布局；PDF 设置独立保存且不改变 EPUB 数据',async({page})=>{
  await page.goto('/');await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles(resolve('tests/fixtures/epub3.epub'));
  await page.getByRole('button',{name:'打开《把日子读成诗》',exact:true}).click();await expect(page.getByLabel('跳转页码',{exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'添加书签',exact:true}).click();await expect(page.locator('.reader-save-info')).toContainText('已保存');
  const dimensions=await page.evaluate(()=>({header:document.querySelector('.reader-toolbar')!.getBoundingClientRect().height,sidebar:document.querySelector('.reader-sidebar')!.getBoundingClientRect().width,footer:document.querySelector('.reader-footer')!.getBoundingClientRect().height}));
  await page.getByRole('button',{name:'返回书架',exact:true}).click();const before=await epubRecords(page);
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles({name:'settings.pdf',mimeType:'application/pdf',buffer:makePdf()});await page.getByRole('button',{name:'打开《Offline PDF sample》',exact:true}).click();await expect(page.getByTestId('pdf-reader')).toBeVisible();await expect(page.locator('.pdf-loading')).toHaveCount(0);
  expect(await page.evaluate(()=>({header:document.querySelector('.reader-toolbar')!.getBoundingClientRect().height,sidebar:document.querySelector('.reader-sidebar')!.getBoundingClientRect().width,footer:document.querySelector('.reader-footer')!.getBoundingClientRect().height}))).toEqual(dimensions);
  for(const label of ['目录','书签列表','笔记列表','阅读设置','进入全屏'])await expect(page.getByRole('button',{name:label,exact:true})).toBeVisible();
  const dialog=await settings(page);await expect(dialog.getByLabel('设置字号')).toBeDisabled();await expect(dialog.getByLabel('字体',{exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:/^文字重排/}).click();await dialog.getByLabel('字体',{exact:true}).selectOption('sans');await dialog.getByLabel('行间距',{exact:true}).selectOption('2');await dialog.getByRole('button',{name:'选择深夜',exact:true}).click();await dialog.getByLabel('设置正文宽度').press('Home');await dialog.getByRole('button',{name:'完成',exact:true}).click();
  await page.getByLabel('字号',{exact:true}).fill('30');await page.getByLabel('字号',{exact:true}).press('Enter');await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await expect(page.locator('.pdf-reflow-page')).toHaveCSS('font-size','30px');await expect(page.locator('.pdf-reflow-page')).toHaveCSS('line-height','60px');
  expect(await epubRecords(page)).toEqual(before);
  await page.reload();await expect(page.locator('.pdf-reflow-page')).toHaveCSS('font-size','30px');await expect(page.getByTestId('pdf-reader')).toHaveCSS('background-color','rgb(32, 39, 36)');expect(await epubRecords(page)).toEqual(before);
  await page.screenshot({path:'test-results/pdf-settings-parity.png'});
  await page.getByRole('button',{name:'返回书架',exact:true}).click();await page.getByRole('button',{name:'打开《把日子读成诗》',exact:true}).click();await expect(page.getByLabel('字号',{exact:true})).toHaveValue('22');await expect(page.getByRole('button',{name:'取消当前位置书签',exact:true})).toBeVisible();
});

test('鼠标划线后可创建、编辑、跳转、删除和撤销 PDF 笔记，缩放和重排保留锚点',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await openPdf(page);await selectText(page);
  await page.getByRole('button',{name:'添加笔记',exact:true}).click();await page.getByLabel('笔记内容',{exact:true}).fill('PDF 中的第一条想法');await page.getByRole('button',{name:'高亮颜色#a9cba0',exact:true}).click();await page.getByRole('button',{name:'保存笔记',exact:true}).click();
  await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);await page.getByRole('button',{name:'笔记列表',exact:true}).click();await expect(page.locator('.note-item')).toContainText('PDF 中的第一条想法');
  await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('笔记内容',{exact:true}).fill('更新后的 PDF 笔记');await page.getByRole('button',{name:'保存笔记',exact:true}).click();
  await page.getByLabel('PDF 缩放',{exact:true}).selectOption('1.5');await expect(page.locator('.pdf-loading')).toHaveCount(0);await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);
  const rect=(await page.locator('.pdf-highlight').first().boundingBox())!;await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);await expect(page.getByRole('dialog',{name:'编辑笔记',exact:true})).toBeVisible();await page.getByRole('button',{name:'取消',exact:true}).click();
  await mode(page,'文字重排');await expect(page.locator('.pdf-reflow-content')).toContainText('Yueye PDF');await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);
  await pageNumber(page,'3');await expect(page.locator('.pdf-highlight')).toHaveCount(0);await page.locator('.note-item .saved-content').click();await expect(page.getByLabel('PDF 页码',{exact:true})).toHaveValue('1');await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);
  await page.reload();await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);await page.getByRole('button',{name:'笔记列表',exact:true}).click();await expect(page.locator('.note-item')).toContainText('更新后的 PDF 笔记');
  await page.getByRole('button',{name:'删除笔记',exact:true}).click();await expect(page.locator('.pdf-highlight')).toHaveCount(0);await expect(page.locator('.note-item')).toHaveCount(0);await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.locator('.note-item')).toHaveCount(1);await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);
  await page.screenshot({path:'test-results/pdf-notes-parity.png'});expect(errors).toEqual([]);
});

test('纯高亮及重叠笔记支持点击选择编辑，未保存修改可取消放弃',async({page})=>{
  await openPdf(page);await selectText(page);await page.getByRole('button',{name:'高亮',exact:true}).click();await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);
  await selectText(page);await page.getByRole('button',{name:'添加笔记',exact:true}).click();await page.getByLabel('笔记内容',{exact:true}).fill('重叠记录');await page.getByRole('button',{name:'保存笔记',exact:true}).click();
  const rect=(await page.locator('.pdf-highlight').first().boundingBox())!;await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);await expect(page.getByRole('dialog',{name:'这里记录了这些想法',exact:true})).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:/重叠记录/}).click();
  await page.getByLabel('笔记内容',{exact:true}).fill('尚未保存');page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('dialog',{name:'编辑笔记',exact:true})).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'笔记列表',exact:true}).click();await expect(page.locator('.note-item')).toHaveCount(2);await expect(page.locator('.pdf-sidebar')).toContainText('重叠记录');await expect(page.locator('.pdf-sidebar')).not.toContainText('尚未保存');
});

test('扫描页可框选区域记录笔记，书签、缩放、文字模式切回和刷新保持记录',async({page})=>{
  await openPdf(page,{scan:true});await page.getByRole('button',{name:'添加或移除页面书签',exact:true}).click();await page.getByRole('button',{name:'区域笔记',exact:true}).click();
  const capture=page.locator('.pdf-region-capture'),bounds=(await capture.boundingBox())!;
  await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.65,bounds.y+bounds.height*.4,{steps:10});await page.mouse.up();
  await page.getByRole('button',{name:'添加笔记',exact:true}).click();await page.getByLabel('笔记内容',{exact:true}).fill('扫描页的图像区域');await page.getByRole('button',{name:'保存笔记',exact:true}).click();await expect(page.locator('.pdf-highlight')).toHaveCount(1);
  await page.getByLabel('PDF 缩放',{exact:true}).selectOption('1.5');await expect(page.locator('.pdf-loading')).toHaveCount(0);await expect(page.locator('.pdf-highlight')).toHaveCount(1);
  const normalized=await page.locator('.pdf-highlight').evaluate(mark=>({left:mark.style.left,width:mark.style.width}));expect(parseFloat(normalized.left)).toBeCloseTo(20,0);expect(parseFloat(normalized.width)).toBeCloseTo(45,0);
  await mode(page,'文字重排');await expect(page.locator('.pdf-text-empty')).toContainText('没有可提取文字');await expect(page.locator('.pdf-highlight')).toHaveCount(0);
  await page.getByRole('button',{name:'笔记列表',exact:true}).click();await page.locator('.note-item .saved-content').click();await expect(page.getByTestId('pdf-reader')).toHaveAttribute('data-view-mode','original');await expect(page.locator('.pdf-highlight')).toHaveCount(1);
  await page.reload();await expect(page.locator('.pdf-highlight')).toHaveCount(1);await page.getByRole('button',{name:'书签列表',exact:true}).click();await expect(page.locator('.pdf-sidebar .saved-item')).toHaveCount(1);await page.getByRole('button',{name:'删除第 1 页书签',exact:true}).click();await expect(page.locator('.pdf-sidebar .saved-item')).toHaveCount(0);await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.locator('.pdf-sidebar .saved-item')).toHaveCount(1);
});

test('1000 页连续滚动按需渲染，滚动页码、跳转与页内位置续读准确',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await openPdf(page,{pages:1000});await mode(page,'纵向滚动');await expect(page.locator('.pdf-page-slot')).toHaveCount(1000);
  expect(await page.locator('.pdf-page canvas').count()).toBeLessThanOrEqual(3);await pageNumber(page,'500');await expect(page.getByLabel('PDF 页码',{exact:true})).toHaveValue('500');await expect(page.locator('[data-pdf-page="500"] canvas')).toBeVisible();
  await page.getByLabel('PDF 阅读区域',{exact:true}).evaluate(area=>{const slot=area.querySelector<HTMLElement>('[data-page-slot="501"]')!;area.scrollTop=slot.offsetTop+slot.clientHeight*.35-24;area.dispatchEvent(new Event('scroll'));});
  await expect(page.getByLabel('PDF 页码',{exact:true})).toHaveValue('501');await expect(page.locator('.pdf-loading')).toHaveCount(0);await expect(page.locator('.pdf-save')).toContainText('已保存');
  const fraction=()=>page.getByLabel('PDF 阅读区域',{exact:true}).evaluate(area=>{const slot=area.querySelector<HTMLElement>('[data-page-slot="501"]')!;return (area.scrollTop+24-slot.offsetTop)/slot.clientHeight;});
  const before=await fraction();expect(before).toBeCloseTo(.35,1);await page.reload();await expect(page.getByLabel('PDF 页码',{exact:true})).toHaveValue('501');await expect(page.locator('.pdf-loading')).toHaveCount(0);expect(await fraction()).toBeCloseTo(before,1);expect(await page.locator('.pdf-page canvas').count()).toBeLessThanOrEqual(3);
  await pageNumber(page,'1000');await expect(page.locator('[data-pdf-page="1000"] canvas')).toBeVisible();await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();expect(await page.locator('.pdf-page canvas').count()).toBeLessThanOrEqual(3);expect(errors).toEqual([]);
});

test('PDF 窄窗口下设置、侧栏和全屏可用，打开弹窗时键盘不误翻页',async({page})=>{
  await page.setViewportSize({width:860,height:720});await openPdf(page);await expect(page.getByRole('button',{name:'阅读设置',exact:true})).toBeVisible();
  const dialog=await settings(page);await page.keyboard.press('PageDown');await expect(page.getByLabel('PDF 页码',{exact:true})).toHaveValue('1');await dialog.getByRole('button',{name:'完成',exact:true}).click();
  await page.getByRole('button',{name:'收起侧栏',exact:true}).click();await expect(page.locator('.pdf-sidebar')).toHaveCount(0);await page.getByRole('button',{name:'笔记列表',exact:true}).click();await expect(page.locator('.pdf-sidebar')).toBeVisible();await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
  await page.getByRole('button',{name:'进入全屏',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);await page.getByRole('button',{name:'退出全屏',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
});

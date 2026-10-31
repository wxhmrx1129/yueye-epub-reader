import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test.beforeAll(()=>{
  if(!existsSync(resolve('.local-v11-fixtures/expansion-over-750.epub')))execFileSync(process.execPath,['scripts/create-v11-fixtures.mjs'],{stdio:'pipe'});
});

test('725MiB 解压预算的 EPUB 按需打开，超过 750MiB 在解压前拒绝',async({page})=>{
  await page.goto('/');
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles(resolve('.local-v11-fixtures/expansion-725.epub'));
  await page.getByRole('button',{name:'打开《High expansion EPUB》',exact:true}).click();
  await expect(page.frameLocator('iframe[title="书籍正文"]').locator('h1')).toHaveText('Only required resources are decoded');
  await page.getByRole('button',{name:'返回书架',exact:true}).click();
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles(resolve('.local-v11-fixtures/expansion-over-750.epub'));
  await expect(page.getByRole('alert')).toContainText('750MiB');await expect(page.locator('.shelf-book')).toHaveCount(1);
});
test('51、100、150MiB 图文 EPUB 可导入、显示图片、跳转及恢复',async({page},info)=>{
  test.setTimeout(180_000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');const measurements=[];
  for(const size of [51,100,150]){
    const started=Date.now();
    await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles(resolve(`.local-v11-fixtures/large-${size}.epub`));
    const open=page.getByRole('button',{name:`打开《Large EPUB ${size}MiB》`,exact:true});await expect(open).toBeVisible({timeout:45000});
    const imported=Date.now();await open.click();
    const frame=page.frameLocator('iframe[title="书籍正文"]');await expect(frame.locator('h1')).toContainText('Image chapter 1');
    await expect.poll(()=>frame.locator('img').evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBe(2048);
    const opened=Date.now();
    await page.getByRole('button',{name:new RegExp(`^第 ${size===51?5:size===100?10:16} 节$`)}).click();
    await expect(frame.locator('h1')).toContainText(`Image chapter ${size===51?5:size===100?10:16}`);
    await expect(frame.locator('img')).toBeVisible();await expect(page.locator('.reader-save-info')).toContainText('已保存');
    await page.getByRole('button',{name:'返回书架',exact:true}).click();await open.click();
    await expect(frame.locator('h1')).toContainText(`Image chapter ${size===51?5:size===100?10:16}`);
    await page.getByRole('button',{name:'返回书架',exact:true}).click();
    measurements.push({sizeMiB:size,importMs:imported-started,openMs:opened-imported});
  }
  const boundary=await page.evaluate(async()=>{
    const path='/src/services/storage.ts';const storage=await import(path);
    const books=await storage.listBooks();const book=books.find((b:{fileSize:number})=>b.fileSize===150*1024**2);
    const blob=await storage.getBookFile(book.id);
    try{await storage.importBook(new File([blob,new Uint8Array(1)],'over.epub'));return false;}catch(error){return (error as Error).message.includes('150MiB');}
  });
  expect(boundary).toBe(true);expect(errors).toEqual([]);
  await info.attach('large-epub-timing',{body:JSON.stringify(measurements,null,2),contentType:'application/json'});
});

test('150MiB 扫描 PDF 可按页阅读，重开恢复且单页渲染',async({page},info)=>{
  test.setTimeout(120_000);await page.goto('/');const start=Date.now();
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles(resolve('.local-v11-fixtures/large-150.pdf'));
  const open=page.getByRole('button',{name:'打开《Large PDF 150MiB》',exact:true});await expect(open).toBeVisible({timeout:45000});const imported=Date.now();
  await open.click();await expect(page.getByLabel('PDF 第 1 页',{exact:true})).toBeVisible({timeout:30000});const opened=Date.now();
  await page.getByLabel('PDF 页码',{exact:true}).fill('16');await page.getByRole('button',{name:'跳转',exact:true}).click();await expect(page.getByLabel('PDF 第 16 页',{exact:true})).toBeVisible();
  await expect(page.locator('.pdf-save')).toContainText('已保存');await page.getByRole('button',{name:'返回书架',exact:true}).click();await open.click();
  await expect(page.getByLabel('PDF 第 16 页',{exact:true})).toBeVisible({timeout:30000});await expect(page.locator('.pdf-page canvas')).toHaveCount(1);await expect(page.locator('.app-toast.error')).toHaveCount(0);
  await info.attach('large-pdf-timing',{body:JSON.stringify({sizeMiB:150,importMs:imported-start,openMs:opened-imported}),contentType:'application/json'});
});

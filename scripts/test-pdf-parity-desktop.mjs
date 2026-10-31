/** Upgrade regression with a synthetic, temporary profile; never opens the daily library. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { _electron, expect as baseExpect } from '@playwright/test';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const expect=baseExpect.configure({timeout:20000});
const output=path.join(root,'test-results','pdf-upgrade');await mkdir(output,{recursive:true});
const stateFile=path.join(output,'state.json');
const seed=process.argv.includes('--seed-v110');
const profile=seed?await mkdtemp(path.join(tmpdir(),'yueye-upgrade-parity-')):JSON.parse(await readFile(stateFile,'utf8')).profile;
if(path.dirname(path.resolve(profile))!==path.resolve(tmpdir())||!path.basename(profile).startsWith('yueye-upgrade-parity-'))throw new Error('Unexpected temporary profile');
const executable=process.env.YUEYE_DESKTOP_EXECUTABLE;if(!executable)throw new Error('Set YUEYE_DESKTOP_EXECUTABLE to the packaged executable.');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.YUEYE_DEV_URL;
const source=ts.transpileModule(await readFile(new URL('../tests/pdf-fixture.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {makePdf}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
let app,page,complete=false;const errors=[],external=[];
const watchdog=setTimeout(()=>{app?.process().kill();process.exitCode=1;},150000);
async function launch(){
  app=await _electron.launch({executablePath:path.resolve(executable),args:[`--user-data-dir=${profile}`],env,cwd:root,timeout:30000});page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));await page.context().route(/^https?:\/\//,route=>{external.push(route.request().url());return route.abort();});
  assert.equal(await app.evaluate(({app})=>app.getVersion()),seed?'1.1.0':'1.1.1');await expect(page.getByLabel('选择 EPUB 或 PDF 图书')).toBeAttached();
}
async function close(){
  const process=app.process();const exited=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Close-save timeout')),20000);process.once('exit',()=>{clearTimeout(timeout);resolve();});});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await exited;app=undefined;page=undefined;
}
async function open(title){await page.getByRole('button',{name:`打开《${title}》`,exact:true}).click();}
async function back(){await page.getByRole('button',{name:'返回书架',exact:true}).click();}
try{
  await launch();
  if(seed){
    await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles(path.join(root,'tests/fixtures/epub3.epub'));await open('把日子读成诗');await expect(page.getByLabel('跳转页码',{exact:true})).toBeEnabled();
    await page.getByLabel('字号',{exact:true}).fill('28');await page.getByLabel('字号',{exact:true}).press('Enter');await page.getByRole('button',{name:'阅读设置',exact:true}).click();await page.getByRole('button',{name:'选择暖砂',exact:true}).click();await page.getByRole('button',{name:'完成',exact:true}).click();
    await expect(page.getByLabel('跳转页码',{exact:true})).toBeEnabled();await page.getByRole('button',{name:'窗边的一小段时间',exact:true}).click();await expect(page.frameLocator('iframe[title="书籍正文"]').locator('#p-0-0-0')).toBeAttached();
    await page.evaluate(()=>{const doc=document.querySelector('iframe[title="书籍正文"]').contentDocument;const node=doc.querySelector('#p-0-0-0').firstChild;const range=doc.createRange();range.setStart(node,0);range.setEnd(node,20);doc.getSelection().removeAllRanges();doc.getSelection().addRange(range);doc.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
    await page.getByRole('button',{name:'添加笔记',exact:true}).click();await page.getByLabel('笔记内容',{exact:true}).fill('EPUB upgrade preservation');await page.getByRole('button',{name:'保存笔记',exact:true}).click();
    await page.getByLabel('跳转页码',{exact:true}).fill('5');await page.getByLabel('跳转页码',{exact:true}).press('Enter');await expect(page.getByLabel('跳转页码',{exact:true})).toHaveValue('5');await page.getByRole('button',{name:'添加书签',exact:true}).click();await back();
    await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles({name:'upgrade.pdf',mimeType:'application/pdf',buffer:makePdf()});await open('Offline PDF sample');await expect(page.getByLabel('PDF 第 1 页',{exact:true})).toBeVisible();
    await page.getByLabel('PDF 页码',{exact:true}).fill('2');await page.getByRole('button',{name:'跳转',exact:true}).click();await expect(page.getByLabel('PDF 第 2 页',{exact:true})).toBeVisible();await page.getByLabel('PDF 缩放',{exact:true}).selectOption('1.5');await expect(page.locator('.pdf-loading')).toHaveCount(0);await page.getByRole('button',{name:'添加或移除页面书签',exact:true}).click();
    await close();await writeFile(stateFile,JSON.stringify({profile,seedVersion:'1.1.0'}));complete=true;console.log('Seeded v1.1.0 EPUB/PDF records in an isolated profile.');
  }else{
    await expect(page.locator('.shelf-book')).toHaveCount(2);await open('把日子读成诗');await expect(page.getByLabel('跳转页码',{exact:true})).toBeEnabled();await expect(page.getByLabel('跳转页码',{exact:true})).toHaveValue('5');await expect(page.getByLabel('字号',{exact:true})).toHaveValue('28');await expect(page.getByRole('button',{name:'取消当前位置书签',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'笔记列表',exact:true}).click();await expect(page.locator('.reader-sidebar')).toContainText('EPUB upgrade preservation');await back();await open('Offline PDF sample');await expect(page.getByLabel('PDF 第 2 页',{exact:true})).toBeVisible();await expect(page.getByLabel('PDF 缩放',{exact:true})).toHaveValue('1.5');await expect(page.getByRole('button',{name:'添加或移除页面书签',exact:true})).toHaveAttribute('aria-pressed','true');
    const box=await page.locator('.textLayer span').filter({hasText:'Yueye PDF'}).boundingBox();await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height/2,{steps:10});await page.mouse.up();
    await page.getByRole('button',{name:'添加笔记',exact:true}).click();await page.getByLabel('笔记内容',{exact:true}).fill('Packaged PDF annotation');await page.getByRole('button',{name:'保存笔记',exact:true}).click();await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);
    await page.getByRole('button',{name:'阅读设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'阅读设置',exact:true});await dialog.getByRole('button',{name:/^文字重排/}).click();await dialog.getByRole('button',{name:'选择深夜',exact:true}).click();await dialog.getByRole('button',{name:/^纵向滚动/}).click();await dialog.getByRole('button',{name:'完成',exact:true}).click();await expect(page.locator('.pdf-loading')).toHaveCount(0);await expect(page.locator('.pdf-reflow-content')).toContainText(['Yueye PDF']);
    await close();await launch();await open('Offline PDF sample');await expect(page.getByTestId('pdf-reader')).toHaveAttribute('data-view-mode','text');await expect(page.getByLabel('PDF 页码',{exact:true})).toHaveValue('2');await expect(page.locator('.pdf-highlight')).not.toHaveCount(0);await page.getByRole('button',{name:'笔记列表',exact:true}).click();await expect(page.locator('.pdf-sidebar')).toContainText('Packaged PDF annotation');await page.screenshot({path:path.join(output,'packaged-pdf.png')});
    await back();await open('把日子读成诗');await expect(page.getByLabel('字号',{exact:true})).toHaveValue('28');await expect(page.getByTestId('reader')).toHaveCSS('background-color','rgb(244, 236, 218)');await page.getByRole('button',{name:'笔记列表',exact:true}).click();await expect(page.locator('.reader-sidebar')).toContainText('EPUB upgrade preservation');await close();
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);complete=true;await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,from:'1.1.0',to:'1.1.1',checks:['old-epub-files-progress-settings-bookmarks-notes','old-pdf-progress-zoom-bookmarks','pdf-mouse-selection-note','pdf-reflow-and-scroll','restart-persists-pdf-notes','epub-settings-isolation','offline-no-network']},null,2));console.log('Packaged v1.1.0 → v1.1.1 upgrade and PDF parity passed.');
  }
}catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
finally{clearTimeout(watchdog);if(app)await app.close().catch(()=>{});if(!seed||!complete)await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300});}

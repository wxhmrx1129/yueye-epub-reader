import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { _electron, expect as baseExpect } from '@playwright/test';
import electronExecutable from 'electron';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const expect=baseExpect.configure({timeout:20000});
const output=path.join(root,'test-results','desktop-v11');await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),'yueye-v11-test-'));
const executable=process.env.YUEYE_DESKTOP_EXECUTABLE;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.YUEYE_DEV_URL;
const sample=ts.transpileModule(await readFile(new URL('../tests/pdf-fixture.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {makePdf}=await import(`data:text/javascript;base64,${Buffer.from(sample).toString('base64')}`);
let app,page;const errors=[],external=[],timings=[],memory=[];
const watchdog=setTimeout(()=>{app?.process().kill();process.exitCode=1;},240000);
async function launch(){
  app=await _electron.launch({executablePath:executable?path.resolve(executable):electronExecutable,args:[...(executable?[]:[root]),`--user-data-dir=${profile}`],env,cwd:root,timeout:30000});
  page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.context().route(/^https?:\/\//,route=>{external.push(route.request().url());return route.abort();});
  await expect(page.getByLabel('选择 EPUB 或 PDF 图书')).toBeAttached();
}
async function close(){
  const handle=app.process();const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Close-save timeout')),20000);handle.once('exit',()=>{clearTimeout(timer);resolve();});});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await exited;app=undefined;page=undefined;
}
async function memorySample(label){
  const rows=await app.evaluate(({app})=>app.getAppMetrics().map(item=>({type:item.type,workingSetSizeKiB:item.memory.workingSetSize})));
  memory.push({label,totalWorkingSetMiB:rows.reduce((sum,item)=>sum+item.workingSetSizeKiB,0)/1024,processes:rows});
}
try{
  if(!existsSync(path.join(root,'.local-v11-fixtures','large-150.pdf')))execFileSync(process.execPath,['scripts/create-v11-fixtures.mjs'],{cwd:root,stdio:'pipe'});
  await launch();await memorySample('idle');
  // All HTTP(S) requests are denied: engine, worker, fonts and documents must stay local.
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles({name:'offline.pdf',mimeType:'application/pdf',buffer:makePdf()});
  await page.getByRole('button',{name:'打开《Offline PDF sample》',exact:true}).click();
  await expect(page.locator('.textLayer')).toContainText('Yueye PDF - Page 1');
  await page.getByLabel('PDF 缩放',{exact:true}).selectOption('3');await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await page.getByLabel('PDF 阅读区域',{exact:true}).evaluate(area=>{area.scrollTop=(area.scrollHeight-area.clientHeight)*.7;area.dispatchEvent(new Event('scroll'));});
  await page.getByRole('button',{name:'添加或移除页面书签',exact:true}).click();
  await page.getByRole('button',{name:'进入全屏',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
  await page.getByRole('button',{name:'退出全屏',exact:true}).click();
  await page.getByLabel('PDF 页码',{exact:true}).fill('2');await page.getByRole('button',{name:'跳转',exact:true}).click();await expect(page.getByLabel('PDF 第 2 页',{exact:true})).toBeVisible();
  // Close before the debounced progress save; the close barrier must flush the last page.
  await close();await launch();await page.getByRole('button',{name:'打开《Offline PDF sample》',exact:true}).click();
  await expect(page.getByLabel('PDF 第 2 页',{exact:true})).toBeVisible();await expect(page.getByLabel('PDF 缩放',{exact:true})).toHaveValue('3');
  await page.getByRole('button',{name:'书签列表',exact:true}).click();await expect(page.locator('.pdf-sidebar')).toContainText('第 1 页');
  await page.screenshot({path:path.join(output,'pdf-reader.png')});
  await page.getByRole('button',{name:'返回书架',exact:true}).click();
  for(const format of ['epub','pdf']){
    const start=Date.now();await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles(path.join(root,'.local-v11-fixtures',`large-150.${format}`));
    const title=`Large ${format.toUpperCase()} 150MiB`;const open=page.getByRole('button',{name:`打开《${title}》`,exact:true});await expect(open).toBeVisible({timeout:45000});const imported=Date.now();await open.click();
    if(format==='epub'){
      const frame=page.frameLocator('iframe[title="书籍正文"]');await expect(frame.locator('h1')).toContainText('Image chapter 1');await expect.poll(()=>frame.locator('img').evaluate(image=>image.naturalWidth)).toBe(2048);
    }else await expect(page.getByLabel('PDF 第 1 页',{exact:true})).toBeVisible();
    timings.push({format,sizeMiB:150,importMs:imported-start,openMs:Date.now()-imported});await memorySample(`150MiB ${format} open`);
    await page.getByRole('button',{name:'返回书架',exact:true}).click();
    for(let attempt=0;attempt<10;attempt++){
      await open.click();await expect(page.getByRole('button',{name:'返回书架',exact:true})).toBeVisible();
      if(format==='pdf')await expect(page.getByLabel('PDF 第 1 页',{exact:true})).toBeVisible();else await expect(page.frameLocator('iframe[title="书籍正文"]').locator('h1')).toBeVisible();
      await page.getByRole('button',{name:'返回书架',exact:true}).click();
    }
    await memorySample(`after 10 ${format} switches`);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await close();
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,executable:executable??'Electron production dist',checks:['offline-pdf-worker-and-fonts','pdf-text-layer','zoom','scroll','pdf-bookmark','fullscreen','pdf-close-save','pdf-restart','150MiB-epub','150MiB-pdf','10-switches-per-format'],timings,memory},null,2));
  console.log(JSON.stringify({passed:true,timings,memory:memory.map(({label,totalWorkingSetMiB})=>({label,totalWorkingSetMiB}))},null,2));
}catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
finally{
  clearTimeout(watchdog);if(app)await app.close().catch(()=>{});
  const resolved=path.resolve(profile);if(path.dirname(resolved)!==path.resolve(tmpdir())||!path.basename(resolved).startsWith('yueye-v11-test-'))throw new Error('Unexpected temporary profile path');
  await rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}

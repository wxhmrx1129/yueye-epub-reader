import { expect, test } from '@playwright/test';
import { makePdf } from '../pdf-fixture';

test('PDF 导入、渲染、目录、缩放、书签和刷新续读',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:makePdf()});
  const open=page.getByRole('button',{name:'打开《Offline PDF sample》',exact:true});await expect(open).toBeVisible();
  await open.click();await expect(page.getByTestId('pdf-reader')).toBeVisible();
  await expect(page.getByLabel('PDF 第 1 页',{exact:true})).toBeVisible();
  await expect(page.locator('.textLayer')).toContainText('Yueye PDF - Page 1');
  await page.getByLabel('PDF 页码',{exact:true}).fill('0');await page.getByRole('button',{name:'跳转',exact:true}).click();await expect(page.locator('.pdf-footer')).toContainText('之间的整数页码');
  await page.getByLabel('PDF 页码',{exact:true}).fill('2');await page.getByRole('button',{name:'跳转',exact:true}).click();
  await expect(page.getByLabel('PDF 第 2 页',{exact:true})).toBeVisible();
  await page.getByLabel('PDF 缩放',{exact:true}).selectOption('1.5');
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await page.getByRole('button',{name:'添加或移除页面书签',exact:true}).click();
  await page.getByRole('button',{name:'书签列表',exact:true}).click();await expect(page.locator('.pdf-sidebar')).toContainText('第 2 页');
  await expect(page.locator('.pdf-save')).toContainText('已保存');
  await page.getByRole('button',{name:'返回书架',exact:true}).click();await open.click();
  await expect(page.getByLabel('PDF 第 2 页',{exact:true})).toBeVisible();await expect(page.getByLabel('PDF 缩放',{exact:true})).toHaveValue('1.5');
  if(await page.getByRole('button',{name:'目录',exact:true}).getAttribute('aria-pressed')!=='true')await page.getByRole('button',{name:'目录',exact:true}).click();
  await page.getByRole('button',{name:'Last page',exact:true}).click();
  await expect(page.getByLabel('PDF 第 3 页',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
  await expect(page.locator('.pdf-save')).toContainText('已保存');
  await page.reload();
  await expect(page.getByLabel('PDF 第 3 页',{exact:true})).toBeVisible();await expect(page.locator('.app-toast.error')).toHaveCount(0);
  await page.screenshot({path:'test-results/pdf-reader.png'});expect(errors).toEqual([]);
});

test('PDF 中文 CMap 随应用提供，支持文字层及页内位置恢复',async({page})=>{
  await page.goto('/');await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles({name:'中文测试.pdf',mimeType:'application/pdf',buffer:makePdf({chinese:true})});
  await page.getByRole('button',{name:'打开《Offline PDF sample》',exact:true}).click();
  await expect(page.locator('.textLayer')).toContainText('中文阅读测试');
  await page.getByLabel('PDF 缩放',{exact:true}).selectOption('3');await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await page.getByLabel('PDF 阅读区域',{exact:true}).evaluate(area=>{area.scrollTop=(area.scrollHeight-area.clientHeight)*.6;area.dispatchEvent(new Event('scroll'));});
  await expect(page.locator('.pdf-save')).toContainText('已保存');await page.getByRole('button',{name:'返回书架',exact:true}).click();
  await page.getByRole('button',{name:'打开《Offline PDF sample》',exact:true}).click();await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await expect.poll(()=>page.getByLabel('PDF 阅读区域',{exact:true}).evaluate(area=>area.scrollTop/Math.max(1,area.scrollHeight-area.clientHeight))).toBeCloseTo(.6,1);
});

test('扫描 PDF 与 1000 页文件按需渲染，混合导入隔离损坏与密码错误',async({page})=>{
  await page.goto('/');
  await page.getByLabel('选择 EPUB 或 PDF 图书').setInputFiles([
    {name:'scan.pdf',mimeType:'application/pdf',buffer:makePdf({scan:true})},
    {name:'long.pdf',mimeType:'application/pdf',buffer:makePdf({pages:1000})},
    {name:'broken.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nbroken')},
    {name:'password.pdf',mimeType:'application/pdf',buffer:makePdf({password:true})},
  ]);
  await expect(page.getByRole('alert')).toContainText('2 本导入失败');
  await expect(page.getByRole('alert')).toContainText('需要打开密码');
  await expect(page.locator('.shelf-book')).toHaveCount(2);
  await page.getByRole('button',{name:'打开《Synthetic scanned PDF》',exact:true}).click();
  await expect(page.getByLabel('PDF 第 1 页',{exact:true})).toBeVisible();await expect(page.locator('.textLayer')).toHaveText('');
  await page.getByRole('button',{name:'返回书架',exact:true}).click();
  await page.getByRole('button',{name:'打开《Offline PDF sample》',exact:true}).click();
  await page.getByLabel('PDF 页码',{exact:true}).fill('1000');await page.getByRole('button',{name:'跳转',exact:true}).click();
  await expect(page.getByLabel('PDF 第 1000 页',{exact:true})).toBeVisible();await expect(page.locator('.pdf-page canvas')).toHaveCount(1);
});

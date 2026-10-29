import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';

const title = '把日子读成诗';
const firstChapter = '第一章 · 把清晨还给自己';

async function importAndOpen(page: Page) {
  await page.goto('/');
  await page.getByLabel('选择 EPUB 图书').setInputFiles(resolve('tests/fixtures/epub3.epub'));
  await page.getByRole('button', { name: `打开《${title}》`, exact: true }).click();
  await expect(page.getByLabel('跳转页码', { exact: true })).toBeEnabled();
  await expect(page.locator('iframe[title="书籍正文"]')).toBeVisible();
  await expect(page.locator('.reader-save-info')).toContainText('已保存');
  await expect(page.locator('.app-toast.error')).toHaveCount(0);
}

async function persisted(page: Page) {
  return page.evaluate(async () => {
    const modulePath = '/src/services/storage.ts';
    const storage = await import(modulePath);
    const books = await storage.listBooks();
    const book = books[0];
    return {
      books, preferences: await storage.getPreferences(),
      progress: book ? await storage.getProgress(book.id) : undefined,
      bookmarks: book ? await storage.listBookmarks(book.id) : [],
      notes: book ? await storage.listAnnotations(book.id) : [],
    };
  });
}

test('完整界面：目录、设置、书签、笔记、刷新续读和移除图书', async ({ page }) => {
  await importAndOpen(page);
  await expect(page.getByRole('button', { name: '木桌上的一道划痕', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `折叠${firstChapter}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '木桌上的一道划痕', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '书签列表', exact: true }).click();
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await expect(page.getByRole('button', { name: '木桌上的一道划痕', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `展开${firstChapter}`, exact: true }).click();
  await page.getByRole('button', { name: '窗边的一小段时间', exact: true }).click();
  await expect(page.locator('.footer-chapter')).toHaveText(firstChapter);

  await page.getByLabel('字号', { exact: true }).fill('');
  await page.getByLabel('字号', { exact: true }).pressSequentially('28');
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('28');
  await page.getByLabel('字号', { exact: true }).press('Enter');
  await page.getByLabel('正文宽度', { exact: true }).fill('');
  await page.getByLabel('正文宽度', { exact: true }).pressSequentially('860');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByLabel('字体', { exact: true }).selectOption('sans');
  await page.getByLabel('行间距', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: '选择暖砂', exact: true }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByLabel('跳转页码', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '窗边的一小段时间', exact: true }).click();
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消当前位置书签', exact: true })).toBeVisible();

  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="书籍正文"]')!;
    const doc = frame.contentDocument!;
    const node = doc.querySelector('#p-0-0-0')!.firstChild!;
    const range = doc.createRange();
    range.setStart(node, 0); range.setEnd(node, 35);
    doc.getSelection()!.removeAllRanges(); doc.getSelection()!.addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '添加笔记', exact: true }).click();
  await page.getByLabel('笔记内容', { exact: true }).fill('每天为自己留出一小段安静的时间。');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await page.getByRole('button', { name: '笔记列表', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '笔记', exact: true })).toContainText('每天为自己留出一小段安静的时间。');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('笔记内容', { exact: true }).fill('更新：每天为自己留出十分钟。');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();

  await page.getByLabel('跳转页码', { exact: true }).fill('5');
  await page.getByLabel('跳转页码', { exact: true }).press('Enter');
  await expect(page.getByLabel('跳转页码', { exact: true })).toHaveValue('5');
  await expect(page.locator('.reader-save-info')).toContainText('已保存');
  const before = await persisted(page);
  expect(before.notes).toHaveLength(1);
  expect(before.bookmarks).toHaveLength(1);
  expect(before.preferences).toMatchObject({ fontSize: 28, contentWidth: 860, fontFamily: 'sans', lineHeight: 2, theme: 'sand' });

  await page.reload();
  await expect(page.getByLabel('跳转页码', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('跳转页码', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('28');
  await expect(page.getByLabel('正文宽度', { exact: true })).toHaveValue('860');
  const restored = await persisted(page);
  expect(restored.progress.cfi).toBe(before.progress.cfi);
  expect(restored.notes[0].note).toBe('更新：每天为自己留出十分钟。');

  await page.getByRole('button', { name: '书签列表', exact: true }).click();
  const bookmarks = page.getByRole('navigation', { name: '书签', exact: true });
  await expect(bookmarks.locator('.saved-item')).toHaveCount(1);
  await bookmarks.locator('.saved-content').click();
  await expect(page.locator('.footer-chapter')).toHaveText(firstChapter);
  await page.getByRole('button', { name: '删除书签', exact: true }).click();
  await expect(bookmarks.locator('.saved-item')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(bookmarks.locator('.saved-item')).toHaveCount(1);

  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await expect(page.getByRole('region', { name: '继续阅读', exact: true })).toBeVisible();
  await page.getByLabel(`《${title}》更多操作`, { exact: true }).click();
  await page.getByRole('button', { name: '移除图书', exact: true }).click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.locator('.shelf-book')).toHaveCount(0);
  expect((await persisted(page)).books).toHaveLength(0);
  expect((await persisted(page)).preferences.fontSize).toBe(28);
});

test('页码校验、输入焦点、全屏及滚动模式可以正常使用', async ({ page }) => {
  await importAndOpen(page);
  const input = page.getByLabel('跳转页码', { exact: true });
  await input.fill('0'); await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('之间的整数页码');
  await input.fill('2.5'); await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('之间的整数页码');
  await input.fill('3'); await input.press('Enter');
  await expect(input).toHaveValue('3');
  await input.press('ArrowRight');
  await expect(input).toHaveValue('3');

  await page.getByRole('button', { name: '进入全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '阅读设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '纵向滚动' }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByText('滚动阅读', { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('button', { name: `打开《${title}》`, exact: true }).click();
  await expect(page.getByText('滚动阅读', { exact: true })).toBeVisible();
  expect((await persisted(page)).preferences.readingMode).toBe('scrolled');
  await expect(page.locator('.app-toast.error')).toHaveCount(0);
});

test('同一本书的多标签写入锁会阻止冲突，并在返回书架后释放', async ({ page, context }) => {
  await importAndOpen(page);
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: `打开《${title}》`, exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('已在另一个页面打开');
  await expect(second.getByTestId('reader')).toHaveCount(0);
  await second.getByRole('button', { name: '关闭提示', exact: true }).click();
  await second.getByLabel(`《${title}》更多操作`, { exact: true }).click();
  await second.getByRole('button', { name: '移除图书', exact: true }).click();
  await second.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('已在另一个页面打开');
  await expect(second.getByRole('dialog', { name: '从书架移除图书？', exact: true })).toBeVisible();
  expect((await persisted(second)).books).toHaveLength(1);
  await second.getByRole('button', { name: '保留图书', exact: true }).click();
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await second.getByRole('button', { name: `打开《${title}》`, exact: true }).click();
  await expect(second.getByLabel('跳转页码', { exact: true })).toBeEnabled();
  await second.close();
});

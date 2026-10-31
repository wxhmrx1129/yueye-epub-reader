import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect as baseExpect } from '@playwright/test';
import electronExecutable from 'electron';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const expect = baseExpect.configure({ timeout: 15_000 });
const artifacts = path.join(root, 'test-results', 'desktop');
const profile = await mkdtemp(path.join(tmpdir(), 'yueye-desktop-test-'));
const executable = process.env.YUEYE_DESKTOP_EXECUTABLE;
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.YUEYE_DEV_URL;
let application;
let page;
const errors = [];
const watchdog = setTimeout(() => {
  console.error('Desktop smoke test exceeded 180 seconds.');
  application?.process().kill();
  process.exitCode = 1;
}, 180_000);

async function launch() {
  application = await _electron.launch({
    executablePath: executable ? path.resolve(executable) : electronExecutable,
    args: [...(executable ? [] : [root]), `--user-data-dir=${profile}`],
    cwd: root,
    env: environment,
    timeout: 30_000,
  });
  page = await application.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByLabel('选择 EPUB 或 PDF 图书')).toBeAttached();
  assert.equal(new URL(page.url()).protocol, 'yueye:');
  assert.equal(new URL(page.url()).host, 'app');
}

async function closeWindow() {
  const processHandle = application.process();
  const exited = processHandle.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The application did not finish saving and exit within 20 seconds.')), 20_000);
      processHandle.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await exited;
  application = undefined;
  page = undefined;
}

async function readStorage() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('yueye-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const result = {};
      for (const name of ['books', 'readingProgress', 'bookmarks', 'annotations', 'preferences']) {
        result[name] = await new Promise((resolve, reject) => {
          const request = db.transaction(name, 'readonly').objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
      return result;
    } finally { db.close(); }
  });
}

try {
  await mkdir(artifacts, { recursive: true });
  await launch();
  console.log('Desktop launch: production assets, isolated temporary profile.');
  const capabilities = await page.evaluate(async () => ({
    secureContext: isSecureContext,
    locks: typeof navigator.locks?.request,
    crypto: typeof crypto.subtle?.digest,
    indexedDB: typeof indexedDB.open,
    require: typeof window.require,
    process: typeof window.process,
    bridge: Object.keys(window.yueyeDesktop ?? {}),
    traversalStatus: (await fetch('yueye://app/%2e%2e%2fpackage.json')).status,
  }));
  assert.deepEqual(capabilities, {
    secureContext: true, locks: 'function', crypto: 'function', indexedDB: 'function',
    require: 'undefined', process: 'undefined', bridge: ['onPrepareClose'], traversalStatus: 403,
  });
  await application.evaluate(({ shell }) => {
    globalThis.__desktopTestLinks = [];
    globalThis.__desktopOriginalOpenExternal = shell.openExternal;
    shell.openExternal = async url => { globalThis.__desktopTestLinks.push(url); };
  });
  await page.evaluate(() => {
    window.open('https://example.com/desktop-test', '_blank');
    window.open('ms-settings:display', '_blank');
    window.open('file:///C:/Windows/win.ini', '_blank');
  });
  await expect.poll(() => application.evaluate(() => globalThis.__desktopTestLinks)).toEqual(['https://example.com/desktop-test']);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await application.evaluate(({ shell }) => { shell.openExternal = globalThis.__desktopOriginalOpenExternal; });
  console.log('Desktop security: secure APIs, renderer isolation, asset containment, external-link filtering passed.');

  const closeRace = await application.evaluate(async ({ BrowserWindow, dialog, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window.webContents;
    const originalSend = contents.send;
    const originalMessageBox = dialog.showMessageBox;
    let requestId;
    let dialogCount = 0;
    let resolveDialog;
    try {
      contents.send = function (channel, ...args) {
        if (channel === 'yueye:prepare-close') { requestId = args[0]; return; }
        return originalSend.call(this, channel, ...args);
      };
      dialog.showMessageBox = async () => {
        dialogCount++;
        return new Promise(resolve => { resolveDialog = resolve; });
      };
      window.close();
      if (requestId === undefined) throw new Error('The main window did not request a close save.');
      const event = { sender: contents, senderFrame: contents.mainFrame };
      ipcMain.emit('yueye:close-ready', event, { requestId, error: 'Simulated save failure for regression testing.' });
      const dialogsAfterFailure = dialogCount;
      // Both stale responses must be ignored while the user chooses in the failure dialog.
      ipcMain.emit('yueye:close-ready', event, { requestId });
      ipcMain.emit('yueye:close-ready', event, { requestId, error: 'Late duplicate failure.' });
      window.close();
      await new Promise(resolve => setImmediate(resolve));
      return { dialogsAfterFailure, dialogsAfterLateReplies: dialogCount, windowAlive: !window.isDestroyed(), windowCount: BrowserWindow.getAllWindows().length };
    } finally {
      resolveDialog?.({ response: 1 });
      await new Promise(resolve => setImmediate(resolve));
      if (!contents.isDestroyed()) contents.send = originalSend;
      dialog.showMessageBox = originalMessageBox;
    }
  });
  assert.deepEqual(closeRace, { dialogsAfterFailure: 1, dialogsAfterLateReplies: 1, windowAlive: true, windowCount: 1 });
  console.log('Desktop close failure: stale success/failure replies cannot close the window or duplicate the pending dialog.');

  await page.screenshot({ path: path.join(artifacts, 'library.png') });
  await page.getByRole('button', { name: '先读一本示例书', exact: false }).click();
  await expect(page.getByTestId('reader')).toBeVisible();
  const pageNumber = page.getByLabel('跳转页码', { exact: true });
  await expect(pageNumber).toBeEnabled({ timeout: 30_000 });
  const chapter = page.frameLocator('iframe[title="书籍正文"]');
  await expect(chapter.locator('body')).toContainText('把日子读成诗');
  assert.equal(await page.locator('iframe[title="书籍正文"]').getAttribute('sandbox'), 'allow-same-origin');
  await page.getByLabel('字号', { exact: true }).fill('24');
  await page.getByLabel('字号', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('button', { name: '选择暖砂', exact: true }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(pageNumber).toBeEnabled();
  await page.getByRole('button', { name: '窗边的一小段时间', exact: true }).click();
  await expect(chapter.locator('body')).toContainText('清晨');
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消当前位置书签', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const doc = document.querySelector('iframe[title="书籍正文"]').contentDocument;
    const walker = doc.createTreeWalker(doc.querySelector('p'), NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode()) && text.length < 10) {}
    if (!text) throw new Error('No sample text available for annotation.');
    const range = doc.createRange();
    range.setStart(text, 0); range.setEnd(text, Math.min(24, text.length));
    doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '添加笔记', exact: true }).click();
  await page.getByLabel('笔记内容', { exact: true }).fill('桌面客户端：重启后保留这条笔记。');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await page.getByRole('button', { name: '笔记列表', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '笔记', exact: true })).toContainText('桌面客户端：重启后保留这条笔记。');
  await page.getByRole('button', { name: '进入全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(pageNumber).toBeEnabled();
  await page.screenshot({ path: path.join(artifacts, 'reader.png') });
  const before = await readStorage();
  assert.equal(before.books.length, 1);
  assert.equal(before.bookmarks.length, 1);
  assert.equal(before.annotations.length, 1);
  assert.equal(before.preferences[0].fontSize, 24);
  assert.equal(before.preferences[0].theme, 'sand');
  console.log('Desktop reading: bundled EPUB, sandboxed chapter, pagination, settings, bookmark, note and fullscreen passed.');

  await expect(page.locator('.reader-save-info')).toContainText('已保存');
  const beforeReloadPage = await pageNumber.inputValue();
  const beforeReloadUrl = page.url();
  await page.evaluate(() => { window.__desktopReloadProbe = true; });
  await Promise.all([
    page.waitForEvent('load', { timeout: 15_000 }),
    page.evaluate(() => { location.reload(); }),
  ]);
  assert.equal(await page.evaluate(() => window.__desktopReloadProbe), undefined);
  assert.equal(page.url(), beforeReloadUrl);
  await expect(page.getByTestId('reader')).toBeVisible();
  await expect(pageNumber).toBeEnabled({ timeout: 30_000 });
  await expect(pageNumber).toHaveValue(beforeReloadPage);
  const reloaded = await readStorage();
  assert.equal(reloaded.books.length, 1);
  assert.equal(reloaded.bookmarks.length, 1);
  assert.equal(reloaded.annotations[0].note, '桌面客户端：重启后保留这条笔记。');
  console.log('Desktop renderer reload: document reload completes and restores the hash-routed reader with local data.');

  // Close as soon as navigation has changed the displayed page, before the 350ms save debounce.
  const previousViewport = await page.evaluate(() => {
    const frame = document.querySelector('iframe[title="书籍正文"]');
    return `${frame.contentWindow.scrollX}:${frame.contentDocument.body.textContent}`;
  });
  await pageNumber.fill('5');
  await pageNumber.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const frame = document.querySelector('iframe[title="书籍正文"]');
    return `${frame.contentWindow.scrollX}:${frame.contentDocument.body.textContent}`;
  })).not.toBe(previousViewport);
  await expect(pageNumber).toHaveValue('5');
  await closeWindow();
  await launch();
  await page.getByRole('button', { name: '打开《把日子读成诗》', exact: true }).click();
  const restoredPage = page.getByLabel('跳转页码', { exact: true });
  await expect(restoredPage).toBeEnabled({ timeout: 30_000 });
  await expect(restoredPage).toHaveValue('5');
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('24');
  const restored = await readStorage();
  assert.equal(restored.bookmarks.length, 1);
  assert.equal(restored.annotations[0].note, '桌面客户端：重启后保留这条笔记。');
  assert.equal(restored.preferences[0].theme, 'sand');
  assert.equal(restored.readingProgress.length, 1);
  await page.getByRole('button', { name: '笔记列表', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '笔记', exact: true })).toContainText('桌面客户端：重启后保留这条笔记。');
  await expect(page.locator('.app-toast.error')).toHaveCount(0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(artifacts, 'restored.png') });
  await closeWindow();
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({
    passed: true, executable: executable ? path.resolve(executable) : 'Electron development executable with production dist',
    capabilities, checks: ['offline-assets', 'secure-context', 'renderer-isolation', 'asset-containment', 'external-link-filtering', 'close-failure-stale-replies', 'demo-import', 'sandboxed-epub', 'pagination', 'preferences', 'bookmark', 'annotation', 'fullscreen', 'renderer-reload', 'save-on-close', 'restart-persistence'],
  }, null, 2));
  console.log('Desktop restart: immediate-close progress, books, preferences, bookmarks and notes persisted. All desktop smoke checks passed.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  clearTimeout(watchdog);
  if (application) {
    const processHandle = application.process();
    await Promise.race([
      application.close().catch(() => {}),
      new Promise(resolve => setTimeout(() => { if (processHandle.exitCode === null) processHandle.kill(); resolve(); }, 5000)),
    ]);
  }
  const parent = path.resolve(tmpdir());
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('yueye-desktop-test-')) {
    throw new Error(`Refusing to remove an unexpected test profile path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

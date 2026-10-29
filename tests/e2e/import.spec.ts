import { expect, test } from '@playwright/test';

// Use the app origin without the HMR client so ongoing UI edits cannot reload a probe.
test.beforeEach(async ({ page }) => {
  await page.route('**/__test_harness__', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><title>EPUB integration tests</title></head><body></body></html>'}));
});

test('EPUB 2、EPUB 3 与缺失目录图书在真实浏览器中可以解析', async ({ page }) => {
  await page.goto('/__test_harness__');
  const results = await page.evaluate(async () => {
    const modulePath = '/src/services/epub/import.ts';
    const { parseEpub } = await import(modulePath);
    const files = ['epub3.epub', 'epub2.epub', 'no-toc.epub'];
    const depth = (items: { children: unknown[] }[]): number => 1 + Math.max(0, ...items.map(item => item.children.length ? depth(item.children as { children: unknown[] }[]) : 0));
    return await Promise.all(files.map(async file => {
      const response = await fetch(`/tests/fixtures/${file}`);
      const book = await parseEpub(await response.blob(), file);
      return { file, title: book.title, chapters: book.chapters.length, toc: book.toc.length, depth: depth(book.toc), hasImage: book.chapters.some((chapter: { html: string }) => chapter.html.includes('data:image/svg+xml')) };
    }));
  });
  expect(results.map(book => book.chapters)).toEqual([5, 5, 5]);
  expect(results.every(book => book.toc > 0 && book.hasImage)).toBe(true);
  expect(results[0].depth).toBe(3);
  expect(results[1].depth).toBe(2);
});

test('不可信书内脚本、远程资源和危险链接被隔离', async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('untrusted.invalid')) remoteRequests.push(request.url()); });
  await page.route('https://untrusted.invalid/**', route => route.abort());
  await page.goto('/__test_harness__');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/services/epub/import.ts';
    const { parseEpub } = await import(modulePath);
    const book = await parseEpub(await (await fetch('/tests/fixtures/unsafe.epub')).blob(), 'unsafe.epub');
    const html = book.chapters[1].html as string;
    const iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-same-origin');
    iframe.srcdoc = html;
    document.body.append(iframe);
    await new Promise<void>(resolve => { iframe.onload = () => resolve(); });
    const doc = iframe.contentDocument!;
    const result = {
      dangerousElements: doc.querySelectorAll('script,iframe,form,object,embed').length,
      eventAttributes: [...doc.querySelectorAll('*')].some(element => [...element.attributes].some(attribute => attribute.name.startsWith('on'))),
      dangerousHref: [...doc.querySelectorAll('a')].some(element => /^javascript:/i.test(element.getAttribute('href') || '')),
      scriptsRan: !!(iframe.contentWindow as Window & { __epubScriptExecuted?: boolean; __epubEventExecuted?: boolean }).__epubScriptExecuted || !!(iframe.contentWindow as Window & { __epubEventExecuted?: boolean }).__epubEventExecuted,
      imageLoaded: [...doc.images].some(image => image.src.startsWith('data:')),
    };
    iframe.remove();
    return result;
  });
  expect(result.dangerousElements).toBe(0);
  expect(result.eventAttributes).toBe(false);
  expect(result.dangerousHref).toBe(false);
  expect(result.scriptsRan).toBe(false);
  expect(remoteRequests).toEqual([]);
});

test('真实 IndexedDB 去重、同名文件、损坏回滚与刷新后续读数据', async ({ page }) => {
  await page.goto('/__test_harness__');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/services/storage.ts';
    const storage = await import(modulePath);
    const load = async (name: string) => new File([await (await fetch(`/tests/fixtures/${name}`)).blob()], name, { type: 'application/epub+zip' });
    const first = await storage.importBook(await load('epub3.epub'));
    const duplicate = await storage.importBook(await load('epub3.epub'));
    await storage.importBook(await load('same-title.epub'));
    let corruptRejected = false;
    try { await storage.importBook(await load('corrupt.epub')); } catch { corruptRejected = true; }
    await storage.saveProgress({bookId:first.book.id,cfi:'epubcfi(/6/4[chapter1]!/4/2:0)',href:'OEBPS/Text/chapter1.xhtml',spineIndex:1,progression:.37,quoteContext:'窗边的小木桌',chapterTitle:'第一章',isFinished:false,updatedAt:Date.now()});
    return { firstId:first.book.id,duplicateId:duplicate.book.id,duplicate:duplicate.duplicate,count:(await storage.listBooks()).length,corruptRejected };
  });
  expect(result.duplicate).toBe(true);
  expect(result.duplicateId).toBe(result.firstId);
  expect(result.count).toBe(2);
  expect(result.corruptRejected).toBe(true);
  await page.reload();
  const restored = await page.evaluate(async id => {
    const modulePath = '/src/services/storage.ts';
    const storage = await import(modulePath);
    const progress = await storage.getProgress(id);
    const books = await storage.listBooks();
    return { progress:progress.progression,count:books.length,bookProgress:books.find((book: {id:string})=>book.id===id).progression };
  }, result.firstId);
  expect(restored).toEqual({progress:.37,count:2,bookProgress:.37});
});

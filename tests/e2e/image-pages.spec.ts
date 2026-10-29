import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ReaderAdapter } from '../../src/services/epub/reader';
import type { PageEntry, ReaderPosition, ReadingProgress } from '../../src/types';

type ImageHarness = Window & {
  __reader: ReaderAdapter;
  __pages: PageEntry[] | null;
  __position: ReaderPosition;
  __errors: string[];
  __reopen: (progress?: ReadingProgress) => Promise<void>;
};

async function openImageBook(page: Page, content: 'mixed' | 'images') {
  await page.route('**/__image_reader_harness__', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><style>body{margin:0}.book-frame{display:block;border:0;width:100%;height:100%}</style></head><body><div id="reader" style="width:1000px;height:700px"></div></body></html>',
  }));
  await page.goto('/__image_reader_harness__');
  await page.evaluate(async mode => {
    const parserPath = '/src/services/epub/import.ts';
    const readerPath = '/src/services/epub/reader.ts';
    const preferencesPath = '/src/preferences.ts';
    const { parseEpub } = await import(parserPath);
    const { ReaderAdapter } = await import(readerPath);
    const { DEFAULT_PREFERENCES } = await import(preferencesPath);
    const book = await parseEpub(await (await fetch('/tests/fixtures/epub3.epub')).blob());
    const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="${color}"/></svg>`;
    const img = (color: string) => `<img src="data:image/svg+xml,${encodeURIComponent(svg(color))}"/>`;
    const section = (body: string, index: number) => `<section${index ? ' style="break-before:column"' : ''}>${body}</section>`;
    const bodies = mode === 'mixed'
      ? ['<p>First page text.</p>', img('green'), '<p>Final page text.</p>']
      : [img('red'), img('green'), svg('blue')];
    book.chapters = [{
      ...book.chapters[0],
      html: `<html><head></head><body>${bodies.map(section).join('')}</body></html>`,
    }];
    const harness = window as unknown as ImageHarness;
    harness.__errors = [];
    harness.__reopen = async (progress?: ReadingProgress) => {
      harness.__reader?.destroy();
      harness.__pages = null;
      harness.__reader = new ReaderAdapter(document.getElementById('reader')!, book, DEFAULT_PREFERENCES, {
        position: (position: ReaderPosition) => { harness.__position = position; },
        index: (pages: PageEntry[] | null) => { harness.__pages = pages; },
        selection: () => {},
        annotation: () => {},
        error: (message: string) => { harness.__errors.push(message); },
      });
      await harness.__reader.open(progress);
    };
    await harness.__reopen();
  }, content);
  await expect.poll(() => page.evaluate(() => (window as unknown as ImageHarness).__pages?.length)).toBe(3);
}

test('图文混排的图片页可通过 CFI 返回，并在重新打开后继续阅读', async ({ page }) => {
  await openImageBook(page, 'mixed');
  const result = await page.evaluate(async () => {
    const harness = window as unknown as ImageHarness;
    await harness.__reader.goToPage(2);
    const saved = { ...harness.__position };
    await harness.__reader.goToPage(3);
    const finalPage = { ...harness.__position };
    await harness.__reader.goTo(saved.cfi);
    const returned = { ...harness.__position };
    await harness.__reopen({ ...saved, bookId: 'image-regression', updatedAt: Date.now() });
    return { saved, finalPage, returned };
  });
  expect(result.saved.page).toBe(2);
  expect(result.saved.quoteContext).toBe('');
  expect(result.saved.cfi).not.toBe(result.finalPage.cfi);
  expect(result.returned.page).toBe(2);
  expect(result.returned.isFinished).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as ImageHarness).__position.page)).toBe(2);
  expect(await page.evaluate(() => (window as unknown as ImageHarness).__position.isFinished)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as ImageHarness).__errors)).toEqual([]);
});

test('纯图片章节中的每一页都有独立 CFI，img 与 SVG 均可准确恢复', async ({ page }) => {
  await openImageBook(page, 'images');
  const result = await page.evaluate(async () => {
    const harness = window as unknown as ImageHarness;
    const states: { requested: number; saved: ReaderPosition; restored: ReaderPosition }[] = [];
    for (let requested = 1; requested <= 3; requested++) {
      await harness.__reader.goToPage(requested);
      const saved = { ...harness.__position };
      await harness.__reader.goToPage(requested === 1 ? 3 : 1);
      await harness.__reader.goTo(saved.cfi);
      states.push({ requested, saved, restored: { ...harness.__position } });
    }
    return { states, entries: harness.__pages!, errors: harness.__errors };
  });
  expect(result.errors).toEqual([]);
  expect(new Set(result.entries.map(entry => entry.cfi)).size).toBe(3);
  expect(new Set(result.states.map(state => state.saved.cfi)).size).toBe(3);
  expect(result.states.map(state => state.restored.page)).toEqual([1, 2, 3]);
  expect(result.states.map(state => state.restored.isFinished)).toEqual([false, false, true]);
  expect(result.states.every(state => state.saved.quoteContext === '')).toBe(true);
});

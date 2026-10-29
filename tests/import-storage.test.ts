import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EPUB_LIMITS, parseEpub, resolvePackagePath } from '../src/services/epub/import';
import { db, deleteAnnotation, flushPendingWrites, getBookFile, getPageIndex, getPreferences, getProgress, importBook, listAnnotations, listBookmarks, listBooks, putAnnotation, putBookmark, putPageIndex, removeBook, savePreferences, saveProgress } from '../src/services/storage';
import type { Annotation, ReadingProgress } from '../src/types';

type Options = { version?:string; nav?:boolean; ncx?:boolean; noTitle?:boolean; body?:string; extra?:Record<string,string>; layout?:string; encrypted?:boolean; missingChapter?:boolean };
function fixture(options:Options = {}): File {
  const version = options.version ?? '3.0';
  const packageXml = `<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${options.noTitle?'':'<dc:title>测试图书</dc:title>'}<dc:creator>测试作者</dc:creator><dc:identifier id="uid">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier><dc:language>zh-CN</dc:language>${options.layout?`<meta property="rendition:layout">${options.layout}</meta>`:''}</metadata><manifest><item id="ch1" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/><item id="img" href="cover.png" media-type="image/png" properties="cover-image"/>${options.nav?'<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>':''}${options.ncx?'<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>':''}</manifest><spine${options.ncx?' toc="ncx"':''}><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`;
  const files:Record<string,Uint8Array> = {
    mimetype:strToU8('application/epub+zip'),
    'META-INF/container.xml':strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/book.opf':strToU8(packageXml),
    'OEBPS/text/one.xhtml':strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>原书标题</title><link rel="stylesheet" href="../style.css"/></head><body><h1>第一章</h1>${options.body ?? '<p id="start">春日的风吹过山野，阅读从此开始。</p><img src="../cover.png"/>'}</body></html>`),
    'OEBPS/text/two.xhtml':strToU8('<html><body><h1>第二章</h1><p>这是第二章。</p></body></html>'),
    'OEBPS/style.css':strToU8('p { line-height: 1.8; }'),
    'OEBPS/cover.png':Uint8Array.from([137,80,78,71,13,10,26,10]),
  };
  if (options.nav) files['OEBPS/nav.xhtml']=strToU8('<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/one.xhtml">一章目录</a><ol><li><a href="text/one.xhtml#start">第一节</a><ol><li><a href="text/one.xhtml#sub">三级节点</a></li></ol></li></ol></li><li><a href="text/two.xhtml">二章目录</a></li></ol></nav></body></html>');
  if (options.ncx) files['OEBPS/toc.ncx']=strToU8('<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="a"><navLabel><text>NCX 第一章</text></navLabel><content src="text/one.xhtml"/><navPoint id="b"><navLabel><text>NCX 子节</text></navLabel><content src="text/one.xhtml#start"/></navPoint></navPoint></navMap></ncx>');
  if (options.encrypted) files['META-INF/encryption.xml']=strToU8('<encryption><EncryptedData><EncryptionMethod Algorithm="urn:drm"/><CipherData><CipherReference URI="OEBPS/text/one.xhtml"/></CipherData></EncryptedData></encryption>');
  if (options.missingChapter) delete files['OEBPS/text/two.xhtml'];
  for (const [name,source] of Object.entries(options.extra ?? {})) files[name]=strToU8(source);
  const zip=zipSync(files,{mtime:new Date('2020-01-01T00:00:00Z')});
  return new File([new Uint8Array(zip).buffer], '测试图书.epub', {type:'application/epub+zip'});
}

beforeAll(()=>{ vi.stubGlobal('crypto',webcrypto); vi.stubGlobal('Blob',NodeBlob); vi.stubGlobal('File',NodeFile); });
beforeEach(async()=>{ await db.delete(); await db.open(); });
afterAll(async()=>{ await db.delete(); vi.unstubAllGlobals(); });

describe('EPUB parsing and content isolation',()=>{
  it('reads EPUB3 metadata, nested navigation, resources, and stable spine bases',async()=>{
    const result=await parseEpub(fixture({nav:true}));
    expect(result.title).toBe('测试图书');
    expect(result.author).toBe('测试作者');
    expect(result.chapters.map(c=>c.cfiBase)).toEqual(['/6/2[ch1]','/6/4[ch2]']);
    expect(result.toc[0].children[0].children[0].label).toBe('三级节点');
    expect(result.toc[0].children[0].href).toBe('OEBPS/text/one.xhtml#start');
    expect(result.chapters[0].title).toBe('一章目录');
    expect(result.chapters[0].html).toContain('data:image/png;base64,');
    expect(result.chapters[0].html).toContain('Content-Security-Policy');
    expect(result.coverBlob?.type).toBe('image/png');
  });
  it('reads EPUB2 NCX and falls back to spine titles when a TOC is missing',async()=>{
    const epub2=await parseEpub(fixture({version:'2.0',ncx:true}));
    expect(epub2.version).toBe('2.0');
    expect(epub2.toc[0].children[0].label).toBe('NCX 子节');
    const fallback=await parseEpub(fixture({noTitle:true}),'无元数据.epub');
    expect(fallback.title).toBe('无元数据');
    expect(fallback.toc.map(c=>c.label)).toEqual(['第一章','第二章']);
  });
  it('removes executable content and remote loads while retaining safe local and external links',async()=>{
    const result=await parseEpub(fixture({body:'<script>parent.pwned=true</script><p onclick="alert(1)" style="background:url(https://tracker.invalid/x)">正文</p><img src="https://tracker.invalid/pixel"/><a href="javascript:alert(1)">危险链接</a><a href="two.xhtml#anchor">本书</a><a href="https://example.com">外链</a><iframe src="https://tracker.invalid/frame"></iframe><form action="https://tracker.invalid"><input/></form>',extra:{'OEBPS/style.css':'@import "https://tracker.invalid/font.css"; p {background:url(https://tracker.invalid/bg)}'}}));
    const doc=new DOMParser().parseFromString(result.chapters[0].html,'text/html');
    expect(doc.querySelector('script,iframe,form,input,[onclick]')).toBeNull();
    expect(doc.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('[data-epub-href]')?.getAttribute('data-epub-href')).toBe('OEBPS/text/two.xhtml#anchor');
    expect(doc.querySelector('a[href="https://example.com"]')?.getAttribute('rel')).toContain('noopener');
    expect(result.chapters[0].html).not.toContain('tracker.invalid');
  });
  it('rejects invalid ZIP paths, DRM, fixed layout, and missing required resources',async()=>{
    await expect(parseEpub(fixture({extra:{'../escape.txt':'bad'}}))).rejects.toThrow('不安全');
    await expect(parseEpub(fixture({encrypted:true}))).rejects.toThrow('DRM');
    await expect(parseEpub(fixture({layout:'pre-paginated'}))).rejects.toThrow('固定版式');
    await expect(parseEpub(fixture({missingChapter:true}))).rejects.toThrow('缺少第 2 节');
    await expect(parseEpub(new Blob(['not a zip']))).rejects.toThrow('压缩包');
  });
  it('breaks circular CSS imports and rejects repeated imports that expand beyond the style budget',async()=>{
    const circular=await parseEpub(fixture({extra:{
      'OEBPS/style.css':'@import "nested.css"; p { color: #123456; }',
      'OEBPS/nested.css':'@import "style.css#again"; h1 { font-weight: 700; }',
    }}));
    expect(circular.chapters[0].html).toContain('color: #123456');
    expect(circular.chapters[0].html).toContain('font-weight: 700');
    expect(circular.chapters[0].html).not.toContain('@import');
    await expect(parseEpub(fixture({extra:{
      'OEBPS/style.css':'@import "repeated.css";'.repeat(1024),
      'OEBPS/repeated.css':'p { color: #123456; }'.repeat(1024),
    }}))).rejects.toThrow('样式展开后过大');
  });
  it('charges repeated nested SVG references against the expansion budget before creating large data URLs',async()=>{
    const oldLimit=EPUB_LIMITS.expanded;
    EPUB_LIMITS.expanded=128*1024;
    try {
      const extra:Record<string,string>={};
      for(let layer=0;layer<6;layer++)extra[`OEBPS/layer${layer}.svg`]=`<svg xmlns="http://www.w3.org/2000/svg">${layer===5?'<rect width="10" height="10"/>':`<image href="layer${layer+1}.svg"/>`.repeat(8)}</svg>`;
      await expect(parseEpub(fixture({body:'<img src="../layer0.svg"/>',extra}))).rejects.toThrow('样式或图片展开后过大');
    } finally { EPUB_LIMITS.expanded=oldLimit; }
  });
  it('normalizes local references without allowing remote protocols or escaped package paths',()=>{
    expect(resolvePackagePath('OEBPS/text/a.xhtml','../images/a%20b.png')).toBe('OEBPS/images/a b.png');
    expect(resolvePackagePath('OEBPS/a.xhtml','//tracker.invalid/p')).toBeUndefined();
    expect(resolvePackagePath('OEBPS/a.xhtml','javascript:alert(1)')).toBeUndefined();
    expect(resolvePackagePath('OEBPS/a.xhtml','%2e%2e/%2e%2e/file')).not.toContain('..');
  });
});

describe('transactional local library',()=>{
  it('deduplicates bytes without overwriting progress, and permits same-name different books',async()=>{
    const first=await importBook(fixture());
    const progress:ReadingProgress={bookId:first.book.id,cfi:'epubcfi(/6/2[ch1]!/4/2/1:8)',href:'OEBPS/text/one.xhtml',spineIndex:0,progression:.4,quoteContext:'山野',chapterTitle:'第一章',isFinished:false,updatedAt:Date.now()};
    await saveProgress(progress);
    const duplicate=await importBook(fixture());
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.book.id).toBe(first.book.id);
    expect((await getProgress(first.book.id))?.cfi).toBe(progress.cfi);
    expect((await listBooks())[0].progression).toBe(.4);
    await importBook(fixture({body:'<p>另一个文件，同一书名。</p>'}));
    expect(await listBooks()).toHaveLength(2);
    expect((await getBookFile(first.book.id)).size).toBeGreaterThan(0);
  });
  it('rolls back a file-write failure rather than leaving an unusable book card',async()=>{
    const spy=vi.spyOn(db.bookFiles,'add').mockRejectedValueOnce(new DOMException('full','QuotaExceededError'));
    await expect(importBook(fixture())).rejects.toThrow('full');
    expect(await listBooks()).toHaveLength(0);
    spy.mockRestore();
  });
  it('flushes book records started without awaiting their write promises',async()=>{
    const {book}=await importBook(fixture());
    const bookmark={id:'flush-bookmark',bookId:book.id,cfi:'epubcfi(/6/2!/4/2/1:0)',href:'OEBPS/text/one.xhtml',chapterTitle:'第一章',excerpt:'正文',createdAt:Date.now()};
    const annotation:Annotation={id:'flush-annotation',bookId:book.id,rangeCfi:'epubcfi(/6/2!/4/2,/1:0,/1:2)',href:bookmark.href,chapterTitle:'第一章',quote:'正文',prefix:'',suffix:'',note:'关闭前的笔记',color:'#ffe9a0',createdAt:Date.now(),updatedAt:Date.now()};
    const bookmarkWrite=putBookmark(bookmark),annotationWrite=putAnnotation(annotation);
    let writesFinished=false;
    const writes=Promise.all([bookmarkWrite,annotationWrite]).then(()=>{writesFinished=true;});
    await flushPendingWrites();
    expect(writesFinished).toBe(true);
    expect(await listBookmarks(book.id)).toEqual([bookmark]);
    expect(await listAnnotations(book.id)).toEqual([annotation]);
    await writes;
  });
  it('persists settings and records, deduplicates bookmarks, and removes one book atomically',async()=>{
    const {book}=await importBook(fixture());
    const other=await importBook(fixture({body:'<p>另一本</p>'}));
    const preferences=await getPreferences();
    await savePreferences({...preferences,fontSize:30,readingMode:'scrolled'});
    const bookmark={id:'b1',bookId:book.id,cfi:'epubcfi(/6/2!/4/2/1:0)',href:'OEBPS/text/one.xhtml',chapterTitle:'第一章',excerpt:'正文',createdAt:Date.now()};
    await putBookmark(bookmark); await putBookmark({...bookmark,id:'b2'});
    expect(await listBookmarks(book.id)).toHaveLength(1);
    const annotation:Annotation={id:'a1',bookId:book.id,rangeCfi:'epubcfi(/6/2!/4/2,/1:0,/1:2)',href:bookmark.href,chapterTitle:'第一章',quote:'正文',prefix:'',suffix:'',note:'笔记',color:'#ffe9a0',createdAt:Date.now(),updatedAt:Date.now()};
    await putAnnotation(annotation);
    await putAnnotation({...annotation,note:'更新的笔记'});
    expect((await listAnnotations(book.id))[0].note).toBe('更新的笔记');
    await putPageIndex({id:'idx',bookId:book.id,signature:'width-900',pages:[{chapter:0,localPage:0,cfi:bookmark.cfi}]});
    expect((await getPageIndex(book.id,'width-900'))?.pages).toHaveLength(1);
    await removeBook(book.id);
    expect(await listBookmarks(book.id)).toHaveLength(0);
    expect(await listAnnotations(book.id)).toHaveLength(0);
    expect(await getPageIndex(book.id,'width-900')).toBeUndefined();
    await expect(getBookFile(book.id)).rejects.toThrow('找不到原书');
    expect((await listBooks())[0].id).toBe(other.book.id);
    expect((await getPreferences()).fontSize).toBe(30);
    await expect(putAnnotation(annotation)).rejects.toThrow('已被移除');
    await deleteAnnotation(annotation.id);
  });
});

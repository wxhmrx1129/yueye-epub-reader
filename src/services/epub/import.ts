import DOMPurify from 'dompurify';
import { strFromU8, unzipSync } from 'fflate';
import type { Chapter, ParsedBook, TocItem } from '../../types';
import { openArchive } from './archive';
import { validateImagePixels } from './image-limits';
import { checkCancelled, FILE_LIMIT, validateFileSize, type TaskOptions } from '../tasks';

export const EPUB_LIMITS = { archive: FILE_LIMIT, unpacked: 750 * 1024 ** 2, resource: 50 * 1024 ** 2, entries: 10000, expanded: 250 * 1024 ** 2, stylesheet: 16 * 1024 ** 2 };
const MIME: Record<string, string> = { jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',avif:'image/avif',css:'text/css',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',xhtml:'application/xhtml+xml',html:'text/html' };
const CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src 'none'";
type ManifestItem = { id: string; href: string; media: string; properties: string[] };

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('无法读取文件，请重新选择。'));
    reader.readAsArrayBuffer(blob);
  });
}

function fail(message: string): never { throw new Error(message); }
function xml(source: string, name: string): Document {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) fail(`${name} 格式损坏，无法解析。`);
  return doc;
}
function elements(parent: Document | Element, localName: string): Element[] { return Array.from(parent.getElementsByTagNameNS('*', localName)); }
function text(parent: Document | Element, localName: string): string { return elements(parent, localName)[0]?.textContent?.trim() ?? ''; }
function withoutFragment(href: string): string { return href.split('#')[0]; }

/** Package paths are normalized once; remote URLs are never fetched. */
export function resolvePackagePath(base: string, reference: string): string | undefined {
  const value = reference.trim();
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value) || value.includes('\\')) return undefined;
  try {
    const resolved = new URL(value, `https://epub.invalid/${base}`);
    if (resolved.origin !== 'https://epub.invalid' || resolved.search) return undefined;
    const pathname = decodeURIComponent(resolved.pathname).replace(/^\//, '');
    if (pathname.split('/').some(part => part === '..' || part === '.') || pathname.includes('\\') || pathname.includes('\0')) return undefined;
    return pathname + resolved.hash;
  } catch { return undefined; }
}

function inspectZip(bytes: Uint8Array) {
  if (bytes.length < 22) fail('这不是有效的 EPUB 文件：压缩包不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail('这不是有效的 EPUB 文件：找不到压缩包目录。');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff) fail('暂不支持分卷或 ZIP64 格式的 EPUB。');
  if (count > EPUB_LIMITS.entries) fail(`书籍资源过多，最多支持 ${EPUB_LIMITS.entries} 项。`);
  if (offset + centralSize > end) fail('EPUB 压缩包目录已损坏。');
  let total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail('EPUB 压缩包目录已损坏。');
    const flags = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) fail('EPUB 压缩包目录已损坏。');
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (flags & 1) fail('该 EPUB 已加密，首版暂不支持 DRM 或加密压缩包。');
    if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\\') || name.includes('\0') || Object.prototype.hasOwnProperty.call(Object.prototype,name) || name.split('/').some(part => part === '..' || part === '.')) fail('EPUB 包含不安全的资源路径。');
    if (names.has(name)) fail('EPUB 包含重名资源，无法可靠定位正文。');
    names.add(name);
    if (size > EPUB_LIMITS.resource) fail('单项书籍资源超过 50MiB 限制。');
    total += size;
    if (total > EPUB_LIMITS.unpacked) fail('书籍解压后超过 750MiB 安全限制。');
    offset = next;
  }
  return names;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function safeExternalUrl(value: string) { return /^https?:\/\//i.test(value.trim()); }
function safeDataResource(value: string) {
  return /^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype));base64,[a-z0-9+/=\r\n]+$/i.test(value);
}

export async function parseEpub(blob: Blob, originalFileName = '未命名.epub', options: TaskOptions & {lazy?:boolean; bytes?:Uint8Array} = {}): Promise<ParsedBook> {
  validateFileSize(blob.size); checkCancelled(options.signal);
  options.onStage?.('校验 EPUB 结构');
  const bytes = options.bytes ?? await readBlobBytes(blob);
  checkCancelled(options.signal);
  const zipNames = inspectZip(bytes);
  const archive = options.lazy ? openArchive(bytes,EPUB_LIMITS.resource,EPUB_LIMITS.unpacked,options.signal) : undefined;
  let files: Record<string, Uint8Array> = {};
  const objectUrls = new Set<string>();
  const fontKeys = new Map<string,{key:Uint8Array;length:number}>();
  let releaseResources=()=>{};
  const dispose = () => { archive?.dispose(); for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); fontKeys.clear();files = {};releaseResources(); };
  try {
  async function ensure(paths: string[]) {
    checkCancelled(options.signal);
    const missing = [...new Set(paths.map(withoutFragment))].filter(path => zipNames.has(path) && !files[path]);
    if (missing.length && archive) {
      const loaded=await archive.read(missing);
      for(const [path,data] of Object.entries(loaded)) {
        const mask=fontKeys.get(path);
        if(mask)for(let i=0;i<Math.min(data.length,mask.length);i++)data[i]^=mask.key[i%mask.key.length];
      }
      Object.assign(files,loaded);
    }
    checkCancelled(options.signal);
  }
  try {
    let declaredTotal = 0;
    if (!archive) files = unzipSync(bytes, { filter: entry => {
      if (!zipNames.has(entry.name) || entry.originalSize > EPUB_LIMITS.resource) fail('EPUB 资源目录与实际内容不一致。');
      declaredTotal += entry.originalSize;
      if (declaredTotal > EPUB_LIMITS.unpacked) fail('书籍解压后超过 750MiB 安全限制。');
      return !entry.name.endsWith('/');
    } });
  } catch (error) { fail(error instanceof Error && /限制|不一致/.test(error.message) ? error.message : 'EPUB 压缩包损坏，无法解压。'); }
  if (Object.keys(files).length > EPUB_LIMITS.entries || Object.values(files).reduce((sum, data) => sum + data.length, 0) > EPUB_LIMITS.unpacked) fail('EPUB 资源超过导入限制。');
  const read = (path: string): string => { const data = files[withoutFragment(path)]; return data ? strFromU8(data) : fail(`EPUB 缺少必要资源：${path}`); };
  await ensure(['mimetype','META-INF/container.xml','META-INF/encryption.xml']);
  if (!files['META-INF/container.xml']) fail('文件缺少 META-INF/container.xml，不是可识别的 EPUB。');
  if (files.mimetype && strFromU8(files.mimetype).trim() !== 'application/epub+zip') fail('文件内容不是 EPUB 格式。');
  const container = xml(read('META-INF/container.xml'), 'EPUB 容器');
  const opf = elements(container, 'rootfile').find(item => item.getAttribute('media-type') === 'application/oebps-package+xml')?.getAttribute('full-path') ?? elements(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opf || !zipNames.has(opf)) fail('EPUB 缺少有效的 OPF 图书描述。');
  await ensure([opf]);
  const packageDoc = xml(read(opf), 'OPF');
  const pkg = packageDoc.documentElement;
  const spineElement = elements(packageDoc, 'spine')[0];
  if (!spineElement) fail('图书没有可阅读的章节。');
  const metas = elements(packageDoc, 'meta');
  if (metas.some(m => m.getAttribute('property') === 'rendition:layout' && m.textContent?.trim() === 'pre-paginated') || metas.some(m => m.getAttribute('name') === 'fixed-layout' && m.getAttribute('content') === 'true')) fail('该书为固定版式 EPUB，当前版本仅支持可重排版图书。');
  if (spineElement.getAttribute('page-progression-direction') === 'rtl') fail('当前版本暂不支持从右向左阅读的 EPUB。');
  const manifest = new Map<string, ManifestItem>();
  for (const item of elements(packageDoc, 'item')) {
    const id = item.getAttribute('id');
    const href = resolvePackagePath(opf, item.getAttribute('href') ?? '');
    if (id && href) manifest.set(id, { id, href:withoutFragment(href), media:item.getAttribute('media-type') ?? '', properties:(item.getAttribute('properties') ?? '').split(/\s+/) });
  }
  const title = text(packageDoc, 'title') || originalFileName.replace(/\.epub$/i, '') || '未命名图书';
  const author = elements(packageDoc, 'creator').map(el => el.textContent?.trim()).filter(Boolean).join('、') || '未知作者';
  const language = text(packageDoc, 'language') || 'und';
  const mimeByPath = new Map(Array.from(manifest.values(), item => [item.href, item.media]));

  // Standard font obfuscation is not DRM; reverse only the two EPUB font algorithms.
  if (files['META-INF/encryption.xml']) {
    const encrypted = xml(read('META-INF/encryption.xml'), '加密资源描述');
    const identifierId = pkg.getAttribute('unique-identifier');
    const identifier = elements(packageDoc, 'identifier').find(el => el.getAttribute('id') === identifierId)?.textContent?.trim() ?? text(packageDoc, 'identifier');
    for (const entry of elements(encrypted, 'EncryptedData')) {
      const algorithm = elements(entry, 'EncryptionMethod')[0]?.getAttribute('Algorithm');
      const uri = elements(entry, 'CipherReference')[0]?.getAttribute('URI') ?? '';
      const path = resolvePackagePath('', uri);
      if (!path || !zipNames.has(path)) fail('书籍加密资源描述无效。');
      await ensure([path]);
      const media = mimeByPath.get(path) ?? '';
      if (!/font|opentype|truetype/i.test(media)) fail('该 EPUB 含 DRM 加密内容，当前版本无法打开。');
      let key: Uint8Array;
      let length: number;
      if (algorithm === 'http://www.idpf.org/2008/embedding') {
        key = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(identifier.replace(/\s/g, '')))); length = 1040;
      } else if (algorithm === 'http://ns.adobe.com/pdf/enc#RC') {
        const hex = identifier.replace(/^urn:uuid:/i, '').replace(/-/g, '');
        if (!/^[0-9a-f]{32}$/i.test(hex)) fail('图书字体混淆标识不正确。');
        key = Uint8Array.from(hex.match(/../g)!, chunk => parseInt(chunk, 16)); length = 1024;
      } else fail('该 EPUB 含不支持的加密内容，当前版本无法打开。');
      const data = files[path].slice();
      for (let i = 0; i < Math.min(data.length, length); i++) data[i] ^= key[i % key.length];
      files[path] = data;
      fontKeys.set(path,{key,length});
    }
  }

  const resourceCache = new Map<string, string>();
  const resourceBlobs = new Map<string,Blob>();
  const resourceUsers = new Map<string,Set<number>>();
  releaseResources=()=>{resourceCache.clear();resourceBlobs.clear();resourceUsers.clear();};
  let usedResources = new Set<string>();
  const localResource = (value:string) => safeDataResource(value) || objectUrls.has(withoutFragment(value));
  const activeResources = new Set<string>();
  let expandedCharacters = 0;
  function accountExpansion(length: number) {
    expandedCharacters += length;
    if (expandedCharacters > EPUB_LIMITS.expanded) fail('书籍样式或图片展开后过大，超过安全导入限制。');
  }
  function resourceUrl(path: string, embedded = false): string | undefined {
    const fragment = path.includes('#') ? path.slice(path.indexOf('#')) : '';
    path = withoutFragment(path);
    usedResources.add(path);
    const cacheKey = embedded ? `inline:${path}` : path;
    const data = files[path];
    if (!data) return undefined;
    if (resourceCache.has(cacheKey)) {
      const cached = resourceCache.get(cacheKey)! + fragment;
      accountExpansion(cached.length);
      return cached;
    }
    if (activeResources.has(path)) return undefined;
    activeResources.add(path);
    const media = mimeByPath.get(path) || MIME[path.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
    validateImagePixels(data,media);
    let content = data;
    if (media === 'image/svg+xml') {
      const svgDoc = new DOMParser().parseFromString(strFromU8(data), 'image/svg+xml');
      svgDoc.querySelectorAll('script,foreignObject,iframe,object,embed,style').forEach(el => el.remove());
      for (const element of Array.from(svgDoc.querySelectorAll('*'))) {
        for (const attr of Array.from(element.attributes)) {
          if (/^on/i.test(attr.name) || attr.name === 'style') element.removeAttribute(attr.name);
          if (/^(?:href|xlink:href)$/i.test(attr.name) && !attr.value.startsWith('#')) {
            const referenced = resolvePackagePath(path, attr.value);
            const replacement = referenced ? resourceUrl(referenced,true) : undefined;
            if (replacement) element.setAttribute(attr.name, replacement); else element.removeAttribute(attr.name);
          }
          if (/url\s*\(/i.test(attr.value) && !/^url\(\s*['"]?#/i.test(attr.value)) element.removeAttribute(attr.name);
        }
      }
      content = new TextEncoder().encode(DOMPurify.sanitize(new XMLSerializer().serializeToString(svgDoc), { USE_PROFILES:{svg:true,svgFilters:true} }));
    }
    // Lazy readers share binary Blob URLs instead of copying image data into every chapter.
    accountExpansion(archive && !embedded ? content.length : media.length + 13 + Math.ceil(content.length / 3) * 4 + fragment.length);
    const binary = archive && !embedded ? new Blob([new Uint8Array(content).buffer],{type:media}) : undefined;
    const url = binary ? URL.createObjectURL(binary) : `data:${media};base64,${base64(content)}`;
    if (binary) resourceBlobs.set(path,binary);
    if (archive) objectUrls.add(url);
    resourceCache.set(cacheKey, url);
    activeResources.delete(path);
    return url + fragment;
  }
  function css(source: string, base: string, depth = 0, ancestors = new Set<string>()): string {
    const stylesheetPath = withoutFragment(base);
    if (depth > 6 || ancestors.has(stylesheetPath)) return '';
    accountExpansion(source.length);
    const chain = new Set(ancestors).add(stylesheetPath);
    let expandedLength = source.length;
    function accountStylesheet(length: number) {
      expandedLength += length;
      if (expandedLength > EPUB_LIMITS.stylesheet) fail('书籍样式展开后过大，超过安全导入限制。');
    }
    accountStylesheet(0);
    let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
    result = result.replace(/@import\s+(?:url\(\s*)?["']?([^"'\s);]+)["']?\s*\)?[^;]*;/gi, (_all, href:string) => {
      const path = resolvePackagePath(base, href);
      const imported = path && files[withoutFragment(path)] ? css(read(path), path, depth + 1, chain) : '';
      accountStylesheet(imported.length);
      return imported;
    });
    // CSS escape sequences are unnecessary for the supported resource URLs and can obscure protocols.
    result = result.replace(/(?:expression\s*\([^;]*|behavior\s*:[^;]*|-moz-binding\s*:[^;]*)/gi, '');
    result = result.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_all, _quote:string, href:string) => {
      if (href.startsWith('#')) return `url("${href.replace(/["\\\n\r]/g, '')}")`;
      if (localResource(href)) return `url("${href}")`;
      const path = resolvePackagePath(base, href);
      const url = path ? resourceUrl(path) : undefined;
      if (url) accountStylesheet(url.length);
      return url ? `url("${url}")` : 'url("")';
    });
    return result;
  }
  function chapterHtml(source: string, path: string): { html:string; title:string } {
    accountExpansion(source.length);
    const doc = new DOMParser().parseFromString(source, 'text/html');
    if (doc.documentElement.getAttribute('dir') === 'rtl' || doc.body.getAttribute('dir') === 'rtl') fail('该书采用从右向左排版，当前版本暂不支持。');
    const chapterTitle = doc.body.querySelector('h1,h2,h3')?.textContent?.trim() || doc.querySelector('title')?.textContent?.trim() || '';
    doc.querySelectorAll('script,iframe,object,embed,base,form,input,button,textarea,select,audio,video,source,track,meta').forEach(el => el.remove());
    for (const link of Array.from(doc.querySelectorAll('link'))) {
      const target = resolvePackagePath(path, link.getAttribute('href') ?? '');
      if (link.getAttribute('rel')?.split(/\s+/).includes('stylesheet') && target && files[withoutFragment(target)]) {
        const style = doc.createElement('style'); style.textContent = css(read(target), target); link.replaceWith(style);
      } else link.remove();
    }
    for (const style of Array.from(doc.querySelectorAll('style'))) style.textContent = css(style.textContent ?? '', path);
    const layoutCss = Array.from(doc.querySelectorAll('style,[style]')).map(el => el.localName === 'style' ? el.textContent ?? '' : el.getAttribute('style') ?? '').join('\n');
    if (/(?:writing-mode\s*:\s*(?:vertical|tb)|-epub-writing-mode\s*:\s*vertical)/i.test(layoutCss)) fail('该书采用竖排版式，当前版本暂不支持。');
    for (const element of Array.from(doc.querySelectorAll('*'))) {
      for (const attr of Array.from(element.attributes)) {
        if (/^on/i.test(attr.name) || ['srcset','ping','action','formaction','autofocus','contenteditable','srcdoc','background','poster'].includes(attr.name.toLowerCase())) { element.removeAttribute(attr.name); continue; }
        if (attr.name === 'style') { element.setAttribute('style', css(attr.value, path)); continue; }
        const isHref = /^(?:href|xlink:href)$/i.test(attr.name);
        const isResource = attr.name.toLowerCase() === 'src' || isHref && element.localName !== 'a';
        if (isResource) {
          if (isHref && attr.value.startsWith('#')) continue;
          if (localResource(attr.value)) continue;
          const target = resolvePackagePath(path, attr.value);
          const replacement = target ? resourceUrl(target) : undefined;
          if (replacement) element.setAttribute(attr.name, replacement); else element.removeAttribute(attr.name);
        } else if (isHref) {
          if (safeExternalUrl(attr.value)) {
            element.setAttribute('target','_blank'); element.setAttribute('rel','noopener noreferrer');
          } else {
            const target = resolvePackagePath(path, attr.value);
            if (target) { element.setAttribute('href', '#'); element.setAttribute('data-epub-href', target); }
            else element.removeAttribute(attr.name);
          }
        }
      }
    }
    const clean = DOMPurify.sanitize(doc.documentElement.outerHTML, {
      WHOLE_DOCUMENT:true, ADD_TAGS:['style'], ADD_ATTR:['data-epub-href','epub:type'],
      ALLOWED_URI_REGEXP:/^(?:(?:https?|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
      FORBID_TAGS:['script','iframe','object','embed','form','input','button','textarea','select','audio','video','source','track','base','link','meta'],
    });
    const output = new DOMParser().parseFromString(clean, 'text/html');
    const csp = output.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = CSP; output.head.prepend(csp);
    const charset = output.createElement('meta'); charset.setAttribute('charset', 'utf-8'); output.head.prepend(charset);
    return {html:'<!doctype html>\n'+output.documentElement.outerHTML,title:chapterTitle};
  }

  let toc: TocItem[] = [];
  const navItem = Array.from(manifest.values()).find(item => item.properties.includes('nav'));
  if (navItem) await ensure([navItem.href]);
  if (navItem && files[navItem.href]) {
    const navDoc = new DOMParser().parseFromString(read(navItem.href), 'text/html');
    const navs = Array.from(navDoc.querySelectorAll('nav'));
    const nav = navs.find(el => /\btoc\b/.test(el.getAttribute('epub:type') ?? el.getAttribute('type') ?? '') || el.getAttribute('role') === 'doc-toc') ?? navs[0];
    const parseOl = (ol: Element | undefined, prefix: string): TocItem[] => !ol ? [] : Array.from(ol.children).filter(el => el.localName === 'li').map((li, index) => {
      const labelElement = Array.from(li.children).find(el => el.localName === 'a' || el.localName === 'span');
      const label = labelElement?.textContent?.trim() || `第 ${index + 1} 节`;
      const href = labelElement?.getAttribute('href');
      const nested = Array.from(li.children).find(el => el.localName === 'ol');
      return {id:`${prefix}-${index}`,label,href:href ? resolvePackagePath(navItem.href,href) ?? '' : '',children:parseOl(nested,`${prefix}-${index}`)};
    });
    toc = parseOl(nav?.querySelector('ol') ?? undefined, 'nav');
  }
  if (!toc.length) {
    const ncxId = spineElement.getAttribute('toc');
    const ncx = (ncxId ? manifest.get(ncxId) : undefined) ?? Array.from(manifest.values()).find(item => item.media === 'application/x-dtbncx+xml');
    if (ncx) await ensure([ncx.href]);
    if (ncx && files[ncx.href]) {
      try {
        const ncxDoc = xml(read(ncx.href), 'NCX 目录');
        const parsePoints = (parent: Element, prefix: string): TocItem[] => Array.from(parent.children).filter(el => el.localName === 'navPoint').map((point,index) => {
          const content = Array.from(point.children).find(el => el.localName === 'content');
          return {id:`${prefix}-${index}`,label:text(point,'text') || `第 ${index+1} 节`,href:resolvePackagePath(ncx.href,content?.getAttribute('src') ?? '') ?? '',children:parsePoints(point,`${prefix}-${index}`)};
        });
        const navMap = elements(ncxDoc,'navMap')[0];
        if (navMap) toc = parsePoints(navMap,'ncx');
      } catch { /* A broken optional NCX must not prevent reading the spine. */ }
    }
  }
  const findLabel = (items:TocItem[],href:string):string => {
    for (const item of items) { if (withoutFragment(item.href) === href && !item.href.includes('#')) return item.label; const nested = findLabel(item.children,href); if (nested) return nested; }
    return '';
  };
  const chapters: Chapter[] = [];
  const spineItems = Array.from(spineElement.children).filter(el => el.localName === 'itemref');
  for (let index = 0; index < spineItems.length; index++) {
    const itemRef = spineItems[index];
    if (itemRef.getAttribute('linear') === 'no') continue;
    if ((itemRef.getAttribute('properties') ?? '').includes('rendition:layout-pre-paginated')) fail('该书含固定版式章节，当前版本仅支持可重排版图书。');
    const idref = itemRef.getAttribute('idref') ?? '';
    const item = manifest.get(idref);
    if (!item || !zipNames.has(item.href)) fail(`图书缺少第 ${index + 1} 节正文资源。`);
    if (!['application/xhtml+xml','text/html'].includes(item.media)) continue;
    const content = archive ? {html:'',title:''} : chapterHtml(read(item.href),item.href);
    const escapedId = idref.replace(/[\[\](),;=^]/g, char => '^'+char);
    chapters.push({id:item.id,href:item.href,title:findLabel(toc,item.href) || content.title || `第 ${chapters.length+1} 节`,cfiBase:`/6/${(index+1)*2}[${escapedId}]`,html:content.html});
  }
  if (!chapters.length) fail('图书没有可阅读的 XHTML 章节。');
  if (!toc.length) toc = chapters.map((chapter,index) => ({id:`spine-${index}`,label:chapter.title,href:chapter.href,children:[]}));
  const coverId = metas.find(el => el.getAttribute('name') === 'cover')?.getAttribute('content');
  const cover = Array.from(manifest.values()).find(item => item.properties.includes('cover-image')) ?? (coverId ? manifest.get(coverId) : undefined);
  let coverBlob: Blob | undefined;
  // Load only the local dependency graph needed by this chapter (CSS, images, SVG and fonts).
  async function preload(path:string, seen = new Set<string>(), depth = 0):Promise<void> {
    path = withoutFragment(path);
    if (seen.has(path) || depth > 10 || !zipNames.has(path)) return;
    seen.add(path); await ensure([path]);
    const media = mimeByPath.get(path) || MIME[path.split('.').pop()?.toLowerCase() ?? ''];
    if (!/xml|html|css/.test(media ?? '') || !files[path]) return;
    const source = read(path);
    const references = [...source.matchAll(/(?:src|href|xlink:href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')\s]+)|@import\s*["']([^"']+)["']/gi)];
    for (const match of references) {
      const target = resolvePackagePath(path,match[1] ?? match[2] ?? match[3]);
      if (!target || /\.(?:xhtml|html|opf|ncx)(?:#|$)/i.test(target)) continue;
      await preload(target,seen,depth+1);
    }
  }
  if (cover) await preload(cover.href);
  if (cover && files[cover.href] && cover.media.startsWith('image/')) {
    const url = resourceUrl(cover.href);
    if (url) {
      if (archive) coverBlob = resourceBlobs.get(cover.href);
      else {
        const encoded = url.slice(url.indexOf(',')+1);
        const content = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        coverBlob = new Blob([content], {type:cover.media});
      }
    }
  }
  let loading = Promise.resolve();
  function releaseChapter(index:number) {
    if (!archive) return;
    chapters[index].html = '';
    for (const [path,users] of resourceUsers) {
      users.delete(index);
      if (!users.size) {
        const url = resourceCache.get(path); if (url) { URL.revokeObjectURL(url); objectUrls.delete(url); }
        resourceCache.delete(path); resourceCache.delete(`inline:${path}`); resourceBlobs.delete(path); resourceUsers.delete(path);
      }
    }
  }
  async function loadChapter(index:number):Promise<Chapter> {
    const chapter = chapters[index];
    if (!chapter) fail('章节不存在。');
    if (!archive || chapter.html) return chapter;
    const job = loading.then(async()=>{
      checkCancelled(options.signal);
      if (chapter.html) return;
      expandedCharacters = 0; usedResources = new Set();
      await preload(chapter.href);
      const content = chapterHtml(read(chapter.href),chapter.href);
      chapter.html = content.html;
      if (!findLabel(toc,chapter.href) && content.title) chapter.title = content.title;
      for (const path of usedResources) {
        if (!resourceUsers.has(path)) resourceUsers.set(path,new Set());
        resourceUsers.get(path)!.add(index);
      }
      // Binary resources are now shared Blob URLs; don't retain another JS copy.
      files = {};
    });
    loading = job.catch(()=>{}); await job; return chapter;
  }
  const result:ParsedBook = {title,author,language,version:pkg.getAttribute('version') ?? '2.0',chapters,toc,coverBlob,...(archive?{dispose,loadChapter,releaseChapter}:{})};
  if (archive) { options.onStage?.('解析首章'); await loadChapter(0); }
  return result;
  } catch (error) { dispose(); throw error; }
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, ArrowRight, BookOpen, Check, ChevronDown, FileUp, Info, Leaf, LibraryBig, LoaderCircle, MoreHorizontal, Plus, Search, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { BookRecord } from '../../types';
import { Modal } from '../../components/Modal';
import './library.css';

export interface LibraryProps {
  books: BookRecord[];
  onOpen: (book: BookRecord) => void;
  onImport: (files: File[]) => void;
  onRemove: (book: BookRecord) => void;
  importing: boolean;
  importStatus?: string;
  onDemo?: () => void;
  onCancelImport?: () => void;
}

function percentage(book: BookRecord) { return Math.min(100, Math.max(0, Math.round(book.progression * 100))); }
function statusFor(book: BookRecord) { return book.isFinished ? '已读完' : book.lastReadAt ? `已读 ${percentage(book)}%` : '未开始'; }
function humanSize(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / (1024 * 1024)).toFixed(3)} MiB`; }
function dateLabel(date: number) {
  if (!date) return '还没开始的故事';
  const days = Math.floor((Date.now() - date) / 86400000);
  if (days <= 0) return '今天读过';
  if (days === 1) return '昨天读过';
  return `${new Date(date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 阅读`;
}

function BookCover({ book, small = false }: { book: BookRecord; small?: boolean }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!book.coverBlob) { setUrl(''); return; }
    const objectUrl = URL.createObjectURL(book.coverBlob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [book.coverBlob]);
  const tone = Array.from(book.title).reduce((sum, c) => sum + c.charCodeAt(0), 0) % 6;
  return (
    <div className={`shelf-book-cover shelf-cover-tone-${tone}${small ? ' shelf-book-cover-small' : ''}`}>
      {url ? <img src={url} alt={`${book.title}封面`} loading="lazy" /> : <>
        <span className="shelf-cover-edition">阅 野 · 藏 书</span>
        <span className="shelf-cover-line" />
        <span className="shelf-cover-title">{book.title}</span>
        <span className="shelf-cover-author">{book.author || '未知作者'}</span>
        <span className="shelf-cover-leaf" aria-hidden="true"><Leaf size={36} strokeWidth={.8} /></span>
      </>}
      <span className="shelf-cover-spine" aria-hidden="true" />
    </div>
  );
}

function QuietBooks() {
  return <svg className="shelf-hero-art" viewBox="0 0 290 180" fill="none" aria-hidden="true">
    <ellipse cx="145" cy="156" rx="118" ry="11" fill="#d4ddca" opacity=".45" />
    <path d="M210 145V72" stroke="#8c9c7e" strokeWidth="2" />
    <path d="M210 107c-22-6-37-23-35-44 23 0 37 18 35 44Z" fill="#bdccb1" />
    <path d="M210 92c21-7 34-25 29-43-22 5-31 22-29 43Z" fill="#8da483" />
    <path d="M210 130c18-4 31-18 29-34-21 2-31 17-29 34Z" fill="#adbea0" />
    <path d="M194 132h31l-6 25h-20l-5-25Z" fill="#d6c7aa" />
    <rect x="47" y="130" width="124" height="23" rx="3" fill="#678167" />
    <path d="M58 134h110v14H58" fill="#f2ecdb" /><path d="M62 139h102m-102 4h102" stroke="#d9d3c3" />
    <rect x="36" y="103" width="126" height="25" rx="3" fill="#c4af8f" />
    <path d="M42 107h106v17H42" fill="#f5efdf" /><path d="M46 113h95m-95 5h95" stroke="#d9d3c3" />
    <g transform="rotate(-12 110 91)"><rect x="77" y="22" width="65" height="80" rx="3" fill="#4e6c54" />
    <path d="M86 23v77" stroke="#344f3c" strokeWidth="2" /><rect x="95" y="37" width="34" height="37" rx="1" stroke="#a9b99a" opacity=".8" />
    <path d="M106 61c-1-8 1-12 6-15 3 7 2 12-6 15Zm0 0c-7-1-10-4-10-9 7 0 10 3 10 9Zm0 0 7 9" stroke="#c1ceb0" /></g>
    <path d="M252 34v9m-4-4h8M48 58v8m-4-4h8" stroke="#b5bd9f" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="175" cy="38" r="2.5" fill="#b1bea5" /><circle cx="265" cy="105" r="2" fill="#c6c5ab" />
  </svg>;
}

export function Library({ books, onOpen, onImport, onRemove, importing, importStatus, onDemo, onCancelImport }: LibraryProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [information, setInformation] = useState<BookRecord | null>(null);
  const sorted = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return books.filter(book => !needle || `${book.title}\n${book.author}`.toLocaleLowerCase().includes(needle)).sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
      if (sort === 'imported') return b.importedAt - a.importedAt;
      return b.lastReadAt - a.lastReadAt || b.importedAt - a.importedAt;
    });
  }, [books, query, sort]);
  const inProgress = books.filter(book => book.lastReadAt > 0 && !book.isFinished);
  const finished = books.filter(book => book.isFinished).length;
  const recent = [...inProgress].sort((a, b) => b.lastReadAt - a.lastReadAt)[0];
  const openFiles = () => { if (!importing) fileInput.current?.click(); };

  return (
    <div className="shelf-app"
      onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = importing ? 'none' : 'copy'; }}
      onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!importing && event.dataTransfer.files.length) onImport(Array.from(event.dataTransfer.files)); }}
    >
      <input ref={fileInput} type="file" accept=".epub,.pdf,application/epub+zip,application/pdf" multiple aria-label="选择 EPUB 或 PDF 图书" className="shelf-file-input"
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) onImport(files); }} />

      <aside className="shelf-sidebar">
        <a className="shelf-brand" href="#" onClick={event => { event.preventDefault(); setQuery(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }} aria-label="阅野，我的书架">
          <span className="shelf-brand-icon"><BookOpen size={24} strokeWidth={1.7} /></span>
          <span>阅野<small>YUEYE READER</small></span>
        </a>
        <div className="shelf-sidebar-section">我的阅读空间</div>
        <button type="button" className="shelf-nav-active" onClick={() => setQuery('')}><LibraryBig size={18} /><span>我的书架</span><b>{books.length}</b></button>
        <div className="shelf-sidebar-bottom">
          <span className="shelf-sidebar-leaf"><Leaf size={28} strokeWidth={1.2} /></span>
          <p>一页书，一方天地。</p>
          <span>让阅读回归简单</span>
          <div className="shelf-local-note"><ShieldCheck size={14} /> 数据保存在本机</div>
        </div>
      </aside>

      <main className="shelf-main">
        <header className="shelf-topbar">
          <div className="shelf-breadcrumb"><span>我的空间</span><span>/</span><strong>书架</strong></div>
          <div className="shelf-topbar-right"><span className="shelf-local-badge"><span /> 本地阅读，安心收藏</span>
            <button type="button" className="shelf-import-button" onClick={openFiles} disabled={importing}>{importing ? <LoaderCircle size={17} className="shelf-spin" /> : <Plus size={18} />}<span>{importing ? '正在导入' : '导入书籍'}</span></button>
          </div>
        </header>

        <div className="shelf-content">
          <section className="shelf-hero">
            <div className="shelf-hero-copy"><div className="shelf-eyebrow"><span /> 在字里行间，遇见更大的世界</div>
              <h1>把时间，留给阅读。</h1>
              <p>收藏喜欢的书，接着上次的故事，让每一次翻页都有回响。</p>
            </div>
            <QuietBooks />
          </section>

          {recent && !query && <section className="shelf-continue" aria-label="继续阅读">
            <div className="shelf-continue-cover"><BookCover book={recent} small /></div>
            <div className="shelf-continue-copy"><span className="shelf-section-kicker">CONTINUE READING <span>继续上次阅读</span></span>
              <h2>{recent.title}</h2><p>{recent.chapterTitle || recent.author || '故事正在继续'}</p>
              <div className="shelf-continue-progress"><span className="shelf-progress-track"><span style={{ width: `${percentage(recent)}%` }} /></span><span>已读 {percentage(recent)}%</span></div>
            </div>
            <button type="button" className="shelf-continue-button" onClick={() => onOpen(recent)}>继续阅读 <ArrowRight size={17} /></button>
          </section>}

          <section className="shelf-collection" aria-labelledby="shelf-collection-heading">
            <div className="shelf-collection-header">
              <div className="shelf-heading-group"><h2 id="shelf-collection-heading">全部藏书 <span>{books.length.toString().padStart(2, '0')}</span></h2><span className="shelf-reading-count">{inProgress.length} 本在读<span>·</span>{finished} 本读完</span></div>
              <div className="shelf-filters">
                <div className="shelf-search"><Search size={16} /><input type="search" placeholder="搜索书名、作者" aria-label="搜索书名或作者" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button>}</div>
                <label className="shelf-sort"><ArrowDownUp size={15} /><select aria-label="图书排序" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">最近阅读</option><option value="imported">导入时间</option><option value="title">书名排序</option></select><ChevronDown size={12} /></label>
              </div>
            </div>

            {importStatus && <div className={`shelf-import-status${importing ? ' shelf-import-status-working' : ''}`} role="status">{importing ? <LoaderCircle size={16} className="shelf-spin" /> : <Info size={16} />}<span>{importStatus}</span></div>}

            {!books.length ? <div className="shelf-empty">
              <div className="shelf-empty-icon"><BookOpen size={32} strokeWidth={1.25} /><span><Plus size={13} /></span></div>
              <h3>你的下一段旅程，从一本书开始</h3>
              <p>将 EPUB / PDF 文件拖到这里，或从电脑中选择图书</p>
              <button type="button" className="shelf-import-button shelf-empty-import" onClick={openFiles} disabled={importing}>{importing ? <LoaderCircle size={17} className="shelf-spin" /> : <Upload size={17} />}{importing ? '正在导入书籍…' : '导入第一本书'}</button>
              <span className="shelf-empty-hint">支持 EPUB 2 / EPUB 3 / PDF · 每本最高 150MiB · 可一次导入多本</span>
              {onDemo && <div className="shelf-demo"><span>还没有准备好书籍？</span><button type="button" onClick={onDemo} disabled={importing}><Sparkles size={14} /> 先读一本示例书 <ArrowRight size={13} /></button></div>}
            </div> : !sorted.length ? <div className="shelf-no-results"><Search size={30} strokeWidth={1.3} /><h3>没有找到相关图书</h3><p>试试其他书名或作者，或者导入一本新书。</p><button type="button" onClick={() => setQuery('')}>查看全部藏书</button></div> :
              <div className="shelf-book-grid">
                {sorted.map(book => <article className="shelf-book" key={book.id}>
                  <button type="button" className="shelf-cover-button" onClick={() => onOpen(book)} aria-label={`打开《${book.title}》`}>
                    <BookCover book={book} />
                    {book.isFinished && <span className="shelf-finished-badge"><Check size={12} /> 已读完</span>}
                    <span className="shelf-cover-hover"><BookOpen size={18} />{book.lastReadAt ? '继续阅读' : '开始阅读'}</span>
                  </button>
                  <div className="shelf-book-title-row"><button type="button" className="shelf-book-title" title={book.title} onClick={() => onOpen(book)}>{book.title}</button>
                    <details className="shelf-book-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}>
                      <summary aria-label={`《${book.title}》更多操作`} title="更多操作"><MoreHorizontal size={19} /></summary>
                      <div className="shelf-book-menu-items"><button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setInformation(book); }}><Info size={15} />图书信息</button><button type="button" className="shelf-menu-danger" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onRemove(book); }}><Trash2 size={15} />移除图书</button></div>
                    </details>
                  </div>
                  <p className="shelf-book-author" title={book.author}>{book.author || '未知作者'}</p>
                  <span className="shelf-format-badge">{book.format==='pdf'?'PDF':'EPUB'}</span>
                  <div className="shelf-book-progress"><span className="shelf-progress-track"><span style={{ width: `${percentage(book)}%` }} /></span><span>{statusFor(book)}</span></div>
                  <div className="shelf-book-date">{dateLabel(book.lastReadAt)}</div>
                </article>)}
                {!query && <button type="button" className="shelf-add-book" onClick={openFiles} disabled={importing}><span className="shelf-add-book-frame"><Plus size={25} strokeWidth={1.3} /><span>再添一本好书</span></span><span>导入 EPUB / PDF 图书</span></button>}
              </div>}
          </section>

          <footer className="shelf-footer"><span><Leaf size={14} /> 阅读，是与自己相处的好时光。</span><span>阅野 YUEYE<span className="shelf-footer-dot">·</span>为专注阅读而生</span></footer>
        </div>
      </main>

      {dragging && <div className="shelf-drop-overlay" aria-live="polite"><div><FileUp size={48} strokeWidth={1.2} /><h2>{importing ? '请等待当前导入完成' : '把书放在这里'}</h2><p>{importing ? '很快就可以继续添加图书' : '松开鼠标，将 EPUB / PDF 收藏到你的书架'}</p></div></div>}

      {importing&&<div className="shelf-import-task" role="status"><span>{importStatus}</span><button className="app-secondary" onClick={onCancelImport}>取消导入</button></div>}
      {information && <Modal title="图书信息" onClose={() => setInformation(null)}><div className="shelf-book-information"><h3>{information.title}</h3><p>{information.author || '未知作者'}</p><dl><dt>文件名称</dt><dd>{information.originalFileName}</dd><dt>文件大小</dt><dd>{humanSize(information.fileSize)}</dd><dt>图书格式</dt><dd>{information.format==='pdf'?`PDF · ${information.pageCount??'—'} 页`:`EPUB ${information.epubVersion}`}</dd><dt>语言</dt><dd>{information.language || '未标注'}</dd><dt>导入时间</dt><dd>{new Date(information.importedAt).toLocaleString('zh-CN')}</dd><dt>阅读进度</dt><dd>{statusFor(information)}</dd></dl><div className="shelf-information-note"><ShieldCheck size={15} />这本书与阅读记录仅保存在本机。</div></div></Modal>}
    </div>
  );
}

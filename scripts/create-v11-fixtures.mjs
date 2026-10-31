import { mkdirSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { writeFileSync } from 'node:fs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'.local-v11-fixtures');mkdirSync(output,{recursive:true});
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(data){let crc=0xffffffff;for(const byte of data)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
// A real, decodable RGB image with deterministic noise, not an invalid padding image.
const width=2048,height=1536,raw=Buffer.alloc((width*3+1)*height);let state=123456789;
for(let y=0;y<height;y++)for(let x=1;x<=width*3;x++){state^=state<<13;state^=state>>>17;state^=state<<5;raw[y*(width*3+1)+x]=state&255;}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:0})),chunk('IEND',Buffer.alloc(0))]);

function writeEpub(targetMiB){
  const imageCount=Math.floor((targetMiB*1024**2-1024**2)/png.length);
  const entries=[['mimetype',Buffer.from('application/epub+zip')],['META-INF/container.xml',Buffer.from('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')]];
  const manifest=[],spine=[];
  for(let index=0;index<imageCount;index++){
    manifest.push(`<item id="c${index}" href="c${index}.xhtml" media-type="application/xhtml+xml"/><item id="i${index}" href="i${index}.png" media-type="image/png"/>`);spine.push(`<itemref idref="c${index}"/>`);
    entries.push([`c${index}.xhtml`,Buffer.from(`<html><body><h1>Image chapter ${index+1}</h1><p>Large EPUB ${targetMiB}MiB — real image sample.</p><img src="i${index}.png"/></body></html>`)], [`i${index}.png`,png]);
  }
  entries.push(['book.opf',Buffer.from(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Large EPUB ${targetMiB}MiB</dc:title><dc:creator>Yueye synthetic tests</dc:creator></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`)]);
  const paddingName='padding.bin';const overhead=22+entries.reduce((sum,[name,data])=>sum+76+Buffer.byteLength(name)*2+data.length,0)+76+paddingName.length*2;
  entries.push([paddingName,Buffer.alloc(targetMiB*1024**2-overhead)]);
  const file=path.join(output,`large-${targetMiB}.epub`),fd=openSync(file,'w');let offset=0;const central=[];const imageCrc=crc32(png);
  for(const [name,data] of entries){
    const filename=Buffer.from(name),crc=data===png?imageCrc:crc32(data),local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);header.writeUInt32LE(crc,16);header.writeUInt32LE(data.length,20);header.writeUInt32LE(data.length,24);header.writeUInt16LE(filename.length,28);header.writeUInt32LE(offset,42);
    writeSync(fd,local);writeSync(fd,filename);writeSync(fd,data);offset+=local.length+filename.length+data.length;central.push(header,filename);
  }
  const directory=Buffer.concat(central);writeSync(fd,directory);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);writeSync(fd,end);closeSync(fd);
  if(statSync(file).size!==targetMiB*1024**2)throw new Error('EPUB size mismatch');
  console.log(JSON.stringify({file,bytes:statSync(file).size,imageCount}));
}
function writePdf(targetMiB){
  const file=path.join(output,`large-${targetMiB}.pdf`),fd=openSync(file,'w'),offsets=[0];let offset=0,id=0;
  const write=data=>{if(typeof data==='string')data=Buffer.from(data);writeSync(fd,data);offset+=data.length;};
  const object=(data)=>{const current=++id;offsets.push(offset);write(`${current} 0 obj\n`);write(data);write('\nendobj\n');return current;};
  write('%PDF-1.7\n');const count=16;
  object(`<< /Type /Catalog /Pages 2 0 R >>`);
  object(`<< /Type /Pages /Kids [${Array.from({length:count},(_,i)=>`${5+i*3} 0 R`).join(' ')}] /Count ${count} >>`);
  const rgb=Buffer.alloc(width*height*3);for(let y=0;y<height;y++)raw.copy(rgb,y*width*3,y*(width*3+1)+1,(y+1)*(width*3+1));
  const compressed=deflateSync(rgb,{level:0});
  for(let i=0;i<count;i++){
    const image=object(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),compressed,Buffer.from('\nendstream')]));
    const commands='q 540 0 0 405 30 180 cm /Photo Do Q';const content=object(`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Photo ${image} 0 R >> >> /Contents ${content} 0 R >>`);
  }
  const info=object(`<< /Title (Large PDF ${targetMiB}MiB) >>`);
  const remaining=targetMiB*1024**2-offset-3000;
  if(remaining<0)throw new Error('PDF exceeds target');
  object(Buffer.concat([Buffer.from(`<< /Length ${remaining} >>\nstream\n`),Buffer.alloc(remaining),Buffer.from('\nendstream')]));
  const xref=offset;write(`xref\n0 ${id+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${id+1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  // Legal trailing whitespace brings this valid image PDF exactly to the boundary.
  write(Buffer.alloc(targetMiB*1024**2-offset,32));closeSync(fd);console.log(JSON.stringify({file,bytes:statSync(file).size,pages:count}));
}
for(const size of [51,100,150])writeEpub(size);writePdf(150);
const zero=new Uint8Array(25*1024**2);
const files={
  mimetype:Buffer.from('application/epub+zip'),
  'META-INF/container.xml':Buffer.from('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'book.opf':Buffer.from('<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>High expansion EPUB</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'),
  'chapter.xhtml':Buffer.from('<html><body><h1>Only required resources are decoded</h1><p>Large auxiliary binary entries must stay compressed.</p></body></html>'),
};
for(let i=0;i<29;i++)files[`auxiliary-${i}.bin`]=zero;
writeFileSync(path.join(output,'expansion-725.epub'),zipSync(files,{level:1}));
files['auxiliary-29.bin']=zero;
writeFileSync(path.join(output,'expansion-over-750.epub'),zipSync(files,{level:1}));
console.log('Prepared 725MiB and over-750MiB declared expansion boundary samples.');

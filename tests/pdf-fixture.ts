import { deflateSync } from 'node:zlib';

/** Original synthetic test documents, containing no private books or external material. */
export function makePdf({pages=3,scan=false,password=false,chinese=false,oversizedPage=0}:{pages?:number;scan?:boolean;password?:boolean;chinese?:boolean;oversizedPage?:number} = {}):Buffer {
  const objects:Buffer[]=[];
  const add=(value:string|Buffer)=>{objects.push(Buffer.isBuffer(value)?value:Buffer.from(value));return objects.length;};
  add('');add('');
  const font=chinese?add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>'):add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if(chinese)add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');
  const pageIds:number[]=[];
  const image=scan?add(Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n'),Buffer.from([40,90,150,200,120,50,50,180,120,190,80,160]),Buffer.from('\nendstream')])):0;
  for(let i=0;i<pages;i++){
    const source=Buffer.from(scan?'q 400 0 0 500 70 100 cm /Photo Do Q':chinese?'BT /F1 24 Tf 60 720 Td <4e2d658796058bfb6d4b8bd5> Tj ET':`BT /F1 24 Tf 60 720 Td (Yueye PDF - Page ${i+1}) Tj 0 -45 Td /F1 12 Tf (Selectable offline reading test.) Tj ET`);
    const compressed=deflateSync(source);
    const content=add(Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`),compressed,Buffer.from('\nendstream')]));
    const page=add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${i+1===oversizedPage?50000:i%2?720:540} 800] /Resources << /Font << /F1 ${font} 0 R >> ${scan?`/XObject << /Photo ${image} 0 R >>`:''} >> /Contents ${content} 0 R >>`);
    pageIds.push(page);
  }
  const outline=add('');
  const first=add(`<< /Title (First page) /Parent ${outline} 0 R /Dest [${pageIds[0]} 0 R /Fit] >>`);
  const last=add(`<< /Title (Last page) /Parent ${outline} 0 R /Dest [${pageIds[pages-1]} 0 R /Fit] /Prev ${first} 0 R >>`);
  objects[first-1]=Buffer.from(`<< /Title (First page) /Parent ${outline} 0 R /Dest [${pageIds[0]} 0 R /Fit] /Next ${last} 0 R >>`);
  objects[outline-1]=Buffer.from(`<< /Type /Outlines /First ${first} 0 R /Last ${last} 0 R /Count 2 >>`);
  const info=add(`<< /Title (${scan?'Synthetic scanned PDF':'Offline PDF sample'}) /Author (Yueye test) >>`);
  const encryption=password?add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`):0;
  objects[0]=Buffer.from(`<< /Type /Catalog /Pages 2 0 R /Outlines ${outline} 0 R >>`);
  objects[1]=Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pages} >>`);
  const chunks=[Buffer.from('%PDF-1.7\n')];const offsets=[0];let offset=chunks[0].length;
  objects.forEach((object,index)=>{offsets.push(offset);const data=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);chunks.push(data);offset+=data.length;});
  chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R /Info ${info} 0 R ${encryption?`/Encrypt ${encryption} 0 R /ID [<${'11'.repeat(16)}><${'11'.repeat(16)}>]`:''} >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

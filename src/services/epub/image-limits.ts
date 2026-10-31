/** Read raster dimensions before the browser allocates decoded pixels. */
export const MAX_EPUB_IMAGE_PIXELS=32*1024*1024;
export function validateImagePixels(data:Uint8Array,media:string) {
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  let width=0,height=0;
  if(media==='image/png'&&data.length>=24&&view.getUint32(0)===0x89504e47){width=view.getUint32(16);height=view.getUint32(20);}
  else if(media==='image/gif'&&data.length>=10){width=view.getUint16(6,true);height=view.getUint16(8,true);}
  else if(media==='image/jpeg'&&data.length>4&&view.getUint16(0)===0xffd8){
    let offset=2;
    while(offset+9<data.length){
      if(data[offset++]!==0xff)break;while(data[offset]===0xff)offset++;
      const marker=data[offset++];if(marker===0xd9||marker===0xda)break;
      if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      const length=view.getUint16(offset);if(length<2||offset+length>data.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){height=view.getUint16(offset+3);width=view.getUint16(offset+5);break;}offset+=length;
    }
  } else if(media==='image/webp'&&data.length>=30&&view.getUint32(0)===0x52494646){
    const kind=view.getUint32(12);
    if(kind===0x56503858){width=1+data[24]+(data[25]<<8)+(data[26]<<16);height=1+data[27]+(data[28]<<8)+(data[29]<<16);}
    else if(kind===0x56503820){width=view.getUint16(26,true)&0x3fff;height=view.getUint16(28,true)&0x3fff;}
    else if(kind===0x5650384c&&data[20]===0x2f){const bits=view.getUint32(21,true);width=1+(bits&0x3fff);height=1+((bits>>>14)&0x3fff);}
  } else if(media==='image/avif'){
    for(let offset=4;offset+16<=Math.min(data.length,65536);offset++)if(view.getUint32(offset)===0x69737065){width=view.getUint32(offset+8);height=view.getUint32(offset+12);break;}
  }
  if(width*height>MAX_EPUB_IMAGE_PIXELS)throw new Error('EPUB 单张图片超过 32 兆像素安全限制，请缩小图片后重试。');
}

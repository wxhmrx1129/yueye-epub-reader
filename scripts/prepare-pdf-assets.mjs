import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root,'node_modules','pdfjs-dist');
const target = path.join(root,'public','pdfjs');
await mkdir(target,{recursive:true});
for (const name of ['cmaps','standard_fonts','wasm','iccs','LICENSE']) {
  await cp(path.join(source,name),path.join(target,name),{recursive:true});
}
console.log('PDF engine resources and third-party licenses prepared for offline use.');

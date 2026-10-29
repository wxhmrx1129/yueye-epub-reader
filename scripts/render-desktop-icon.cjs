const { app, BrowserWindow } = require('electron');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const output = process.argv[2];
const profile = process.argv[3];
if (!output || !profile) throw new Error('Use node scripts/create-desktop-icon.mjs [output-directory].');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => {
  console.error('Icon generation timed out after 30 seconds.');
  app.exit(1);
}, 30_000);
let window;
app.whenReady().then(async () => {
  const svg = await readFile(resolve(root, 'public/favicon.svg'), 'utf8');
  window = new BrowserWindow({
    width: 256, height: 256, useContentSize: true,
    frame: false, transparent: true, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><style>html,body{margin:0;width:256px;height:256px;background:transparent}svg{display:block;width:256px;height:256px}</style>${svg}</html>`)}`);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  if (image.isEmpty()) throw new Error('Electron did not render the application icon.');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'icon.png'), images.at(-1));
  await writeFile(resolve(output, 'icon.ico'), Buffer.concat([directory, ...images]));
  console.log(`Generated ${output}/icon.png and icon.ico from public/favicon.svg.`);
  clearTimeout(watchdog);
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  clearTimeout(watchdog);
  window?.destroy();
  app.exit(1);
});

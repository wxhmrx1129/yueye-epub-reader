const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { APP_ORIGIN, CONTENT_SECURITY_POLICY, assetPath, externalUrl } = require('./policy.cjs');

app.setName('阅野');
// This directory and the protocol origin must stay stable across upgrades.
app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir') || path.join(app.getPath('appData'), 'YueyeReader'));
app.setAppUserModelId('com.yueye.reader');
protocol.registerSchemesAsPrivileged([{
  scheme: 'yueye',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const devUrl = !app.isPackaged ? process.env.YUEYE_DEV_URL : undefined;
if (devUrl) {
  const url = new URL(devUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('开发服务器仅允许本机 127.0.0.1 地址。');
}
const entryUrl = devUrl || `${APP_ORIGIN}/`;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.epub': 'application/epub+zip',
};
let mainWindow;
let closeRequest;
let requestSerial = 0;
let closing = false;
let failureDialogOpen = false;

async function registerAssets() {
  const root = path.join(app.getAppPath(), 'dist');
  protocol.handle('yueye', async request => {
    const file = assetPath(request.url, root);
    if (!file) return new Response('Forbidden', { status: 403 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    try {
      const bytes = await readFile(file);
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: {
          'Content-Type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Security-Policy': CONTENT_SECURITY_POLICY,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return new Response(error.code === 'ENOENT' ? 'Not found' : 'Unable to read asset', { status: error.code === 'ENOENT' ? 404 : 500 });
    }
  });
}

function cancelCloseRequest() {
  if (closeRequest) clearTimeout(closeRequest.timer);
  closeRequest = undefined;
}

async function closeFailed(message) {
  if (!mainWindow || mainWindow.isDestroyed() || failureDialogOpen) return;
  const window = mainWindow;
  // Expire the request before showing a dialog: a late renderer response must
  // not close the window underneath the user's retry / return decision.
  cancelCloseRequest();
  failureDialogOpen = true;
  let response;
  try {
    ({ response } = await dialog.showMessageBox(window, {
      type: 'warning', title: '阅读记录尚未保存',
      message: '暂时无法完成退出前的保存。', detail: message,
      buttons: ['重试保存', '返回阅读', '直接退出'], defaultId: 0, cancelId: 1,
      noLink: true,
    }));
  } finally {
    failureDialogOpen = false;
  }
  if (window.isDestroyed()) return;
  if (response === 0) window.close();
  if (response === 2) { closing = true; window.close(); }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 760, minHeight: 560,
    title: '阅野 · EPUB 阅读器', backgroundColor: '#edf2e9', show: false,
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => {
    // A close request made during startup may precede the preload listener.
    if (closeRequest) mainWindow.webContents.send('yueye:prepare-close', closeRequest.requestId);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = externalUrl(url);
    if (safeUrl) void shell.openExternal(safeUrl).catch(error => console.error('打开链接失败', error));
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow the app's own reload / recovery button without permitting a new page.
    const current = new URL(mainWindow.webContents.getURL());
    const destination = new URL(url);
    current.hash = ''; destination.hash = '';
    if (current.href === destination.href) return;
    event.preventDefault();
    const safeUrl = externalUrl(url);
    if (safeUrl && !devUrl) void shell.openExternal(safeUrl).catch(error => console.error('打开链接失败', error));
  });
  mainWindow.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      dialog.showErrorBox('阅野无法打开', `客户端页面加载失败（${code}）：${description}\n请重新安装客户端后重试。`);
      closing = true; app.quit();
    }
  });
  mainWindow.on('close', event => {
    if (closing || mainWindow.webContents.isDestroyed() || mainWindow.webContents.isCrashed()) return;
    event.preventDefault();
    if (closeRequest || failureDialogOpen) return;
    const requestId = ++requestSerial;
    closeRequest = {
      requestId,
      timer: setTimeout(() => void closeFailed('保存超过 15 秒。可返回阅读后重试，或直接退出（最近的修改可能尚未保存）。'), 15_000),
    };
    mainWindow.webContents.send('yueye:prepare-close', requestId);
  });
  mainWindow.on('closed', () => { cancelCloseRequest(); mainWindow = undefined; });
  void mainWindow.loadURL(entryUrl);
}

ipcMain.on('yueye:close-ready', (event, result) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
  if (!closeRequest || result?.requestId !== closeRequest.requestId) return;
  clearTimeout(closeRequest.timer);
  if (result.error) { void closeFailed(String(result.error)); return; }
  cancelCloseRequest(); closing = true; mainWindow.close();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  });
  app.whenReady().then(async () => {
    await registerAssets();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(contents === mainWindow?.webContents && permission === 'fullscreen');
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === mainWindow?.webContents && permission === 'fullscreen');
    createWindow();
  }).catch(error => { dialog.showErrorBox('阅野启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}

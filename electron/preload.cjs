const { contextBridge, ipcRenderer } = require('electron');

// The renderer can only complete the main process's pending close request.
// No filesystem, arbitrary IPC, or Node APIs are exposed to book content.
contextBridge.exposeInMainWorld('yueyeDesktop', {
  onPrepareClose(callback) {
    const listener = async (_event, requestId) => {
      try {
        await callback();
        ipcRenderer.send('yueye:close-ready', { requestId });
      } catch (error) {
        ipcRenderer.send('yueye:close-ready', {
          requestId,
          error: error instanceof Error ? error.message : '本地记录尚未保存。',
        });
      }
    };
    ipcRenderer.on('yueye:prepare-close', listener);
    return () => ipcRenderer.removeListener('yueye:prepare-close', listener);
  },
});

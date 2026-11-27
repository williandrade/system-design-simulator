const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('simulatorMcpSetup', {
    get: () => ipcRenderer.invoke('mcp-setup:get'),
    copy: (client) => ipcRenderer.invoke('mcp-setup:copy', client),
  });
  contextBridge.exposeInMainWorld('simulatorCanvasMcp', {
    pair: (token, canvasId, code) => ipcRenderer.invoke('canvas-mcp:pair', token, canvasId, code),
    result: (token, payload) => ipcRenderer.invoke('canvas-mcp:result', token, payload),
    disconnect: (token) => ipcRenderer.invoke('canvas-mcp:disconnect', token),
    subscribe: (token, callback) => {
      const listener = (_event, target, payload) => {
        if (target === token) callback(payload);
      };
      ipcRenderer.on('canvas-mcp:event', listener);
      return () => ipcRenderer.removeListener('canvas-mcp:event', listener);
    },
  });
}

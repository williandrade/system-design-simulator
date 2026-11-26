const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('simulatorMcpSetup', {
    get: () => ipcRenderer.invoke('mcp-setup:get'),
    copy: (client) => ipcRenderer.invoke('mcp-setup:copy', client),
  });
}

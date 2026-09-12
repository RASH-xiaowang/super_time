const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersions: () => ipcRenderer.invoke('app:versions'),
  ping: () => ipcRenderer.invoke('app:ping'),
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  pickDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (listener) => {
      const handler = (_event, maximized) => {
        try {
          listener(maximized);
        } catch {
          /* ignore */
        }
      };
      ipcRenderer.on('window:maximized-changed', handler);
      return () => ipcRenderer.removeListener('window:maximized-changed', handler);
    }
  },
  wechat: {
    listMethods: () => ipcRenderer.invoke('wechat:list-methods'),
    info: () => ipcRenderer.invoke('wechat:info'),
    call: (method, args) => ipcRenderer.invoke('wechat:call', method, args),
    dispose: () => ipcRenderer.invoke('wechat:dispose'),
    getLlmConfig: () => ipcRenderer.invoke('wechat:llm-get'),
    saveLlmConfig: (config) => ipcRenderer.invoke('wechat:llm-save', config),
    listLlmModels: (options) => ipcRenderer.invoke('wechat:llm-models', options),
    onEvent: (listener) => {
      const handler = (_event, payload) => {
        try {
          listener(payload);
        } catch {
          /* 渲染进程回调异常不传播到主进程 */
        }
      };
      ipcRenderer.on('wechat:event', handler);
      return () => ipcRenderer.removeListener('wechat:event', handler);
    }
  }
});
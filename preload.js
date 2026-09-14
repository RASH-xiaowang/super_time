const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersions: () => ipcRenderer.invoke('app:versions'),
  /** 是否验收测试模式（mock 模型）：前端据此显示醒目横幅。 */
  isTestMode: () => ipcRenderer.invoke('app:test-mode'),
  ping: () => ipcRenderer.invoke('app:ping'),
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  pickDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
  /** 保存对话框：只取路径，写盘由后端做（大文件不经 IPC）。 */
  saveFileDialog: (opts) => ipcRenderer.invoke('dialog:save-file', opts),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  /** 把指定的界面矩形导出成 PNG（「导出报告」用；坐标是渲染页视口的 CSS 像素）。 */
  capturePanel: (rect) => ipcRenderer.invoke('window:capture-panel', rect),
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:maximize-toggle'),
    toggleFullscreen: () => ipcRenderer.send('window:fullscreen-toggle'),
    close: () => ipcRenderer.send('window:close'),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    onFullscreenChange: (listener) => {
      const handler = (_event, fullscreen) => {
        try {
          listener(fullscreen);
        } catch {
          /* ignore */
        }
      };
      ipcRenderer.on('window:fullscreen-changed', handler);
      return () => ipcRenderer.removeListener('window:fullscreen-changed', handler);
    },
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
    /** 后端进程状态快照：渲染端挂载后补一次，避免错过首启期间的状态事件。 */
    backendState: () => ipcRenderer.invoke('wechat:backend-state'),
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
  },
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    activationRequest: () => ipcRenderer.invoke('license:activation-request'),
    exportRequest: () => ipcRenderer.invoke('license:export-request'),
    importFile: () => ipcRenderer.invoke('license:import'),
    importText: (text) => ipcRenderer.invoke('license:import-text', text),
    remove: () => ipcRenderer.invoke('license:remove'),
    fingerprint: () => ipcRenderer.invoke('license:fingerprint'),
  },
  /** 诊断日志（M6）：用户报障时把落盘日志导出来。 */
  diag: {
    logInfo: () => ipcRenderer.invoke('diag:log-info'),
    exportLog: () => ipcRenderer.invoke('diag:export-log'),
    revealLog: () => ipcRenderer.invoke('diag:reveal-log'),
  }
});
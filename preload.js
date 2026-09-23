const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersions: () => ipcRenderer.invoke('app:versions'),
  /** 是否验收测试模式（mock 模型）：前端据此显示醒目横幅。 */
  isTestMode: () => ipcRenderer.invoke('app:test-mode'),
  /**
   * 首启闸门豁免状态（N2）：`{ packaged, skipGates }`，两个值都由主进程算好。
   *
   * 只读、不接受任何参数 —— 判定权不在渲染进程（打包态下 `skipGates` 恒为 false，
   * 见 src/backend/debug-gates.js）。渲染层另有第二道判定：`ui-app/debug-gates.ts`。
   */
  debugGates: () => ipcRenderer.invoke('app:debug-gates'),
  ping: () => ipcRenderer.invoke('app:ping'),
  /** 文件选择对话框：`opts.filters` 交给主进程转给原生对话框（知识库用它传白名单）。 */
  openFile: (opts) => ipcRenderer.invoke('dialog:open-file', opts),
  pickDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
  /** 保存对话框：只取路径，写盘由后端做（大文件不经 IPC）。 */
  saveFileDialog: (opts) => ipcRenderer.invoke('dialog:save-file', opts),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  /** 把指定的界面矩形导出成 PNG（「导出报告」用；坐标是渲染页视口的 CSS 像素）。 */
  capturePanel: (rect) => ipcRenderer.invoke('window:capture-panel', rect),
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
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
  },
  wechat: {
    listMethods: () => ipcRenderer.invoke('wechat:list-methods'),
    info: () => ipcRenderer.invoke('wechat:info'),
    call: (method, args) => ipcRenderer.invoke('wechat:call', method, args),
    getLlmConfig: () => ipcRenderer.invoke('wechat:llm-get'),
    saveLlmConfig: (config) => ipcRenderer.invoke('wechat:llm-save', config),
    listLlmModels: (options) => ipcRenderer.invoke('wechat:llm-models', options),
    /** 已保存的模型配置集：列出 / 切换 / 新增·更新 / 删除（都走同一条 IPC，用 op 区分）。 */
    getLlmProfiles: () => ipcRenderer.invoke('wechat:llm-profiles', { op: 'list' }),
    activateLlmProfile: (id) => ipcRenderer.invoke('wechat:llm-profiles', { op: 'activate', id }),
    saveLlmProfile: (options) => ipcRenderer.invoke('wechat:llm-profiles', { op: 'save', ...(options || {}) }),
    deleteLlmProfile: (id) => ipcRenderer.invoke('wechat:llm-profiles', { op: 'delete', id }),
    /** 后端进程状态快照：渲染端挂载后补一次，避免错过首启期间的状态事件。 */
    backendState: () => ipcRenderer.invoke('wechat:backend-state'),
    onEvent: (listener) => {
      const handler = (_event, payload) => {
        try {
          listener(payload);
        } catch (e) {
          /* 渲染进程回调异常不传播到主进程 —— 但必须留一行：
             「中继事件没进 DOM」和「回调抛了」在日志里本来长得一模一样（N33 的第三条腿）。 */
          console.error('[relay:throw]', (payload && payload.name) || '?', (e && e.message) || String(e));
        }
      };
      ipcRenderer.on('wechat:event', handler);
      return () => ipcRenderer.removeListener('wechat:event', handler);
    }
  },
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    exportRequest: () => ipcRenderer.invoke('license:export-request'),
    importFile: () => ipcRenderer.invoke('license:import'),
    importText: (text) => ipcRenderer.invoke('license:import-text', text),
    remove: () => ipcRenderer.invoke('license:remove'),
  },
  /** 诊断日志（M6）：用户报障时把落盘日志导出来。 */
  diag: {
    logInfo: () => ipcRenderer.invoke('diag:log-info'),
    exportLog: () => ipcRenderer.invoke('diag:export-log'),
    revealLog: () => ipcRenderer.invoke('diag:reveal-log'),
  },
  /**
   * 自动更新（electron-updater + GitHub Releases）。
   *
   * `state()` 是挂载时补一次的快照（渲染层可能错过早先的事件）；`onEvent` 之后
   * 每次状态变化都会推一遍（进度已按 1% 节流）。`check({ manual: true })` 是用户
   * 主动触发 —— 自动检查由主进程排在启动后，不经过这里。
   * 「能不能更新 / 更新源在哪」都由主进程决定，渲染层只决定「要不要点这个按钮」。
   */
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: (opts) => ipcRenderer.invoke('update:check', opts),
    install: () => ipcRenderer.invoke('update:install'),
    onEvent: (listener) => {
      const handler = (_event, payload) => {
        try {
          listener(payload);
        } catch {
          /* 渲染进程回调异常不传播到主进程 */
        }
      };
      ipcRenderer.on('update:event', handler);
      return () => ipcRenderer.removeListener('update:event', handler);
    },
  }
});
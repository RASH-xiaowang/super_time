const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersions: () => ipcRenderer.invoke('app:versions'),
  /** 是否验收测试模式（自动化窗口）。⚠️ 它**不等于**「回答来自 mock 模型」，后者见 runMode。 */
  isTestMode: () => ipcRenderer.invoke('app:test-mode'),
  /**
   * 运行模式事实：`{ test, llmMock, dataRoot }`。
   * 横幅据此区分「自动化窗口」与「真的装了 mock 模型」，并把**数据根**显示出来
   * （"这次验收到底用的哪份数据"一眼可查）。
   */
  runMode: () => ipcRenderer.invoke('app:run-mode'),
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
    /** 连接测试（2026-09-30）：`{baseUrl, apiKey}` → `{ok, value:{ms, models, url}}`。 */
    testLlmConnection: (options) => ipcRenderer.invoke('wechat:llm-test', options),
    /** 余额查询（2026-09-30）：`{baseUrl, apiKey}` → `{ok, value:{currency,total,…}}`。 */
    getLlmBalance: (options) => ipcRenderer.invoke('wechat:llm-balance', options),
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
  /**
   * 局域网远程访问（手机端）—— 只有**桌面端**能配置它。
   *
   * 刻意单独一组而不是塞进 `wechat`：这两条不经过后端 worker（配置读写除外），
   * 而是主进程自己的 HTTP 服务；而且它们**不在**远程方法白名单里 ——
   * 手机浏览器拿不到这个对象，也就不可能用它改自己的权限。
   */
  remoteAccess: {
    /** 当前状态：是否在监听、实际端口、绑定地址、令牌掩码、候选地址、队列与会话数。 */
    state: () => ipcRenderer.invoke('remote-access:state'),
    /**
     * 按当前配置对齐监听状态（开关/端口/令牌改完之后调）。
     *
     * 为什么要显式调：服务内部有 60 秒的兜底复查，但用户在界面上点了开关就应当**立刻**生效，
     * 等一分钟会被当成「开关坏了」。
     */
    apply: () => ipcRenderer.invoke('remote-access:apply'),
    /**
     * 生成新令牌并**同时打开**开关；返回 `{ token, state }`。
     *
     * 令牌原文只在这一次的返回值里出现（界面用它拼二维码与可复制的链接），
     * 之后所有状态查询都只给掩码 —— 否则任何能看到这块屏幕的人（投屏、截图、远程协助）
     * 就等于拿到了完整凭据。
     */
    rotate: () => ipcRenderer.invoke('remote-access:rotate'),
    /** 打开 / 关闭监听。关闭会立刻断开所有在连的手机（令牌保留，下次打开还是同一个）。 */
    toggle: (enabled) => ipcRenderer.invoke('remote-access:toggle', enabled === true),
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
    previewLog: () => ipcRenderer.invoke('diag:preview-log'),
    copyLogPath: () => ipcRenderer.invoke('diag:copy-log-path'),
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
    /**
     * W2-12.2：跳过某个版本（传空串 = 取消跳过）。
     * 渲染层只提供「跳哪个版本号」这一个字符串。
     */
    skip: (version) => ipcRenderer.invoke('update:skip', version),
    /** W2-12.2：手动重试下载（不受自动重试的次数上限约束）。 */
    retry: () => ipcRenderer.invoke('update:retry'),
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
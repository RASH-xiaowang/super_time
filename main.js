// 必须最先执行：终端/父进程退出后 stdout 管道会关闭，之后任何 console.log 都会
// 触发 EPIPE 并被 Node 当未捕获异常抛出，主进程弹出致命框（详见模块注释）。
// 必须最先执行：终端/父进程退出后 stdout 管道会关闭，之后任何 console.log 都会
// 触发 EPIPE 并被 Node 当未捕获异常抛出，主进程弹出致命框（详见模块注释）。
// SUPERTIME_NO_CONSOLE_GUARD=1 仅供 scripts/epipe-smoke.js 做负对照用。
if (process.env.SUPERTIME_NO_CONSOLE_GUARD !== '1') require('./src/backend/console-safe').install();

const { app, BrowserWindow, ipcMain, dialog, screen, shell, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  configure: configureWechatPaths,
  applyConfig,
  recordResolved,
  loadWechatSettings,
  loadLlmConfig,
  saveLlmConfig,
  configPath,
} = require('./src/backend/wechat-paths');
const { findByBaseUrl: findModelCatalog } = require('./src/backend/llm-model-catalog');
const licenseService = require('./src/license/service');
const { getDeviceFingerprint } = require('./src/license/fingerprint');
const { createWorkerChannel } = require('./src/backend/backend-rpc');

// ── userData 隔离（必须在任何 getPath / 单实例锁之前）────────────────────
// 安装版原本和开发态共用 `<APPDATA>\super-time-electron`（package.json 没有顶层
// productName，app.getName() 取的是 name）。后果：装完直接吃到开发态或**旧版本遗留**
// 的数据 —— 实测那台电脑上一开机就拿着上一台机器的 db_dir 去解密，报
// 「数据库目录不存在（D:\Tencent\...\wxid_xxx\db_storage）」。而 NSIS 升级/卸载
// 都不会清理 userData，这份脏状态会一直黏着。
// 这里给安装版一个独立目录，彻底隔离。SUPERTIME_USER_DATA_DIR 可显式指定（调试用）。
const USER_DATA_OVERRIDE = (process.env.SUPERTIME_USER_DATA_DIR || '').trim();
if (USER_DATA_OVERRIDE) {
  app.setPath('userData', USER_DATA_OVERRIDE);
} else if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Super Time'));
}

/** 「微信+」的运行期状态目录（config.json / llm.json）跟着 userData 走。 */
const STATE_DIR = configureWechatPaths({ userDataPath: app.getPath('userData') });

const APP_VERSION = (() => {
  try {
    return require('./package.json').version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

// ── 单实例锁：同一时间只允许一个应用实例 ────────────────────────────────
// 拿到锁的实例：监听 second-instance，把已有窗口拉到前台（提示用户）。
// 没拿到锁的重复实例：立即退出（拦截），不做任何初始化 —— 避免出现
// 两个窗口/两份后端进程互相打架（2026-09-11 实测发生过 12 进程双实例）。
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  console.log('[single-instance] 已有实例在运行，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[single-instance] 检测到重复启动，已拦截并聚焦现有窗口');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
/** 当前后端句柄；进程已死或尚未 init 完成时为 null。 */
let wechatBackend = null;
/** 后端进程启动时返回的 { info, methods }。 */
let wechatBoot = null;
/** 监管状态：后端数据目录、已重启次数、是否正在主动停止。 */
let backendUserDataPath = null;
let backendRestartCount = 0;
/** 主动停止（应用退出 / 显式 dispose）后不再自动重启。 */
let backendStopping = false;

// ── 调用超时 ─────────────────────────────────────────────────────────
// 实际逻辑在 src/backend/backend-rpc.js（那里可被单测覆盖）；这里只决定窗口大小。
// 原实现整条调用链没有 deadline：后端某个方法真卡住时，pending 里的 Promise
// 永不 settle，界面就无限转圈、只能重启应用。分两档：普通调用 60 秒；
// 已知的分钟级任务（导出、全量解密、批量转写、建索引、备份恢复）给 10 分钟。
// 两个窗口都可用环境变量覆盖：现场排查能临时放宽，验证脚本则压到极小值来确认
// 「超时确实会解除等待」而不是靠读代码。
const CALL_TIMEOUT_MS = Number(process.env.SUPERTIME_CALL_TIMEOUT_MS) > 0
  ? Number(process.env.SUPERTIME_CALL_TIMEOUT_MS)
  : undefined;
const LONG_CALL_TIMEOUT_MS = Number(process.env.SUPERTIME_LONG_CALL_TIMEOUT_MS) > 0
  ? Number(process.env.SUPERTIME_LONG_CALL_TIMEOUT_MS)
  : undefined;

/**
 * 拉起一个「微信+」后端进程，并建立带超时的 RPC 通道。
 *
 * 所有 Remote 方法都是同步 node:sqlite，个别方法单次就要 12–21 秒
 * （getSnsImageDataUrl 会全量解密扫描 Sns/Img 与 msg/attach）。跑在主进程里会
 * 卡死窗口消息泵 —— 实测单次阻塞 45.6 秒，Windows 直接判定「应用未响应」。
 * 放进 utilityProcess 后主进程只转发 IPC，重活不再影响窗口响应。
 *
 * 请求/响应配平、超时、死亡收敛都在 backend-rpc 里 —— 抽出去是为了能被单测覆盖：
 * 留在主进程时这些分支只有手工 taskkill 才能观察。
 *
 * @param userDataPath - 传给后端的应用数据目录。
 * @param onExit - 进程退出回调，交给监管器决定是否重建（init 期间也会触发）。
 */
function spawnBackendProcess(userDataPath, onExit) {
  const child = utilityProcess.fork(
    path.join(__dirname, 'src', 'backend', 'wechat-worker.js'),
    [],
    { serviceName: 'super-time-wechat-backend', stdio: 'inherit' }
  );
  return createWorkerChannel(child, {
    userDataPath,
    onEvent: (name, args) => broadcastWechatEvent(name, args),
    onExit,
    ...(CALL_TIMEOUT_MS === undefined ? {} : { callTimeoutMs: CALL_TIMEOUT_MS }),
    ...(LONG_CALL_TIMEOUT_MS === undefined ? {} : { longTimeoutMs: LONG_CALL_TIMEOUT_MS }),
  });
}

// ── 后端监管：有界退避重启 ───────────────────────────────────────────
// 原实现的后果（本会话实测复现）：后端进程一旦退出，之后所有调用都固定 reject
// 「微信+后端进程已退出」，功能整体失效、只能重启应用 —— 而进程退出本身可能只是
// 一次偶发（例如同步查询撞上数据变更）。这里补上有界重启。
const BACKEND_RESTART_MAX = 3;
const RESTART_BACKOFF_MS = [500, 1500, 4500];

/** 启动后端并完成 init，成功后写入 wechatBackend / wechatBoot。 */
async function startWechatBackend(userDataPath) {
  const handle = spawnBackendProcess(userDataPath, (code) => {
    if (backendStopping) return;
    wechatBackend = null;
    wechatBoot = null;
    broadcastWechatEvent('wechat-backend-down', [{ code }]);
    scheduleBackendRestart(`进程退出 (code=${code})`);
  });
  const boot = await handle.init();
  wechatBackend = handle;
  wechatBoot = boot;
  return handle;
}

/** 把「已保存的微信设置」回灌到后端（首次启动与每次重启后都要做）。 */
async function applySavedWechatSettings() {
  const savedSettings = loadWechatSettings();
  if (Object.keys(savedSettings).length === 0) return;
  const r = await wechatBackend.call('saveWechatConfig', [{ patch: savedSettings }]);
  if (!r.ok || r.value?.ok === false) {
    console.warn('[wechat] 应用 wechat/config.json 设置失败:', r.error || r.value?.error);
  }
}

/**
 * 安排一次重启；超过上限则明确告知用户，不再无限重试。
 * @param reason - 最近一次失败原因，写进面向用户的提示与日志。
 */
function scheduleBackendRestart(reason) {
  if (backendStopping) return;
  if (backendRestartCount >= BACKEND_RESTART_MAX) {
    const msg = `微信+ 后端连续 ${BACKEND_RESTART_MAX} 次重启失败，相关功能不可用。`
      + `请重启应用；若持续失败请检查 wechat/config.json 与数据目录。最近原因：${reason}`;
    console.error('[wechat]', msg);
    broadcastWechatEvent('wechat-backend-failed', [{ message: msg }]);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { dialog.showErrorBox('微信+ 后端不可用', msg); } catch { /* 对话框失败不致命 */ }
    }
    return;
  }
  const attempt = backendRestartCount;
  backendRestartCount += 1;
  const delay = RESTART_BACKOFF_MS[attempt] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
  console.warn(`[wechat] 后端将在 ${delay}ms 后第 ${backendRestartCount}/${BACKEND_RESTART_MAX} 次重启（原因：${reason}）`);
  const timer = setTimeout(() => {
    if (backendStopping) return;
    void (async () => {
      try {
        await startWechatBackend(backendUserDataPath);
        // 新进程是干净的，必须回灌已保存设置，否则密钥/路径全空。
        await applySavedWechatSettings();
        backendRestartCount = 0;
        console.log('[wechat] 后端已恢复，Remote 方法数:', wechatBoot?.methods?.length ?? 0);
        broadcastWechatEvent('wechat-backend-up', [{ methods: wechatBoot?.methods?.length ?? 0 }]);
      } catch (e) {
        scheduleBackendRestart(`重启后 init 失败：${e?.message ?? e}`);
      }
    })();
  }, delay);
  if (timer.unref) timer.unref();
}

/** 微信+前端构建产物（npm run build:ui 生成）；缺失时回退到演示页。 */
function uiEntryHtml() {
  const built = path.join(__dirname, 'src', 'client', 'ui-dist', 'index.html');
  if (fs.existsSync(built)) return built;
  return path.join(__dirname, 'src', 'index.html');
}

function broadcastWechatEvent(name, args) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('wechat:event', { name, args });
    } catch {
      /* 窗口可能已销毁，忽略 */
    }
  }
}

function createWindow() {
  const appIcon = path.join(__dirname, 'build', 'icon.ico');
  // 初始尺寸按主屏工作区算，**不写死宽高**：写死 1664×1066 时，1366×768 或
  // 1080p@125% 的机器上窗口比屏幕还大（审计 P0-2）。窗口本身始终可缩放，
  // 下限取实测能容下「会话列表 + 消息区 + 群聊信息抽屉」三列的值。
  const MIN_W = 960;
  const MIN_H = 640;
  const work = screen.getPrimaryDisplay().workAreaSize;
  const initialWidth = Math.max(MIN_W, Math.round(work.width * 0.92));
  const initialHeight = Math.max(MIN_H, Math.round(work.height * 0.92));
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: MIN_W,
    minHeight: MIN_H,
    useContentSize: true,
    resizable: true,
    // 标题栏是自绘的（frame:false），最大化/全屏都由自绘按钮触发，所以这里要放开，
    // 否则那两个按钮点了没反应。
    maximizable: true,
    fullscreenable: true,
    show: false,
    frame: false,
    backgroundColor: '#0f172a',
    title: 'Super Time · 微信+',
    icon: fs.existsSync(appIcon) ? appIcon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false));
  // 全屏状态也要回传：标题栏那个按钮的图标要跟着切换（进入/退出全屏图标不同）
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:fullscreen-changed', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:fullscreen-changed', false));

  // 调试：SUPERTIME_SKELETON=1 时加载 ?skeleton=1，Overview 强制展示骨架屏。
  const loadQuery = process.env.SUPERTIME_SKELETON === '1' ? { query: { skeleton: '1' } } : undefined;
  mainWindow.loadFile(uiEntryHtml(), loadQuery);

  // DevTools 按需开启：实测打开 DevTools 会额外拉起一个 renderer 进程并常驻
  // 约 200MB（独立窗口 + 自己的 V8 堆），因此不再默认打开。
  // 需要调试时设 SUPERTIME_DEVTOOLS=1。
  if (!app.isPackaged && process.env.SUPERTIME_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 渲染进程日志转发（默认关闭，用 SUPERTIME_RENDERER_LOG=1 打开）。
  //
  // 之前是无条件转发，而「朋友圈」面板会为大量被 CSP 拦下的 http 图片各打一条
  // console 消息，一次访问就是成百上千行 —— 每条都要跨 IPC 到主进程再写 stdout，
  // 在 stdout 未被及时消费时会堆在 Node 的写缓冲里。这里改成按需开启，
  // 并对单条消息截断、对总量设上限。
  if (process.env.SUPERTIME_RENDERER_LOG === '1') {
    const MAX_RELAYED = 500;
    let relayed = 0;
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (relayed >= MAX_RELAYED) return;
      relayed += 1;
      if (relayed === MAX_RELAYED) {
        console.log(`[renderer] 已达转发上限 ${MAX_RELAYED} 行，后续渲染进程日志不再转发`);
      }
      console.log(`[renderer:${level}]`, String(message).slice(0, 500), `(${sourceId}:${line})`);
    });
  }
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[render-process-gone]', JSON.stringify(details));
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });

  // 事件循环阻塞诊断（SUPERTIME_ELD=1）。主进程里所有 Remote 方法都用同步的
  // node:sqlite，一旦某个查询跑得久，窗口消息泵就被卡住 —— 这正是
  // 「应用未响应」的来源。这里按 5 秒窗口统计事件循环延迟的最大值。
  if (process.env.SUPERTIME_ELD === '1') {
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const timer = setInterval(() => {
      const max = histogram.max / 1e6;
      const p99 = histogram.percentile(99) / 1e6;
      if (max > 200) {
        console.log(`[eld] 主进程事件循环阻塞 ${max.toFixed(0)}ms (p99=${p99.toFixed(0)}ms) @ ${new Date().toISOString()}`);
      }
      histogram.reset();
    }, 5000);
    if (timer.unref) timer.unref();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // 未获单实例锁的重复实例不做任何初始化（app.quit 已在上面调用）。
  if (!singleInstanceLock) return;
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }));

  ipcMain.handle('app:ping', () => `pong @ ${new Date().toISOString()}`);

  /**
   * 是否处于验收/自动化测试模式（`SUPERTIME_TEST_MODE=1`）。
   *
   * 验收脚本会用**本地 mock LLM** 替换模型，回答是固定文本而不是真实数据 ——
   * 曾经两次被误认成「应用在编造答案」。前端据此在窗口顶部挂一条醒目横幅。
   */
  ipcMain.handle('app:test-mode', () => process.env.SUPERTIME_TEST_MODE === '1');

  // —— License 授权（混合模式：本地验签为主）——
  ipcMain.handle('license:status', () => {
    try {
      return licenseService.getLicenseStatus(app.getPath('userData'), APP_VERSION);
    } catch (err) {
      return { state: 'error', licensed: false, reason: err.message, code: 'ERROR' };
    }
  });

  ipcMain.handle('license:activation-request', () => {
    try {
      return licenseService.getActivationRequest(app.getPath('userData'), APP_VERSION);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('license:export-request', async () => {
    try {
      const req = licenseService.getActivationRequest(app.getPath('userData'), APP_VERSION);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出激活请求',
        defaultPath: `activation-request-${req.fingerprint.slice(0, 8)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(req, null, 2), 'utf8');
      return { ok: true, path: result.filePath, request: req };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('license:import', async () => {
    try {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: '导入许可证',
        properties: ['openFile'],
        filters: [{ name: 'License', extensions: ['json', 'lic'] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      const content = fs.readFileSync(picked.filePaths[0], 'utf8');
      return licenseService.importLicense(app.getPath('userData'), APP_VERSION, content);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('license:import-text', (_e, text) => {
    try {
      return licenseService.importLicense(app.getPath('userData'), APP_VERSION, String(text ?? ''));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('license:remove', () => {
    try {
      return { ok: true, status: licenseService.removeLicense(app.getPath('userData'), APP_VERSION) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('license:fingerprint', () => {
    try {
      return getDeviceFingerprint();
    } catch (err) {
      return { fingerprint: '', parts: {}, error: err.message };
    }
  });

  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return { canceled: true, files: [] };
    return { canceled: false, files: result.filePaths };
  });

  ipcMain.handle('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] ?? null };
  });

  /**
   * 保存对话框：只负责选路径，真正的写盘由后端做（视频有几十 MB，不适合经 IPC 传字节）。
   */
  ipcMain.handle('dialog:save-file', async (_event, opts) => {
    try {
      // 调试/自动化用：设了 SUPERTIME_SAVE_PATH 就跳过原生对话框直接用它
      // （原生对话框在无头自动化里点不到，否则「保存」按钮无法被测试覆盖）。
      const forced = (process.env.SUPERTIME_SAVE_PATH || '').trim();
      if (forced) return { canceled: false, path: forced };
      const result = await dialog.showSaveDialog(mainWindow, {
        title: typeof opts?.title === 'string' && opts.title ? opts.title : '保存文件',
        defaultPath: typeof opts?.defaultName === 'string' && opts.defaultName ? opts.defaultName : 'export.bin',
        filters: Array.isArray(opts?.filters) ? opts.filters : undefined,
      });
      if (result.canceled || !result.filePath) return { canceled: true, path: null };
      return { canceled: false, path: result.filePath };
    } catch (e) {
      return { canceled: true, path: null, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('shell:show-item', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath) {
      shell.showItemInFolder(filePath);
    }
    return true;
  });

  // —— 自绘标题栏窗口控制 ——
  ipcMain.on('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.on('window:maximize-toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => {
    if (mainWindow) mainWindow.close();
  });
  ipcMain.on('window:fullscreen-toggle', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
  ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() ?? false);
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

  /**
   * 把渲染进程指定的矩形区域截成 PNG 保存（「导出报告 → 界面截图」）。
   *
   * 为什么放在主进程：`webContents.capturePage(rect)` 只有主进程能用；渲染端的
   * `getBoundingClientRect()` 给的正是 CSS 像素坐标，与 capturePage 的矩形同坐标系，
   * 因此「所见即所存」——不需要另写一套报告模板。
   * @param rect - { x, y, width, height }，相对渲染页视口。
   * @returns { ok, canceled? , path?, message? }
   */
  ipcMain.handle('window:capture-panel', async (_event, rect) => {
    try {
      if (!mainWindow) return { ok: false, message: '窗口不存在' };
      const x = Math.max(0, Math.round(Number(rect?.x) || 0));
      const y = Math.max(0, Math.round(Number(rect?.y) || 0));
      const width = Math.max(1, Math.round(Number(rect?.width) || 0));
      const height = Math.max(1, Math.round(Number(rect?.height) || 0));
      const image = await mainWindow.webContents.capturePage({ x, y, width, height });
      const png = image.toPNG();
      if (!png || png.length === 0) return { ok: false, message: '截图内容为空' };
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const suggested = typeof rect?.filename === 'string' && rect.filename.trim()
        ? rect.filename.trim()
        : `wechat-report-${stamp}.png`;
      // 调试/自动化用：设了 SUPERTIME_CAPTURE_PATH 就跳过保存对话框直接落盘
      // （原生对话框在无头自动化里点不到，否则导出无法被测试覆盖）。
      const forced = process.env.SUPERTIME_CAPTURE_PATH;
      if (forced) {
        fs.writeFileSync(forced, png);
        return { ok: true, path: forced, bytes: png.length, width: image.getSize().width, height: image.getSize().height };
      }
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: '导出报告截图',
        defaultPath: suggested,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (canceled || !filePath) return { ok: true, canceled: true };
      fs.writeFileSync(filePath, png);
      return { ok: true, path: filePath, bytes: png.length, width: image.getSize().width, height: image.getSize().height };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  });

  // —— 微信+后端（迁移自 @deepseek-ai/dsh-wechat-data，独立进程运行）——
  try {
    // 先读取 wechat/config.json 里的路径配置并映射到 DSH_WECHAT_* 环境变量
    // （必须在 fork 之前，子进程直接继承 process.env）。
    applyConfig();
    backendUserDataPath = app.getPath('userData');
    await startWechatBackend(backendUserDataPath);
    // 启动后将实际解析到的路径记录回 wechat/config.json。
    try {
      recordResolved(wechatBoot.info);
    } catch (e) {
      console.warn('[wechat] 记录路径配置失败:', e);
    }
    // 若 wechat/config.json 中已有保存过的微信设置（密钥等），启动时回写后端。
    try {
      await applySavedWechatSettings();
    } catch (e) {
      console.warn('[wechat] 应用 wechat/config.json 设置失败:', e);
    }
    console.log('[wechat] 微信+后端已就绪，Remote 方法数:', wechatBoot.methods.length);
    console.log('[wechat] 状态目录:', STATE_DIR);
    console.log('[wechat] 路径配置:', configPath());
  } catch (err) {
    console.error('[wechat] 微信+后端初始化失败:', err);
    // 初始化失败也交给监管器重试 —— 这是最该自愈的一类失败：
    // 首次启动时数据可能正在解密、数据根尚未就绪，等一会儿再拉一次往往就成功。
    // 原实现只 console.error 一句，界面永远停在「微信+后端未初始化」。
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { dialog.showErrorBox('微信+ 后端初始化失败', `正在自动重试。原因：${err?.message ?? err}`); } catch { /* 不致命 */ }
    }
    scheduleBackendRestart(`初始化失败：${err?.message ?? err}`);
  }

  ipcMain.handle('wechat:list-methods', () => {
    if (!wechatBoot) return { ok: false, error: { message: '微信+后端未初始化' } };
    return { ok: true, value: wechatBoot.methods };
  });

  ipcMain.handle('wechat:info', () => {
    if (!wechatBoot) return { ok: false, error: { message: '微信+后端未初始化' } };
    return { ok: true, value: wechatBoot.info };
  });

  ipcMain.handle('wechat:call', (_event, method, args) => {
    if (!wechatBackend) return { ok: false, error: { message: '微信+后端未初始化' } };
    try {
      const lic = licenseService.getLicenseStatus(app.getPath('userData'), APP_VERSION);
      const gate = licenseService.authorizeCall(lic, method);
      if (!gate.ok) {
        return {
          ok: false,
          error: {
            message: gate.message,
            code: gate.code,
            details: { licenseState: lic.state, method, feature: licenseService.METHOD_FEATURE[method] || 'wechat-data' },
          },
        };
      }
    } catch (e) {
      // 授权检查**自身**失败时必须拒绝，而不是放行。
      // 许可 JSON 损坏、readLicenseFile 读盘失败、指纹采集异常等都会落到这里；
      // 原实现只 warn 一句就继续调用后端，等于「许可闸门一旦出异常就完全失效」。
      console.error('[license] 授权校验异常，已拒绝本次调用:', e?.message ?? e);
      return {
        ok: false,
        error: {
          message: `许可校验失败，已拒绝本次调用：${e?.message ?? String(e)}`,
          code: 'LICENSE_CHECK_FAILED',
          details: { method },
        },
      };
    }
    return wechatBackend.call(method, args);
  });

  ipcMain.handle('wechat:dispose', () => {
    // 显式 dispose 的语义是「拆掉后端」，因此先关掉监管器再拆 ——
    // 否则进程退出会触发自动重启，与调用方意图相反。
    backendStopping = true;
    if (wechatBackend) {
      wechatBackend.dispose();
      wechatBackend = null;
      wechatBoot = null;
      return { ok: true };
    }
    return { ok: true };
  });

  // —— 微信问答模型配置（wechat/llm.json） ——
  ipcMain.handle('wechat:llm-get', () => {
    try {
      return { ok: true, value: loadLlmConfig() };
    } catch (e) {
      return { ok: false, error: { message: e.message } };
    }
  });
  ipcMain.handle('wechat:llm-save', (_event, cfg) => {
    try {
      return { ok: true, value: saveLlmConfig(cfg || {}) };
    } catch (e) {
      return { ok: false, error: { message: e.message } };
    }
  });
  // —— 通过 base_url 拉取官方模型列表（OpenAI 兼容 GET {base_url}/models）。
  //     放在主进程执行：file:// 渲染页跨域 fetch 会被 CORS 拦，Node fetch 不受限。 ——
  ipcMain.handle('wechat:llm-models', async (_event, opts = {}) => {
    const baseUrl = String(opts.baseUrl || '').trim();
    const apiKey = String(opts.apiKey || '');
    /** 把 undici 的底层错误码翻译成用户能照做的中文提示。
     *  原始错误（如 "fetch failed"/UND_ERR_CONNECT_TIMEOUT）对用户毫无信息量。 */
    const humanizeNetworkError = (e, host) => {
      const code = e?.cause?.code || e?.code || '';
      if (e?.name === 'AbortError') return `请求超时（30 秒）：${host} 无响应，请检查网络或地址`;
      if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
        return `连接 ${host} 超时：网络不通或地址有误（国内网络通常无法直连 api.openai.com，可换 DeepSeek / 通义千问等国内厂商）`;
      }
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `域名解析失败（${host}）：请检查 API 地址拼写`;
      if (code === 'ECONNREFUSED') return `连接被拒绝（${host}）：端口未开放或已被防火墙拦截`;
      if (code === 'ECONNRESET') return `连接被重置（${host}）：可能被网络中间设备中断，请重试或换厂商`;
      if (/CERT|SELF_SIGNED|TLS|SSL/i.test(String(code))) return `TLS 证书校验失败（${host}）：${code}`;
      return `${e?.message || String(e)}（${host}）`;
    };
    try {
      if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('API 地址需以 http:// 或 https:// 开头');
      }
      let host = baseUrl;
      try { host = new URL(baseUrl).host } catch { /* 保底用原文 */ }
      const url = baseUrl.replace(/\/+$/, '') + '/models';
      /** 未填 Key 时的兜底：命中内置清单则返回清单而非报错。
       *  填了 Key 的失败不发生回退 —— 用户已有凭据，真错误更有价值。 */
      const catalogFallback = (note) => {
        if (apiKey) return null;
        const hit = findModelCatalog(baseUrl);
        if (!hit) return null;
        return { ok: true, value: { models: hit.models, source: 'catalog', vendor: hit.vendor, note } };
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let res;
      try {
        res = await fetch(url, {
          headers: {
            accept: 'application/json',
            ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
          },
          signal: ctrl.signal,
        });
      } catch (e) {
        const fb = catalogFallback('当前网络无法直连该地址，已改用内置清单');
        if (fb) return fb;
        throw new Error(humanizeNetworkError(e, host));
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        if (res.status === 401 || res.status === 403) {
          const fb = catalogFallback('该厂商列表接口需要 API Key，已改用内置清单');
          if (fb) return fb;
          const authHint = apiKey ? 'API Key 无效或无权限，请检查后重试' : 'API Key 为空，请先填写你的 API Key';
          throw new Error(`接口返回 ${res.status} ${res.statusText || ''}${body ? '：' + body : ''}（${authHint}）`.trim());
        }
        let hint = '';
        if (res.status === 404) {
          hint = '（该地址可能缺少 /v1 后缀，或厂商不提供 /models 接口，可手动填写模型名）';
        }
        throw new Error(`接口返回 ${res.status} ${res.statusText || ''}${body ? '：' + body : ''} ${hint}`.trim());
      }
      const data = await res.json().catch(() => null);
      const raw = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : [];
      const models = [...new Set(raw
        .map((m) => (typeof m === 'string' ? m : m?.id))
        .filter((id) => typeof id === 'string' && id))];
      return { ok: true, value: { models, source: 'live' } };
    } catch (e) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
  });

  createWindow();

  // 调试用：SUPERTIME_SCREENSHOT=path 时加载完成后截图并退出；
  // SUPERTIME_THEME=light|dark 可在截图前强制主题。
  if (process.env.SUPERTIME_SCREENSHOT) {
    setTimeout(async () => {
      try {
        if (process.env.SUPERTIME_THEME === 'light' || process.env.SUPERTIME_THEME === 'dark') {
          await mainWindow.webContents.executeJavaScript(`(() => {
            const wantLight = ${JSON.stringify(process.env.SUPERTIME_THEME)} === 'light';
            const isLight = document.documentElement.classList.contains('theme-light');
            if (isLight !== wantLight) {
              const btn = document.querySelector('[data-theme-toggle]');
              btn?.click();
            }
            window.scrollTo(0, 0);
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        if (process.env.SUPERTIME_TAB) {
          await mainWindow.webContents.executeJavaScript(`(() => {
            const label = ${JSON.stringify(process.env.SUPERTIME_TAB)};
            const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === label);
            btn?.click();
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        // 调试用：SUPERTIME_CLICK='标签A|标签B' 依次点击匹配的按钮
        // （精确匹配优先，其次前缀匹配），用于截图验证需要多步交互的界面
        // ——SUPERTIME_TAB 只能点一次、且必须整串相等，开不出「先切页签、再展开面板」这类状态。
        if (process.env.SUPERTIME_CLICK) {
          const labels = process.env.SUPERTIME_CLICK.split('|').map((s) => s.trim()).filter(Boolean);
          for (const label of labels) {
            const clicked = await mainWindow.webContents.executeJavaScript(`(() => {
              const want = ${JSON.stringify(label)};
              const btns = Array.from(document.querySelectorAll('button'));
              const hit = btns.find(b => (b.textContent || '').trim() === want)
                || btns.find(b => (b.textContent || '').trim().startsWith(want));
              if (!hit) return false;
              hit.click();
              return true;
            })()`);
            console.log('[click]', label, clicked ? 'ok' : '按钮未找到');
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (process.env.SUPERTIME_MAP_DEBUG === '1') {
          const mapInfo = await mainWindow.webContents.executeJavaScript(`(() => {
            const s = Array.from(document.querySelectorAll('section')).find(x => (x.textContent || '').includes('世界板块'));
            if (!s) return { found: false };
            const cs = getComputedStyle(s);
            const p = s.parentElement;
            const pc = p ? getComputedStyle(p) : null;
            return {
              found: true,
              text: s.textContent?.slice(0, 80),
              h: s.getBoundingClientRect().height,
              display: cs.display,
              flex: cs.flex,
              minH: cs.minHeight,
              overflow: cs.overflow,
              parentClass: p?.className,
              parentH: p?.getBoundingClientRect().height,
              parentDisplay: pc?.display,
              parentOverflow: pc?.overflow,
              parentMinH: pc?.minHeight,
              bodyH: s.children[1]?.getBoundingClientRect().height,
              bodyTextH: s.children[1]?.textContent?.length,
              canvasCount: s.querySelectorAll('canvas').length,
              hasEcharts: !!s.querySelector('.map, [class*="map"]'),
            };
          })()`);
          console.log('[map debug]', JSON.stringify(mapInfo));
        }
        const scrollTarget = Number(process.env.SUPERTIME_SCROLL);
        if (process.env.SUPERTIME_SCROLL === '1' || scrollTarget > 0) {
          const info = await mainWindow.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('[class*="content"]');
            const p = c?.closest('[class*="panel"]');
            const scrollables = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 10);
            return {
              innerHeight: window.innerHeight,
              rootH: document.getElementById('root')?.getBoundingClientRect().height,
              panelH: p?.getBoundingClientRect().height,
              contentClientH: c?.clientHeight,
              contentScrollH: c?.scrollHeight,
              contentOverflow: c ? getComputedStyle(c).overflow : null,
              scrollables: scrollables.slice(0, 5).map(el => ({ cls: el.className, client: el.clientHeight, scroll: el.scrollHeight })),
            };
          })()`);
          console.log('[scroll debug]', JSON.stringify(info));
          await mainWindow.webContents.executeJavaScript(`(() => {
            const candidates = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 10);
            const target = candidates.slice().sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || candidates[candidates.length - 1];
            if (target) target.scrollTop = ${scrollTarget || 520};
            return candidates.length;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.SUPERTIME_SCREENSHOT, image.toPNG());
        console.log('[screenshot] saved', process.env.SUPERTIME_SCREENSHOT);
      } catch (e) {
        console.error('[screenshot] failed', e);
      }
      app.quit();
    }, 9000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // 先置停止标记：kill 会触发 exit 回调，不置标记就会安排一次无意义的重启。
  backendStopping = true;
  if (wechatBackend) {
    try {
      wechatBackend.dispose();
    } catch {
      /* 退出时尽力释放 */
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
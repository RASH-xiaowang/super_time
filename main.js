// 必须最先执行：终端/父进程退出后 stdout 管道会关闭，之后任何 console.log 都会
// 触发 EPIPE 并被 Node 当未捕获异常抛出，主进程弹出致命框（详见 src/backend/console-safe.js）。
// SUPERTIME_NO_CONSOLE_GUARD=1 仅供 scripts/epipe-smoke.js 做负对照用。
if (process.env.SUPERTIME_NO_CONSOLE_GUARD !== '1') require('./src/backend/console-safe').install();

const { app, BrowserWindow, clipboard, ipcMain, dialog, screen, shell, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { decideNavigation, decideWindowOpen } = require('./src/backend/navigation-policy');

/**
 * 启动自检：**必须先于任何 `app.*` 用法**。
 *
 * `ELECTRON_RUN_AS_NODE=1` 时 Electron 退化成纯 Node，`require('electron')` 返回的是
 * **可执行文件路径字符串**，解构出来的 `app` 是 `undefined` —— 于是崩在下面那句
 * `app.isPackaged`，报错与真因（环境变量）毫不相干。2026-09-29 实测 `npm run dev`：
 *
 *   TypeError: Cannot read properties of undefined (reading 'isPackaged')
 *       at Object.<anonymous> (main.js:27:9)
 *
 * 启动方式已经由 `scripts/launch-app.mjs` 修掉（它统一摘掉那个变量，仓库里三个真机脚本
 * 与 `SuperTime.cmd` 早就是这么做的）。**这段是兜底**：无论谁用什么姿势把本入口当纯 Node
 * 跑（含打包产物被误用），都要得到一句能直接照做的诊断，而不是一个指向第 27 行的 TypeError。
 */
if (app === undefined || typeof app.isPackaged !== 'boolean') {
  console.error([
    '[启动自检] 当前进程不是 Electron 运行时 —— require("electron") 没给出 app 对象。',
    '  最常见原因：环境里有 ELECTRON_RUN_AS_NODE=1，Electron 会因此退化成纯 node。',
    '  怎么修：',
    '    · 用 npm start / npm run dev 启动（它们会剥掉这个环境变量）；',
    '    · 或手动：npx electron .',
    '    · PowerShell 临时清掉：$env:ELECTRON_RUN_AS_NODE=$null; npx electron .',
  ].join('\n'));
  process.exit(1);
}

/**
 * fuses 覆盖不到的启动开关。
 *
 * Electron 只给 `--inspect*` 配了 fuse；`--remote-debugging-port` / `-pipe` **没有任何
 * fuse 覆盖** —— 而它们一旦生效，任何能**传参启动本 exe** 的一方即可通过 CDP 拿到渲染
 * 进程与整条 IPC 桥（实测打包产物上 `/json/list` 直接列出应用页面，`Runtime.evaluate`
 * 能读到 `electronAPI`）。打包态一律剥掉；开发态保留（调试需要）。
 * 已知残留：`--no-sandbox` 由 Electron 在更早阶段处理，这里剥掉只影响后续判断
 * （见 docs/RELEASE-PLAN.md 的 H10 遗留清单）。
 */
const GUARDED_SWITCHES = [
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins',
  'no-sandbox', 'disable-gpu-sandbox', 'inspect', 'inspect-brk',
];
if (app.isPackaged) {
  for (const sw of GUARDED_SWITCHES) {
    if (app.commandLine.hasSwitch(sw)) {
      app.commandLine.removeSwitch(sw);
      console.warn('[security] 已忽略启动参数 --' + sw);
    }
  }
}

/**
 * 安全探针的两个计数。P0-4 起由 `src/backend/main-window.js` 里的守卫递增 ——
 * 传下去的是**同一个对象**（值语义会丢掉递增，探针就恒为 0 了）。
 * 判「有没有被绕过」不能看 `window.open` 的返回值：deny 时 Chromium 也可能回一个
 * 指向空窗的 WindowProxy，所以弹窗只能数 `did-create-window`。
 */
const securityCounters = { openExternalAttempts: 0, popupWindowsCreated: 0 };
const {
  configure: configureWechatPaths,
  applyConfig,
  recordResolved,
  loadWechatSettings,
  mirroredSecretValues,
  loadLlmConfig,
  saveLlmConfig,
  loadLlmStore,
  activateLlmProfile,
  upsertLlmProfile,
  deleteLlmProfile,
  configPath,
} = require('./src/backend/wechat-paths');
const { findByBaseUrl: findModelCatalog } = require('./src/backend/llm-model-catalog');
const licenseService = require('./src/license/service');
const { createWorkerChannel } = require('./src/backend/backend-rpc');
const {
  createBackendSupervisor,
  BACKEND_CALL_READY_WAIT_MS,
} = require('./src/backend/backend-supervisor');
const { buildDiagnosticPreview, buildDiagnosticReport, createDiagLog, installConsoleCapture, installRendererConsoleCapture, rendererConsoleLevels } = require('./src/backend/diag-log');
const { restrictWechatState } = require('./src/backend/secure-fs');
const { resolveDebugGates, resolveHangMethods, HANG_ENV: DEBUG_HANG_ENV } = require('./src/backend/debug-gates');
const { createUpdateService } = require('./src/backend/update');
const { registerMiscIpc } = require('./src/backend/ipc-misc');
const { registerWechatIpc } = require('./src/backend/ipc-wechat');
const { registerRemoteAccessIpc } = require('./src/backend/ipc-remote-access');
const { registerUpdateIpc } = require('./src/backend/ipc-update');
const { createIpcTrust } = require('./src/backend/ipc-trust');
// 局域网远程访问（手机端）：HTTP 服务 + 与 IPC 共用的那道闸门。
const { createRemoteAccessServer } = require('./src/backend/http-server');
const { createCallQueue } = require('./src/backend/http-queue');
const { gatedWechatCall } = require('./src/backend/call-gates');
const {
  uiEntryHtml,
  createMainWindow,
  installWebContentsGuards: installWindowGuards,
  broadcastToWindows,
} = require('./src/backend/main-window');
const { installScreenshotAutomation } = require('./src/backend/main-debug-automation');

/**
 * 首启闸门豁免状态（N2）。
 *
 * 每次调用**现取** `app.isPackaged`：它是本项唯一的信任边界（环变量伪造不了打包态），
 * 取值动作留在主进程，回给渲染层的只有算好的结论（`{ packaged, skipGates }`）。
 * 豁免范围与「打包态不得豁免」的依据见 `src/backend/debug-gates.js`。
 */
const debugGates = () => resolveDebugGates({ isPackaged: app.isPackaged, env: process.env });

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

/** 「Super Time」的运行期状态目录（config.json / llm.json）跟着 userData 走。 */
const STATE_DIR = configureWechatPaths({ userDataPath: app.getPath('userData') });


// ── 文件日志（M6）────────────────────────────────────────────────────────
// GUI 态下 stdout 是无人接管的管道，console-safe 发现管道坏了就彻底静默 ——
// 崩溃之后什么都没留下。这里在 STATE_DIR/logs 下落一份带轮转的日志，
// 并把 console 也接进去（**在这之后**装：console-safe 那层管道坏了会直接 return，
// 顺序反了日志会跟着一起没）。
const diagLog = createDiagLog({ dir: path.join(STATE_DIR, 'logs') });
installConsoleCapture(diagLog);
process.on('uncaughtException', (e) => {
  // 崩溃必须留痕：这是「用户说打不开，我们却什么都没有」的唯一补救。
  try { diagLog.write('fatal', ['uncaughtException', e]); } catch { /* 日志自己绝不抛 */ }
});
process.on('unhandledRejection', (reason) => {
  try { diagLog.write('error', ['unhandledRejection', reason]); } catch { /* 同上 */ }
});
// ── 密钥文件权限收紧（M1）────────────────────────────────────────────────
// config.json / secrets.json / keys.json 里有微信库密钥与 API Key 的明文，默认权限下
// 同机其它账户也能读。这里先把**状态目录**收紧到当前用户；真实数据根要等后端解析出来
// （见 migrateSecretsAndTightenAcl），因为数据根可由配置指到任意位置。
// 靠目录的 (OI)(CI) 继承让之后新建的文件自动跟随，不必每写一个文件都调一次 icacls。
// 放在日志安装**之后**：拿不到权限时那行告警要能落进文件日志（GUI 态 stdout 是断的）。
{
  // 默认数据根**只在已存在时**顺带收紧：`restrictDir` 内部会 mkdirSync，无条件传进去会在
  // 还没用过微信数据的新装机器上凭空造一个空的 `<userData>/wechat-data`（复审实测：数据根
  // 被配置指到别处时那个空目录依然出现，纯误导）。真实的数据根由收尾步骤按解析结果收紧。
  const defaultDataRoot = path.join(app.getPath('userData'), 'wechat-data');
  const r = restrictWechatState({
    stateDir: STATE_DIR,
    ...(fs.existsSync(defaultDataRoot) ? { dataRoot: defaultDataRoot } : {}),
  });
  if (!r.ok) console.warn('[security] 密钥目录权限预收紧未完全成功：' + r.failures.join('; '));
}

const APP_VERSION = (() => {
  try {
    return require('./package.json').version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

// 应用身份（N20）：必须与 NSIS 快捷方式里写的 appId 一致，否则任务栏固定/分组会认成两个应用。
// 放在建窗之前（与文档建议的同序），见 src/backend/app-id.js 的说明。
const { APP_ID: appId } = require('./src/backend/app-id.js');
app.setAppUserModelId(appId);
console.log('[app-id] AppUserModelID=' + appId);

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
/**
 * 自动更新服务（electron-updater）；在 `whenReady` 里建好，之前为 null。
 *
 * 三个 `update:*` 处理器都注册在它建好**之后**，所以这里不需要额外的空值兜底。
 */
let updateService = null;
/**
 * 局域网远程访问（手机端）的 HTTP 服务句柄；未创建或已停止时为 null。
 *
 * 它**默认不监听**：`start()` 内部要求 `api_enabled === true` 且令牌非空才会真的绑端口
 * （理由见 `src/backend/http-server.js` 文件头 —— 老配置里遗留的 `api_enabled: true`
 * 不该让端口在用户没点过任何新开关时就打开）。
 */
let remoteAccess = null;

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

/** 建窗口与装守卫需要的上下文（本体在 `src/backend/main-window.js`，行为逐字未改）。 */
const windowCtx = { app, BrowserWindow, screen, fs, path, rootDir: __dirname, env: process.env, getMainWindow: () => mainWindow };
const guardsCtx = { shell, rootDir: __dirname, decideNavigation, decideWindowOpen, counters: securityCounters };

/** 向所有窗口转发后端事件（本体已外提，这里只保留 main.js 内的调用点形状）。 */
function broadcastWechatEvent(name, args) {
  broadcastToWindows(windowCtx, 'wechat:event', { name, args });
  // 同一份事件也要发给手机浏览器（SSE）。payload 形状与 `wechat:event` 完全一致，
  // 所以渲染层那套「事件名 → DOM CustomEvent」的分发逻辑两边共用、一字不改 ——
  // WAL 实时刷新链（`wechat-data/updated`）在手机上因此与桌面端同样即时。
  if (remoteAccess) remoteAccess.pushEvent(name, args);
}

/**
 * 后端生命周期监管器：拉起 / init / 状态 / 有界重启 / 设置回灌 / 密钥迁移。
 * main.js 只保留“事件往哪发”与“什么时机开始/停止”两个编排点。
 */
const backendSupervisor = createBackendSupervisor({
  isPackaged: app.isPackaged,
  env: process.env,
  utilityProcess,
  diagLog,
  resolveHangMethods,
  DEBUG_HANG_ENV,
  createWorkerChannel,
  onEvent: broadcastWechatEvent,
  loadWechatSettings,
  mirroredSecretValues,
  restrictWechatState,
  stateDir: STATE_DIR,
  fs,
  path,
  applyConfig,
  recordResolved,
  callTimeoutMs: CALL_TIMEOUT_MS,
  longTimeoutMs: LONG_CALL_TIMEOUT_MS,
});

function broadcastUpdateState(state) {
  broadcastToWindows(windowCtx, 'update:event', state);
}

/**
 * 建更新服务（**懒加载** electron-updater）。
 *
 * 为什么包 try/catch：更新只是附属能力。它加载失败（asar 里少了依赖、原生模块不兼容）
 * 绝不能让应用起不来 —— 那会把「升级坏了」放大成「应用打不开」。失败时退化成
 * `autoUpdater: null`，服务把自己报成 `unsupported / unavailable`，界面照常可用。
 *
 * 为什么在 whenReady 里才建：electron-updater 读 `app.getVersion()` 与
 * `resources/app-update.yml`，都要求 app 已就绪。
 */
function createUpdateServiceSafe() {
  let autoUpdater = null;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[update] electron-updater 加载失败，本次运行不支持自动更新:', err);
  }
  return createUpdateService({
    autoUpdater,
    isPackaged: app.isPackaged,
    currentVersion: APP_VERSION,
    onState: broadcastUpdateState,
    // 走 console.* 而不是直接写 diagLog：上面 installConsoleCapture 已把 console
    // 接进文件日志，这里再写一次会在同一行上出现两份。
    log: (level, args) => {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink('[update]', ...args);
    },
  });
}

function createWindow() {
  mainWindow = createMainWindow(windowCtx);
}

function installWebContentsGuards(contents) {
  installWindowGuards(contents, guardsCtx);
  // 渲染层 console → 诊断日志（2026-10-08 补）。修复前渲染层的 warn/error 一行都进不了
  // app.log，用户机器上「卡片只显示默认文案」这类问题取不到任何证据。
  // 默认只收 warn/error（渲染层 info/log 量太大，会把轮转冲掉）；要更全就设
  // SUPERTIME_RENDERER_LOG_LEVELS=verbose,info,warn,error。
  installRendererConsoleCapture(contents, diagLog, rendererConsoleLevels());
}

app.whenReady().then(async () => {
  // 未获单实例锁的重复实例不做任何初始化（app.quit 已在上面调用）。
  if (!singleInstanceLock) return;
  // 入口路径只解析一次：IPC 信任与窗口 loadFile 必须用同一份路径。
  // 若两处各自再调 uiEntryHtml，构建产物恰好出现/消失时会出现「信任旧入口、
  // 却加载回退入口」的竞态。
  const appEntryHtml = uiEntryHtml(windowCtx);
  windowCtx.entryHtml = appEntryHtml;
  // 所有特权 IPC 共用同一份来源守卫：只接受当前主窗口的主 frame，
  // 且 frame URL 必须是应用自己的入口 HTML。
  const ipcTrust = createIpcTrust({
    getMainWindow: () => mainWindow,
    entryUrl: pathToFileURL(appEntryHtml).href,
  });
  // 诊断日志（M6）：界面上的「导出诊断日志」走这三个。
  // 正常情况下日志落在 STATE_DIR/logs，用户报障时把它交出来即可。
  registerMiscIpc({
    ipcMain, ipcTrust, app, dialog, shell, path, fs, diagLog, STATE_DIR, APP_VERSION, debugGates, licenseService,
    clipboard, getMainWindow: () => mainWindow, buildDiagnosticPreview, buildDiagnosticReport, installWebContentsGuards,
  });

  // —— Super Time 后端相关的 IPC ——
  // 处理器全部在这里注册（都在 createWindow() 之前），后端进程本身在
  // createWindow() 之后才启动，理由见那一处注释。
  // 这份 ctx 同时喂两处：IPC 的 `wechat:call` 与 HTTP 的 `POST /api/wechat/call`。
  // 两条路都经 `gatedWechatCall(ctx, …)`（call-gates.js），闸门只有一份实现 ——
  // 分开写的话，最可能的漂法是 HTTP 那份少抄 catch，于是许可校验一抛异常就变成放行。
  // 两个传输层也都把「过闸后的调用」放进同一把并发闸：worker 是单线程，桌面端若绕过
  // 队列继续无限压请求，远程端的 32 条排队上限就会被桌面请求随意绕过。
  const backendCallQueue = createCallQueue();
  const gateCtx = {
    ipcMain, ipcTrust, app, licenseService, debugGates,
    awaitBackendReady: (timeoutMs) => backendSupervisor.waitUntilReady(timeoutMs),
    findModelCatalog, APP_VERSION,
    getWechatBackend: () => backendSupervisor.backend,
    getWechatBoot: () => backendSupervisor.boot,
    getBackendStatus: () => backendSupervisor.status,
    scheduleWechatCall: (task, meta) => backendCallQueue.run(task, meta),
    getCallQueueStats: () => backendCallQueue.stats(),
    getRpcStats: () => (backendSupervisor.backend && typeof backendSupervisor.backend.stats === 'function'
      ? backendSupervisor.backend.stats()
      : undefined),
    BACKEND_CALL_READY_WAIT_MS, loadLlmConfig, saveLlmConfig, loadLlmStore, upsertLlmProfile, activateLlmProfile, deleteLlmProfile,
  };
  registerWechatIpc(gateCtx);

  // —— 局域网远程访问（手机端）——
  // 这里只**创建**，不启动：启动排在后端就绪之后（见 setBackendStatus('ready') 那一处），
  // 因为数据根要等后端解析出来才知道，而配置与令牌都住在数据根下。
  // 静态资源服务的就是 Electron 自己 loadFile 的同一份产物（`src/client/ui-dist`），
  // 所以手机与桌面加载的是同一个构建，不存在「手机版另一套代码」。
  remoteAccess = createRemoteAccessServer({
    getDataRoot: () => String(backendSupervisor.boot?.info?.root ?? ''),
    getUiDistDir: () => path.join(__dirname, 'src', 'client', 'ui-dist'),
    gatedCall: (method, args) => gatedWechatCall(gateCtx, method, args),
    callQueue: backendCallQueue,
    appVersion: APP_VERSION,
    ...(process.env.SUPERTIME_REMOTE_ACCESS_LOOPBACK_TEST === '1' ? { bindHost: '127.0.0.1' } : {}),
  });
  registerRemoteAccessIpc({
    ipcMain,
    ipcTrust,
    remoteAccess,
    backendCall: (method, args) => gatedWechatCall(gateCtx, method, args),
  });

  // ── 自动更新（electron-updater + GitHub Releases）──────────────────────
  // 五条控制通道已收敛到 ipc-update.js；update:event 仍由本文件的广播函数发出。
  // 更新源与安装包同源（build.publish → 打包时写进 resources/app-update.yml），
  // 状态机与各事件的收敛规则见 src/backend/update.js。
  updateService = createUpdateServiceSafe();
  // 一行正向留痕。没有它的话，日志里只有「加载失败」这一种证据 —— 用户报障说
  // 「升不了级」时，我们无法区分「服务就绪但检查失败」与「整个模块没装进包」。
  // package:smoke / 诊断日志导出都会带上这一行。
  console.log('[update] 更新服务已就绪 supported=%s current=%s',
    updateService.isSupported(), APP_VERSION);
  registerUpdateIpc({ ipcMain, ipcTrust, updateService });

  createWindow();

  // 安全守卫的端到端探针（仅 SUPERTIME_SECURITY_PROBE=1）：
  // 在**真实渲染进程**里尝试三类被禁行为 —— 新窗口打开 file:/smb:/自定义协议、以及
  // 把页面导航到外站 —— 把结果打成一行可被脚本断言的话后退出。
  // 为什么不只靠单测：单测证明的是判定函数；只有真的在渲染进程里跑一遍，
  // 才能证明守卫**挂上了**（web-contents-created 的注册时机、sandbox 下的实际行为）。
  // 必须在这里注册（不能挪到下面 await 之后）：did-finish-load 会在后端 init 的
  // await 期间就触发，那时再注册就永远等不到了。
  // 断言脚本：scripts/security-guard-smoke.js
  if (process.env.SUPERTIME_SECURITY_PROBE === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const urlBefore = mainWindow.webContents.getURL();
        const probe = {
          sandbox: null, opened: [], navAttempt: null,
          openExternalAttempts: 0, popupWindows: 0, urlBefore, urlAfter: null, navigated: null,
        };
        // 每个动作单独 evaluate 带超时：守卫失效时导航会把 frame 带走，而 executeJavaScript 在 frame
        // 销毁后不再 settle（评审实测）。一次超时有两种含义：**没观测到**（首跑排在后端 init 之后，CI
        // 实测 4s settle 不了而日志证明守卫全生效）与**观测到不成立** —— 只重试前者，见 N35。
        const evaluate = async (js, ms = 4000) => {
          let timer; let v = '__timeout__';
          for (let i = 0; i < 12; i += 1) {
            try {
              v = await Promise.race([
                mainWindow.webContents.executeJavaScript(js),
                new Promise((resolve) => { timer = setTimeout(() => resolve('__timeout__'), ms); }),
              ]);
            } catch (e) { v = '__error__:' + (e && e.message ? e.message : String(e)); }
            clearTimeout(timer); if (v !== '__timeout__') break;
          }
          return v;
        };

        // ① 沙箱是否真的生效（行为事实，不靠日志）
        probe.sandbox = await evaluate(
          '({ require: typeof require, process: typeof process, buffer: typeof Buffer,'
          + ' electronAPIKeys: Object.keys(window.electronAPI || {}).length })',
        );
        // ② 三类被禁协议的新窗口（逐条判定，避免一条挂住拖垮全部）
        // `result` 只记录 `window.open` 的返回形态（诊断用）；**安全判定看 `windowsAfter`**：
        // 处理器 deny 时 Chromium 照样可能回一个指向空窗的 WindowProxy（CI 上实测见过 'window'），
        // 而「是否真的开出了窗口」只有 did-create-window 说得上话。
        for (const u of ['file:///C:/Windows/System32/calc.exe', 'smb://attacker/share', 'ms-msdt:/id']) {
          const opened = await evaluate(`window.open(${JSON.stringify(u)}) === null ? 'null' : 'window'`);
          probe.opened.push({ url: u, result: opened, windowsAfter: securityCounters.popupWindowsCreated });
        }
        // ③ 外部导航
        probe.navAttempt = await evaluate("(() => { window.location.href = 'https://example.com/'; return 'attempted' })()");
        probe.openExternalAttempts = securityCounters.openExternalAttempts;
        probe.popupWindows = securityCounters.popupWindowsCreated;
        probe.urlAfter = mainWindow.webContents.getURL();
        probe.navigated = probe.urlAfter !== probe.urlBefore;
        console.log('[security-probe] ' + JSON.stringify(probe));
        app.quit();
      }, 3000);
    });
  }

  // 先建窗、再起后端：窗口能立刻显示加载态，首帧不再等 init（原顺序会先 await 后端
  // init，而 init 要 import 783KB 的 bundle、解析数据根，首次还可能触发 bootstrap，
  // 首帧被整段推迟）。
  // 放到这里还有个实际原因：状态横幅由渲染端承载，而渲染端要等窗口建好才能收到事件，
  // 也要等它挂载后主动查 backendState 才能补救「首启就失败」时错过的事件。
  // 启动编排已抽到 backend-supervisor.js：这里只按“窗口已建好”的时机发起，
  // 并保留远程访问的启动点（它依赖后端解析出的数据根）。
  const bootResult = await backendSupervisor.bootstrap(app.getPath('userData'));
  if (bootResult.ok) {
    console.log('[wechat] 状态目录:', STATE_DIR);
    console.log('[wechat] 路径配置:', configPath());
    // 远程访问（手机端）在**后端就绪之后**才决定要不要监听：数据根这时才解析出来，
    // 而 `api_enabled` / `api_port` 与令牌都住在数据根下。默认不监听（见 http-server.js 文件头）。
    try {
      const ra = await remoteAccess.syncWithConfig();
      if (ra.running) console.log('[remote-access] 手机访问地址: http://%s:%d', ra.address, ra.port);
    } catch (e) {
      console.warn('[remote-access] 启动失败（不影响桌面端）:', e?.message ?? e);
    }
  }

  // 自动更新（延迟 30s，见 update.js）：刻意放在后端 try/catch **之外** —— 更新能不能
  // 检查跟后端起没起来无关，后端初始化失败时更该让用户有机会升到修好的版本。
  // 排在建窗与后端之后是为了不与启动期抢带宽/事件循环。
  updateService.scheduleAutoCheck();

  // 截图/主题/页签/点击/地图/滚动等调试自动化已抽到
  // src/backend/main-debug-automation.js；这里只保留启动末尾的挂载点。
  installScreenshotAutomation({ getWindow: () => mainWindow, app });

  // 安全守卫的端到端探针已挪到 createWindow() 之后（见那处注释）：
  // did-finish-load 会在后端 init 的 await 期间触发，注册晚了就永远等不到。

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // 先置停止标记：kill 会触发 exit 回调，不置标记就会安排一次无意义的重启。
  backendSupervisor.stop();
  // 远程访问先停：它是唯一**对外**的入口，退出时应当立刻不再接受连接（而不是等进程销毁
  // socket）。stop() 是异步的，这里不 await —— 退出路径上不能挂住，端口随进程一起释放。
  if (remoteAccess) { void remoteAccess.stop(); remoteAccess = null; }
  // 更新服务收尾。两条路都会经过这里：
  //   · 用户点「重启并安装」→ quitAndInstall 内部调 app.quit() → 本回调；
  //   · 自动更新已下载 → autoInstallOnAppQuit 在退出时拉起安装包。
  // 顺序上必须先 dispose 后端再让安装器动手：后端 worker 还持有 decrypted/*.sqlite
  // 的文件句柄，安装器要替换的正是被占用的那些文件。这里摘掉监听器不会影响安装
  // （安装由 electron-updater 另起的分离进程完成），只是别让它再往已销毁的窗口推状态。
  if (updateService) {
    try {
      updateService.dispose();
    } catch {
      /* 退出时尽力释放 */
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

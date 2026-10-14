// 必须最先执行：终端/父进程退出后 stdout 管道会关闭，之后任何 console.log 都会
// 触发 EPIPE 并被 Node 当未捕获异常抛出，主进程弹出致命框（详见 src/backend/console-safe.js）。
// SUPERTIME_NO_CONSOLE_GUARD=1 仅供 scripts/epipe-smoke.js 做负对照用。
if (process.env.SUPERTIME_NO_CONSOLE_GUARD !== '1') require('./src/backend/console-safe').install();

const { app, BrowserWindow, clipboard, ipcMain, dialog, screen, shell, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
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
const { buildDiagnosticPreview, buildDiagnosticReport, createDiagLog, installConsoleCapture, installRendererConsoleCapture, rendererConsoleLevels } = require('./src/backend/diag-log');
const { restrictWechatState } = require('./src/backend/secure-fs');
const { resolveDebugGates, resolveHangMethods, HANG_ENV: DEBUG_HANG_ENV } = require('./src/backend/debug-gates');
const { createUpdateService } = require('./src/backend/update');
const { registerMiscIpc } = require('./src/backend/ipc-misc');
const { registerWechatIpc } = require('./src/backend/ipc-wechat');
// 局域网远程访问（手机端）：HTTP 服务 + 与 IPC 共用的那道闸门。
const { createRemoteAccessServer } = require('./src/backend/http-server');
const { createRemoteAccessControl } = require('./src/backend/http-control');
const { gatedWechatCall } = require('./src/backend/call-gates');
const {
  createMainWindow,
  installWebContentsGuards: installWindowGuards,
  broadcastToWindows,
} = require('./src/backend/main-window');

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
/** 当前后端句柄；进程已死或尚未 init 完成时为 null。 */
let wechatBackend = null;
/** 后端进程启动时返回的 { info, methods }。 */
let wechatBoot = null;
/**
 * 局域网远程访问（手机端）的 HTTP 服务句柄；未创建或已停止时为 null。
 *
 * 它**默认不监听**：`start()` 内部要求 `api_enabled === true` 且令牌非空才会真的绑端口
 * （理由见 `src/backend/http-server.js` 文件头 —— 老配置里遗留的 `api_enabled: true`
 * 不该让端口在用户没点过任何新开关时就打开）。
 */
let remoteAccess = null;
/** 监管状态：数据目录、当前句柄、已重启次数、待执行的重启定时器、是否主动停止。 */
let backendUserDataPath = null;
/**
 * 最近一次拉起的句柄（无论 init 是否完成）。
 *
 * 与 `wechatBackend` 的区别很关键：`wechatBackend` 只在 init 成功后才有值，
 * 而退出回调必须能判断「退出的到底是不是当前这个进程」——否则一个已被取代的
 * 陈旧句柄迟到地报 exit，就会把健康的新句柄置空、还多排一次重启。
 */
let backendCurrentHandle = null;
let backendRestartCount = 0;
/** 待执行的重启定时器；非空表示已有一次重启在路上，避免同一故障排两次。 */
let backendRestartTimer = null;
/** 面向界面的后端状态快照（渲染端可能错过事件，需要能主动查）。 */
let backendStatus = { state: 'starting', restarts: 0, lastError: null };
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
 * 拉起一个「Super Time」后端进程，并建立带超时的 RPC 通道。
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
  // stdio: 'pipe'（原来是 'inherit'）。原因：后端是**独立进程**，它那些
  // `[wechat-sync]` / `[config]` / 重试日志都写在自己的 stdout/stderr 上；
  // 'inherit' 时这些字节进的是主进程的那条管道，而 GUI 态那条管道是断的、
  // console-safe 会静默 —— 于是「打不开」这类最可能来自后端的报障，我们手上什么都没留下。
  // 这里把两条流转进文件日志，同时转写一份到本进程的标准流（保持开发态可见性）。
  // RPC 不受影响：它与后端之间走 process.parentPort，与 stdio 无关。
  // H7 验收：「永不回包」注入名单（非打包态专用）。打包态下 `resolveHangMethods` 恒返回空表，
  // 并且这里**显式删掉**该变量而不是「不设置」—— worker 就不再可能继承到一个卡死的注入名单。
  const hangMethods = resolveHangMethods({ isPackaged: app.isPackaged, env: process.env });
  const workerEnv = { ...process.env };
  if (hangMethods.length > 0) workerEnv[DEBUG_HANG_ENV] = hangMethods.join(',');
  else delete workerEnv[DEBUG_HANG_ENV];
  const child = utilityProcess.fork(
    path.join(__dirname, 'src', 'backend', 'wechat-worker.js'),
    [],
    { serviceName: 'super-time-wechat-backend', stdio: 'pipe', env: workerEnv }
  );
  for (const [stream, level, target] of [
    [child.stdout, 'backend', process.stdout],
    [child.stderr, 'backend!', process.stderr],
  ]) {
    if (!stream || typeof stream.on !== 'function') continue;
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === '') continue;
        diagLog.write(level, [line]);
        // 直接写进程流而不是 console：console 已经被接管，会重复落进文件一遍。
        try { target.write(line + '\n'); } catch { /* 管道坏了就只留文件那份 */ }
      }
    });
  }
  return createWorkerChannel(child, {
    userDataPath,
    onEvent: (name, args) => { if (process.env.SUPERTIME_RELAY_LOG === '1') console.log('[relay:in]', name); broadcastWechatEvent(name, args); },
    onExit,
    ...(CALL_TIMEOUT_MS === undefined ? {} : { callTimeoutMs: CALL_TIMEOUT_MS }),
    ...(LONG_CALL_TIMEOUT_MS === undefined ? {} : { longTimeoutMs: LONG_CALL_TIMEOUT_MS }),
  });
}

// ── 后端监管：有界退避重启 ───────────────────────────────────────────
// 原实现的后果（本会话实测复现）：后端进程一旦退出，之后所有调用都固定 reject
// 「Super Time 后端进程已退出」，功能整体失效、只能重启应用 —— 而进程退出本身可能只是
// 一次偶发（例如同步查询撞上数据变更）。这里补上有界重启。
const BACKEND_RESTART_MAX = 3;
const RESTART_BACKOFF_MS = [500, 1500, 4500];
/**
 * 调用等待后端就绪的上限。
 *
 * 要比「退避 + init」最长情况更宽（最坏 0.5+1.5+4.5s 退避 + 每次 init 若干秒），
 * 又要短到用户可接受 —— 所以就绪等待给 20 秒；后端已判定 failed 时立刻返回，不空等。
 */
const BACKEND_CALL_READY_WAIT_MS = 20_000;

/** 更新状态快照并广播，渲染端可同时靠事件与主动查询拿到它。 */
function setBackendStatus(state, lastError = null) {
  backendStatus = { state, restarts: backendRestartCount, lastError };
  broadcastWechatEvent('wechat-backend/status', [backendStatus]);
}

/**
 * 等后端就绪。
 *
 * 为什么需要它：后端启动被移到建窗之后（为了首帧与可视提示），于是窗口一挂载就
 * 可能发请求，此时后端还在 fork / import 783KB bundle / 解析数据根的路上。
 * 若不等待而是立刻回「后端未初始化」，首屏就会把一句**假的**错误显示给用户，
 * 而渲染端分不清「还没好」与「坏了」、不会重试（各面板只在
 * wechat-data/updated 时重载，没订阅的面板就一直错着）。
 * 因此在主进程侧把这些调用挂住，等到就绪或判定为失败为止。
 *
 * @param timeoutMs - 最长等待；超时按「未就绪」返回，不无限挂。
 * @returns 是否等到就绪。
 */
function awaitBackendReady(timeoutMs) {
  if (backendStatus.state === 'ready' && wechatBackend) return Promise.resolve(true);
  if (backendStatus.state === 'failed' || backendStopping) return Promise.resolve(false);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const done = (backendStatus.state === 'ready' && wechatBackend)
        ? true
        : (backendStatus.state === 'failed' || backendStopping || Date.now() - startedAt > timeoutMs)
          ? false
          : null;
      if (done === null) return;
      clearInterval(timer);
      if (done) console.log(`[wechat] 有调用等待后端就绪 ${Date.now() - startedAt}ms 后返回`);
      resolve(done);
    }, 100);
    if (timer.unref) timer.unref();
  });
}

/** 启动后端并完成 init，成功后写入 wechatBackend / wechatBoot。 */
async function startWechatBackend(userDataPath) {
  const handle = spawnBackendProcess(userDataPath, (code) => {
    // 只认「当前句柄」的退出：陈旧句柄的迟到 exit 不能动健康的新句柄，也不能再排一次重启。
    if (backendStopping || handle !== backendCurrentHandle) return;
    wechatBackend = null;
    wechatBoot = null;
    setBackendStatus('down', `后端进程已退出 (code=${code})`);
    scheduleBackendRestart(`进程退出 (code=${code})`);
  });
  backendCurrentHandle = handle;
  try {
    const boot = await handle.init();
    wechatBackend = handle;
    wechatBoot = boot;
    return handle;
  } catch (e) {
    // init 失败或超时：**必须杀掉刚拉起的子进程**。否则会漏一个仍在跑解密/同步的进程，
    // 而且下一次 start 直接覆盖句柄后它就彻底无人认领（既不退出也不再被监管）。
    if (handle === backendCurrentHandle) {
      try { handle.dispose(); } catch { /* 已退出 */ }
    }
    throw e;
  }
}

/**
 * 把「已保存的微信设置」回灌到后端（首次启动与每次重启后都要做）。
 *
 * **镜像里的密钥要并进同一次 patch**：这次保存返回前，`wechat-host.js` 会调
 * `recordWechatSettings(patch)` 把整份 `config.json.wechatSettings` **重写成**「已过滤密钥」的
 * 干净版（是替换不是合并）。只在镜像里出现过的密钥（后端 config.json 里没有对应值 →
 * `saveConfig` 的 `carried` 也捞不到）若不在这次 patch 里，就会被无声丢掉；并进来之后，
 * 后端把它们写进 `secrets.json`、回写镜像时又顺手把副本过滤掉 —— 迁移与「去掉多余副本」
 * 一步完成（所以不需要再单独写一个「清理镜像」的步骤）。
 */
async function applySavedWechatSettings() {
  const savedSettings = { ...loadWechatSettings(), ...mirroredSecretValues() };
  if (Object.keys(savedSettings).length === 0) return;
  const r = await wechatBackend.call('saveWechatConfig', [{ patch: savedSettings }]);
  if (!r.ok || r.value?.ok === false) {
    console.warn('[wechat] 应用 wechat/config.json 设置失败:', r.error || r.value?.error);
  }
}

/**
 * M1 启动期收尾：① 按后端解析出的**真实**数据根收紧权限；② 把还留在后端 `config.json` 里的
 * 旧密钥搬进 `secrets.json`。
 *
 * 为什么放在后端就绪之后：数据根可以由配置指向任意位置（`dataRoot` / legacy
 * `DSH_WECHAT_DECRYPTED_DIR`），启动早期拿不到真实值 —— 早先按 `<userData>/wechat-data`
 * 硬编码收紧，用户改了数据根就等于没有保护。
 *
 * 不用再「清理宿主镜像」：`applySavedWechatSettings` 那次保存返回时，`wechat-host.js` 已经
 * 把镜像重写成过滤掉密钥的干净版了（详见该函数的说明）。
 */
async function migrateSecretsAndTightenAcl() {
  const dataRoot = String(wechatBoot?.info?.root ?? '').trim();
  const backendConfigFile = dataRoot ? path.join(dataRoot, 'config.json') : '';
  const r = restrictWechatState({ stateDir: STATE_DIR, ...(dataRoot ? { dataRoot } : {}) });
  if (!r.ok) console.warn('[security] 密钥目录权限收紧未完全成功：' + r.failures.join('; '));

  // 启动期迁移：旧 config.json 里还有非空密钥就让后端走一次**空 patch 保存**
  // （saveConfig 会把它们搬进 secrets.json 并从 config.json 删掉；空 patch 不动其它字段）。
  try {
    if (!backendConfigFile || !fs.existsSync(backendConfigFile)) return;
    const raw = JSON.parse(fs.readFileSync(backendConfigFile, 'utf8'));
    const legacy = ['db_enc_key', 'image_aes_key', 'image_xor_key', 'api_token']
      .some((k) => (typeof raw?.[k] === 'string' ? raw[k] !== '' : raw?.[k] !== undefined));
    if (!legacy) return;
    const res = await wechatBackend.call('saveWechatConfig', [{ patch: {} }]);
    if (res.ok && res.value?.ok !== false) {
      console.log('[security] 已把旧 config.json 里的密钥迁移到 secrets.json');
    } else {
      console.warn('[security] 密钥迁移失败（下次保存会再试）:', res.error || res.value?.error);
    }
  } catch (e) {
    console.warn('[security] 密钥迁移失败（下次保存会再试）:', e);
  }
}

/**
 * 安排一次重启；超过上限则明确告知用户，不再无限重试。
 * @param reason - 最近一次失败原因，写进面向用户的提示与日志。
 */
function scheduleBackendRestart(reason) {
  if (backendStopping) return;
  // 同一故障可能同时走两条路径（退出回调 + init 失败的 catch），若各排一个定时器，
  // 就会在「后端已恢复」之后 4.5 秒再拉一个进程覆盖健康句柄，或在健康时误报
  // 「后端不可用」；而且有效重试次数会少于声明的 3 次。用单定时器挡住。
  if (backendRestartTimer) {
    console.warn(`[wechat] 已有重启计划在路上，忽略重复触发（原因：${reason}）`);
    return;
  }
  if (backendRestartCount >= BACKEND_RESTART_MAX) {
    const msg = `Super Time 后端连续 ${BACKEND_RESTART_MAX} 次重启失败，相关功能不可用。`
      + `请重启应用；若持续失败请检查 wechat/config.json 与数据目录。最近原因：${reason}`;
    console.error('[wechat]', msg);
    setBackendStatus('failed', msg);
    // 刻意**不用** dialog.showErrorBox：它是阻塞式模态，无人点击时会卡住主进程，
    // 连 app.quit() 都到不了（实测验证脚本因此挂死 5 分钟）。失败信息改由渲染端
    // 的状态横幅承载 —— 它常驻显示、可自动消失、也不挡任何东西。
    return;
  }
  const attempt = backendRestartCount;
  backendRestartCount += 1;
  setBackendStatus('restarting', reason);
  const delay = RESTART_BACKOFF_MS[attempt] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
  console.warn(`[wechat] 后端将在 ${delay}ms 后第 ${backendRestartCount}/${BACKEND_RESTART_MAX} 次重启（原因：${reason}）`);
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null;
    if (backendStopping) return;
    void (async () => {
      try {
        await startWechatBackend(backendUserDataPath);
      } catch (e) {
        // 走到这里才是「本次重启真的失败」。startWechatBackend 内部已经 dispose 了
        // 刚拉起的句柄，所以不会留下孤儿进程。
        const why = `重启后 init 失败：${e?.message ?? e}`;
        setBackendStatus('down', why);
        scheduleBackendRestart(why);
        return;
      }
      // 新进程是干净的，必须回灌已保存设置，否则密钥/路径全空。
      // 但**回灌失败不等于重启失败**：后端已经起来了。原先把它放在同一个 try 里，
      // 一旦 saveWechatConfig 超时（重启后 worker 立刻跑 2–3 分钟 realtime sync，
      // 单线程会被占住，60 秒窗口完全可能被吃满），就会走到「重启失败」分支 ——
      // 不 dispose 这个已经健康的句柄，而下一轮 start 又把 backendCurrentHandle
      // 覆盖掉，于是它彻底失管（还在解密/同步，退出事件还被身份校验主动忽略）。
      // 与首启路径保持一致：只 warn。
      try {
        await applySavedWechatSettings();
      } catch (e) {
        console.warn('[wechat] 重启后回灌设置失败（后端仍可用，不影响本次恢复）:', e?.message ?? e);
      }
      // 重启成功后也要跑一次 M1 收尾：`scheduleBackendRestart` 的路径不经过首启那段代码，
      // 如果首启的 init 失败、这次重启才成功，自定义数据根会一直不被收紧、旧密钥也不会迁移
      // （默认根有启动早期的预收紧兜住，自定义根没有）。与首启一致：失败只 warn。
      try {
        await migrateSecretsAndTightenAcl();
      } catch (e) {
        console.warn('[security] 重启后的密钥加固收尾失败:', e?.message ?? e);
      }
      backendRestartCount = 0;
      setBackendStatus('ready');
      console.log('[wechat] 后端已恢复，Remote 方法数:', wechatBoot?.methods?.length ?? 0);
    })();
  }, delay);
  if (backendRestartTimer.unref) backendRestartTimer.unref();
}

/** 建窗口与装守卫需要的上下文（本体在 `src/backend/main-window.js`，行为逐字未改）。 */
const windowCtx = { app, BrowserWindow, screen, fs, path, rootDir: __dirname, env: process.env };
const guardsCtx = { shell, rootDir: __dirname, decideNavigation, decideWindowOpen, counters: securityCounters };

/** 向所有窗口转发后端事件（本体已外提，这里只保留 main.js 内的调用点形状）。 */
function broadcastWechatEvent(name, args) {
  broadcastToWindows(windowCtx, 'wechat:event', { name, args });
  // 同一份事件也要发给手机浏览器（SSE）。payload 形状与 `wechat:event` 完全一致，
  // 所以渲染层那套「事件名 → DOM CustomEvent」的分发逻辑两边共用、一字不改 ——
  // WAL 实时刷新链（`wechat-data/updated`）在手机上因此与桌面端同样即时。
  if (remoteAccess) remoteAccess.pushEvent(name, args);
}

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
  // 诊断日志（M6）：界面上的「导出诊断日志」走这三个。
  // 正常情况下日志落在 STATE_DIR/logs，用户报障时把它交出来即可。
  registerMiscIpc({
    ipcMain, app, dialog, shell, path, fs, diagLog, STATE_DIR, APP_VERSION, debugGates, licenseService,
    clipboard, getMainWindow: () => mainWindow, buildDiagnosticPreview, buildDiagnosticReport, installWebContentsGuards,
  });

  // —— Super Time 后端相关的 IPC ——
  // 处理器全部在这里注册（都在 createWindow() 之前），后端进程本身在
  // createWindow() 之后才启动，理由见那一处注释。
  // 这份 ctx 同时喂两处：IPC 的 `wechat:call` 与 HTTP 的 `POST /api/wechat/call`。
  // 两条路都经 `gatedWechatCall(ctx, …)`（call-gates.js），闸门只有一份实现 ——
  // 分开写的话，最可能的漂法是 HTTP 那份少抄 catch，于是许可校验一抛异常就变成放行。
  const gateCtx = {
    ipcMain, app, licenseService, debugGates, awaitBackendReady, findModelCatalog, APP_VERSION,
    getWechatBackend: () => wechatBackend, getWechatBoot: () => wechatBoot, getBackendStatus: () => backendStatus,
    BACKEND_CALL_READY_WAIT_MS, loadLlmConfig, saveLlmConfig, loadLlmStore, upsertLlmProfile, activateLlmProfile, deleteLlmProfile,
  };
  registerWechatIpc(gateCtx);

  // —— 局域网远程访问（手机端）——
  // 这里只**创建**，不启动：启动排在后端就绪之后（见 setBackendStatus('ready') 那一处），
  // 因为数据根要等后端解析出来才知道，而配置与令牌都住在数据根下。
  // 静态资源服务的就是 Electron 自己 loadFile 的同一份产物（`src/client/ui-dist`），
  // 所以手机与桌面加载的是同一个构建，不存在「手机版另一套代码」。
  remoteAccess = createRemoteAccessServer({
    getDataRoot: () => String(wechatBoot?.info?.root ?? ''),
    getUiDistDir: () => path.join(__dirname, 'src', 'client', 'ui-dist'),
    gatedCall: (method, args) => gatedWechatCall(gateCtx, method, args),
    appVersion: APP_VERSION,
  });
  // 界面改完「远程访问」设置后立即生效（不等 60s 的兜底复查）。
  ipcMain.handle('remote-access:state', () => ({ ok: true, value: remoteAccess.getState() }));
  ipcMain.handle('remote-access:apply', async () => {
    try {
      return { ok: true, value: await remoteAccess.syncWithConfig() };
    } catch (e) {
      return { ok: false, error: { message: e?.message ?? String(e) } };
    }
  });
  // 开关与令牌轮换：写配置一律走后端的 saveWechatConfig（它负责原子写、写前备份、
  // 以及把 api_token 这类密钥字段分流进 secrets.json 并收紧 ACL）。
  const raControl = createRemoteAccessControl({
    backendCall: (method, args) => gatedWechatCall(gateCtx, method, args),
    remoteAccess,
  });
  ipcMain.handle('remote-access:rotate', async () => {
    try {
      const r = await raControl.rotate();
      return r.ok ? { ok: true, value: r } : { ok: false, error: { message: r.error } };
    } catch (e) {
      return { ok: false, error: { message: e?.message ?? String(e) } };
    }
  });
  ipcMain.handle('remote-access:toggle', async (_e, enabled) => {
    try {
      const r = await raControl.setEnabled(enabled === true);
      return r.ok ? { ok: true, value: r.state } : { ok: false, error: { message: r.error } };
    } catch (e) {
      return { ok: false, error: { message: e?.message ?? String(e) } };
    }
  });

  // ── 自动更新（electron-updater + GitHub Releases）──────────────────────
  // 三个通道 + 一条广播：
  //   update:state   —— 渲染层挂载时补一次状态（可能已经错过早先的事件，同 wechat:backend-state）
  //   update:check   —— 用户手动触发；自动检查由 scheduleAutoCheck 排在启动 30s 后
  //   update:install —— 重启并安装已下载的更新
  //   update:skip    —— W2-12.2：跳过某个版本（空串 = 取消跳过）
  //   update:retry   —— W2-12.2：手动重试下载（**不受**自动重试的次数上限约束）
  //   update:event   —— 主进程 → 渲染层的状态推送（含下载进度）
  // 更新源与安装包同源（build.publish → 打包时写进 resources/app-update.yml），
  // 状态机与各事件的收敛规则见 src/backend/update.js。
  updateService = createUpdateServiceSafe();
  // 一行正向留痕。没有它的话，日志里只有「加载失败」这一种证据 —— 用户报障说
  // 「升不了级」时，我们无法区分「服务就绪但检查失败」与「整个模块没装进包」。
  // package:smoke / 诊断日志导出都会带上这一行。
  console.log('[update] 更新服务已就绪 supported=%s current=%s',
    updateService.isSupported(), APP_VERSION);
  ipcMain.handle('update:state', () => ({ ok: true, value: updateService.getState() }));
  ipcMain.handle('update:check', async (_event, opts) => {
    try {
      // 只收 `manual` 这一个布尔：渲染层决定不了「要不要真的出网」—— 那只由主进程的
      // 打包态判定与环境变量决定（见 update.js 的 isSupported）。
      const next = await updateService.check({ manual: !!(opts && opts.manual === true) });
      return { ok: true, value: next };
    } catch (err) {
      return { ok: false, error: { message: err?.message || String(err) } };
    }
  });
  ipcMain.handle('update:install', () => {
    const r = updateService.install();
    return r.ok ? { ok: true } : { ok: false, error: { message: r.error } };
  });
  /**
   * W2-12.2：跳过某个版本 / 手动重试下载。
   *
   * 与 `update:check` 同一条纪律：渲染层只传「跳哪个版本号」这一个字符串，
   * **不参与**任何「要不要出网」的判定。`skipVersion` 传空串就是取消跳过（可反悔）。
   */
  ipcMain.handle('update:skip', (_event, version) => {
    try {
      const v = typeof version === 'string' ? version : '';
      return { ok: true, value: updateService.skipVersion(v) };
    } catch (err) {
      return { ok: false, error: { message: err?.message || String(err) } };
    }
  });
  ipcMain.handle('update:retry', async () => {
    try {
      const next = await updateService.retryDownload();
      return { ok: true, value: next };
    } catch (err) {
      return { ok: false, error: { message: err?.message || String(err) } };
    }
  });

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
    // 若 wechat/config.json 中已有保存过的微信设置，启动时回写后端
    // （密钥类字段会被一并交给后端写进 secrets.json，而不是回放成镜像副本）。
    try {
      await applySavedWechatSettings();
    } catch (e) {
      console.warn('[wechat] 应用 wechat/config.json 设置失败:', e);
    }
    // M1 启动期收尾：按**真实**数据根收紧权限 + 把旧 config.json 里的密钥迁走。
    try {
      await migrateSecretsAndTightenAcl();
    } catch (e) {
      console.warn('[security] 密钥加固收尾失败:', e);
    }
    backendRestartCount = 0;
    setBackendStatus('ready');
    console.log('[wechat] Super Time 后端已就绪，Remote 方法数:', wechatBoot.methods.length);
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
  } catch (err) {
    console.error('[wechat] Super Time 后端初始化失败:', err);
    // 初始化失败也交给监管器重试 —— 这是最该自愈的一类失败：
    // 首次启动时数据可能正在解密、数据根尚未就绪，等一会儿再拉一次往往就成功。
    // 不用阻塞式对话框，失败信息走渲染端横幅（见 setBackendStatus 的说明）。
    setBackendStatus('down', `初始化失败：${err?.message ?? err}`);
    scheduleBackendRestart(`初始化失败：${err?.message ?? err}`);
  }

  // 自动更新（延迟 30s，见 update.js）：刻意放在后端 try/catch **之外** —— 更新能不能
  // 检查跟后端起没起来无关，后端初始化失败时更该让用户有机会升到修好的版本。
  // 排在建窗与后端之后是为了不与启动期抢带宽/事件循环。
  updateService.scheduleAutoCheck();

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

  // 安全守卫的端到端探针已挪到 createWindow() 之后（见那处注释）：
  // did-finish-load 会在后端 init 的 await 期间触发，注册晚了就永远等不到。

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // 先置停止标记：kill 会触发 exit 回调，不置标记就会安排一次无意义的重启。
  backendStopping = true;
  if (backendRestartTimer) { clearTimeout(backendRestartTimer); backendRestartTimer = null; }
  // 远程访问先停：它是唯一**对外**的入口，退出时应当立刻不再接受连接（而不是等进程销毁
  // socket）。stop() 是异步的，这里不 await —— 退出路径上不能挂住，端口随进程一起释放。
  if (remoteAccess) { void remoteAccess.stop(); remoteAccess = null; }
  if (wechatBackend) {
    try {
      wechatBackend.dispose();
    } catch {
      /* 退出时尽力释放 */
    }
  }
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
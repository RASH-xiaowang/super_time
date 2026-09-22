// 必须最先执行：终端/父进程退出后 stdout 管道会关闭，之后任何 console.log 都会
// 触发 EPIPE 并被 Node 当未捕获异常抛出，主进程弹出致命框（详见模块注释）。
// 必须最先执行：终端/父进程退出后 stdout 管道会关闭，之后任何 console.log 都会
// 触发 EPIPE 并被 Node 当未捕获异常抛出，主进程弹出致命框（详见模块注释）。
// SUPERTIME_NO_CONSOLE_GUARD=1 仅供 scripts/epipe-smoke.js 做负对照用。
if (process.env.SUPERTIME_NO_CONSOLE_GUARD !== '1') require('./src/backend/console-safe').install();

const { app, BrowserWindow, ipcMain, dialog, screen, shell, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { decideNavigation, decideWindowOpen } = require('./src/backend/navigation-policy');

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

/** 交给系统浏览器打开的次数（仅供安全探针断言；正常流程里是「用户点了外链」的计数）。 */
let openExternalAttempts = 0;
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
const { buildDiagnosticReport, createDiagLog, installConsoleCapture } = require('./src/backend/diag-log');
const { restrictWechatState } = require('./src/backend/secure-fs');
const { resolveDebugGates, resolveHangMethods, HANG_ENV: DEBUG_HANG_ENV } = require('./src/backend/debug-gates');
const { createUpdateService } = require('./src/backend/update');
const { registerMiscIpc } = require('./src/backend/ipc-misc');

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
    onEvent: (name, args) => broadcastWechatEvent(name, args),
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

/** Super Time 前端构建产物（npm run build:ui 生成）；缺失时回退到演示页。 */
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

/**
 * 更新状态广播（`update:event`）。
 *
 * 与 `wechat:event` 同一套做法：主进程是唯一的事实来源，渲染层只是投影。
 * 进度类事件在 update.js 里已按 1% 阶梯节流，这里不再二次过滤。
 */
function broadcastUpdateState(state) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('update:event', state);
    } catch {
      /* 窗口可能已销毁，忽略 */
    }
  }
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
  /**
   * 窗口图标。**打包态这个路径不存在**（`build/` 是 electron-builder 的 buildResources，
   * 不在 `files` 白名单里），于是 `icon` 为 undefined，Windows 会退回用 exe 内嵌的图标 ——
   * 而那个图标就是同一份 `build/icon.ico`（`win.icon` 会在打包时烘进 exe；实测取出两者
   * 的 32×32 帧是同一张图）。即 dev 与打包态的窗口/任务栏图标一致，**不存在「打包版没图标」**。
   *
   * 所以别把 `build/` 加进 `files`：那会白带一份 83KB，并把图标改成走
   * `nativeImage.createFromPath` 读 asar 内的 .ico（打包态未验证的路径），收益为零。
   * 相关取证见 docs/RELEASE-PLAN.md 的 M19。
   */
  const appIcon = path.join(__dirname, 'build', 'icon.ico');
  // 启动尺寸取固定基准 1440×900，再按主屏工作区收敛：写死一个较大的尺寸时
  // （历史上是 1664×1066），1366×768 或 1080p@125% 的机器上窗口会比屏幕还大
  // （审计 P0-2）。窗口本身始终可缩放，下限取实测能容下
  // 「会话列表 + 消息区 + 群聊信息抽屉」三列的值。
  const MIN_W = 960;
  const MIN_H = 640;
  const BASE_W = 1440;
  const BASE_H = 900;
  const work = screen.getPrimaryDisplay().workAreaSize;
  const initialWidth = Math.max(MIN_W, Math.min(BASE_W, work.width));
  const initialHeight = Math.max(MIN_H, Math.min(BASE_H, work.height));
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
    title: 'Super Time',
    icon: fs.existsSync(appIcon) ? appIcon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true —— 渲染进程只经 preload 暴露的 contextBridge 说话，
      // 而 preload.js 只 require('electron')（沙箱下允许），因此可以直接开。
      // 开着的意义：渲染进程即使是 XSS 也在 OS 级沙箱里，拿不到 Node 原语。
      // 回归由 scripts/packaged-smoke.js 兜（它会真的启动打包产物断言后端就绪+出图）。
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true
    }
  });

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
}

/**
 * 给每个 webContents 装导航 / 开窗守卫。
 *
 * 渲染的是**聊天与朋友圈内容**，即不可信输入 —— 所以这里默认拒绝：
 *   · 新窗口一律不开（`action:'deny'`），只有 http(s) 才交给系统浏览器
 *     （`file:` 能直接拉起本地可执行文件，`smb:`/UNC 会带着凭据外连）；
 *   · 页面导航只允许应用自己的 `file:` 页面（本应用是单页，正常不会导航）；
 *   · 不允许挂 `<webview>`（本应用不用它）。
 * 用 `app.on('web-contents-created')` 统一安装，而不是只在主窗口上挂一遍 ——
 * 否则将来任何新建的 webContents（预览窗、开发者工具）都绕过了守卫。
 * 判定逻辑在 `src/backend/navigation-policy.js`，有单测覆盖（含默认拒绝）。
 * @param {Electron.WebContents} contents - 新建的 webContents。
 */
function installWebContentsGuards(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (decideWindowOpen(url) === 'external') {
      openExternalAttempts += 1;
      // 系统没有对应处理程序时 openExternal 会 reject —— 不接住就是未处理拒绝。
      shell.openExternal(url).catch((e) => {
        console.warn('[security] 交给系统打开失败：' + String(e && e.message ? e.message : e));
      });
    } else {
      console.warn('[security] 已拒绝打开外部链接：' + String(url));
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (decideNavigation(url, __dirname) === 'allow') return;
    event.preventDefault();
    console.warn('[security] 已阻止页面导航：' + String(url));
  });
  // will-redirect 是**独立事件**：主框架的 HTTP 重定向只走它（实测 will-navigate 拦下
  // 第一步后它就不会触发，所以当前只是「单点依赖」—— 一旦 decideNavigation 放宽，
  // 重定向立刻成为绕过路径）。判定函数是现成的，这里补上零成本。
  contents.on('will-redirect', (event, url) => {
    if (decideNavigation(url, __dirname) === 'allow') return;
    event.preventDefault();
    console.warn('[security] 已阻止重定向：' + String(url));
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    console.warn('[security] 已阻止挂载 webview');
  });
}

app.whenReady().then(async () => {
  // 未获单实例锁的重复实例不做任何初始化（app.quit 已在上面调用）。
  if (!singleInstanceLock) return;
  // 诊断日志（M6）：界面上的「导出诊断日志」走这三个。
  // 正常情况下日志落在 STATE_DIR/logs，用户报障时把它交出来即可。
  registerMiscIpc({
    ipcMain, app, dialog, shell, path, fs, diagLog, STATE_DIR, APP_VERSION, debugGates, licenseService,
    getMainWindow: () => mainWindow,
    buildDiagnosticReport,
  });

  // —— Super Time 后端相关的 IPC ——
  // 处理器全部在这里注册（都在 createWindow() 之前），后端进程本身在
  // createWindow() 之后才启动，理由见那一处注释。
  ipcMain.handle('wechat:list-methods', () => {
    if (!wechatBoot) return { ok: false, error: { message: 'Super Time 后端未初始化' } };
    return { ok: true, value: wechatBoot.methods };
  });

  ipcMain.handle('wechat:info', () => {
    if (!wechatBoot) return { ok: false, error: { message: 'Super Time 后端未初始化' } };
    return { ok: true, value: wechatBoot.info };
  });

  ipcMain.handle('wechat:call', async (_event, method, args) => {
    // 后端还在启动/重启时**等待**，而不是立刻回一句假错误（见 awaitBackendReady）。
    const ready = await awaitBackendReady(BACKEND_CALL_READY_WAIT_MS);
    if (!ready || !wechatBackend) {
      return {
        ok: false,
        error: {
          message: backendStatus.lastError
            ? `Super Time 后端暂不可用：${backendStatus.lastError}`
            : 'Super Time 后端仍在启动中，请稍候重试',
          code: 'BACKEND_NOT_READY',
          details: { method, state: backendStatus.state },
        },
      };
    }
    // N2：调试闸门豁免。放开的是「授权」这道闸门 —— 验收脚本要用真实后端跑 UI 全链路，
    // 而它拿不到厂商签发的许可证。条件来自主进程的 `debugGates()`（打包态恒不成立）、
    // **不**接受渲染层传来的任何参数，且必须放在下面的 `authorizeCall` 之前。
    // 放在 `try` 之外是刻意的：`wechatBackend.call` 同步抛错时不该被误报成「许可校验失败」。
    if (debugGates().skipGates) {
      console.warn('[debug-gates] 已跳过许可证校验（method=%s）', method);
      return wechatBackend.call(method, args);
    }
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


  /**
   * 后端状态快照。
   *
   * 之所以要有主动查询：渲染端订阅事件是在模块加载时注册的，而首启期间
   * 后端可能先于订阅就报出 down/ready/failed —— 那些事件会丢失。
   * 界面挂载后用这个接口补一次状态，才能保证「该提示的一定提示到」。
   */
  ipcMain.handle('wechat:backend-state', () => ({ ok: true, value: { ...backendStatus } }));

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
  /**
   * 已保存的模型配置集（profiles）。
   *
   * 为什么与 `wechat:llm-save` 分成两条通道：切换是**一次轻动作**（改 activeProfileId +
   * 把该套字段摊平到顶层，一个原子写），而 llm-save 走的是「提交整个表单」。
   * 混在一起会逼着界面为了「换个模型」先构造一份完整表单 —— 那正是「切换要点两次、
   * 还容易把别家 Key 一起提交」的老毛病。
   *
   * op：list / activate / save / delete（未识别的 op 明确报错，不静默当 list）。
   */
  ipcMain.handle('wechat:llm-profiles', (_event, opts = {}) => {
    try {
      const op = String((opts && opts.op) || 'list');
      if (op === 'list') return { ok: true, value: loadLlmStore() };
      if (op === 'activate') return { ok: true, value: activateLlmProfile(String((opts && opts.id) || '')) };
      if (op === 'save') return { ok: true, value: upsertLlmProfile(opts || {}) };
      if (op === 'delete') return { ok: true, value: deleteLlmProfile(String((opts && opts.id) || '')) };
      return { ok: false, error: { message: `未知的模型配置操作：${op}` } };
    } catch (e) {
      return { ok: false, error: { message: e && e.message ? e.message : String(e) } };
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

  // ── 自动更新（electron-updater + GitHub Releases）──────────────────────
  // 三个通道 + 一条广播：
  //   update:state   —— 渲染层挂载时补一次状态（可能已经错过早先的事件，同 wechat:backend-state）
  //   update:check   —— 用户手动触发；自动检查由 scheduleAutoCheck 排在启动 30s 后
  //   update:install —— 重启并安装已下载的更新
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
          openExternalAttempts: 0, urlBefore, urlAfter: null, navigated: null,
        };
        // 每个动作**单独** evaluate 并带超时：守卫一旦失效，导航会把 frame 带走，
        // 而 `executeJavaScript` 在 frame 销毁后不再 settle —— 不设超时的话探针会
        // 永远打不出结果，失效只能表现为「无输出 + 冒烟等到 kill 超时」（评审实测）。
        const evaluate = async (js, ms = 4000) => {
          let timer;
          try {
            return await Promise.race([
              mainWindow.webContents.executeJavaScript(js),
              new Promise((resolve) => { timer = setTimeout(() => resolve('__timeout__'), ms); }),
            ]);
          } catch (e) {
            return '__error__:' + (e && e.message ? e.message : String(e));
          } finally {
            if (timer) clearTimeout(timer);
          }
        };

        // ① 沙箱是否真的生效（行为事实，不靠日志）
        probe.sandbox = await evaluate(
          '({ require: typeof require, process: typeof process, buffer: typeof Buffer,'
          + ' electronAPIKeys: Object.keys(window.electronAPI || {}).length })',
        );
        // ② 三类被禁协议的新窗口（逐条判定，避免一条挂住拖垮全部）
        for (const u of ['file:///C:/Windows/System32/calc.exe', 'smb://attacker/share', 'ms-msdt:/id']) {
          const opened = await evaluate(`window.open(${JSON.stringify(u)}) === null ? 'null' : 'window'`);
          probe.opened.push({ url: u, result: opened });
        }
        // ③ 外部导航
        probe.navAttempt = await evaluate("(() => { window.location.href = 'https://example.com/'; return 'attempted' })()");
        probe.openExternalAttempts = openExternalAttempts;
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
'use strict';

/**
 * 应用自动更新（electron-updater + GitHub Releases）。
 *
 * ## 链路
 *
 * ```
 * 安装版启动 → 延迟 30s autoUpdater.checkForUpdates()
 *   → 读 Releases 上的 latest.yml，与本机版本比对
 *   → 有新版本：后台自动下载（autoDownload）
 *   → 下载完成：退出应用时自动装（autoInstallOnAppQuit）
 *              用户也可以在「设置 → 软件更新」点「重启并安装」
 * ```
 *
 * ## 为什么用 electron-updater 而不是自己比版本号
 *
 * 它读的是 electron-builder **打包时**写进 `resources/app-update.yml` 的 feed 配置
 * （与安装包出自同一份 `build.publish`，两边不会各自漂移）。版本比对、增量下载、
 * 静默安装、安装后重启都是它做掉的。自己拿 GitHub API 比对版本号只能做到
 * 「提示有新版本」，**装不了** —— 用户仍要自己去 Releases 下载并手工覆盖安装。
 *
 * ## 为什么 autoUpdater 由调用方注入
 *
 * 真的 `autoUpdater` 需要 Electron 运行时**且**打包产物里的 `app-update.yml` 才肯工作，
 * 单测跑不起来。所以这里只做「事件 → 状态」的收敛与推送，`autoUpdater` 由 main.js
 * 注入；测试喂一个假 EventEmitter 即可覆盖全部状态迁移（见 tests/update.spec.ts）。
 *
 * ## 日志前缀的归属
 *
 * 本模块打出去的每一行都**不带** `[update]` 前缀，前缀由注入的 `log` 统一加
 * （main.js 的适配器负责）。原因是同一个适配器还要转发 electron-updater 自己的
 * 消息（那些消息没有前缀），只有在这里不加、在适配器加，两路才都能得到恰好一个前缀。
 *
 * ## 为什么必须判 `isPackaged`
 *
 * 未打包时 electron-updater 找不到 `app-update.yml` 会抛
 * `ENOENT ... app-update.yml`；而且开发态本来就不该去拉线上的更新。
 * 这里把「不支持」也当成一个**正常状态**回给界面（`reason: 'dev'`），
 * 界面据此显示「开发态不检查更新」而不是一条吓人的报错。
 *
 * @module update
 */

/** 自动检查的延迟：等窗口画完、后端就绪再出网，不与启动期抢带宽与事件循环。 */
const DEFAULT_AUTO_CHECK_DELAY_MS = 30 * 1000;

/** Release 说明的展示上限：GitHub Release 的 body 可以很长，整段过 IPC 没有意义。 */
const MAX_RELEASE_NOTES_CHARS = 2000;

/**
 * 下载进度的推送阶梯（百分点）。
 *
 * `download-progress` 每秒可触发几十次；逐条转发会把 IPC 打满，而界面上 0.3% 的
 * 抖动本来也看不见。只推「整数百分比变了」的那些帧 —— 一次下载最多 100 条消息。
 * 阶段切换**必须**推（否则界面停在「正在下载」那一格不动）。
 */
const PROGRESS_STEP_PERCENT = 1;

/**
 * 显式关闭自动检查的环境变量（值为 `'1'`）。
 *
 * 给自动化用：打包冒烟（packaged-smoke）会启动**真实安装版**，若它每次都去 GitHub
 * 拉一次 latest.yml，CI 就多了一个会因网络抖动的失败点。这类脚本显式设 `=1`。
 */
const DISABLE_UPDATE_CHECK_ENV = 'SUPERTIME_DISABLE_UPDATE_CHECK';

/** 空状态。`currentVersion` 由调用方给（main.js 取的是打包的 version）。 */
function blankUpdateState(currentVersion) {
  return {
    phase: 'idle',
    currentVersion: typeof currentVersion === 'string' && currentVersion ? currentVersion : null,
    version: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    progress: null,
    error: null,
    reason: null,
    checkedAt: null,
    manual: false,
  };
}

/**
 * Release 说明归一化。electron-updater 对 GitHub provider 给的是字符串，
 * 对多版本差分的 provider 给的是 `{ version, note }[]` —— 两种都收进来。
 * @param {unknown} notes
 * @returns {string|null}
 */
function normalizeReleaseNotes(notes) {
  let text = null;
  if (typeof notes === 'string') {
    text = notes;
  } else if (Array.isArray(notes)) {
    const parts = notes
      .map((n) => {
        if (typeof n === 'string') return n;
        if (n && typeof n === 'object' && typeof n.note === 'string') {
          return n.version ? `v${n.version}\n${n.note}` : n.note;
        }
        return '';
      })
      .filter(Boolean);
    text = parts.length ? parts.join('\n\n') : null;
  }
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_RELEASE_NOTES_CHARS
    ? `${trimmed.slice(0, MAX_RELEASE_NOTES_CHARS)}…`
    : trimmed;
}

/** 进度归一化：`percent` 夹到 [0,100]，其余数值字段非有限数一律置 null（界面据此决定显示什么）。 */
function normalizeProgress(p) {
  const src = p && typeof p === 'object' ? p : {};
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const rawPercent = Number.isFinite(src.percent) ? src.percent : 0;
  return {
    percent: Math.max(0, Math.min(100, rawPercent)),
    transferred: num(src.transferred),
    total: num(src.total),
    bytesPerSecond: num(src.bytesPerSecond),
  };
}

/**
 * 把一条 electron-updater 事件收敛成新状态（纯函数，可脱离 Electron 测试）。
 *
 * @param {ReturnType<typeof blankUpdateState>} state 当前状态。
 * @param {{ type: string, info?: any, progress?: any, error?: unknown, reason?: string, manual?: boolean, at?: string }} event
 * @returns {ReturnType<typeof blankUpdateState>} 新状态（不修改入参）。
 */
function applyUpdateEvent(state, event) {
  const e = event || {};
  const at = typeof e.at === 'string' ? e.at : new Date().toISOString();
  const info = e.info && typeof e.info === 'object' ? e.info : {};
  const version = typeof info.version === 'string' && info.version ? info.version : null;

  switch (e.type) {
    case 'unsupported':
      return { ...state, phase: 'unsupported', reason: e.reason || 'unknown', progress: null, error: null };

    case 'checking':
      return { ...state, phase: 'checking', manual: e.manual === true, progress: null, error: null, reason: null, checkedAt: at };

    case 'available':
      return {
        ...state,
        phase: 'available',
        version,
        releaseName: typeof info.releaseName === 'string' && info.releaseName ? info.releaseName : null,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: typeof info.releaseDate === 'string' && info.releaseDate ? info.releaseDate : null,
        progress: null,
        error: null,
        reason: null,
        checkedAt: at,
      };

    case 'not-available':
      // 明确的「已是最新」：版本/说明全部清空，避免界面上留着上一次检查的版本号。
      return {
        ...state,
        phase: 'up-to-date',
        version: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        progress: null,
        error: null,
        reason: null,
        checkedAt: at,
      };

    case 'progress':
      return { ...state, phase: 'downloading', progress: normalizeProgress(e.progress), error: null };

    case 'downloaded':
      return {
        ...state,
        phase: 'downloaded',
        version: version || state.version,
        releaseName: typeof info.releaseName === 'string' && info.releaseName ? info.releaseName : state.releaseName,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes) || state.releaseNotes,
        progress: { percent: 100, transferred: null, total: null, bytesPerSecond: null },
        error: null,
        checkedAt: at,
      };

    case 'error':
      return { ...state, phase: 'error', error: describeUpdateError(e.error), progress: null, checkedAt: at };

    default:
      return state;
  }
}

/**
 * 把 electron-updater 抛出的原始错误翻成一句能指导动作的话。
 *
 * 这几类错在部署现场各有各的成因，而原始 message 全是英文技术串
 * （`ENOENT ... app-update.yml`、`HttpError: 404`）—— 直接丢给用户等于没说。
 * @param {unknown} err
 * @returns {string}
 */
function describeUpdateError(err) {
  const raw = err instanceof Error ? err.message : String(err == null ? '' : err);
  const msg = raw || '未知错误';
  if (/app-update\.yml/i.test(msg)) {
    return '安装包里缺少更新配置（app-update.yml）：打包时没有配置发布源（build.publish）';
  }
  if (/404|Not Found/i.test(msg)) {
    return '更新源返回 404：请确认 Releases 里已经发布过带 latest.yml 的正式版本';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|network/i.test(msg)) {
    return `网络不可达，无法检查更新（${msg}）`;
  }
  if (/sha512|checksum|integrity/i.test(msg)) {
    return `安装包校验失败，可能下载不完整，请重试（${msg}）`;
  }
  return msg;
}

/** 日志适配：diagLog 只有 `write(level, args)`，而 electron-updater 要 info/warn/error/debug 四个方法。 */
function toUpdaterLogger(log) {
  const at = (level) => (...args) => {
    try {
      log(level, args);
    } catch {
      /* 日志自己绝不向上抛 */
    }
  };
  return {
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    // 刻意不转发 debug：electron-updater 在 debug 级打的是 provider 内部请求细节与
    // 逐条下载进度，量级足以把 2MB×3 的诊断日志淹掉，反而盖住真正有用的行。
    debug: () => {},
  };
}

/**
 * 建一个更新服务。
 *
 * @param {{
 *   autoUpdater: any,                       electron-updater 的 autoUpdater（测试可注入假的）
 *   isPackaged: boolean,                    Electron 的 app.isPackaged
 *   currentVersion?: string,                当前版本（展示用）
 *   log?: (level: string, args: unknown[]) => void,
 *   onState?: (state: object) => void,      状态每次变化时回调（main.js 用它广播给渲染进程）
 *   env?: Record<string, string | undefined>,
 *   autoCheckDelayMs?: number,
 * }} opts
 * @returns {{
 *   getState: () => object,
 *   isSupported: () => boolean,
 *   check: (o?: { manual?: boolean }) => Promise<object>,
 *   install: () => { ok: boolean, error?: string },
 *   scheduleAutoCheck: () => void,
 *   dispose: () => void,
 * }} 更新服务。
 */
function createUpdateService(opts = {}) {
  const autoUpdater = opts.autoUpdater;
  const isPackaged = opts.isPackaged === true;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};
  const env = opts.env || process.env;
  const delayMs = Number.isFinite(opts.autoCheckDelayMs) && opts.autoCheckDelayMs >= 0
    ? opts.autoCheckDelayMs
    : DEFAULT_AUTO_CHECK_DELAY_MS;

  let state = blankUpdateState(opts.currentVersion);
  let timer = null;
  let disposed = false;
  /** 上一次推给界面的整数百分比；-1 表示「本轮的阶梯还没开始」。 */
  let lastEmittedPercent = -1;
  /** 已注册的监听器，dispose 时逐个摘掉（测试里会反复建服务）。 */
  const wired = [];

  const commit = (event) => {
    state = applyUpdateEvent(state, event);
    try {
      onState(state);
    } catch (err) {
      log('warn', ['状态回调抛错', err]);
    }
    return state;
  };

  /**
   * 进度专用提交：按 1% 阶梯节流（阶段切换必推，见 PROGRESS_STEP_PERCENT 的说明）。
   */
  const commitProgress = (progress) => {
    const prevPhase = state.phase;
    state = applyUpdateEvent(state, { type: 'progress', progress });
    const pct = Math.floor((state.progress && state.progress.percent) || 0);
    if (prevPhase !== state.phase || pct !== lastEmittedPercent) {
      lastEmittedPercent = pct;
      try {
        onState(state);
      } catch (err) {
        log('warn', ['状态回调抛错', err]);
      }
    }
  };

  const disabledByEnv = () => String(env[DISABLE_UPDATE_CHECK_ENV] ?? '') === '1';
  // autoUpdater 缺失 = main.js 那边 require('electron-updater') 失败了（打包产物缺依赖等）。
  // 也算「不支持」，且必须能和「开发态」区分开：前者是发布事故，后者是正常现象。
  const isSupported = () => isPackaged && !disabledByEnv() && !!autoUpdater;

  /** 不支持的原因码，`unsupported` 状态与界面文案一一对应。 */
  const unsupportedReason = () => {
    if (!isPackaged) return 'dev';
    if (disabledByEnv()) return 'disabled';
    if (!autoUpdater) return 'unavailable';
    return 'unknown';
  };

  if (autoUpdater) {
    // autoDownload：发现新版本就后台拉，不等用户点（本轮选定的行为）。
    // autoInstallOnAppQuit：拉完不打断用户，退出时自动装 —— 装完下次启动就是新版。
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = toUpdaterLogger(log);

    const wire = (name, handler) => {
      autoUpdater.on(name, handler);
      wired.push([name, handler]);
    };
    wire('checking-for-update', () => {
      lastEmittedPercent = -1;
      // `manual` 由调用 check() 的那一方决定；electron-updater 开始拉取时自己也会发
      // 一次这个事件，这里只做幂等重申，不能把用户手动触发的标记冲掉。
      commit({ type: 'checking', manual: state.manual === true });
    });
    wire('update-available', (info) => {
      lastEmittedPercent = -1;
      commit({ type: 'available', info });
    });
    wire('update-not-available', (info) => commit({ type: 'not-available', info }));
    wire('download-progress', (progress) => commitProgress(progress));
    wire('update-downloaded', (info) => commit({ type: 'downloaded', info }));
    wire('error', (err) => commit({ type: 'error', error: err }));
  }

  const service = {
    getState: () => state,
    isSupported,

    /**
     * 检查更新。
     *
     * 去重是必要的：`checkForUpdates` 在「正在检查」或「正在下载」时再调一次会让
     * electron-updater 并发跑两条下载，最后写出一个损坏的安装包。
     * @param {{ manual?: boolean }} [o] `manual` 仅用于让界面区分「用户点的」与「自动的」。
     * @returns {Promise<object>} 调用后的状态（不等待下载完成）。
     */
    async check(o = {}) {
      if (!isSupported()) return commit({ type: 'unsupported', reason: unsupportedReason() });
      if (state.phase === 'checking' || state.phase === 'downloading') return state;

      commit({ type: 'checking', manual: o.manual === true });
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        // 正常情况下 'error' 事件已经把它记过一次了；这里只兜「没发事件就直接 reject」的路径。
        if (state.phase !== 'error') commit({ type: 'error', error: err });
      }
      return state;
    },

    /**
     * 重启并安装已下载的更新。
     *
     * 只在 `downloaded` 阶段成立 —— 其它阶段调用 `quitAndInstall` 会让 electron-updater
     * 在没得装的情况下把应用关掉（用户视角就是「点了按钮应用自己退了，什么都没发生」）。
     * @returns {{ ok: boolean, error?: string }}
     */
    install() {
      if (state.phase !== 'downloaded') {
        return { ok: false, error: '当前没有已下载的更新' };
      }
      log('info', ['用户要求重启并安装 v' + (state.version || '?')]);
      // 放到下一个 tick：先把 { ok: true } 回给渲染进程，再让 quitAndInstall 走 quit 流程。
      // 同步调用的话主进程可能在 IPC 响应发出去之前就开始退出。
      setImmediate(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (err) {
          log('error', ['quitAndInstall 失败', err]);
        }
      });
      return { ok: true };
    },

    /** 启动后延迟自动检查一次（只排一次；`unref` 以免拖住进程退出）。 */
    scheduleAutoCheck() {
      if (disposed || timer) return;
      if (!isSupported()) {
        // 不支持也把状态摆正，界面一挂载就能问到原因，而不是停在 idle。
        commit({ type: 'unsupported', reason: unsupportedReason() });
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        Promise.resolve(service.check({ manual: false })).catch((err) => {
          log('warn', ['自动检查更新失败', err]);
        });
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
      log('info', [`已安排启动后 ${Math.round(delayMs / 1000)}s 检查更新`]);
    },

    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const [name, handler] of wired) {
        try {
          autoUpdater.removeListener(name, handler);
        } catch {
          /* 摘不掉就交给进程退出 */
        }
      }
      wired.length = 0;
    },
  };

  return service;
}

module.exports = {
  DEFAULT_AUTO_CHECK_DELAY_MS,
  DISABLE_UPDATE_CHECK_ENV,
  MAX_RELEASE_NOTES_CHARS,
  PROGRESS_STEP_PERCENT,
  applyUpdateEvent,
  blankUpdateState,
  createUpdateService,
  describeUpdateError,
  normalizeProgress,
  normalizeReleaseNotes,
  toUpdaterLogger,
};

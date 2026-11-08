'use strict';

/**
 * 后端 utilityProcess 的生命周期监管器。
 *
 * 这段逻辑原先全部住在 `main.js` 的组合根里：进程拉起、init、状态快照、
 * 有界退避重启、设置回灌、密钥迁移与退出收尾共享同一批模块级变量。
 * 那些分支只能在真实 Electron 里观察，几乎无法单测；抽出后由
 * `tests/backend-supervisor.spec.ts` 用假 child 确定性覆盖。
 *
 * `main.js` 仍保留“什么时候启动/退出”与“事件发给谁”两个编排点，
 * 其余状态机都在本模块内。
 */

const BACKEND_RESTART_MAX = 3;
const RESTART_BACKOFF_MS = [500, 1500, 4500];
const BACKEND_RESTART_STABLE_MS = 30_000;
const BACKEND_CALL_READY_WAIT_MS = 20_000;

function required(deps, name) {
  if (deps[name] === undefined) {
    throw new Error(`createBackendSupervisor: missing dependency ${name}`);
  }
  return deps[name];
}

/** 把宿主已保存的设置与密钥镜像回灌到新 worker。 */
async function applySupervisorSettings(runtime) {
  const savedSettings = { ...runtime.loadWechatSettings(), ...runtime.mirroredSecretValues() };
  if (Object.keys(savedSettings).length === 0) return;
  const r = await runtime.backend.call('saveWechatConfig', [{ patch: savedSettings }]);
  if (!r.ok || r.value?.ok === false) {
    runtime.log.warn('[wechat] 应用 wechat/config.json 设置失败:', r.error || r.value?.error);
  }
}

/** 旧密钥迁移与 secrets 目录 ACL 收紧；失败只告警，不拖垮刚恢复的 worker。 */
async function migrateSupervisorSecrets(runtime) {
  const dataRoot = String(runtime.boot?.info?.root ?? '').trim();
  const backendConfigFile = dataRoot ? runtime.path.join(dataRoot, 'config.json') : '';
  const r = runtime.restrictWechatState({ stateDir: runtime.stateDir, ...(dataRoot ? { dataRoot } : {}) });
  if (!r.ok) runtime.log.warn('[security] 密钥目录权限收紧未完全成功：' + r.failures.join('; '));
  else if (Array.isArray(r.skipped) && r.skipped.length > 0) {
    // 已收紧的目录不再重写整棵子树的 ACL（数据根 4.8 万文件时那是每次启动 2.6s 的白工）。
    runtime.log.log('[security] 敏感目录 ACL 已收紧，跳过递归传播（' + String(r.elapsedMs ?? 0) + 'ms）');
  }

  try {
    if (!backendConfigFile || !runtime.fs.existsSync(backendConfigFile)) return;
    const raw = JSON.parse(runtime.fs.readFileSync(backendConfigFile, 'utf8'));
    const legacy = ['db_enc_key', 'image_aes_key', 'image_xor_key', 'api_token']
      .some((k) => (typeof raw?.[k] === 'string' ? raw[k] !== '' : raw?.[k] !== undefined));
    if (!legacy) return;
    const res = await runtime.backend.call('saveWechatConfig', [{ patch: {} }]);
    if (res.ok && res.value?.ok !== false) {
      runtime.log.log('[security] 已把旧 config.json 里的密钥迁移到 secrets.json');
    } else {
      runtime.log.warn('[security] 密钥迁移失败（下次保存会再试）:', res.error || res.value?.error);
    }
  } catch (e) {
    runtime.log.warn('[security] 密钥迁移失败（下次保存会再试）:', e);
  }
}

/**
 * 拉起 worker 进程并接好日志/通道（从 createBackendSupervisor 拆出：单函数行数棘轮 ≤250）。
 * @param {object} ctx - 闭包依赖（见下面的解构）。
 * @returns {object} createWorkerChannel 返回的句柄。
 */
function spawnWorkerProcess(ctx) {
  const { userData, onExit, bootTrace, isPackaged, env, deps, diagLog, log, createWorkerChannel, onEvent, resolveHangMethods, DEBUG_HANG_ENV, utilityProcess, path } = ctx;

    const hangMethods = resolveHangMethods({ isPackaged, env });
    const workerEnv = { ...env };
    if (hangMethods.length > 0) workerEnv[DEBUG_HANG_ENV] = hangMethods.join(',');
    else delete workerEnv[DEBUG_HANG_ENV];

    // 仅「未打包 + 显式 env」才给 worker 加 node 启动参数：用于内存/heap 策略实验
    // （例如 `--max-old-space-size=192`）与 heap snapshot 归因。打包态一律不加。
    const workerExecArgv = [];
    if (!isPackaged) {
      if (env.SUPERTIME_BACKEND_INSPECT === '1') {
        const inspectPort = String(env.SUPERTIME_BACKEND_INSPECT_PORT ?? '9229').trim();
        workerExecArgv.push('--inspect=127.0.0.1:' + (/^\d+$/.test(inspectPort) ? inspectPort : '9229'));
      }
      const nodeArgs = String(env.SUPERTIME_BACKEND_NODE_ARGS ?? '').trim();
      if (nodeArgs !== '') workerExecArgv.push(...nodeArgs.split(/\s+/).filter((s) => s !== ''));
    }
    const child = utilityProcess.fork(
      path.join(__dirname, 'wechat-worker.js'),
      [],
      {
        serviceName: 'super-time-wechat-backend',
        stdio: 'pipe',
        env: workerEnv,
        ...(workerExecArgv.length > 0 ? { execArgv: workerExecArgv } : {}),
      },
    );
    bootTrace('main:spawn-called');
    for (const [stream, level, target] of [
      [child.stdout, 'backend', process.stdout],
      [child.stderr, 'backend!', process.stderr],
    ]) {
      if (!stream || typeof stream.on !== 'function') continue;
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim() === '') continue;
          diagLog.write(level, [line]);
          try { target.write(line + '\n'); } catch { /* 管道坏了就只留文件那份 */ }
        }
      });
    }
    return createWorkerChannel(child, {
      userDataPath: userData,
      onEvent: (name, args) => {
        if (env.SUPERTIME_RELAY_LOG === '1') log.log('[relay:in]', name);
        onEvent(name, args);
      },
      onExit,
      ...(deps.callTimeoutMs === undefined ? {} : { callTimeoutMs: deps.callTimeoutMs }),
      ...(deps.longTimeoutMs === undefined ? {} : { longTimeoutMs: deps.longTimeoutMs }),
    });
  }

/**
 * 把稳定窗口与 ready 广播收进一个小控制器，避免监管器工厂继续膨胀。
 *
 * @param {object} ctx - getBackend/getStatus/isStopping/setStatus 等访问器。
 * @returns {{ clear: () => void, markReady: (handle: object, message: string) => void }}
 */
function createReadyController(ctx) {
  let stableTimer = null;
  const clear = () => {
    if (stableTimer === null) return;
    ctx.clearTimeoutFn(stableTimer);
    stableTimer = null;
  };
  function markReady(handle, message) {
    if (ctx.isStopping() || ctx.getBackend() !== handle) return;
    clear();
    ctx.setStatus('ready');
    if (message !== '') ctx.log.log(message);
    if (ctx.getRestartCount() === 0) return;
    stableTimer = ctx.setTimeoutFn(() => {
      stableTimer = null;
      if (ctx.isStopping() || ctx.getBackend() !== handle || ctx.getStatus().state !== 'ready') return;
      ctx.setRestartCount(0);
      ctx.setStatus('ready');
      ctx.log.log(`[wechat] 后端已稳定运行 ${String(ctx.restartStableMs)}ms，连续重启计数已清零`);
    }, ctx.restartStableMs);
    if (stableTimer && typeof stableTimer.unref === 'function') stableTimer.unref();
  }
  return { clear, markReady };
}

/** 启动分段打点；关闭时直接返回，避免热路径做字符串拼接。 */
function writeBootTrace(log, startedAt, label) {
  if (process.env.SUPERTIME_BOOT_TRACE !== '1') return;
  try {
    log.log('[boot-phase] main:' + label + ' t=' + String(startedAt === 0 ? 0 : Date.now() - startedAt));
  } catch { /* 打点失败绝不影响启动 */ }
}

/**
 * 等待 worker 的 dispose 回执（或 backend-rpc 的超时兜底），再让调用方继续退出。
 * 返回 Promise 是为了让 before-quit 可以暂停一次；普通调用方仍可忽略它。
 */
const disposePromises = new WeakMap();
function disposeBackendHandle(handle, log) {
  if (!handle) return Promise.resolve();
  const existing = disposePromises.get(handle);
  if (existing !== undefined) return existing;
  const pending = new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (outcome?.acknowledged === true) {
        log.log('[wechat] 后端已收尾（收到 dispose ACK，注入已还原）');
      } else if (outcome?.reason === 'timeout') {
        log.warn('[wechat] dispose 等待 ACK 超时；worker 已被终止，注入还原/收尾无法确认');
      } else if (outcome?.reason === 'worker-exited') {
        log.warn('[wechat] worker 在 dispose ACK 前退出；注入还原/收尾无法确认');
      } else if (outcome?.reason === 'error') {
        log.warn('[wechat] worker 的 dispose 回执失败；注入还原/收尾无法确认');
      } else if (outcome?.reason === 'send-failed') {
        log.warn('[wechat] dispose 消息未送达 worker；注入还原/收尾无法确认');
      } else {
        log.warn('[wechat] worker 未返回可识别的 dispose ACK；注入还原/收尾无法确认');
      }
      resolve();
    };
    try {
      const result = handle.dispose(finish);
      if (result && typeof result.then === 'function') {
        void result.then(finish, finish);
      }
    } catch {
      finish({ acknowledged: false, reason: 'send-failed' });
    }
  });
  disposePromises.set(handle, pending);
  return pending;
}

/**
 * 把 stop 的并发幂等、完成终态清理与恢复入口收在一个小状态机里。
 * 更新安装失败时，stop 返回值里的 restart 必须能在终态清理后重新拉起 worker。
 */
function createStopController(ctx) {
  let stopping = false;
  let stopPromise = null;

  function stop() {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    ctx.clearReady();
    ctx.clearRestartTimer();
    const handle = ctx.getHandle();
    ctx.clearBackend();
    let pending = null;
    const clearFinishedStop = () => {
      // 只清理本轮；若调用方在收尾期间又发起了一次 stop，不能误伤新 Promise。
      if (stopPromise !== pending) return;
      stopPromise = null;
      stopping = false;
    };
    try {
      pending = ctx.dispose(handle).then(
        () => {
          clearFinishedStop();
          return { restart: ctx.restart };
        },
        (err) => {
          clearFinishedStop();
          throw err;
        },
      );
    } catch (err) {
      clearFinishedStop();
      throw err;
    }
    stopPromise = pending;
    return pending;
  }

  return {
    stop,
    wait: async () => { if (stopPromise !== null) await stopPromise; },
    isStopping: () => stopping,
  };
}

/** 等待后端进入 ready；状态机留在监管器内，这里只负责有界轮询。 */
function createReadyWaiter(ctx) {
  return function waitUntilReady(timeoutMs = ctx.readyWaitMs) {
    if (ctx.getStatus().state === 'ready' && ctx.getBackend()) return Promise.resolve(true);
    if (ctx.getStatus().state === 'failed' || ctx.isStopping()) return Promise.resolve(false);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = ctx.setIntervalFn(() => {
        const state = ctx.getStatus().state;
        const done = (state === 'ready' && ctx.getBackend())
          ? true
          : (state === 'failed' || ctx.isStopping() || Date.now() - startedAt > timeoutMs)
            ? false
            : null;
        if (done === null) return;
        ctx.clearIntervalFn(timer);
        if (done) ctx.log.log(`[wechat] 有调用等待后端就绪 ${Date.now() - startedAt}ms 后返回`);
        resolve(done);
      }, 100);
      if (timer.unref) timer.unref();
    });
  };
}

/** 校验并集中读取监管器依赖，保持主状态机函数低于行数棘轮。 */
function supervisorRuntime(deps) {
  return {
    isPackaged: required(deps, 'isPackaged'),
    env: deps.env ?? process.env,
    utilityProcess: required(deps, 'utilityProcess'),
    diagLog: required(deps, 'diagLog'),
    resolveHangMethods: required(deps, 'resolveHangMethods'),
    DEBUG_HANG_ENV: required(deps, 'DEBUG_HANG_ENV'),
    createWorkerChannel: required(deps, 'createWorkerChannel'),
    onEvent: required(deps, 'onEvent'),
    loadWechatSettings: required(deps, 'loadWechatSettings'),
    mirroredSecretValues: required(deps, 'mirroredSecretValues'),
    restrictWechatState: required(deps, 'restrictWechatState'),
    stateDir: required(deps, 'stateDir'),
    fs: required(deps, 'fs'),
    path: required(deps, 'path'),
    applyConfig: required(deps, 'applyConfig'),
    recordResolved: required(deps, 'recordResolved'),
    log: deps.log ?? console,
    restartMax: deps.restartMax ?? BACKEND_RESTART_MAX,
    restartBackoffMs: deps.restartBackoffMs ?? RESTART_BACKOFF_MS,
    restartStableMs: deps.restartStableMs ?? BACKEND_RESTART_STABLE_MS,
    readyWaitMs: deps.readyWaitMs ?? BACKEND_CALL_READY_WAIT_MS,
    setTimeoutFn: deps.setTimeoutFn ?? setTimeout,
    clearTimeoutFn: deps.clearTimeoutFn ?? clearTimeout,
    setIntervalFn: deps.setIntervalFn ?? setInterval,
    clearIntervalFn: deps.clearIntervalFn ?? clearInterval,
  };
}

/**
 * 创建一个后端监管器。
 *
 * 所有 Electron/文件/配置依赖都从这里注入，便于在 Node 单测里替换。
 *
 * @param {object} deps
 * @param {boolean} deps.isPackaged - Electron `app.isPackaged` 的现取值。
 * @param {object} [deps.env] - 进程环境；默认 process.env。
 * @param {object} deps.utilityProcess - Electron utilityProcess。
 * @param {object} deps.diagLog - 主进程诊断日志（只要求 write）。
 * @param {Function} deps.resolveHangMethods - debug-gates 的注入名单判定。
 * @param {string} deps.DEBUG_HANG_ENV - 注入名单环境变量名。
 * @param {Function} deps.createWorkerChannel - backend-rpc 的通道工厂。
 * @param {Function} deps.onEvent - 后端事件广播（也会收到状态快照）。
 * @param {Function} deps.loadWechatSettings - 宿主配置里的普通设置。
 * @param {Function} deps.mirroredSecretValues - 宿主镜像里的非空密钥。
 * @param {Function} deps.restrictWechatState - 收紧密钥文件 ACL。
 * @param {string} deps.stateDir - 宿主状态目录。
 * @param {object} deps.fs - node:fs 子集（existsSync/readFileSync）。
 * @param {object} deps.path - node:path。
 * @param {Function} deps.applyConfig - 把路径配置映射到 process.env。
 * @param {Function} deps.recordResolved - 回写后端解析出的真实路径。
 * @param {Function} [deps.log] - 诊断输出；默认 console。
 * @param {number} [deps.callTimeoutMs] - 普通 RPC 超时。
 * @param {number} [deps.longTimeoutMs] - 长任务 RPC 超时。
 * @param {number} [deps.restartMax] - 最大连续重启次数。
 * @param {number[]} [deps.restartBackoffMs] - 退避序列。
 * @param {number} [deps.restartStableMs] - 连续重启计数清零前要求的稳定运行时长。
 * @param {number} [deps.readyWaitMs] - 调用等待后端就绪的默认上限。
 * @param {Function} [deps.setTimeoutFn] - 定时器注入（测试用）。
 * @param {Function} [deps.clearTimeoutFn] - 定时器清除注入（测试用）。
 * @param {Function} [deps.setIntervalFn] - 轮询注入（测试用）。
 * @param {Function} [deps.clearIntervalFn] - 轮询清除注入（测试用）。
 */
function createBackendSupervisor(deps) {
  const {
    isPackaged, env, utilityProcess, diagLog, resolveHangMethods, DEBUG_HANG_ENV,
    createWorkerChannel, onEvent, loadWechatSettings, mirroredSecretValues,
    restrictWechatState, stateDir, fs, path, applyConfig, recordResolved, log,
    restartMax, restartBackoffMs, restartStableMs, readyWaitMs,
    setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn,
  } = supervisorRuntime(deps);

  let backend = null; let boot = null;
  let userDataPath = null; let currentHandle = null;
  let restartCount = 0; let restartTimer = null;
  let status = { state: 'starting', restarts: 0, lastError: null };
  const initializing = new Set();

  const lifecycle = {
    log, stateDir, fs, path,
    restrictWechatState, loadWechatSettings, mirroredSecretValues,
    get backend() { return backend; },
    get boot() { return boot; },
  };

  function setStatus(state, lastError = null) {
    status = { state, restarts: restartCount, lastError };
    try {
      onEvent('wechat-backend/status', [status]);
    } catch (e) {
      log.warn('[wechat] 广播后端状态失败:', e?.message ?? e);
    }
  }

  const readyController = createReadyController({
    getBackend: () => backend,
    getStatus: () => status,
    isStopping: () => stopController.isStopping(),
    getRestartCount: () => restartCount,
    setRestartCount: (value) => { restartCount = value; },
    setStatus,
    restartStableMs,
    setTimeoutFn,
    clearTimeoutFn,
    log,
  });

  const stopController = createStopController({
    clearReady: () => readyController.clear(),
    clearRestartTimer: () => {
      if (!restartTimer) return;
      clearTimeoutFn(restartTimer);
      restartTimer = null;
    },
    getHandle: () => currentHandle ?? backend,
    clearBackend: () => {
      backend = null;
      boot = null;
      currentHandle = null;
    },
    dispose: (handle) => disposeBackendHandle(handle, log),
    restart: () => restart('更新安装失败后恢复后端'),
  });

  let bootT0 = 0;
  const bootTrace = (label) => writeBootTrace(log, bootT0, label);

  function spawn(userData, onExit) {
    return spawnWorkerProcess({
      userData, onExit, bootTrace, isPackaged, env, deps, diagLog, log, utilityProcess, path,
      createWorkerChannel, onEvent, resolveHangMethods, DEBUG_HANG_ENV,
    });
  }


  async function start(userData) {
    const handle = spawn(userData, (code) => {
      if (stopController.isStopping() || handle !== currentHandle) return;
      readyController.clear();
      backend = null;
      boot = null;
      currentHandle = null;
      setStatus('down', `后端进程已退出 (code=${code})`);
      // init reject 由 start() 先等 dispose ACK，再由调用方安排重启。
      if (initializing.has(handle)) return;
      scheduleRestart(`进程退出 (code=${code})`);
    });
    currentHandle = handle;
    initializing.add(handle);
    try {
      const nextBoot = await handle.init();
      // stop() 可能发生在 init 期间，此时不能把已停止的句柄写回 backend。
      if (stopController.isStopping() || handle !== currentHandle) {
        const error = new Error('后端在初始化完成前已停止');
        error.code = 'BACKEND_STOPPED_DURING_INIT';
        throw error;
      }
      backend = handle;
      boot = nextBoot;
      return handle;
    } catch (e) {
      const stoppedDuringInit = stopController.isStopping() || handle !== currentHandle;
      const failure = stoppedDuringInit
        ? Object.assign(new Error('后端在初始化完成前已停止'), {
            code: 'BACKEND_STOPPED_DURING_INIT',
            cause: e,
          })
        : e;
      // init 失败时 worker 也可能已起来：先等 dispose ACK/超时，再让调用方重启。
      await disposeBackendHandle(handle, log);
      if (handle === currentHandle) {
        currentHandle = null;
      }
      throw failure;
    } finally {
      initializing.delete(handle);
    }
  }

  const waitUntilReady = createReadyWaiter({
    readyWaitMs, getStatus: () => status, getBackend: () => backend,
    isStopping: () => stopController.isStopping(), setIntervalFn, clearIntervalFn, log,
  });

  function scheduleRestart(reason) {
    if (stopController.isStopping()) return;
    readyController.clear();
    if (restartTimer) {
      log.warn(`[wechat] 已有重启计划在路上，忽略重复触发（原因：${reason}）`);
      return;
    }
    if (restartCount >= restartMax) {
      const msg = `Super Time 后端连续 ${restartMax} 次重启失败，相关功能不可用。`
        + `请重启应用；若持续失败请检查 wechat/config.json 与数据目录。最近原因：${reason}`;
      log.error('[wechat]', msg);
      setStatus('failed', msg);
      return;
    }
    const attempt = restartCount;
    restartCount += 1;
    setStatus('restarting', reason);
    const delay = restartBackoffMs[attempt] ?? restartBackoffMs[restartBackoffMs.length - 1];
    log.warn(`[wechat] 后端将在 ${delay}ms 后第 ${restartCount}/${restartMax} 次重启（原因：${reason}）`);
    restartTimer = setTimeoutFn(() => {
      restartTimer = null;
      if (stopController.isStopping()) return;
      void (async () => {
        let handle;
        try {
          handle = await start(userDataPath);
        } catch (e) {
          const why = `重启后 init 失败：${e?.message ?? e}`;
          setStatus('down', why);
          scheduleRestart(why);
          return;
        }
        try {
          await applySupervisorSettings(lifecycle);
        } catch (e) {
          log.warn('[wechat] 重启后回灌设置失败（后端仍可用，不影响本次恢复）:', e?.message ?? e);
        }
        try {
          await migrateSupervisorSecrets(lifecycle);
        } catch (e) {
          log.warn('[security] 重启后的密钥加固收尾失败:', e?.message ?? e);
        }
        readyController.markReady(
          handle,
          `[wechat] 后端已恢复，Remote 方法数: ${String(boot?.methods?.length ?? 0)}`,
        );
      })();
    }, delay);
    if (restartTimer.unref) restartTimer.unref();
  }

  /**
   * 首次启动或重启后的完整收尾。失败不会把刚恢复的健康句柄打回失败态。
   * 设置回灌与 ACL 收尾只 warn，与历史行为一致。
   */
  async function bootstrap(userData) {
    bootT0 = Date.now();
    bootTrace('bootstrap-start');
    applyConfig();
    userDataPath = userData;
    try {
      await start(userData);
      bootTrace('init-returned');
      try {
        recordResolved(boot.info);
      } catch (e) {
        log.warn('[wechat] 记录路径配置失败:', e);
      }
      bootTrace('record-resolved');
      try {
        await applySupervisorSettings(lifecycle);
      } catch (e) {
        log.warn('[wechat] 应用 wechat/config.json 设置失败:', e);
      }
      bootTrace('settings-applied');
      try {
        await migrateSupervisorSecrets(lifecycle);
      } catch (e) {
        log.warn('[security] 密钥加固收尾失败:', e);
      }
      bootTrace('secrets-migrated');
      readyController.markReady(backend, `[wechat] Super Time 后端已就绪，Remote 方法数: ${String(boot.methods.length)}`);
      bootTrace('ready');
      return { ok: true, backend, boot };
    } catch (err) {
      // stop() 可能在 init 期间结束。此时 currentHandle 已被清空，start()
      // 抛出的“取消”不是运行故障，绝不能再排一次自动重启。
      if (err?.code === 'BACKEND_STOPPED_DURING_INIT') {
        setStatus('down', '后端已停止');
        return { ok: false, error: err };
      }
      log.error('[wechat] Super Time 后端初始化失败:', err);
      setStatus('down', `初始化失败：${err?.message ?? err}`);
      scheduleRestart(`初始化失败：${err?.message ?? err}`);
      return { ok: false, error: err };
    }
  }

  /**
   * 在显式停止后恢复后端。
   *
   * 安装更新时会先 stop()，但 quitAndInstall 仍可能同步抛错（文件被占用、安装器启动失败等）。
   * 此时应用并没有退出，必须能把后端拉回来，否则所有依赖 worker 的功能会永久不可用。
   */
  async function restart(reason = '手动重启') {
    await stopController.wait();
    if (backend !== null && currentHandle !== null) return { ok: true, backend, boot };
    if (userDataPath === null) {
      return { ok: false, error: new Error('后端尚未完成首次 bootstrap，无法重启') };
    }
    setStatus('starting', reason);
    return bootstrap(userDataPath);
  }

  return {
    get backend() { return backend; },
    get boot() { return boot; },
    get status() { return status; },
    get isStopping() { return stopController.isStopping(); },
    waitUntilReady,
    bootstrap,
    restart,
    stop: stopController.stop,
    /** 暴露给测试：真机路径始终经 bootstrap/scheduleRestart 进入。 */
    _test: { start, scheduleRestart, setStatus },
  };
}

module.exports = {
  createBackendSupervisor,
  BACKEND_RESTART_MAX,
  RESTART_BACKOFF_MS,
  BACKEND_RESTART_STABLE_MS,
  BACKEND_CALL_READY_WAIT_MS,
};

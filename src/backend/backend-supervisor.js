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
 * @param {number} [deps.readyWaitMs] - 调用等待后端就绪的默认上限。
 * @param {Function} [deps.setTimeoutFn] - 定时器注入（测试用）。
 * @param {Function} [deps.clearTimeoutFn] - 定时器清除注入（测试用）。
 * @param {Function} [deps.setIntervalFn] - 轮询注入（测试用）。
 * @param {Function} [deps.clearIntervalFn] - 轮询清除注入（测试用）。
 */
function createBackendSupervisor(deps) {
  const isPackaged = required(deps, 'isPackaged');
  const env = deps.env ?? process.env;
  const utilityProcess = required(deps, 'utilityProcess');
  const diagLog = required(deps, 'diagLog');
  const resolveHangMethods = required(deps, 'resolveHangMethods');
  const DEBUG_HANG_ENV = required(deps, 'DEBUG_HANG_ENV');
  const createWorkerChannel = required(deps, 'createWorkerChannel');
  const onEvent = required(deps, 'onEvent');
  const loadWechatSettings = required(deps, 'loadWechatSettings');
  const mirroredSecretValues = required(deps, 'mirroredSecretValues');
  const restrictWechatState = required(deps, 'restrictWechatState');
  const stateDir = required(deps, 'stateDir');
  const fs = required(deps, 'fs');
  const path = required(deps, 'path');
  const applyConfig = required(deps, 'applyConfig');
  const recordResolved = required(deps, 'recordResolved');
  const log = deps.log ?? console;

  const restartMax = deps.restartMax ?? BACKEND_RESTART_MAX;
  const restartBackoffMs = deps.restartBackoffMs ?? RESTART_BACKOFF_MS;
  const readyWaitMs = deps.readyWaitMs ?? BACKEND_CALL_READY_WAIT_MS;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;

  let backend = null;
  let boot = null;
  let userDataPath = null;
  let currentHandle = null;
  let restartCount = 0;
  let restartTimer = null;
  let status = { state: 'starting', restarts: 0, lastError: null };
  let stopping = false;

  const lifecycle = {
    log,
    stateDir,
    fs,
    path,
    restrictWechatState,
    loadWechatSettings,
    mirroredSecretValues,
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

  /**
   * 启动分段打点（`SUPERTIME_BOOT_TRACE=1` 门控；默认零开销）。
   * 时间原点在 `bootstrap()` 入口重置，所以每条 t 都是「从本次 bootstrap 开始」的毫秒数。
   */
  let bootT0 = 0;
  function bootTrace(label) {
    if (process.env.SUPERTIME_BOOT_TRACE !== '1') return;
    try {
      log.log('[boot-phase] main:' + label + ' t=' + String(bootT0 === 0 ? 0 : Date.now() - bootT0));
    } catch { /* 打点失败绝不影响启动 */ }
  }

  function spawn(userData, onExit) {
    const hangMethods = resolveHangMethods({ isPackaged, env });
    const workerEnv = { ...env };
    if (hangMethods.length > 0) workerEnv[DEBUG_HANG_ENV] = hangMethods.join(',');
    else delete workerEnv[DEBUG_HANG_ENV];

    // 仅「未打包 + 显式 env」才给 worker 开 inspector：用于 heap snapshot 归因
    // （性能专项）。打包态一律不开，避免把调试端口带进发行版；只绑 127.0.0.1。
    const inspectPort = String(env.SUPERTIME_BACKEND_INSPECT_PORT ?? '9229').trim();
    const inspectArgv = !isPackaged && env.SUPERTIME_BACKEND_INSPECT === '1'
      ? ['--inspect=127.0.0.1:' + (/^\d+$/.test(inspectPort) ? inspectPort : '9229')]
      : undefined;
    const child = utilityProcess.fork(
      path.join(__dirname, 'wechat-worker.js'),
      [],
      {
        serviceName: 'super-time-wechat-backend',
        stdio: 'pipe',
        env: workerEnv,
        ...(inspectArgv ? { execArgv: inspectArgv } : {}),
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

  async function start(userData) {
    const handle = spawn(userData, (code) => {
      if (stopping || handle !== currentHandle) return;
      backend = null;
      boot = null;
      setStatus('down', `后端进程已退出 (code=${code})`);
      scheduleRestart(`进程退出 (code=${code})`);
    });
    currentHandle = handle;
    try {
      const nextBoot = await handle.init();
      backend = handle;
      boot = nextBoot;
      return handle;
    } catch (e) {
      if (handle === currentHandle) {
        // init 失败：worker 可能已起来（只是 init 这步失败），同样按握手 dispose。
        try { handle.dispose(() => {}); } catch { /* 已退出 */ }
      }
      throw e;
    }
  }

  function waitUntilReady(timeoutMs = readyWaitMs) {
    if (status.state === 'ready' && backend) return Promise.resolve(true);
    if (status.state === 'failed' || stopping) return Promise.resolve(false);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = setIntervalFn(() => {
        const done = (status.state === 'ready' && backend)
          ? true
          : (status.state === 'failed' || stopping || Date.now() - startedAt > timeoutMs)
            ? false
            : null;
        if (done === null) return;
        clearIntervalFn(timer);
        if (done) log.log(`[wechat] 有调用等待后端就绪 ${Date.now() - startedAt}ms 后返回`);
        resolve(done);
      }, 100);
      if (timer.unref) timer.unref();
    });
  }

  function scheduleRestart(reason) {
    if (stopping) return;
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
      if (stopping) return;
      void (async () => {
        try {
          await start(userDataPath);
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
        restartCount = 0;
        setStatus('ready');
        log.log('[wechat] 后端已恢复，Remote 方法数:', boot?.methods?.length ?? 0);
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
      restartCount = 0;
      setStatus('ready');
      bootTrace('ready');
      log.log('[wechat] Super Time 后端已就绪，Remote 方法数:', boot.methods.length);
      return { ok: true, backend, boot };
    } catch (err) {
      log.error('[wechat] Super Time 后端初始化失败:', err);
      setStatus('down', `初始化失败：${err?.message ?? err}`);
      scheduleRestart(`初始化失败：${err?.message ?? err}`);
      return { ok: false, error: err };
    }
  }

  function stop() {
    stopping = true;
    if (restartTimer) {
      clearTimeoutFn(restartTimer);
      restartTimer = null;
    }
    if (backend) {
      // dispose 是握手：等 worker 收尾（还原注入/清 marker/关句柄）完成才 kill。
      // 同步等：`before-quit` 之后 app 马上要退，异步回调用不上（超时上限见 backend-rpc.js）。
      try {
        backend.dispose(() => { log.log('[wechat] 后端已收尾（注入已还原）'); });
      } catch { /* 退出时尽力释放 */ }
    }
    backend = null;
    boot = null;
    currentHandle = null;
  }

  return {
    get backend() { return backend; },
    get boot() { return boot; },
    get status() { return status; },
    get isStopping() { return stopping; },
    waitUntilReady,
    bootstrap,
    stop,
    /** 暴露给测试：真机路径始终经 bootstrap/scheduleRestart 进入。 */
    _test: { start, scheduleRestart, setStatus },
  };
}

module.exports = {
  createBackendSupervisor,
  BACKEND_RESTART_MAX,
  RESTART_BACKOFF_MS,
  BACKEND_CALL_READY_WAIT_MS,
};

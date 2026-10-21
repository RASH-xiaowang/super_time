'use strict';

/**
 * Super Time —— 后端宿主适配层
 *
 * 将 @deepseek-ai/dsh-wechat-data 的 Typert Remote 后端（单一 ESM bundle，
 * 见 ./wechat-data/index.js）接入 Super Time 的 Electron 主进程：
 *   - 提供最小化的 Cordis Context（reflect/effect/emit/llm/settings）
 *   - 将数据根默认指向应用 userData/wechat-data（可用 DSH_HOME 或
 *     DSH_WECHAT_DATA_DIR 覆盖，保持与上游一致的目录布局）
 *   - 将 @Remote 方法表枚举为 Electron IPC 可调用的方法名空间
 */

const path = require('node:path');
const os = require('node:os');
const { statSync } = require('node:fs');
const wechatPaths = require('./wechat-paths');
const argsGuard = require('./wechat-args-guard');
const { cancelPlanFor, injectFallbackJobId, jobIdForCall } = require('./wechat-cancel');
const { createLlmBridge } = require('./llm-bridge');

/**
 * 启动分段打点（`SUPERTIME_BOOT_TRACE=1` 才生效，默认零开销）。
 *
 * 为什么需要它：首屏「后端 ready」实测中位 2806ms（docs/perf/02-BASELINE.md §3），
 * 但这一个数字把「拉进程 + 加载 1.7MB bundle + 建 gateway + 主进程收尾」全糊在一起，
 * 无法判断该优化哪一段。这里只打时间戳、不做任何业务动作，是定位而不是优化。
 *
 * 时间原点由 `wechat-worker.js` 在**任何 require 之前**写进
 * `globalThis.__SUPERTIME_BOOT_T0`，所以 `worker:requires-done` 也包含 require 成本；
 * 在非 worker 环境（单测）里退化成模块加载时刻。
 */
const BOOT_TRACE_ON = process.env.SUPERTIME_BOOT_TRACE === '1';
const BOOT_T0 = Number(globalThis.__SUPERTIME_BOOT_T0) || Date.now();

/**
 * 打一条启动分段。
 * @param {string} label - 阶段名（固定词表，便于日志侧解析）。
 */
function bootTrace(label) {
  if (!BOOT_TRACE_ON) return;
  try {
    console.log('[boot-phase] ' + label + ' t=' + String(Date.now() - BOOT_T0));
  } catch { /* 打点失败绝不影响启动 */ }
}


/**
 * 已经用**真实流量**证明过「生成的 schema 与面板实际传来的形状对得上」的方法。
 *
 * 空集起步不是偷懒：`wechat-data/lib/typert.host.js` 里生成的 zod schema 长期落后于
 * `@Remote` 声明，且生成器不在本仓库。具体缺口数不要在这里写死，它会随生成物漂移；
 * 每次启动的真实读数看 `info().argGuard.covered/total`（当前工作树实测：133 个
 * invocation 中 89 个带参数 schema，44 个是零参数方法、无需参数 schema，另有 62 个
 * `@Remote` 方法根本不在 invocation 表）。连续几次
 * 合法调用只能证明「见过的那一种形状合法」，不能证明 stale schema 覆盖了全部合法形状；
 * 因此这里**不做自动升级**。只有人工核对过 schema、给出明确证据后，才能把方法名加进
 * 这份白名单并注明证据。结构/体积那一道闸门（`wechat-args-guard.js` 的 ① 档）
 * 不受这份名单影响，它**总是**拒绝。
 *
 * 2026-10-15 第一个试点：`deleteTask`。
 * 证据是生成物与声明逐字一致：
 *   - `src/backend/wechat-data/src/gateway-config-ops.ts:258-260`
 *     声明 `deleteTask(options: { id: number })`；
 *   - `src/backend/wechat-data/lib/typert.host.js:258-261`
 *     生成的参数 schema 同样是 `z.object({ id: z.number() })`。
 * 多余字段仍按 `checkSchema` 的既有纪律放行，因此这份名单只会拒绝
 * `id` 缺失或类型错误，不会误伤面板先发来的新字段。
 */
const ENFORCED_SCHEMA_METHODS = new Set([
  'deleteTask',
]);


/**
 * 「纯读且昂贵」方法的结果缓存（正缓存 + 负缓存）。
 *
 * `getSnsImageDataUrl` 这类方法在哈希路径压不中时会退化成对整个
 * `cache/<月>/Sns/Img` 乃至 `msg/attach` 做全量「读文件 + AES 解密 + MD5」扫描，
 * 实测单次 **12–21 秒**，而且上游没有负缓存 —— 同一张图被重复请求（面板重挂载、
 * 来回切页签）就会一次次重扫。
 *
 * 这里在适配层加一层有界缓存：命中即返回，重复请求从十几秒降到 0；
 * 失败结果同样缓存，避免对"确实没有"的图反复全量扫描。
 *
 * 三条边界：
 *   - 单条结果超过 512KB（例如整段视频的 base64）不入缓存，不把大对象钉在内存里；
 *   - 全部结果的总字符数不超过 64MB，超过后按 LRU 队头逐出；
 *   - 数据更新时**定向**失效，不是整体清空（见 clearStaleResultCache 的说明）。
 */
const CACHEABLE_METHODS = new Set([
  'getSnsImageDataUrl',
  'getSnsVideoCoverDataUrl',
  'getSnsVideoDataUrl',
  'getArticleCover',
  'getImageDataUrl',
  'getEmoticonDataUrl',
  'getAvatar',
]);
/** 内容本身会变的方法：数据一更新就得丢弃（头像可换、远程封面可换）。 */
const VOLATILE_CACHE_METHODS = new Set(['getAvatar', 'getArticleCover']);
const RESULT_CACHE_MAX = 300;
const RESULT_CACHE_MAX_CHARS = 512 * 1024;
const RESULT_CACHE_MAX_TOTAL_CHARS = 64 * 1024 * 1024;
const resultCache = new Map();
let resultCacheChars = 0;

/** 整体失效：只用于「解码结果整体作废」的场合（图片密钥变更）。 */
function clearResultCache() {
  resultCache.clear();
  resultCacheChars = 0;
}

/** 单条结果实际进入预算的字符数（只算缓存会命中的 url/data 字符串）。 */
function resultCacheCharsOf(result) {
  const value = result && result.value;
  const payload = value && typeof value === 'object' ? (value.url ?? value.data ?? null) : null;
  return typeof payload === 'string' ? payload.length : 0;
}

/** 删除单条并同步总字符计数。 */
function deleteResultCacheEntry(key) {
  if (!resultCache.has(key)) return;
  const result = resultCache.get(key);
  resultCache.delete(key);
  resultCacheChars -= resultCacheCharsOf(result);
}

/**
 * 数据更新后的**定向**失效（替代原先的整体 `clear()`）。
 *
 * 原先每来一次 `wechat-data/updated` 就清空：这几个方法里最贵的（朋友圈图片/视频帧）
 * 单次要「读文件 + AES 解密 + MD5」全量扫描，该文件自己的注释实测 **12–21 秒**；
 * 而同步活跃期约 10s 就有一次事件 —— 整体清空等于让缓存永远命中不了，
 * 面板每次重挂载都要重扫一遍。
 *
 * 只丢两类：
 *   · **失败结果**：图片可能在该消息到达之后才下载到本地，之前的「没找到」必须重试
 *     （这也是当初缓存失败结果时明确写下的例外）；
 *   · **内容会变的方法**（VOLATILE_CACHE_METHODS）。
 * 其余成功结果是内容寻址的（`getImageDataUrl` 按 username+localId、`getSns*DataUrl`
 * 按 md5/id），新消息不会改变既有条目的字节。图片**密钥**变更另走
 * `call()` 里 `saveWechatConfig` 那条路径整体清空 —— 解码结果随密钥而变。
 */
function clearStaleResultCache() {
  for (const [key, result] of [...resultCache]) {
    const sep = key.indexOf('\u0000');
    const method = sep < 0 ? key : key.slice(0, sep);
    if (VOLATILE_CACHE_METHODS.has(method) || (result && result.ok === false)) deleteResultCacheEntry(key);
  }
}

/**
 * 结果缓存的键。
 *
 * `decodeSig` 是「影响解码结果的外部输入」的指纹（后端 `config.json` 的 `db_dir` 等 +
 * `secrets.json` 里的图片 AES/XOR 密钥）。**必须进键**：这几个方法的返回值是「按当前密钥
 * 解码出来的字节」，那两个文件一改（界面上保存**或者用户手工编辑**）旧结果就不再正确；
 * 而手工编辑不走任何 RPC，没有别的途径能通知到缓存（复审实测：手改 `secrets.json` 换
 * `image_aes_key` 后，同一 `localId` 会永久返回旧字节）。
 */
function resultCacheKey(method, callArgs, decodeSig = '') {
  if (!CACHEABLE_METHODS.has(method)) return null;
  try {
    return method + '\u0000' + decodeSig + '\u0000' + JSON.stringify(callArgs);
  } catch {
    return null;
  }
}

/** 读取并刷新新鲜度（LRU）。未命中返回 null。 */
function readResultCache(key) {
  const hit = resultCache.get(key);
  if (hit === undefined) return null;
  resultCache.delete(key);
  resultCache.set(key, hit);
  return hit;
}

function writeResultCache(key, result) {
  const value = result && result.value;
  const payload = value && typeof value === 'object' ? (value.url ?? value.data ?? null) : null;
  if (typeof payload === 'string' && payload.length > RESULT_CACHE_MAX_CHARS) return;
  if (resultCache.has(key)) deleteResultCacheEntry(key);
  resultCache.set(key, result);
  resultCacheChars += resultCacheCharsOf(result);
  while (resultCache.size > RESULT_CACHE_MAX || resultCacheChars > RESULT_CACHE_MAX_TOTAL_CHARS) {
    const oldest = resultCache.keys().next();
    if (oldest.done) break;
    deleteResultCacheEntry(oldest.value);
  }
}

/** 最小化 Cordis Context：只实现 WechatDataGateway 运行时需要的面。 */
function createMiniContext(options = {}) {
  const disposers = [];
  const services = new Map();
  const llm = options.llm || createLlmBridge(options.llmConfig);
  const agentDefaultModel = options.agentDefaultModel || {
    currentSelection() {
      const provider = llm.config.provider || '';
      const model = llm.config.model || '';
      if (!provider || !model) return undefined;
      return { provider, model };
    },
  };
  const settings = options.settings || {
    get(key) {
      if (key === 'agent-default-model') {
        const sel = agentDefaultModel.currentSelection?.();
        return sel ? { provider: sel.provider, model: sel.model } : {};
      }
      return {};
    },
  };

  const ctx = {
    llm,
    agentDefaultModel,
    settings,
    reflect: {
      provide(name, value) {
        services.set(name, value);
        return value;
      },
    },
    effect(fn, label) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      else disposers.push(() => {});
      return disposer;
    },
    emit(name, ...args) {
      // 数据更新：定向失效（失败结果 + 内容会变的方法），不再整体清空（M8）。
      if (name === 'wechat-data/updated') clearStaleResultCache();
      try {
        options.onEvent?.(name, args);
      } catch {
        /* 广播失败不影响业务 */
      }
    },
    plugin() {
      throw new Error('Super Time 不使用 Cordis 插件装载，请直接 new WechatDataGateway');
    },
    dispose() {
      for (let i = disposers.length - 1; i >= 0; i -= 1) {
        try {
          disposers[i]();
        } catch {
          /* 释放失败不影响后续 */
        }
      }
      disposers.length = 0;
    },
  };
  return ctx;
}

/**
 * 创建「Super Time」后端实例。
 * @param {object} options
 * @param {string} [options.userDataPath] - Electron app.getPath('userData')，
 *   非 Electron 环境默认 ~/.dsh（与上游一致）。
 * @param {function} [options.onEvent] - 接收 gateway.emit 事件（如 wechat-data/updated）。
 * @param {object} [options.llmConfig] - SUPERTIME_LLM_* 环境变量之外的显式配置。
 * @returns {{gateway, methodNames, info, call, dispose}}
 */
/** 把宿主初始化前的环境配置与加载顺序集中起来，返回运行时依赖。 */
function configureBackendEnvironment(options) {
  const userHome = options.userDataPath || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  // 状态目录（config.json / llm.json）必须和主进程解析到同一个：
  // 都以 userData 为根。不显式配置的话本进程会落到默认 ~/.dsh，
  // 于是主进程写一份、后端读另一份，改了配置像没生效。
  wechatPaths.configure({ userDataPath: userHome });
  // 数据根默认布局：<DSH_HOME>/wechat-data（即应用 userData/wechat-data）。
  if (!process.env.DSH_HOME) process.env.DSH_HOME = userHome;
  return userHome;
}

/**
 * 加载后端 bundle、类型协议与影子 schema，再创建 gateway。
 *
 * 各观察设施加载失败只降级不阻断业务；typert schema 只负责 ② 档影子校验。
 */
async function loadBackendRuntime(options) {
  bootTrace('runtime:start');
  const userHome = configureBackendEnvironment(options);
  bootTrace('env-config');
  const mod = await import('./wechat-data/lib/index.js');
  bootTrace('bundle-import');
  // 连接策略由后端包自己实现；这里在 gateway 建好前把宿主配置交给它。
  if (typeof mod.configureSqliteCachePolicy === 'function') {
    mod.configureSqliteCachePolicy();
  }
  const protocol = await import('@deepseek-ai/dsh-typert-protocol');
  bootTrace('protocol-import');

  /**
   * H2：慢调用的耗时写进审计表（`wechat_privacy.db#operation_log.duration_ms`）。
   * 日志给开发者在现场捞，审计表给用户在界面上查；失败或加载不到都只降级成「不记账」。
   */
  const recordSlowCall = typeof mod.recordOperation === 'function' ? mod.recordOperation : null;
  const SLOW_CALL_MS = typeof mod.SLOW_OPERATION_MS === 'number' ? mod.SLOW_OPERATION_MS : 1000;
  /**
   * `SUPERTIME_SLOW_CALL_MS` 是诊断用的日志阈值，落审计表的阈值仍走 `SLOW_CALL_MS`。
   */
  const slowLogOverride = Number(process.env.SUPERTIME_SLOW_CALL_MS);
  const SLOW_LOG_MS = Number.isFinite(slowLogOverride) && slowLogOverride > 0 ? slowLogOverride : 1000;

  /**
   * 生成的 zod schema 表（② 档的影子校验）。
   * 加载失败不许把后端拖到起不来；`argSchemas` 为 null 时 `checkSchema` 回 `unloaded`。
   */
  let argSchemas = null;
  try {
    const typert = await import('./wechat-data/lib/typert.host.js');
    argSchemas = argsGuard.buildSchemaMap(typert?.TYPERT?.invocations ?? []);
    if (argSchemas.size === 0) console.warn('[wechat] typert schema 表是空的，入参形状校验无覆盖');
  } catch (e) {
    console.warn('[wechat] typert schema 表没加载到（形状校验关闭）:', e?.message ?? e);
  }

  bootTrace('typert-schema');
  const context = createMiniContext(options);
  bootTrace('mini-context');
  const gateway = new mod.WechatDataGateway(context);
  bootTrace('gateway-ctor');
  return { userHome, protocol, argSchemas, context, gateway, mod, recordSlowCall, SLOW_CALL_MS, SLOW_LOG_MS };
}

/**
 * 「影响解码结果的外部输入」的指纹：数据根下的 `config.json` 与 `secrets.json`。
 * 手工编辑这两个文件时不需要任何 RPC 通知，靠文件 mtime/size 自失效。
 */
function createDecodeInputSig(gateway) {
  return () => {
    try {
      const root = path.dirname(gateway._dirs.decrypted);
      const sig = (name) => {
        try {
          const st = statSync(path.join(root, name));
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return '-';
        }
      };
      return sig('config.json') + '|' + sig('secrets.json');
    } catch {
      return '';
    }
  };
}

/** 把 Typert Remote 方法表压成「外部名 → 实现名」的映射。 */
function buildMethodMap(protocol, gateway) {
  const methodMap = new Map();
  for (const marker of protocol.remoteMethods(gateway)) {
    const name = marker.exportName || marker.method;
    methodMap.set(name, marker.method);
  }
  return methodMap;
}

/** 生成后端实例的 info()：路径、方法与入参守卫影子账本。 */
function createBackendInfo(gateway, context, methodMap, argSchemas) {
  return () => {
    const root = path.dirname(gateway._dirs.decrypted);
    return {
      root,
      decrypted: gateway._dirs.decrypted,
      decoded: gateway._dirs.decoded,
      selfUsername: gateway._selfUsername,
      pathConfig: wechatPaths.configPath(),
      methods: [...methodMap.keys()].sort(),
      llmConfigured: context.llm?.configured ?? false,
      /**
       * 入参守卫的影子账本（P2-7 的 ② 档靠它拿证据）：
       * `covered/total` 是 schema 覆盖数，`mismatched` 是真实调用中的形状失配，
       * `largest` 是每条方法的历史最大参数体积。
       */
      argGuard: argsGuard.snapshot(argSchemas ? argSchemas.size : 0, methodMap.size, ENFORCED_SCHEMA_METHODS),
    };
  };
}

/** 生成后端实例的 call()：入参双档校验、结果缓存、慢调用审计与配置镜像。 */
function createBackendCall({
  gateway,
  methodMap,
  argSchemas,
  decodeInputSig,
  recordSlowCall,
  SLOW_LOG_MS,
}) {
  return async function call(method, args = [], callHandle = '') {
    const implName = methodMap.get(method);
    if (!implName) {
      return { ok: false, error: { message: `未知的 Super Time 后台方法: ${method}` } };
    }
    const fn = gateway[implName];
    // ① 结构与体积：这一档**总是**拒绝（渲染进程不是可信调用方）。
    const guard = argsGuard.guardCallArgs(args);
    if (!guard.ok) {
      console.warn('[wechat] 入参被拒 %s：%s', method, guard.message);
      return { ok: false, error: { message: guard.message, code: guard.code, details: { method } } };
    }
    const callArgs = injectFallbackJobId(method, guard.value, callHandle);
    argsGuard.observe(method, guard.bytes);
    // ② 形状（生成的 zod schema）：默认只记账；只有显式白名单里的方法才硬拒。
    const verdict = argsGuard.checkSchema(argSchemas, implName, callArgs, ENFORCED_SCHEMA_METHODS);
    if (verdict.verdict === 'mismatch') {
      argsGuard.noteSchema(implName, verdict.message ?? 'schema 判定不通过');
      if (verdict.code) {
        console.warn('[wechat] 入参形状被拒 %s：%s', method, verdict.message);
        return { ok: false, error: { message: verdict.message, code: verdict.code, details: { method } } };
      }
    } else if (verdict.verdict === 'ok') {
      argsGuard.noteSchema(implName, null);
    }
    const cacheKey = resultCacheKey(method, callArgs, decodeInputSig());
    if (cacheKey) {
      const cached = readResultCache(cacheKey);
      if (cached !== null) return cached;
    }
    const startedAt = Date.now();
    try {
      const value = await fn.apply(gateway, callArgs);
      // 慢调用打点：这些方法都在后端进程里同步跑，偏慢的要能看见。
      const cost = Date.now() - startedAt;
      if (cost > SLOW_LOG_MS) {
        console.warn(`[wechat] 慢调用 ${method} 耗时 ${cost}ms`);
        /**
         * H2：同一笔慢调用也落进审计表。
         *
         * 只记 `status: 'ok'` 的慢调用吗？不 —— 失败的慢调用同样是瓶颈证据，
         * 所以这里不区分成败，只在 `category` 上用 `error` 把它和成功那批分开。
         */
        if (recordSlowCall) {
          try {
            recordSlowCall(gateway._dirs.decrypted, {
              category: 'error',
              action: 'slow_call',
              status: 'ok',
              target: method,
              detail: `Remote 调用耗时 ${cost}ms`,
              durationMs: cost,
            });
          } catch (e) {
            console.warn('[wechat] 记慢调用进审计表失败:', e?.message ?? e);
          }
        }
      }
      // 数据配置保存成功后，把「非密钥」设置镜像到 wechat/config.json。
      // 密钥类字段由 wechat-paths.js 的 SECRET_SETTING_KEYS 过滤掉。
      if (method === 'saveWechatConfig' && value && value.ok !== false) {
        const patch = callArgs[0]?.patch ?? callArgs[0];
        if (patch && typeof patch === 'object') {
          try {
            wechatPaths.recordWechatSettings(patch);
          } catch (e) {
            console.warn('[wechat] 记录设置到 wechat/config.json 失败:', e);
          }
        }
        // 保存配置可能改了图片 AES/XOR 密钥，而这里的缓存存的是已解码结果。
        clearResultCache();
      }
      const result = { ok: true, value };
      if (cacheKey) writeResultCache(cacheKey, result);
      return result;
    } catch (err) {
      const e = err || new Error('未知错误');
      const result = {
        ok: false,
        error: {
          message: readableCallError(method, e),
          code: typeof e.code === 'string' ? e.code : undefined,
          details: e.details ?? undefined,
        },
      };
      // 负缓存：真的解不出来的图不要每次重挂载都再全量扫一遍。
      if (cacheKey) writeResultCache(cacheKey, result);
      return result;
    }
  };
}

/** 生成后端实例的取消接口，保留 `this._cancelJob` 的转发关系。 */
function createBackendCancel(gateway) {
  return {
    /**
     * 主进程 RPC 超时后的尽力取消。
     *
     * 显式带 jobId 的方法按原标识打断；调用方没传 jobId 的可取消方法，宿主会在执行时
     * 注入一个 RPC 序号派生的内部 jobId，超时后再用同一序号找回它。
     */
    async cancelCall(method, args = [], callHandle = '') {
      const plan = cancelPlanFor(method, args);
      if (!plan.ok && plan.reason === 'no-job-id') {
        const jobId = jobIdForCall(method, args, callHandle);
        if (jobId) {
          return this._cancelJob(plan.method, jobId);
        }
      }
      if (!plan.ok) return plan;
      const cancelFn = gateway[plan.method];
      if (typeof cancelFn !== 'function') {
        return { ok: false, reason: 'cancel-method-missing', method: plan.method, jobId: plan.jobId };
      }
      return this._cancelJob(plan.method, plan.jobId, cancelFn);
    },
    /**
     * 调一个取消 Remote，并把成功/失败折叠成宿主取消回执。
     */
    async _cancelJob(cancelMethod, jobId, cancelFn) {
      const fn = cancelFn || gateway[cancelMethod];
      if (typeof fn !== 'function') {
        return { ok: false, reason: 'cancel-method-missing', method: cancelMethod, jobId };
      }
      try {
        const result = await fn.call(gateway, { jobId });
        const ok = Boolean(result && result.ok !== false);
        const reason = result && (result.message || result.error)
          ? String(result.message || result.error)
          : undefined;
        return {
          ok,
          ...(reason ? { reason } : {}),
          method: cancelMethod,
          jobId,
        };
      } catch (e) {
        return {
          ok: false,
          reason: e?.message ?? String(e),
          method: cancelMethod,
          jobId,
        };
      }
    },
  };
}

async function createWechatBackend(options = {}) {
  const {
    protocol,
    argSchemas,
    context,
    gateway,
    mod,
    recordSlowCall,
    SLOW_LOG_MS,
  } = await loadBackendRuntime(options);
  const decodeInputSig = createDecodeInputSig(gateway);
  const methodMap = buildMethodMap(protocol, gateway);
  const cancel = createBackendCancel(gateway);
  /**
   * 原图自动下载（实验）的启动/收尾钩子。
   *
   * 为什么放在宿主而不是 gateway：注入是**进程级副作用**，必须跟着后端进程的
   * 生命周期走 —— 进程退出/宿主 dispose 时要调 `UninstallImgHelper` 还原微信进程
   * （见 `query/wechat-image-autodownload.ts`）。开关持久在数据根 config.json 里，
   * 上次打开过就在这里恢复；未打开时返回 null，连 koffi 都不会加载。
   */
  const imageAutoDownload = (() => {
    try {
      return mod.startWechatImageAutoDownloadOnBoot?.(gateway._dirs.decrypted) ?? null;
    } catch {
      return null;
    }
  })();
  bootTrace('backend:assembled');

  return {
    gateway,
    context,
    methodNames() {
      return [...methodMap.keys()].sort();
    },
    info: createBackendInfo(gateway, context, methodMap, argSchemas),
    call: createBackendCall({
      gateway,
      methodMap,
      argSchemas,
      decodeInputSig,
      recordSlowCall,
      SLOW_LOG_MS,
    }),
    ...cancel,
    dispose() {
      try {
        imageAutoDownload?.stop?.();
      } catch {
        /* 尽力还原微信进程 */
      }
      try {
        context.dispose();
      } catch {
        /* 尽力释放 */
      }
    },
  };
}


/**
 * 已知错误的翻译表（N30 的第一条 + W3-11.6 扩到 8 条）。
 *
 * 为什么是表而不是一串 if：这类「底层英文 → 去哪做什么」的映射只有一个正确形态 ——
 * 每来一种新错误就补一行；而**表**让「覆盖了哪些形态」变成可数、可断言的（见
 * `host-error-message.spec.ts` 的「表不许缩水」那条），if 链则会安静地只剩第一条。
 *
 * 三条纪律（与 N30 立项时一致，扩表不破）：
 *   ① 每条都要说「去哪做什么」，并且**保留原始错误**（可诊断，用户截图也够定位）；
 *   ② **表外一律原样透传** —— 猜错形态会把真实故障说成「未配置」，比英文原文更有害；
 *   ③ 每条的正则都要窄：宁可漏（漏了还有原始错误），不可把一个真实故障套上错的处方。
 *
 * ⚠ 加条目前先问：这个形态**真的会出现吗**？本表的每一条都对应一类真实可见的首启/运行态
 * （没配数据源、解密中断、并发读写、只读介质、文件被占用、磁盘满、权限不足），
 * 不是把 SQLite 文档里的错误码抄一遍。
 */
const READABLE_ERRORS = [
  {
    re: /unable to open database file|SQLITE_CANTOPEN/i,
    say: '读不到本机的微信数据：请先在「数据配置」中设置数据目录并完成解密',
  },
  {
    re: /file is not a database|SQLITE_NOTADB|SQLITE_CORRUPT|database disk image is malformed/i,
    say: '这个库文件已损坏（常见于解密中途被打断）：请到「数据库健康」体检，必要时对该库重新解密',
  },
  {
    re: /database is locked|SQLITE_BUSY/i,
    say: '有其它任务正在读写这个库（解密 / 建索引 / 导出进行中都会这样）：请等它跑完再试',
  },
  {
    re: /SQLITE_READONLY|attempt to write a readonly database/i,
    say: '数据目录是只读的（可能位于只读介质或被同步策略锁住）：请把数据根改到可写目录后重试',
  },
  {
    re: /\bEPERM\b|\bEBUSY\b/i,
    say: '文件正被其它程序占用（Windows 上常见于杀软扫描或资源管理器预览）：请关闭占用它的程序后重试',
  },
  {
    re: /\bENOSPC\b|no space left/i,
    say: '磁盘空间不足（导出与解密都需要临时空间）：请清理出空间后再试',
  },
  {
    re: /\bEACCES\b|permission denied/i,
    say: '没有读写权限：请检查数据目录的权限（本应用只以当前用户身份访问，不会提权）',
  },
  {
    re: /\bEMFILE\b|too many open files/i,
    say: '同时打开的文件太多了：请关闭一些面板或浏览器窗口后重试；若反复出现请重启应用',
  },
];

/**
 * 把底层英文错误翻译成用户能照着做的一句话。
 *
 * 为什么得有这一层：面板把 `error.message` 原样渲染进 `role="alert"`（`Chats` / `Contacts`
 * 等皆是），而「还没配置数据目录 / 还没解密」是**每个查询面板都会撞到**的首启状态 ——
 * `node:sqlite` 的原文是 `unable to open database file`，用户既看不懂也不知道下一步做什么。
 * 只在这一处翻译，所有 Remote 方法一起受益。**只翻译表内已知的形态，其余原样透传** ——
 * 不猜、不美化，避免把真实故障说成「未配置」。
 *
 * @param {string} method - Remote 方法名（只用于留痕）。
 * @param {Error} e - 原始错误。
 * @returns {string} 可直接显示的消息。
 */
function readableCallError(method, e) {
  const raw = (e && e.message) || String(e);
  for (const { re, say } of READABLE_ERRORS) {
    if (re.test(raw)) return say + '（原始错误：' + raw + '）';
  }
  return raw;
}

/**
 * 结果缓存的把手（导出给单测）。
 *
 * 为什么导出：这几条策略（键构造、读写、定向失效）值得单独锁住，而通过真实图片数据去
 * 间接观察既慢又不稳；这里只交出**函数**，内部 `resultCache` 本身不外泄。
 * @returns 结果缓存的键构造 / 读写 / 失效入口。
 */
function resultCacheHandles() {
  return {
    key: resultCacheKey,
    read: readResultCache,
    write: writeResultCache,
    clearStale: clearStaleResultCache,
    clearAll: clearResultCache,
    size: () => resultCache.size,
    stats: () => ({ size: resultCache.size, chars: resultCacheChars }),
  };
}
module.exports = {
  createWechatBackend,
  createLlmBridge,
  createMiniContext,
  /** 单测入口（见 resultCacheHandles 的说明）。 */
  resultCacheHandles,
  /** 单测入口：错误文案翻译（见 readableCallError 的说明）。 */
  readableCallError,
};

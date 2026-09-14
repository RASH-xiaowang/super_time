'use strict';

/**
 * Super Time —— 「微信+」后端宿主适配层
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
const wechatPaths = require('./wechat-paths');
const { fetchWithRetry } = require('./llm-retry');

/** 每次重试打一条日志：重试过程不上界面（成功的重试应当无感），但诊断日志里要留痕。 */
function logRetry(what) {
  return (info) => {
    console.warn(`[llm] ${what} 请求失败（${info.reason}），${info.delayMs}ms 后重试（第 ${info.attempt} 次尝试）`);
  };
}

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
 * 两条边界：
 *   - 单条结果超过 512KB（例如整段视频的 base64）不入缓存，不把大对象钉在内存里；
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
const resultCache = new Map();

/** 整体失效：只用于「解码结果整体作废」的场合（图片密钥变更）。 */
function clearResultCache() {
  resultCache.clear();
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
    if (VOLATILE_CACHE_METHODS.has(method) || (result && result.ok === false)) resultCache.delete(key);
  }
}

function resultCacheKey(method, callArgs) {
  if (!CACHEABLE_METHODS.has(method)) return null;
  try {
    return method + '\u0000' + JSON.stringify(callArgs);
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
  const value = result?.value;
  const payload = value && typeof value === 'object' ? (value.url ?? value.data ?? null) : null;
  if (typeof payload === 'string' && payload.length > RESULT_CACHE_MAX_CHARS) return;
  if (resultCache.has(key)) resultCache.delete(key);
  while (resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next();
    if (oldest.done) break;
    resultCache.delete(oldest.value);
  }
  resultCache.set(key, result);
}

/** 可注入的 LLM 桥接配置（wechat/llm.json 优先，其次环境变量/覆盖参数）。 */
function llmConfigFromEnv(overrides = {}) {
  const file = wechatPaths.loadLlmConfig();
  return {
    provider: overrides.provider || file.provider || process.env.SUPERTIME_LLM_PROVIDER || 'openai-compat',
    model: overrides.model || file.model || process.env.SUPERTIME_LLM_MODEL || '',
    apiKey: overrides.apiKey || file.apiKey || process.env.SUPERTIME_LLM_API_KEY || '',
    baseUrl: overrides.baseUrl || file.apiUrl || process.env.SUPERTIME_LLM_API_URL || 'https://api.openai.com/v1',
    apiPath: overrides.apiPath || file.apiPath || process.env.SUPERTIME_LLM_API_PATH || '/chat/completions',
    embeddingModel: overrides.embeddingModel || file.embeddingModel || process.env.SUPERTIME_LLM_EMBED_MODEL || '',
    embedPath: overrides.embedPath || file.embedPath || process.env.SUPERTIME_LLM_EMBED_PATH || '/embeddings',
    timeoutMs: Number(overrides.timeoutMs || file.timeoutMs || process.env.SUPERTIME_LLM_TIMEOUT_MS || 120_000),
  };
}

/** 把 dsh-llm 的 Message 内容块转成 OpenAI 聊天消息。 */
function toOpenAiMessage(message) {
  const content = Array.isArray(message.content)
    ? message.content.map((part) => part.text ?? '').join('')
    : String(message.content ?? '');
  return { role: message.role ?? 'user', content };
}

/**
 * 极简 LLM 桥：未配置时方法抛错（与上游“未配置默认模型”一致）；
 * 配置了 SUPERTIME_LLM_* 时走 OpenAI 兼容的 /chat/completions。
 *
 * stream() 是**真流式**：以 `stream: true` 发请求并按 SSE 逐块 yielding text-delta，
 * 调用方（gateway）因此可以在生成过程中把增量推给界面。
 * 厂商不支持 SSE 时自动退化为整段返回 —— 一次 yield 完整 text。
 */
function createLlmBridge(configOverrides = {}) {
  /** 组装一次请求所需的 URL / headers / body。 */
  function buildRequest(opts, streamMode) {
    const cfg = llmConfigFromEnv(configOverrides);
    const configured = Boolean(cfg.model && (cfg.apiKey || cfg.baseUrl));
    if (!configured) {
      throw new Error('LLM 未配置：请在「微信问答 → 模型配置」中填写模型与 API Key');
    }
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      ...(opts.messages || []).map(toOpenAiMessage),
    ];
    const url = cfg.baseUrl.replace(/\/+$/, '') + (cfg.apiPath.startsWith('/') ? cfg.apiPath : '/' + cfg.apiPath);
    const headers = { 'content-type': 'application/json', accept: streamMode ? 'text/event-stream' : 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    return {
      cfg,
      url,
      headers,
      controller,
      clear: () => clearTimeout(timer),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: opts.model || cfg.model,
          messages,
          max_tokens: opts.maxTokens ?? 2048,
          stream: streamMode,
        }),
        signal: controller.signal,
      },
    };
  }

  async function fetchCompletion(opts) {
    const req = buildRequest(opts, false);
    try {
      // 有界重试：网络抖动 / 429 / 5xx 自动重来，401/400 这类立刻失败。
      // 整体超时仍由 req.init.signal 控制（重试在 signal 中止时立即停止）。
      const res = await fetchWithRetry(fetch, req.url, req.init, { onRetry: logRetry('chat') });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const payload = await res.json();
      return payload?.choices?.[0]?.message?.content ?? '';
    } finally {
      req.clear();
    }
  }

  async function* stream(opts) {
    const req = buildRequest(opts, true);
    let res;
    try {
      // 只对**握手**做重试：一旦开始吐 chunk 就不能重来（会重复输出内容）。
      res = await fetchWithRetry(fetch, req.url, req.init, { onRetry: logRetry('chat(stream)') });
    } catch (e) {
      req.clear();
      throw e;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      req.clear();
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    const contentType = String(res.headers.get('content-type') || '');
    // 厂商忽略 stream:true 直接返回整段 JSON 时走这里（也覆盖 res.body 为空的情况）
    if (!res.body || !contentType.includes('event-stream')) {
      try {
        const payload = await res.json();
        const text = payload?.choices?.[0]?.message?.content ?? '';
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: 'stop' };
      } finally {
        req.clear();
      }
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        // SSE 以空行分隔事件；这里逐行处理 `data:` 负载即可（OpenAI 兼容格式）
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let delta = '';
          try {
            const parsed = JSON.parse(data);
            delta = parsed?.choices?.[0]?.delta?.content
              ?? parsed?.choices?.[0]?.message?.content
              ?? '';
          } catch {
            continue;   // 心跳/非 JSON 行忽略
          }
          if (!delta) continue;
          full += delta;
          yield { type: 'text-delta', index: 0, text: delta };
        }
      }
    } finally {
      req.clear();
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: full } };
    yield { type: 'finish', reason: 'stop' };
  }

  /**
   * 向量化（RAG 稠密检索通道）：OpenAI 兼容的 POST {baseUrl}{embedPath}。
   *
   * 与 chat 调用共用 llm.json 的 baseUrl/apiKey；模型取 embeddingModel，
   * 留空则回退到 chat model（部分厂商同一模型名即可向量化）。
   * 出网点由上层（gateway 的隐私闸门）决定是否允许 —— 本函数只负责发请求。
   * @param {string[]} texts - 待向量化文本。
   * @param {{model?: string}} [opts] - 覆盖模型。
   * @returns {Promise<number[][]>} 每条文本对应的向量。
   */
  async function embed(texts, opts = {}) {
    const cfg = llmConfigFromEnv(configOverrides);
    const model = opts.model || cfg.embeddingModel || cfg.model;
    if (!model || (!cfg.apiKey && !cfg.baseUrl)) {
      throw new Error('未配置 embedding（请在「微信问答 → 模型配置」填写向量模型或 API Key）');
    }
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
    if (list.length === 0) return [];
    const url = cfg.baseUrl.replace(/\/+$/, '') + (cfg.embedPath.startsWith('/') ? cfg.embedPath : '/' + cfg.embedPath);
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchWithRetry(fetch, url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: list }),
        signal: controller.signal,
      }, { onRetry: logRetry('embedding') });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`embedding HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const payload = await res.json();
      const data = Array.isArray(payload?.data) ? payload.data : [];
      // 按 index 排序保证与输入顺序一致（部分厂商不保证返回顺序）。
      const sorted = data.slice().sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
      return sorted.map((d) => (Array.isArray(d?.embedding) ? d.embedding : []));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get configured() {
      const cfg = llmConfigFromEnv(configOverrides);
      return Boolean(cfg.model && (cfg.apiKey || cfg.baseUrl));
    },
    get config() {
      return llmConfigFromEnv(configOverrides);
    },
    stream,
    embed,
    async generate(opts) {
      return { content: await fetchCompletion(opts) };
    },
    listConfigurableProviders() {
      const cfg = llmConfigFromEnv(configOverrides);
      const ok = Boolean(cfg.model && (cfg.apiKey || cfg.baseUrl));
      return ok ? [{ provider: cfg.provider, model: cfg.model }] : [];
    },
    async listModels(provider) {
      const cfg = llmConfigFromEnv(configOverrides);
      if (!cfg.model) return [];
      if (provider && provider !== cfg.provider) return [];
      return [{ id: cfg.model }];
    },
  };
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
 * 收紧 SQLite 页缓存（主进程内存的主要可回收项）。
 *
 * WeChatDataGateway 在 100+ 处按调用点 `new DatabaseSync(...)` 打开短连接，而
 * node:sqlite 的默认 `cache_size` 是 -2000（每连接 2MB 页缓存）。连接关闭后这
 * 部分原生内存大部分不会归还操作系统，于是主进程 RSS 随查询次数被不断抬升，
 * 一次全页签遍历即可多占数十 MB 且不回落。
 *
 * 这里在加载 bundle 之前替换 node:sqlite 的 DatabaseSync 导出：每个连接建好后
 * 立刻把页缓存压到 256KB。bundle 内部是
 * `import { DatabaseSync } from "node:sqlite"`，其 ESM 外观在首次 import 时
 * 由 CJS 导出生成，因此在 import 之前替换即可被 bundle 取到（已有脚本实测验证：
 * bundle 内新建连接读回 `cache_size = -256`）。
 *
 * 可用 DSH_WECHAT_SQLITE_CACHE_KB 调整；设为 0 或负数则不干预。
 */
let sqlitePageCachePatched = false;
function applySqlitePageCacheLimit() {
  if (sqlitePageCachePatched) return;
  const kb = Number(process.env.DSH_WECHAT_SQLITE_CACHE_KB ?? 256);
  if (!Number.isFinite(kb) || kb <= 0) return;
  try {
    const sqlite = require('node:sqlite');
    const Original = sqlite.DatabaseSync;
    sqlite.DatabaseSync = new Proxy(Original, {
      construct(target, args) {
        const db = Reflect.construct(target, args);
        try {
          db.exec(`PRAGMA cache_size = -${Math.floor(kb)}`);
        } catch {
          /* 个别连接可能不接受该 PRAGMA，忽略即可 */
        }
        return db;
      },
    });
    sqlitePageCachePatched = true;
  } catch (e) {
    console.warn('[wechat] 收紧 SQLite 页缓存失败:', e?.message ?? e);
  }
}

/**
 * 创建「微信+」后端实例。
 * @param {object} options
 * @param {string} [options.userDataPath] - Electron app.getPath('userData')，
 *   非 Electron 环境默认 ~/.dsh（与上游一致）。
 * @param {function} [options.onEvent] - 接收 gateway.emit 事件（如 wechat-data/updated）。
 * @param {object} [options.llmConfig] - SUPERTIME_LLM_* 环境变量之外的显式配置。
 * @returns {{gateway, methodNames, info, call, dispose}}
 */
async function createWechatBackend(options = {}) {
  const userHome = options.userDataPath || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  // 状态目录（config.json / llm.json）必须和主进程解析到同一个：
  // 都以 userData 为根。不显式配置的话本进程会落到默认 ~/.dsh，
  // 于是主进程写一份、后端读另一份，改了配置像没生效。
  wechatPaths.configure({ userDataPath: userHome });
  // 数据根默认布局：<DSH_HOME>/wechat-data（即应用 userData/wechat-data）。
  if (!process.env.DSH_HOME) process.env.DSH_HOME = userHome;

  // 必须在 import bundle 之前收紧页缓存，否则 bundle 已绑定原始导出。
  applySqlitePageCacheLimit();

  const mod = await import('./wechat-data/lib/index.js');
  const protocol = await import('@deepseek-ai/dsh-typert-protocol');
  const context = createMiniContext(options);
  const gateway = new mod.WechatDataGateway(context);

  const methodMap = new Map();
  for (const marker of protocol.remoteMethods(gateway)) {
    const name = marker.exportName || marker.method;
    methodMap.set(name, marker.method);
  }

  return {
    gateway,
    context,
    methodNames() {
      return [...methodMap.keys()].sort();
    },
    info() {
      const root = path.dirname(gateway._dirs.decrypted);
      return {
        root,
        decrypted: gateway._dirs.decrypted,
        decoded: gateway._dirs.decoded,
        selfUsername: gateway._selfUsername,
        pathConfig: wechatPaths.configPath(),
        methods: [...methodMap.keys()].sort(),
        llmConfigured: context.llm?.configured ?? false,
      };
    },
    async call(method, args = []) {
      const implName = methodMap.get(method);
      if (!implName) {
        return { ok: false, error: { message: `未知的微信+后台方法: ${method}` } };
      }
      const fn = gateway[implName];
      const callArgs = Array.isArray(args) ? args : [args];
      const cacheKey = resultCacheKey(method, callArgs);
      if (cacheKey) {
        const cached = readResultCache(cacheKey);
        if (cached !== null) return cached;
      }
      const startedAt = Date.now();
      try {
        const value = await fn.apply(gateway, callArgs);
        // 慢调用打点：这些方法都在后端进程里同步跑，偏慢的要能看见。
        const cost = Date.now() - startedAt;
        if (cost > 1000) {
          console.warn(`[wechat] 慢调用 ${method} 耗时 ${cost}ms`);
        }
        // 数据配置保存成功后，把「非密钥」设置镜像到 wechat/config.json 供用户查看与手工编辑。
        // 密钥类字段由 wechat-paths.js 的 SECRET_SETTING_KEYS 过滤掉 —— 它们有单独的、
        // 受权限保护的 secrets.json（见 query/config.ts 的 SECRET_FIELDS）。
        if (method === 'saveWechatConfig' && value && value.ok !== false) {
          const patch = callArgs[0]?.patch ?? callArgs[0];
          if (patch && typeof patch === 'object') {
            try {
              wechatPaths.recordWechatSettings(patch);
            } catch (e) {
              console.warn('[wechat] 记录设置到 wechat/config.json 失败:', e);
            }
          }
          // 保存配置可能改了图片 AES/XOR 密钥，而这里的缓存存的是**已解码**的结果
          // （解码结果随密钥而变）。判据不在这里区分「密钥是否真变了」—— 那要知道后端的
          // 默认值口径（`image_xor_key` 的 136），抄一份只会漂移；保存配置是用户手动、
          // 低频的操作，整体清空换来的代价只是这一次重新解码。
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
            message: e.message || String(e),
            code: typeof e.code === 'string' ? e.code : undefined,
            details: e.details ?? undefined,
          },
        };
        // 负缓存：真的解不出来的图不要每次重挂载都再全量扫一遍。
        if (cacheKey) writeResultCache(cacheKey, result);
        return result;
      }
    },
    dispose() {
      try {
        context.dispose();
      } catch {
        /* 尽力释放 */
      }
    },
  };
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
  };
}

module.exports = {
  createWechatBackend,
  createLlmBridge,
  createMiniContext,
  applySqlitePageCacheLimit,
  /** 单测入口（见 resultCacheHandles 的说明）。 */
  resultCacheHandles,
};

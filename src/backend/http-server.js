/**
 * 局域网远程访问（手机端）的 HTTP 服务。
 *
 * ## 它是什么、不是什么
 *
 * 它把**桌面端已经在用的那一套后端方法**通过 HTTP 暴露给同一局域网里的手机浏览器，
 * 让手机加载**同一份渲染层产物**（`src/client/ui-dist`，与 Electron `loadFile` 的是同一份）。
 * 它不是「另一个后端」：所有调用最终都走 `call-gates.js` 的同一道闸门序列
 * （后端就绪等待 → 调试豁免 → 许可证授权），再进同一个单线程 worker。
 *
 * 所以手机上能看到什么，由**令牌**（是不是主人给的）与**会话权限标记**决定：
 * 非 fullAccess 会话走方法白名单；fullAccess 延续桌面权限，但八个 Agent 方法仅允许桌面 IPC。
 *
 * 当前标题栏「打开网页」交接码与设置页局域网扫码都会签发 `fullAccess` 会话
 * （全部方法 + `/api/native/*`）；长期 `api_token` 登录得到的会话按白名单收口。
 *
 * ## 默认关闭，且需要两个条件同时成立
 *
 * 启动监听要求 `api_enabled === true` **并且** `api_token` 非空。
 *
 * 为什么要多加「令牌非空」这一条：`api_enabled` 这个键在 2026-09-15（N24）之前
 * 是**界面上可见的**，那批用户的 `config.json` 里至今还留着一条 `"api_enabled": true`
 * —— 而这个键从那时起到现在**没有任何消费者**（N24 的原文：「看着像功能，实际全仓没有
 * 消费者」）。只判 `api_enabled` 的话，本模块上线的那一刻，那批机器会**在用户从未点过
 * 任何新开关的情况下**开始监听端口。令牌只能由设置界面显式生成，于是「用户主动打开过」
 * 变成了一个硬条件。
 *
 * ## 传输与鉴权形态
 *
 * - 静态资源**不需要**鉴权（渲染层产物不是秘密，安装包里就有）；
 * - 除 `POST /api/auth`、`GET /api/rpa-media/<token>` 与
 *   `GET|POST /api/message-webhook/<token>` 外的所有 `/api/*` 都要求**有效会话 Cookie**。
 *   后两者分别服务 RPA 图片直链与消息列表入站 Webhook：外部系统拿不到 Cookie，凭据只能放在
 *   URL 里（HMAC 路径令牌，轮换 api_token 即失效）；
 * - 事件通道用 **SSE**（`EventSource`）而不是 WebSocket：7 类事件全是单向 server→client，
 *   `EventSource` 是浏览器内建、自带重连、零依赖（本仓无 express/ws，新增运行时依赖要
 *   逐个登记进打包白名单）。代价是它**不能自定义 header** ⇒ 凭据只能用 Cookie。
 * - 明文 HTTP、无 TLS：见 `http-auth.js` 文件头与 `docs/PRIVACY.md` 第四节 H。
 *
 * @module backend/http-server
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  SESSION_COOKIE,
  createPairingStore,
  createSessionStore,
  maskToken,
  parseCookies,
  safeEquals,
} = require('./http-auth.js');
const { createCallQueue, HEAVY_PRIORITY } = require('./http-queue.js');
const { downgradeHeavyByArgs, shouldBypassCallQueue } = require('./call-priority.js');
const { NATIVE_CAPABILITIES, REMOTE_DENIED_CODE, isRemoteHeavy, isHttpCallAllowed } = require('./http-remote-policy.js');
const { connectionCancelPlanFor } = require('./wechat-cancel.js');
const { MIME_BY_EXT, ensureThumb, parseThumbWidth, resolveDecodedFile } = require('./media-protocol.js');
const { RPA_MEDIA_PATH_PREFIX, createRpaMediaHandler } = require('./rpa-media.js');
const { MESSAGE_WEBHOOK_PATH_PREFIX, createMessageWebhookHandler } = require('./message-webhook.js');
const { resolveStaticFile, sendFile } = require('./http-static.js');
const { allowBrowserRequest } = require('./http-request-guard.js');
const { writeFileAtomic } = require('./atomic-json.js');
const { beginMutation, checkMutation, bumpMutationEpoch } = require('./mutation-gate.js');

const {
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  MESSAGE_WEBHOOK_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  ADDRESS_WATCH_MS,
  lanAddresses,
  readRemoteAccessConfig,
  isHostAllowed,
  sendJson,
  readBody,
  createAuthLimiter,
} = require('./http-network-config.js');

/** 端口被占用时往后试多少个（5032…5042）。 */
const PORT_ATTEMPTS = 11;

/** 无凭据的运行期监听快照；后端 worker 用它生成可达的 Webhook / 媒体直链。 */
const REMOTE_ACCESS_RUNTIME_FILE = 'http-runtime.json';

/** SSE 心跳间隔：比常见代理/移动网络的空闲断开阈值短，让连接不被中间设备掐掉。 */
const SSE_HEARTBEAT_MS = 25_000;
/**
 * SSE 连接上限。
 *
 * 浏览器每个标签页、每个面板都可能开一条 EventSource；手机端被恶意脚本/失控页面
 * 刷连接时，主进程会为每条连接保留一个响应句柄与心跳写循环。全局上限挡住总量，
 * 单会话上限挡住「一个 Cookie 刷爆」。超限直接 503，不排队。
 */
const MAX_SSE_CLIENTS = 32;
const MAX_SSE_PER_SESSION = 4;

/**
 * 入站 Webhook 的鉴权失败限速：令牌在 URL 里，先验签再读 body。
 * 30 次/分钟足以覆盖外部系统重试，又能挡住拿错误令牌刷 30MB body 的脚本。
 */
const WEBHOOK_AUTH_WINDOW_MS = 60_000;
const WEBHOOK_AUTH_MAX_FAILURES = 30;

/**
 * 入站 Webhook 的鉴权顺序是「先验 URL 令牌、再读 body」：令牌无效时**一个字节**
 * 的请求体都不读（等价于预认证上限 0，比 1MB 更严）。只有验签通过后才按
 * `MESSAGE_WEBHOOK_BODY_BYTES`（30MB，覆盖附件 base64 膨胀）读取。
 */

/** 入站 Webhook 令牌模块（构建产物，ESM dynamic import；与 message-webhook.js 同源）。 */
let webhookTokenModulePromise = null;
function loadWebhookTokenModule() {
  if (webhookTokenModulePromise === null) {
    webhookTokenModulePromise = import('./wechat-data/lib/net/message-webhook.js').catch((e) => {
      webhookTokenModulePromise = null;
      throw e;
    });
  }
  return webhookTokenModulePromise;
}

/**
 * 先验 URL 令牌（不读 body）。
 * @returns {Promise<boolean>} 令牌有效时为 true。
 */
async function verifyMessageWebhookToken(deps, ctx, token) {
  const cfg = readRemoteAccessConfig(deps.getDataRoot());
  if (cfg.token === '' || typeof token !== 'string' || token === '') return false;
  try {
    const mod = await loadWebhookTokenModule();
    return mod.verifyMessageWebhookToken(cfg.token, token) === true;
  } catch (e) {
    ctx.warn('[remote-access] Webhook 令牌校验模块不可用：%s', e?.message ?? e);
    return false;
  }
}

/** 入站 Webhook 的失败窗口限速（与登录限速分开，互不影响）。 */
function createWebhookAuthLimiter() {
  /** @type {Map<string, number[]>} ip → 失败时刻 */
  const hits = new Map();
  return {
    ok(ip) {
      const list = hits.get(ip);
      if (!list) return true;
      const cutoff = Date.now() - WEBHOOK_AUTH_WINDOW_MS;
      const recent = list.filter((t) => t > cutoff);
      if (recent.length === 0) hits.delete(ip);
      else hits.set(ip, recent);
      return recent.length < WEBHOOK_AUTH_MAX_FAILURES;
    },
    fail(ip) {
      const list = hits.get(ip) || [];
      list.push(Date.now());
      hits.set(ip, list);
    },
    succeed(ip) {
      hits.delete(ip);
    },
    reset() {
      hits.clear();
    },
  };
}
/**
 * 运行期共享状态：路由、生命周期与组合根之间只经这一个对象通信，
 * 不再把几十个闭包变量全部塞进 `createRemoteAccessServer`。
 */
function createServerContext(deps) {
  const log = deps.log || ((m, ...r) => console.log(m, ...r));
  const warn = deps.warn || ((m, ...r) => console.warn(m, ...r));
  return {
    log,
    warn,
    sessions: createSessionStore(),
    pairings: deps.pairings || createPairingStore(),
    queue: deps.callQueue || createCallQueue(),
    limiter: deps.authLimiter || createAuthLimiter(),
    webhookLimiter: createWebhookAuthLimiter(),
    /**
     * RPA 图片签名直链（路由 + Host 例外名单）。放这儿而不是 `createRemoteAccessServer`：
     * 路由的 Host 校验与 `/api/` 分支都要用它，走同一个对象才不会两处各建一份。
     */
    rpaMedia: createRpaMediaHandler({
      getDecodedRoot: () => (typeof deps.getDecodedRoot === 'function' ? String(deps.getDecodedRoot() ?? '') : ''),
      getMediaConfig: () => readRemoteAccessConfig(deps.getDataRoot()),
    }),
    /**
     * 消息列表局域网 Webhook：同样在会话 Cookie 之前验 URL 令牌；落库与投递仍走
     * `deps.gatedCall`，与桌面/手机共用同一道后端就绪与许可闸门。
     */
    messageWebhook: createMessageWebhookHandler({
      getApiToken: () => readRemoteAccessConfig(deps.getDataRoot()).token,
      ingest: (payload) => deps.gatedCall('ingestMessageListWebhook', [payload]),
    }),
    /** @type {Set<http.ServerResponse>} SSE 客户端 */
    sseClients: new Set(),
    /** @type {Map<string, Set<http.ServerResponse>>} 会话 Cookie（或来源 IP）→ 该会话的 SSE 客户端 */
    sseBySession: new Map(),
    maxSseClients: Number.isSafeInteger(deps.maxSseClients) && deps.maxSseClients > 0
      ? deps.maxSseClients
      : MAX_SSE_CLIENTS,
    maxSsePerSession: Number.isSafeInteger(deps.maxSsePerSession) && deps.maxSsePerSession > 0
      ? deps.maxSsePerSession
      : MAX_SSE_PER_SESSION,
    state: {
      running: false,
      port: 0,
      address: '',
      preferredPort: DEFAULT_PORT,
      enabled: false,
      hasToken: false,
      startedAt: 0,
    },
    server: null,
    heartbeat: null,
    reconcileTimer: null,
    lifecycleTail: Promise.resolve(),
  };
}

/**
 * 把一个 SSE 客户端从全局表与会话表里同时摘掉（不销毁连接）。
 * @param {object} ctx - 服务上下文。
 * @param {http.ServerResponse} res - SSE 响应。
 */
function removeSseClient(ctx, res) {
  ctx.sseClients.delete(res);
  for (const [key, set] of ctx.sseBySession) {
    set.delete(res);
    if (set.size === 0) ctx.sseBySession.delete(key);
  }
}

/**
 * 摘掉客户端并销毁连接（慢客户端/写失败）。
 * @param {object} ctx - 服务上下文。
 * @param {http.ServerResponse} res - SSE 响应。
 */
function dropSseClient(ctx, res) {
  removeSseClient(ctx, res);
  try { res.destroy(); } catch { /* 已经断了 */ }
}

/**
 * 写一条 SSE 事件。
 *
 * `res.write()` 返回 false 表示内核缓冲区已满（慢客户端 / 页面卡死）。继续往里写
 * 只会把主进程内存顶上去，还会拖慢心跳；这里直接丢弃该客户端，浏览器端
 * `EventSource` 会按 `retry` 自动重连一个干净的新连接。
 * @returns {boolean} 客户端是否仍然保留。
 */
function writeSse(ctx, res, payload) {
  try {
    if (res.write(`data: ${JSON.stringify(payload)}\n\n`) === false) {
      ctx.warn('[remote-access] SSE 客户端写入阻塞，已丢弃（慢客户端）');
      dropSseClient(ctx, res);
      return false;
    }
    return true;
  } catch {
    dropSseClient(ctx, res);
    return false;
  }
}

/** 令牌换会话的 `/api/auth` 处理器。 */
function createAuthHandler(deps, ctx) {
  async function handleAuth(req, res) {
    if (!allowBrowserRequest(req, res, sendJson, '令牌交换')) return;
    const ip = req.socket.remoteAddress || '';
    if (!ctx.limiter.ok(ip)) {
      sendJson(res, 429, { ok: false, error: { message: '令牌试错次数过多，请一分钟后再试', code: 'TOO_MANY_ATTEMPTS' } });
      return;
    }
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    let body;
    try {
      body = await readBody(req, { requireJson: true, requireObject: true });
    } catch (e) {
      sendJson(res, e.status || 400, { ok: false, error: { message: e.message, code: 'BAD_REQUEST' } });
      return;
    }
    const provided = typeof body.token === 'string' ? body.token : '';
    // 令牌为空时一律拒：那是「还没在桌面端启用」的状态，不能变成「谁都进得来」。
    const longTokenOk = safeEquals(provided, cfg.token);
    // 长期令牌命中时不再把同一输入丢给配对码表做一次“错误猜测”：
    // 否则主人用长期令牌登录一次，就会消耗掉桌面上刚生成的配对码预算。
    const pairing = longTokenOk || cfg.token === '' ? { ok: false } : ctx.pairings.verify(provided);
    if (!longTokenOk && !pairing.ok) {
      ctx.limiter.fail(ip);
      sendJson(res, 401, { ok: false, error: { message: '令牌不正确', code: 'BAD_TOKEN' } });
      return;
    }
    // 只清当前 IP 的失败窗口。任意一次登录成功都不该抹掉其他来源 IP 的限速记录。
    ctx.limiter.succeed(ip);
    // fullAccess 配对码（当前「打开网页」与设置页扫码都会签发）换来的会话是桌面同权限；
    // 长期 api_token 登录得到的会话不是。
    // 这个标记只存在于内存里的会话表：重启、轮换或点卡片返回都会随 stop() 一起清空。
    const fullAccess = pairing.fullAccess === true;
    const session = ctx.sessions.create({ fullAccess });
    res.setHeader('Set-Cookie', session.cookie);
    sendJson(res, 200, {
      ok: true,
      value: { version: deps.appVersion, native: NATIVE_CAPABILITIES, tokenMasked: maskToken(cfg.token), fullAccess },
    });
  }
  return { handleAuth };
}

/** 告诉浏览器端「哪些原生能力这里没有」的 `/api/capabilities` 处理器。 */
function createCapabilitiesHandler(deps, ctx) {
  function handleCapabilities(_req, res) {
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    sendJson(res, 200, {
      ok: true,
      value: {
        transport: 'http',
        version: deps.appVersion,
        native: NATIVE_CAPABILITIES,
        tokenMasked: maskToken(cfg.token),
        addresses: lanAddresses().map((a) => a.address),
        bound: { address: ctx.state.address, port: ctx.state.port },
      },
    });
  }
  return { handleCapabilities };
}

/**
 * fullAccess 会话的原生能力代理（`POST /api/native/<action>`）。
 *
 * 只有 **fullAccess 会话**能进：目录/文件对话框、截图、许可证、诊断、更新、远程访问设置
 * 都是「这台电脑上的动作」。当前设置页扫码与「打开网页」交接都会签发 fullAccess，
 * 二者与桌面同权；只有长期 api_token 登录的非 fullAccess 会话会得到 403。停服/轮换
 * 后内存会话失效，残留 Cookie 再也调不动这些动作。
 * @param {object} deps - `nativeCall` 由 main.js 注入。
 * @param {object} ctx - 服务上下文（会话表）。
 */
function createNativeHandler(deps, ctx) {
  async function handleNative(req, res, action) {
    if (!allowBrowserRequest(req, res, sendJson, '原生能力')) return;
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!ctx.sessions.isFull(cookie)) {
      sendJson(res, 403, { ok: false, error: { message: '该操作需要 fullAccess 会话', code: 'FULL_ACCESS_REQUIRED' } });
      return;
    }
    if (typeof deps.nativeCall !== 'function') {
      sendJson(res, 501, { ok: false, error: { message: '当前版本没有原生能力代理', code: 'NATIVE_UNAVAILABLE' } });
      return;
    }
    let body;
    try {
      body = await readBody(req, { requireJson: true, requireObject: true });
    } catch (e) {
      sendJson(res, e.status || 400, { ok: false, error: { message: e.message, code: 'BAD_REQUEST' } });
      return;
    }
    try {
      const value = await deps.nativeCall(action, body ?? {});
      sendJson(res, 200, { ok: true, value });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: { message: e?.message ?? String(e), code: 'NATIVE_CALL_FAILED' } });
    }
  }
  return { handleNative };
}

/**
 * 聊天图片的 HTTP 流式出口（`GET /api/media/decoded/<relative-path>`）。
 *
 * 桌面端用 `wechat-media://` 自定义协议；浏览器没有这个协议，`<img>` 会直接裂图。
 * 交接态（以及任何已授权会话）改为同源 `/api/media/...`：服务端复用
 * `media-protocol.js` 的同一套「decoded 根内 + 只读图片扩展名 + 拒绝 ..」校验后流式返回。
 * 不返回目录列表、不新增出网点；路径越界/不存在一律 404。
 * @param {object} deps - `getDecodedRoot` 由 main.js 注入（后端解析出的 decoded_images）。
 * @returns {{handleMedia: Function}} 路由处理器。
 */
function createMediaHandler(deps) {
  function handleMedia(req, res, rel, thumbWidth = null) {
    const root = typeof deps.getDecodedRoot === 'function' ? String(deps.getDecodedRoot() ?? '') : '';
    const abs = resolveDecodedFile(root, rel);
    if (abs === null) {
      sendJson(res, 404, { ok: false, error: { message: '图片不存在', code: 'MEDIA_NOT_FOUND' } });
      return;
    }
    const thumb = thumbWidth === null ? null : ensureThumb(abs, thumbWidth);
    const serve = thumb ?? abs;
    const mime = thumb === null
      ? MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream'
      : 'image/jpeg';
    let stat;
    try {
      stat = fs.statSync(serve);
    } catch {
      sendJson(res, 404, { ok: false, error: { message: '图片不存在', code: 'MEDIA_NOT_FOUND' } });
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': thumb === null ? 'private, max-age=60' : 'private, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    const stream = fs.createReadStream(serve);
    const destroyStream = () => {
      if (!stream.destroyed) stream.destroy();
    };
    stream.once('error', () => { try { res.destroy(); } catch { /* 忽略 */ } });
    // res 的 close 在正常完成和客户端断连时都会触发；正常完成时流的 close 已经
    // 在附近，destroy 是幂等的。关键是客户端提前断开时不能继续读完整张大图。
    res.once('close', destroyStream);
    res.once('error', destroyStream);
    stream.pipe(res);
  }
  return { handleMedia };
}

/** 断连取消首次重放的间隔；后端 job 通常在这之前完成注册。 */
const DISCONNECT_CANCEL_RETRY_MS = 25;
/** 断连取消退避上限，避免后端启动/排队较久时高频打扰 worker。 */
const DISCONNECT_CANCEL_RETRY_MAX_MS = 1_000;

/** 只把明确的后端成功信封当作“取消已命中”，未知形状一律继续重放。 */
function cancellationConfirmed(result) {
  return Boolean(result
    && typeof result === 'object'
    && result.ok === true
    && result.value
    && typeof result.value === 'object'
    && result.value.ok === true);
}

/**
 * 管理一次 HTTP 调用的断连取消。
 *
 * 首次取消可能早于 worker 里的 `searchSignal(jobId)` 注册，因而返回 `ok:false`。
 * 排队阶段只需记住断连并禁止出队；一旦 `gatedCall` 已启动，就按退避重放取消，
 * 直到后端明确确认、原调用结束或客户端并未断连。重放始终复用同一个 jobId，且
 * 同一时刻只允许一个取消 RPC 在飞，成功确认后立即停止。
 */
function createDisconnectCancellation(deps, ctx, cancelPlan) {
  let stopped = false;
  let disconnected = false;
  let backendStarted = false;
  let confirmed = false;
  let attemptInFlight = false;
  let retryTimer = null;
  let retryDelay = DISCONNECT_CANCEL_RETRY_MS;

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (stopped || !disconnected || !backendStarted || confirmed || !cancelPlan.ok || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptCancel();
    }, retryDelay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
    retryDelay = Math.min(retryDelay * 2, DISCONNECT_CANCEL_RETRY_MAX_MS);
  };

  const attemptCancel = async () => {
    if (stopped || !disconnected || confirmed || !cancelPlan.ok || attemptInFlight) return;
    attemptInFlight = true;
    try {
      const result = await deps.gatedCall(cancelPlan.method, [{ jobId: cancelPlan.jobId }]);
      if (cancellationConfirmed(result)) {
        confirmed = true;
        clearRetry();
        return;
      }
      scheduleRetry();
    } catch (e) {
      if (!stopped) ctx.warn('[remote-access] 断连取消失败: %s', e?.message ?? e);
      scheduleRetry();
    } finally {
      attemptInFlight = false;
    }
  };

  return {
    disconnect() {
      if (stopped || disconnected) return;
      disconnected = true;
      if (cancelPlan.ok) void attemptCancel();
    },
    beforeBackendCall() {
      backendStarted = true;
      if (disconnected) void attemptCancel();
    },
    stop() {
      stopped = true;
      clearRetry();
    },
    isDisconnected() {
      return disconnected;
    },
  };
}

/** 白名单 → 排队 → 过闸 → 原样回信封的 `/api/wechat/call` 处理器。 */
function createCallHandler(deps, ctx) {
  async function handleCall(req, res) {
    if (!allowBrowserRequest(req, res, sendJson, '远程方法调用')) return;
    let body;
    try {
      body = await readBody(req, { requireJson: true, requireObject: true });
    } catch (e) {
      sendJson(res, e.status || 400, { ok: false, error: { message: e.message, code: 'BAD_REQUEST' } });
      return;
    }
    const method = typeof body.method === 'string' ? body.method : '';
    const args = Array.isArray(body.args) ? body.args : [];
    // fullAccess 交接仍受 Agent 的桌面专属限制；其余 Remote 保持既有交接权限。
    // 普通手机会话仍走白名单 —— 这条分支只看服务端内存里的会话标记，浏览器伪造 URL 无效。
    const sessionCookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const fullAccess = ctx.sessions.isFull(sessionCookie);
    // 白名单在过闸之前：不在名单里的方法连许可证校验都不该走到。
    if (!isHttpCallAllowed(method, fullAccess)) {
      sendJson(res, 200, {
        ok: false,
        error: {
          message: `「${method || '(空)'}」不开放远程访问（仅桌面端可用）`,
          code: REMOTE_DENIED_CODE,
          details: { method },
        },
      });
      return;
    }
    // HTTP 侧同样记代际令牌：手机排队期间后端重启/配置被改写时，旧写不该落地。
    // 观察（observeBackendStatus）在共享的 `gatedWechatCall` 派发时进行；这里只负责
    // 入队前取令牌、出队后比对，避免监听器把「重启前的写」投到新 worker 上。
    const mutationToken = beginMutation(method);
    // HTTP 客户端断开只代表「没人再等这个响应」，worker 里的搜索不会因此自动停。
    // 首次取消可能早于后端 job 注册，因此由 cancelGuard 在原调用仍存活时重放。
    const cancelPlan = connectionCancelPlanFor(method, args);
    let settled = false;
    const cancelGuard = createDisconnectCancellation(deps, ctx, cancelPlan);
    const cancelOnDisconnect = () => {
      if (settled) return;
      cancelGuard.disconnect();
    };
    const onResponseClose = () => {
      if (!res.writableEnded) cancelOnDisconnect();
    };
    const detachDisconnect = () => {
      settled = true;
      cancelGuard.stop();
      req.off('aborted', cancelOnDisconnect);
      res.off('close', onResponseClose);
    };
    req.once('aborted', cancelOnDisconnect);
    res.once('close', onResponseClose);
    try {
      // `args` 一并传给队列：朋友圈取图有网时是纯网络 IO，不该占重活名额
      // （判据见 `call-priority.js` 的 `downgradeHeavyByArgs`）。
      //
      // ⚠️ 这里**不能**无条件写 `meta.priority = HEAVY_PRIORITY` —— 显式 priority 会
      // 短路掉队列里的按入参降级（`priorityOf` 先看显式值）。所以只在「确实是重活、
      // 且不满足降级条件」时才钉死它。
      const meta = { channel: 'remote', method, args };
      if (isRemoteHeavy(method) && !downgradeHeavyByArgs(method, args)) meta.priority = HEAVY_PRIORITY;
      // 静态本地读（世界地图底图 / 地区快照）不排队，与桌面 IPC 用同一份清单；
      // 许可/后端就绪闸仍由 deps.gatedCall 走完整流程（见 call-priority.js 的
      // QUEUE_BYPASS_METHODS）。先定义排队执行体，保证「queue.run 包住真实调用」的
      // 结构仍是可静态核对的（http-server.wiring.spec 会查顺序）。
      const runBackend = () => {
        // 断连可能发生在排队期间。此时 cancelSearch 先到、搜索 job 尚未建立，
        // 取消只能返回 false；若仍出队执行，搜索会无主跑完。出队后必须再次检查。
        if (cancelGuard.isDisconnected()) {
          const error = new Error('客户端已断开，取消排队调用');
          error.code = 'CLIENT_DISCONNECTED';
          throw error;
        }
        cancelGuard.beforeBackendCall();
        const revoked = checkMutation(mutationToken);
        if (revoked) throw revoked;
        return deps.gatedCall(method, args);
      };
      const viaQueue = () => ctx.queue.run(runBackend, meta);
      const result = shouldBypassCallQueue(method)
        ? await runBackend()
        : await viaQueue();
      // 配置保存改变后续读写的语义（数据根/引擎/转写路径）：成功后开新代际，
      // 与桌面 IPC 完全一致；排队中的旧写会在出队时被 checkMutation 拦下。
      if (method === 'saveWechatConfig' && result && typeof result === 'object' && result.ok === true) {
        bumpMutationEpoch('wechat-config-saved');
      }
      detachDisconnect();
      if (!cancelGuard.isDisconnected() && !res.destroyed && !res.writableEnded) sendJson(res, 200, result);
    } catch (e) {
      detachDisconnect();
      if (!cancelGuard.isDisconnected() && !res.destroyed && !res.writableEnded) {
        sendJson(res, 200, {
          ok: false,
          error: { message: e?.message ?? String(e), code: e?.code || 'REMOTE_CALL_FAILED' },
        });
      }
    }
  }
  return { handleCall };
}

/** SSE 事件流处理器。 */
function createEventsHandler(ctx) {
  function handleEvents(req, res) {
    const sessionKey = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      || req.socket.remoteAddress
      || 'unknown';
    const perSession = ctx.sseBySession.get(sessionKey);
    if (ctx.sseClients.size >= ctx.maxSseClients
      || (perSession ? perSession.size : 0) >= ctx.maxSsePerSession) {
      sendJson(res, 503, {
        ok: false,
        error: { message: '事件连接数已达上限，请关闭多余的页面后重试', code: 'SSE_LIMIT' },
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.write('retry: 3000\n\n');
    ctx.sseClients.add(res);
    if (!ctx.sseBySession.has(sessionKey)) ctx.sseBySession.set(sessionKey, new Set());
    ctx.sseBySession.get(sessionKey).add(res);
    const detach = () => removeSseClient(ctx, res);
    req.on('close', detach);
    req.on('error', detach);
    writeSse(ctx, res, { name: 'remote-access/ready', args: [{ port: ctx.state.port }] });
  }
  return { handleEvents };
}

/** 请求路由：Host 校验、API 与会话边界、静态资源兜底。 */
function createRequestRouter(deps, ctx, handlers) {
  /** 当前是否已授权（会话 Cookie 有效）。 */
  function authorized(req) {
    const cookies = parseCookies(req.headers.cookie);
    return ctx.sessions.verify(cookies[SESSION_COOKIE]);
  }

  /** 路由：先校验 Host，再解析 URL，最后分 API / 静态。 */
  async function onRequest(req, res) {
    // Host 校验仍排在所有业务路由与 URL 解析之前。公网域名/其它本机网卡的例外只对
    // RPA 图片直链开放；这里先用原始路径判断，避免为了决定例外名单而提前解析 URL。
    const rawPath = typeof req.url === 'string' ? req.url.split('?', 1)[0] : '';
    const signedPath = rawPath.startsWith(RPA_MEDIA_PATH_PREFIX)
      || rawPath.startsWith(MESSAGE_WEBHOOK_PATH_PREFIX);
    const extraHosts = signedPath ? ctx.rpaMedia.allowedHosts() : [];
    if (!isHostAllowed(req.headers.host, ctx.state.address, ctx.state.port, extraHosts)) {
      ctx.warn('[remote-access] 拒绝不匹配 Host 头: %s（来自 %s）', req.headers.host || '(缺失)', req.socket.remoteAddress || '未知');
      sendJson(res, 421, { ok: false, error: { message: 'Host 头与监听地址不匹配', code: 'BAD_HOST' } });
      return;
    }
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendJson(res, 400, { ok: false, error: { message: 'URL 无法解析', code: 'BAD_URL' } });
      return;
    }
    // 只接受 GET/POST/HEAD：PUT/DELETE 之类在这套接口里没有语义。
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: { message: `不支持 ${req.method}`, code: 'METHOD_NOT_ALLOWED' } });
      return;
    }

    if (urlPath === '/api/auth') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { message: '令牌校验只接受 POST', code: 'METHOD_NOT_ALLOWED' } });
        return;
      }
      await handlers.handleAuth(req, res);
      return;
    }
    if (urlPath.startsWith('/api/')) {
      // RPA 图片签名直链：**凭据在 URL 里**（机器人拿不到会话 Cookie），所以它是
      // `/api/auth` 之外唯一排在会话校验之前的接口（判据见 `rpa-media.js` 文件头）。
      if (urlPath.startsWith(RPA_MEDIA_PATH_PREFIX)) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: { message: '图片直链只接受 GET', code: 'METHOD_NOT_ALLOWED' } });
          return;
        }
        await handlers.handleRpaMedia(res, urlPath.slice(RPA_MEDIA_PATH_PREFIX.length));
        return;
      }
      // 消息列表入站 Webhook：凭据同样在 URL 里，因此排在会话校验之前。
      // **先验 URL 令牌，再读 body**：验签不需要请求体，令牌无效时一个字节都不读
      // （否则未认证方可以拿 30MB body 把主进程内存/带宽打满）。
      if (urlPath.startsWith(MESSAGE_WEBHOOK_PATH_PREFIX)) {
        const token = urlPath.slice(MESSAGE_WEBHOOK_PATH_PREFIX.length);
        const ip = req.socket.remoteAddress || '';
        if (!ctx.webhookLimiter.ok(ip)) {
          sendJson(res, 429, {
            ok: false,
            error: { message: 'Webhook 鉴权失败次数过多，请一分钟后再试', code: 'TOO_MANY_ATTEMPTS' },
          });
          return;
        }
        // 验签期间暂停请求体：避免在动态加载令牌模块的窗口里把 body 读进内存。
        if (req.method === 'POST') req.pause();
        const tokenOk = await verifyMessageWebhookToken(deps, ctx, token);
        if (!tokenOk) {
          ctx.webhookLimiter.fail(ip);
          sendJson(res, 404, { ok: false, error: { message: 'Webhook 不存在或令牌已失效', code: 'WEBHOOK_NOT_FOUND' } });
          // 响应发完后切断连接：不消费攻击者继续灌进来的请求体。
          res.once('finish', () => { try { req.destroy(); } catch { /* 已断开 */ } });
          return;
        }
        ctx.webhookLimiter.succeed(ip);
        if (req.method === 'GET' || req.method === 'HEAD') {
          await handlers.handleMessageWebhookGet(res, token);
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { message: 'Webhook 只接受 GET / POST', code: 'METHOD_NOT_ALLOWED' } });
          res.once('finish', () => { try { req.destroy(); } catch { /* 已断开 */ } });
          return;
        }
        let body;
        try {
          // 先挂上监听器再 resume，避免暂停期间的数据在两者之间丢失。
          const bodyPromise = readBody(req, {
            maxBytes: MESSAGE_WEBHOOK_BODY_BYTES,
            requireJson: true,
            requireObject: true,
          });
          req.resume();
          body = await bodyPromise;
        } catch (e) {
          sendJson(res, e.status || 400, { ok: false, error: { message: e.message, code: e.code || 'BAD_REQUEST' } });
          // 415/413 等入口错误：请求体还停在暂停态，响应发完后直接断开，
          // 不让一个被拒的连接继续占着 socket。
          res.once('finish', () => { try { req.destroy(); } catch { /* 已断开 */ } });
          return;
        }
        await handlers.handleMessageWebhookPost(res, token, body);
        return;
      }
      // 除 /api/auth 外一律要求有效会话（401 而不是 403：不透露端点存在）。
      if (!authorized(req)) {
        sendJson(res, 401, { ok: false, error: { message: '未授权：请先用令牌换取会话', code: 'UNAUTHORIZED' } });
        return;
      }
      if (urlPath === '/api/capabilities' && req.method === 'GET') { handlers.handleCapabilities(req, res); return; }
      if (urlPath.startsWith('/api/media/decoded/') && req.method === 'GET') {
        const thumbWidth = parseThumbWidth('http://local' + String(req.url ?? ''));
        handlers.handleMedia(req, res, urlPath.slice('/api/media/decoded/'.length), thumbWidth);
        return;
      }
      if (urlPath.startsWith('/api/native/') && req.method === 'POST') { await handlers.handleNative(req, res, urlPath.slice('/api/native/'.length)); return; }
      if (urlPath === '/api/wechat/call' && req.method === 'POST') { await handlers.handleCall(req, res); return; }
      if (urlPath === '/api/wechat/events' && req.method === 'GET') { handlers.handleEvents(req, res); return; }
      if (urlPath === '/api/status' && req.method === 'GET') { sendJson(res, 200, { ok: true, value: snapshotRemoteState(deps, ctx) }); return; }
      sendJson(res, 404, { ok: false, error: { message: `没有这个接口：${urlPath}`, code: 'NO_ROUTE' } });
      return;
    }

    // 静态资源不需要会话（渲染层产物不是秘密；数据全在 /api/* 后面）。
    const target = urlPath === '/' ? '/index.html' : urlPath;
    const found = resolveStaticFile(deps.getUiDistDir(), target);
    if (!found.ok) {
      if (found.reason === 'outside') ctx.warn('[remote-access] 拒绝越界路径请求: %s', req.url);
      sendJson(res, 404, { ok: false, error: { message: '没有这个资源', code: 'NOT_FOUND' } });
      return;
    }
    sendFile(res, found.file, target, req.method === 'HEAD');
  }

  /** 把一个后端事件推给所有 SSE 客户端。 */
  function pushEvent(name, args) {
    if (ctx.sseClients.size === 0) return;
    // 快照遍历：writeSse 可能把慢客户端从集合里删掉。
    for (const res of [...ctx.sseClients]) writeSse(ctx, res, { name, args });
  }

  return { onRequest, pushEvent };
}

/** 当前状态快照（不含令牌原文）。 */
function snapshotRemoteState(deps, ctx) {
  const cfg = readRemoteAccessConfig(deps.getDataRoot());
  return {
    ...ctx.state,
    configuredPort: cfg.port,
    enabled: cfg.enabled,
    hasToken: cfg.token !== '',
    tokenMasked: maskToken(cfg.token),
    addresses: lanAddresses().map((a) => a.address),
    queue: ctx.queue.stats(),
    sseClients: ctx.sseClients.size,
    sessions: ctx.sessions.count(),
    pairingCodes: ctx.pairings.count(),
  };
}

/** 监听启停、配置对齐、DHCP 换址重绑的生命周期。 */
function createHttpLifecycle(deps, ctx, onRequest) {
  /** 原子写无凭据监听快照；写失败只降级展示，不影响监听本身。 */
  function persistRuntimeState() {
    const dataRoot = String(deps.getDataRoot() || '');
    if (dataRoot === '') return;
    const target = path.join(dataRoot, REMOTE_ACCESS_RUNTIME_FILE);
    const state = ctx.state;
    const snapshot = {
      version: 1,
      pid: process.pid,
      running: state.running === true,
      address: state.running === true ? state.address : '',
      port: state.running === true ? state.port : 0,
      preferredPort: state.preferredPort,
      startedAt: state.running === true ? state.startedAt : 0,
      updatedAt: Date.now(),
    };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, JSON.stringify(snapshot) + '\n');
    } catch (e) {
      ctx.warn('[remote-access] 监听快照写入失败：%s', e?.message ?? e);
    }
  }

  /** 串行化所有「启 / 停 / 重绑 / 与配置对齐」操作。 */
  function enqueueLifecycle(task) {
    const run = ctx.lifecycleTail.then(task, task);
    ctx.lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 当前状态快照（不含令牌原文）。 */
  function getState() {
    return snapshotRemoteState(deps, ctx);
  }

  /**
   * 兜底：路由处理器漏掉的 rejection / 同步异常。
   *
   * 不接这一层的话，`onRequest` 返回的 rejected promise 在 Node 默认策略下会变成
   * unhandledRejection，请求既没有响应也没有断开（浏览器挂到超时），而且这个
   * 未处理拒绝可能触发主进程的全局处理策略。头已发出（SSE/流式）时只能销毁连接。
   * @param {object} ctx - 服务上下文。
   * @param {http.ServerResponse} res - 响应。
   * @param {unknown} e - 异常。
   */
  function failUnhandledRequest(ctx, res, e) {
    ctx.warn('[remote-access] 未捕获的请求异常：%s', e?.stack ?? e?.message ?? e);
    if (res.headersSent || res.writableEnded) {
      try { res.destroy(); } catch { /* 已经断了 */ }
      return;
    }
    sendJson(res, 500, {
      ok: false,
      error: { message: '远程访问请求处理失败', code: 'INTERNAL_ERROR' },
    });
  }

  /** 监听一个端口；被占用就往后试。@returns 实际端口，全试完返回 0。 */
  function listenOn(host, preferredPort) {
    return new Promise((resolve) => {
      let attempt = 0;
      const tryNext = () => {
        if (attempt >= PORT_ATTEMPTS) { resolve(0); return; }
        const port = preferredPort + attempt;
        attempt += 1;
        const srv = http.createServer((req, res) => {
          try {
            onRequest(req, res).catch((e) => failUnhandledRequest(ctx, res, e));
          } catch (e) {
            failUnhandledRequest(ctx, res, e);
          }
        });
        srv.once('error', (err) => {
          if (err && err.code === 'EADDRINUSE') { tryNext(); return; }
          ctx.warn('[remote-access] 监听失败 %s:%d —— %s', host, port, err?.message ?? err);
          resolve(0);
        });
        srv.listen(port, host, () => {
          ctx.server = srv;
          srv.timeout = 0;
          srv.requestTimeout = REQUEST_TIMEOUT_MS;
          srv.keepAliveTimeout = 75_000;
          srv.headersTimeout = 80_000;
          resolve(port);
        });
      };
      tryNext();
    });
  }

  /** 启动的不加锁实现：只应由已经入队的生命周期任务调用。 */
  async function startNow() {
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    if (ctx.state.running) return getState();
    if (!cfg.enabled || cfg.token === '') {
      ctx.state = { ...ctx.state, running: false, enabled: cfg.enabled, hasToken: cfg.token !== '' };
      persistRuntimeState();
      return getState();
    }
    const host = deps.bindHost || (lanAddresses()[0] || {}).address || '127.0.0.1';
    const port = await listenOn(host, cfg.port);
    if (port === 0) {
      ctx.warn('[remote-access] 端口 %d–%d 都不可用，未启动监听', cfg.port, cfg.port + PORT_ATTEMPTS - 1);
      persistRuntimeState();
      return getState();
    }
    ctx.state = {
      running: true, port, address: host, preferredPort: cfg.port,
      enabled: true, hasToken: true, startedAt: Date.now(),
    };
    persistRuntimeState();
    ctx.heartbeat = setInterval(() => {
      for (const res of [...ctx.sseClients]) {
        writeSse(ctx, res, { name: 'remote-access/heartbeat', args: [] });
      }
    }, SSE_HEARTBEAT_MS);
    ctx.heartbeat.unref?.();
    ctx.reconcileTimer = setInterval(() => { void syncWithConfig(); }, ADDRESS_WATCH_MS);
    ctx.reconcileTimer.unref?.();
    ctx.log('[remote-access] 已启动 http://%s:%d（手机与本机需在同一局域网）', host, port);
    return getState();
  }

  /** 启动（幂等：已在跑就只刷新状态）。 */
  function start() {
    return enqueueLifecycle(() => startNow());
  }

  /** 地址重绑的不加锁实现。 */
  async function refreshBindingNow() {
    if (!ctx.state.running) return;
    const wanted = deps.bindHost || (lanAddresses()[0] || {}).address;
    if (!wanted || wanted === ctx.state.address) return;
    ctx.log('[remote-access] 本机地址变了（%s → %s），重新绑定', ctx.state.address, wanted);
    await stopNow();
    await startNow();
  }

  /** 地址变了就重绑（网卡切换 / DHCP 续租换址）。 */
  function refreshBinding() {
    return enqueueLifecycle(() => refreshBindingNow());
  }

  /** 按当前配置对齐运行状态：该起就起、该停就停、端口或地址变了就重绑。 */
  async function syncWithConfigNow() {
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    const shouldRun = cfg.enabled && cfg.token !== '';
    if (!shouldRun) {
      if (ctx.state.running) {
        ctx.log('[remote-access] 配置已关闭，停止监听');
        await stopNow();
      }
      ctx.state = { ...ctx.state, enabled: cfg.enabled, hasToken: cfg.token !== '' };
      persistRuntimeState();
      return getState();
    }
    if (!ctx.state.running) return startNow();
    if (cfg.port !== ctx.state.preferredPort) {
      ctx.log('[remote-access] 端口配置变了（%d → %d），重新绑定', ctx.state.preferredPort, cfg.port);
      await stopNow();
      return startNow();
    }
    await refreshBindingNow();
    return getState();
  }

  function syncWithConfig() {
    return enqueueLifecycle(() => syncWithConfigNow());
  }

  /** 停止监听并断开所有远程会话。 */
  async function stopNow() {
    if (ctx.heartbeat) { clearInterval(ctx.heartbeat); ctx.heartbeat = null; }
    if (ctx.reconcileTimer) { clearInterval(ctx.reconcileTimer); ctx.reconcileTimer = null; }
    // 共用闸时只清远程排队项；桌面端排在后面的调用不该被「手机访问关闭」连带拒绝。
    const drained = ctx.queue.drain('远程访问服务已停止', 'remote');
    for (const res of ctx.sseClients) {
      try { res.end(); } catch { /* 已经断了 */ }
    }
    ctx.sseClients.clear();
    ctx.sseBySession.clear();
    ctx.sessions.revokeAll();
    ctx.pairings.revokeAll();
    ctx.limiter.reset();
    ctx.webhookLimiter.reset();
    const srv = ctx.server;
    ctx.server = null;
    ctx.state = { ...ctx.state, running: false, port: 0, address: '', startedAt: 0 };
    persistRuntimeState();
    if (!srv) return getState();
    await new Promise((resolve) => {
      srv.close(() => resolve());
      srv.closeIdleConnections?.();
      srv.closeAllConnections?.();
    });
    ctx.log('[remote-access] 已停止监听（断开 %d 个排队请求）', drained);
    return getState();
  }

  /** 停止监听并断开所有远程会话。 */
  function stop() {
    return enqueueLifecycle(() => stopNow());
  }

  return {
    start,
    stop,
    getState,
    syncWithConfig,
    refreshBinding,
    isRunning: () => ctx.state.running,
  };
}

/**
 * 建一个远程访问服务。
 *
 * @param {object} deps
 * @param {() => string} deps.getDataRoot - 数据根（配置与令牌住在这儿）。
 * @param {() => string} deps.getUiDistDir - 渲染层产物目录（`src/client/ui-dist`）。
 * @param {(method: string, args: unknown[]) => Promise<unknown>} deps.gatedCall - 过闸后的后端调用。
 * @param {ReturnType<typeof createCallQueue>} [deps.callQueue] - 与桌面 IPC 共用的调用闸（缺省新建一把）。
 * @param {ReturnType<typeof createPairingStore>} [deps.pairings] - 短命配对码表（缺省新建一把）。
 * @param {ReturnType<typeof createAuthLimiter>} [deps.authLimiter] - 登录限速器（缺省新建一把，测试注入用）。
 * @param {string} deps.appVersion - 应用版本（capabilities 报出）。
 * @param {(msg: string, ...rest: unknown[]) => void} [deps.log] - 日志（默认 console.log）。
 * @param {(msg: string, ...rest: unknown[]) => void} [deps.warn]
 * @param {string} [deps.bindHost] - 强制绑定地址（测试用；缺省取第一个局域网 IPv4）。
 * @returns 服务句柄。
 */
function createRemoteAccessServer(deps) {
  const ctx = createServerContext(deps);
  const pairings = ctx.pairings;
  const routes = createRequestRouter(deps, ctx, {
    handleAuth: createAuthHandler(deps, ctx).handleAuth,
    handleCapabilities: createCapabilitiesHandler(deps, ctx).handleCapabilities,
    handleMedia: createMediaHandler(deps).handleMedia,
    handleRpaMedia: ctx.rpaMedia.handleRpaMedia,
    handleMessageWebhookGet: ctx.messageWebhook.handleGet,
    handleMessageWebhookPost: ctx.messageWebhook.handlePost,
    handleNative: createNativeHandler(deps, ctx).handleNative,
    handleCall: createCallHandler(deps, ctx).handleCall,
    handleEvents: createEventsHandler(ctx).handleEvents,
  });
  const lifecycle = createHttpLifecycle(deps, ctx, routes.onRequest);
  return {
    start: lifecycle.start,
    stop: lifecycle.stop,
    getState: lifecycle.getState,
    pushEvent: routes.pushEvent,
    syncWithConfig: lifecycle.syncWithConfig,
    refreshBinding: lifecycle.refreshBinding,
    isRunning: lifecycle.isRunning,
    issuePairingCode: (options) => pairings.issue(options),
  };
}


module.exports = {
  DEFAULT_PORT,
  PORT_ATTEMPTS,
  SSE_HEARTBEAT_MS,
  REMOTE_ACCESS_RUNTIME_FILE,
  MAX_BODY_BYTES,
  MESSAGE_WEBHOOK_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  lanAddresses,
  readRemoteAccessConfig,
  isHostAllowed,
  createAuthLimiter,
  createRemoteAccessServer,
};

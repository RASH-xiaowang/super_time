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
 * 所以手机上能看到什么，完全由两件事决定：**令牌**（是不是主人给的）与
 * **方法白名单**（`http-remote-policy.js` 的 `REMOTE_SAFE_METHODS`）。
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
 * - 除 `POST /api/auth` 外的所有 `/api/*` 都要求**有效会话 Cookie**；
 * - 事件通道用 **SSE**（`EventSource`）而不是 WebSocket：7 类事件全是单向 server→client，
 *   `EventSource` 是浏览器内建、自带重连、零依赖（本仓无 express/ws，新增运行时依赖要
 *   逐个登记进打包白名单）。代价是它**不能自定义 header** ⇒ 凭据只能用 Cookie。
 * - 明文 HTTP、无 TLS：见 `http-auth.js` 文件头与 `docs/PRIVACY.md` 第四节 H。
 *
 * @module backend/http-server
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
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
const { NATIVE_CAPABILITIES, REMOTE_DENIED_CODE, isRemoteHeavy, isRemoteSafe } = require('./http-remote-policy.js');
const { resolveStaticFile, sendFile } = require('./http-static.js');

/** 默认端口（配置键 `api_port` 的缺省值，与 `config/wechat-config.ts` 同口径）。 */
const DEFAULT_PORT = 5032;

/** 端口被占用时往后试多少个（5032…5042）。 */
const PORT_ATTEMPTS = 11;

/** SSE 心跳间隔：比常见代理/移动网络的空闲断开阈值短，让连接不被中间设备掐掉。 */
const SSE_HEARTBEAT_MS = 25_000;

/** 请求体上限：调用参数是 JSON（方法名 + 参数），4MB 已经很宽；图片是**返回**方向，不受此限。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * 接收完整请求的硬时限。`server.timeout` 必须覆盖 10 分钟档的长任务响应，所以不能拿它
 * 防慢连接；`requestTimeout` 只管「请求头 + 最多 4MB body 必须在这段时间内收完」，
 * 与响应耗时无关，30 秒足够且能把只发 header 后慢慢滴 body 的连接挡在门外。
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** 令牌试错的限速窗口与上限：令牌有 192 位、猜不出来，限速只是顺手挡掉脚本乱撞。 */
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 8;

/** 网卡地址变化的复查间隔：DHCP 换址后自动重绑，否则手机会静默连不上。 */
const ADDRESS_WATCH_MS = 60_000;

/**
 * 明显是虚拟/隧道/回环型网卡的名字特征。
 *
 * 名单只做「排序与默认选择」，不把地址从 `lanAddresses()` 里删掉：状态页仍要完整列出
 * 候选，让用户知道机器上还有哪些地址。真正的默认绑定只取排序后的第一名。
 */
const VIRTUAL_IFACE_HINTS = [
  /vethernet/i,
  /vmware/i,
  /virtualbox/i,
  /hyper-v/i,
  /docker/i,
  /wsl/i,
  /zerotier/i,
  /tailscale/i,
  /wireguard/i,
  /openvpn/i,
  /(^|[^a-z])vpn($|[^a-z])/i,
  /teredo/i,
  /isatap/i,
  /loopback/i,
  /bluetooth/i,
];

/**
 * 给一个 IPv4 网卡地址打分：分数越高越适合当远程访问的默认地址。
 *
 * 只看本机可静态判断的特征，不猜测路由表；这里的目标是把「VMware/Hyper-V 恰好排在
 * Wi-Fi 前面」这类确定性事故消掉。
 */
function lanAddressScore(iface, addr) {
  let score = 0
  if (VIRTUAL_IFACE_HINTS.some((re) => re.test(iface))) score -= 1000
  if (typeof addr.mac === 'string' && addr.mac !== '' && addr.mac !== '00:00:00:00:00:00') score += 20
  if (/(^|[^a-z])(wi-?fi|wlan|wireless)([^a-z]|$)/i.test(iface)) score += 30
  if (/ethernet|以太网|本地连接/i.test(iface)) score += 20
  if (/^169\.254\./.test(addr.address)) score -= 500
  if (addr.address === '0.0.0.0') score -= 900
  return score
}

/**
 * 本机可用于局域网访问的 IPv4 地址。
 *
 * 只取**非 internal 的 IPv4**：IPv6 在手机与路由器的组合下经常不可达（而报错很难懂），
 * internal 是回环。虚拟网卡（VMware / Hyper-V / WSL）也是非 internal 的，会一并列出 ——
 * 绑定用排序后的第一个，其余经 capabilities 报出，界面上可以看见「绑的是哪一个」。
 * 排序把物理 Wi-Fi/以太网排在虚拟网卡和 APIPA 前面，避免某台机器的虚拟适配器
 * 恰好成为默认监听地址，把服务暴露到手机根本不在的那个网络里。
 * @returns 形如 `[{ address, family, iface }]` 的数组。
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ address: a.address, family: 'IPv4', iface, score: lanAddressScore(iface, a) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 读一个 JSON 文件；读不到 / 解析失败一律返回 `{}`（缺配置不等于报错）。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 读远程访问的三个配置项。
 *
 * 直接读文件而不经后端：① 这段逻辑要在**后端就绪之前**就能判断「该不该监听」；
 * ② 读是安全的（写才需要走后端的原子写 + 备份语义，见 `saveWechatConfig`）。
 * 主进程已有直接读 `config.json` 的先例（`main.js` 的 `migrateSecretsAndTightenAcl`）。
 *
 * `api_token` 住在 **`secrets.json`** 而不是 `config.json` —— 它在后端的 `SECRET_FIELDS`
 * 里，保存时会被自动分流过去并收紧 ACL。
 * @param {string} dataRoot - 数据根（`wechatBoot.info.root`）。
 * @returns `{ enabled, port, token }`。
 */
function readRemoteAccessConfig(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot === '') {
    return { enabled: false, port: DEFAULT_PORT, token: '' };
  }
  const cfg = readJsonSafe(path.join(dataRoot, 'config.json'));
  const secrets = readJsonSafe(path.join(dataRoot, 'secrets.json'));
  const port = Number(cfg.api_port);
  return {
    enabled: cfg.api_enabled === true,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.floor(port) : DEFAULT_PORT,
    token: typeof secrets.api_token === 'string' ? secrets.api_token : '',
  };
}

/**
 * Host 头只接受当前监听地址，挡住 DNS rebinding 这类「浏览器从恶意域名连回本机」的打法。
 *
 * 为什么不是宽松匹配：这个服务只绑定一个具体局域网 IPv4（`startNow()` 从不绑 `0.0.0.0`），
 * 手机与页面地址都来自设置页上那个 IP。任何域名形状的 Host 都说明请求不是从正常入口来的
 * （DNS rebinding 正是靠 `attacker.example → 192.168.x.x` 把浏览器里的跨域脚本带到内网）。
 * 端口如果给出了就必须等于实际监听端口；省略端口仍允许，因为 HTTP 缺省端口语义与主机名
 * 校验是两件独立的事，这里真正要钉住的是「主机名必须等于当前监听 IP」。
 *
 * 回环地址额外接受 `localhost`：开发态与本地测试会用 `http://localhost:<port>`，且该别名
 * 不改变「绑定在回环上」这一暴露面。局域网 IP 不接受任何主机名别名。
 *
 * @param {string | undefined} authority - 请求的 `Host` 头。
 * @param {string} expectedAddress - 当前监听地址。
 * @param {number} expectedPort - 当前监听端口。
 * @returns {boolean} 允许该 Host 时为 true。
 */
function isHostAllowed(authority, expectedAddress, expectedPort) {
  if (typeof authority !== 'string') return false;
  const raw = authority.trim();
  if (raw === '' || /[\s,;]/.test(raw)) return false;

  let host = '';
  let portText = '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return false;
    host = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return false;
    portText = rest.slice(1);
  } else {
    const colon = raw.lastIndexOf(':');
    const tail = colon >= 0 ? raw.slice(colon + 1) : '';
    if (tail !== '') {
      if (!/^\d+$/.test(tail)) return false;
      host = raw.slice(0, colon);
      portText = tail;
    } else {
      host = raw;
    }
  }

  if (host === '') return false;
  const expected = String(expectedAddress || '').toLowerCase();
  const actual = host.toLowerCase();
  const isLoopback = expected === '127.0.0.1' || expected === '::1';
  if (actual !== expected && !(isLoopback && actual === 'localhost')) return false;
  if (portText === '') return true;
  return Number(portText) === expectedPort;
}

/** 发一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * 读请求体（带上限）。
 *
 * 超限**立刻销毁连接**而不是读完再拒：读满一个几 GB 的 body 本身就是攻击面。
 * @param {http.IncomingMessage} req
 * @returns JSON 解析结果；失败时 reject（带 `status`）。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('请求体过大');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.length === 0 ? {} : JSON.parse(buffer.toString('utf8')));
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', (e) => reject(e));
  });
}

/**
 * 令牌试错的滑动窗口限速（按来源 IP）。
 * @returns `{ ok(ip), fail(ip), reset() }`。
 */
function createAuthLimiter() {
  /** @type {Map<string, number[]>} ip → 失败时刻列表 */
  const hits = new Map();
  return {
    /** 这个 IP 现在还能不能试。 */
    ok(ip) {
      const list = hits.get(ip);
      if (!list) return true;
      const cutoff = Date.now() - AUTH_WINDOW_MS;
      const recent = list.filter((t) => t > cutoff);
      if (recent.length === 0) hits.delete(ip);
      else hits.set(ip, recent);
      return recent.length < AUTH_MAX_FAILURES;
    },
    /** 记一次失败。 */
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
    /** @type {Set<http.ServerResponse>} SSE 客户端 */
    sseClients: new Set(),
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

/** 写一条 SSE 事件；客户端已经断开时把它从集合里移除。 */
function writeSse(sseClients, res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    sseClients.delete(res);
  }
}

/** 令牌换会话的 `/api/auth` 处理器。 */
function createAuthHandler(deps, ctx) {
  async function handleAuth(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (!ctx.limiter.ok(ip)) {
      sendJson(res, 429, { ok: false, error: { message: '令牌试错次数过多，请一分钟后再试', code: 'TOO_MANY_ATTEMPTS' } });
      return;
    }
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    let body;
    try {
      body = await readBody(req);
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
    const session = ctx.sessions.create();
    res.setHeader('Set-Cookie', session.cookie);
    sendJson(res, 200, {
      ok: true,
      value: { version: deps.appVersion, native: NATIVE_CAPABILITIES, tokenMasked: maskToken(cfg.token) },
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

/** 白名单 → 排队 → 过闸 → 原样回信封的 `/api/wechat/call` 处理器。 */
function createCallHandler(deps, ctx) {
  async function handleCall(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, e.status || 400, { ok: false, error: { message: e.message, code: 'BAD_REQUEST' } });
      return;
    }
    const method = typeof body.method === 'string' ? body.method : '';
    const args = Array.isArray(body.args) ? body.args : [];
    // 白名单在过闸之前：不在名单里的方法连许可证校验都不该走到。
    if (!isRemoteSafe(method)) {
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
    try {
      const meta = { channel: 'remote', method };
      if (isRemoteHeavy(method)) meta.priority = HEAVY_PRIORITY;
      const result = await ctx.queue.run(
        () => deps.gatedCall(method, args),
        meta,
      );
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        error: { message: e?.message ?? String(e), code: e?.code || 'REMOTE_CALL_FAILED' },
      });
    }
  }
  return { handleCall };
}

/** SSE 事件流处理器。 */
function createEventsHandler(ctx) {
  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    ctx.sseClients.add(res);
    writeSse(ctx.sseClients, res, { name: 'remote-access/ready', args: [{ port: ctx.state.port }] });
    req.on('close', () => ctx.sseClients.delete(res));
    req.on('error', () => ctx.sseClients.delete(res));
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

  /** 路由：先 API、后静态。 */
  async function onRequest(req, res) {
    // Host 校验必须排在所有路由之前。
    if (!isHostAllowed(req.headers.host, ctx.state.address, ctx.state.port)) {
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
      // 除 /api/auth 外一律要求有效会话（401 而不是 403：不透露端点存在）。
      if (!authorized(req)) {
        sendJson(res, 401, { ok: false, error: { message: '未授权：请先用令牌换取会话', code: 'UNAUTHORIZED' } });
        return;
      }
      if (urlPath === '/api/capabilities' && req.method === 'GET') { handlers.handleCapabilities(req, res); return; }
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
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(); return; }
    sendFile(res, found.file, target);
  }

  /** 把一个后端事件推给所有 SSE 客户端。 */
  function pushEvent(name, args) {
    if (ctx.sseClients.size === 0) return;
    for (const res of ctx.sseClients) writeSse(ctx.sseClients, res, { name, args });
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

  /** 监听一个端口；被占用就往后试。@returns 实际端口，全试完返回 0。 */
  function listenOn(host, preferredPort) {
    return new Promise((resolve) => {
      let attempt = 0;
      const tryNext = () => {
        if (attempt >= PORT_ATTEMPTS) { resolve(0); return; }
        const port = preferredPort + attempt;
        attempt += 1;
        const srv = http.createServer((req, res) => { void onRequest(req, res); });
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
      return getState();
    }
    const host = deps.bindHost || (lanAddresses()[0] || {}).address || '127.0.0.1';
    const port = await listenOn(host, cfg.port);
    if (port === 0) {
      ctx.warn('[remote-access] 端口 %d–%d 都不可用，未启动监听', cfg.port, cfg.port + PORT_ATTEMPTS - 1);
      return getState();
    }
    ctx.state = {
      running: true, port, address: host, preferredPort: cfg.port,
      enabled: true, hasToken: true, startedAt: Date.now(),
    };
    ctx.heartbeat = setInterval(() => {
      for (const res of ctx.sseClients) writeSse(ctx.sseClients, res, { name: 'remote-access/heartbeat', args: [] });
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
    ctx.sessions.revokeAll();
    ctx.pairings.revokeAll();
    ctx.limiter.reset();
    const srv = ctx.server;
    ctx.server = null;
    ctx.state = { ...ctx.state, running: false, port: 0, address: '', startedAt: 0 };
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
    issuePairingCode: () => pairings.issue(),
  };
}


module.exports = {
  DEFAULT_PORT,
  PORT_ATTEMPTS,
  SSE_HEARTBEAT_MS,
  MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  lanAddresses,
  readRemoteAccessConfig,
  isHostAllowed,
  createAuthLimiter,
  createRemoteAccessServer,
};

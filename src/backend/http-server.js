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
const { SESSION_COOKIE, createSessionStore, maskToken, parseCookies, safeEquals } = require('./http-auth.js');
const { createCallQueue } = require('./http-queue.js');
const { NATIVE_CAPABILITIES, REMOTE_DENIED_CODE, isRemoteSafe } = require('./http-remote-policy.js');
const { resolveStaticFile, sendFile } = require('./http-static.js');

/** 默认端口（配置键 `api_port` 的缺省值，与 `config/wechat-config.ts` 同口径）。 */
const DEFAULT_PORT = 5032;

/** 端口被占用时往后试多少个（5032…5042）。 */
const PORT_ATTEMPTS = 11;

/** SSE 心跳间隔：比常见代理/移动网络的空闲断开阈值短，让连接不被中间设备掐掉。 */
const SSE_HEARTBEAT_MS = 25_000;

/** 请求体上限：调用参数是 JSON（方法名 + 参数），4MB 已经很宽；图片是**返回**方向，不受此限。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 令牌试错的限速窗口与上限：令牌有 192 位、猜不出来，限速只是顺手挡掉脚本乱撞。 */
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 8;

/** 网卡地址变化的复查间隔：DHCP 换址后自动重绑，否则手机会静默连不上。 */
const ADDRESS_WATCH_MS = 60_000;

/**
 * 本机可用于局域网访问的 IPv4 地址。
 *
 * 只取**非 internal 的 IPv4**：IPv6 在手机与路由器的组合下经常不可达（而报错很难懂），
 * internal 是回环。虚拟网卡（VMware / Hyper-V / WSL）也是非 internal 的，会一并列出 ——
 * 绑定用第一个，其余经 capabilities 报出，界面上可以看见「绑的是哪一个」。
 * @returns 形如 `[{ address, family, iface }]` 的数组。
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ address: a.address, family: 'IPv4', iface });
    }
  }
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
        resolve(Buffer.concat(chunks).toString('utf8') === '' ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
    reset() {
      hits.clear();
    },
  };
}

/**
 * 建一个远程访问服务。
 *
 * @param {object} deps
 * @param {() => string} deps.getDataRoot - 数据根（配置与令牌住在这儿）。
 * @param {() => string} deps.getUiDistDir - 渲染层产物目录（`src/client/ui-dist`）。
 * @param {(method: string, args: unknown[]) => Promise<unknown>} deps.gatedCall - 过闸后的后端调用。
 * @param {string} deps.appVersion - 应用版本（capabilities 报出）。
 * @param {(msg: string, ...rest: unknown[]) => void} [deps.log] - 日志（默认 console.log）。
 * @param {(msg: string, ...rest: unknown[]) => void} [deps.warn]
 * @param {string} [deps.bindHost] - 强制绑定地址（测试用；缺省取第一个局域网 IPv4）。
 * @returns 服务句柄。
 */
function createRemoteAccessServer(deps) {
  const log = deps.log || ((m, ...r) => console.log(m, ...r));
  const warn = deps.warn || ((m, ...r) => console.warn(m, ...r));
  const sessions = createSessionStore();
  const queue = createCallQueue();
  const limiter = createAuthLimiter();
  /** @type {Set<http.ServerResponse>} SSE 客户端 */
  const sseClients = new Set();

  let server = null;
  let heartbeat = null;
  let reconcileTimer = null;
  let state = { running: false, port: 0, address: '', preferredPort: DEFAULT_PORT, enabled: false, hasToken: false, startedAt: 0 };

  /** 当前是否已授权（会话 Cookie 有效）。 */
  function authorized(req) {
    const cookies = parseCookies(req.headers.cookie);
    return sessions.verify(cookies[SESSION_COOKIE]);
  }

  /** 写一条 SSE 事件到所有客户端。 */
  function writeSse(res, payload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      sseClients.delete(res); // 写不动就当它断了，交给 close 事件收尾
    }
  }

  /** 处理 `POST /api/auth`：令牌换会话。 */
  async function handleAuth(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (!limiter.ok(ip)) {
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
    // 令牌为空时**一律拒**：那是「还没在桌面端启用」的状态，不能变成「谁都进得来」。
    if (cfg.token === '' || !safeEquals(provided, cfg.token)) {
      limiter.fail(ip);
      sendJson(res, 401, { ok: false, error: { message: '令牌不正确', code: 'BAD_TOKEN' } });
      return;
    }
    limiter.reset();
    const session = sessions.create();
    res.setHeader('Set-Cookie', session.cookie);
    sendJson(res, 200, {
      ok: true,
      value: { version: deps.appVersion, native: NATIVE_CAPABILITIES, tokenMasked: maskToken(cfg.token) },
    });
  }

  /** 处理 `GET /api/capabilities`：告诉浏览器端「哪些原生能力这里没有」。 */
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
        bound: { address: state.address, port: state.port },
      },
    });
  }

  /** 处理 `POST /api/wechat/call`：白名单 → 排队 → 过闸 → 原样回信封。 */
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
    // 白名单在**过闸之前**：不在名单里的方法连许可证校验都不该走到，
    // 更不该让远程端的探测请求在后端留下调用痕迹。
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
      const result = await queue.run(() => deps.gatedCall(method, args));
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        error: { message: e?.message ?? String(e), code: e?.code || 'REMOTE_CALL_FAILED' },
      });
    }
  }

  /** 处理 `GET /api/wechat/events`：SSE 事件流。 */
  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // 反向代理/中间设备常会缓冲 SSE；这一头让常见实现直接透传。
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    // 连上就先补一帧状态：渲染层可能在订阅之前就错过了后端状态事件（与 IPC 侧
    // `wechat:backend-state` 的「挂载后补一次」同一个理由）。
    writeSse(res, { name: 'remote-access/ready', args: [{ port: state.port }] });
    req.on('close', () => sseClients.delete(res));
    req.on('error', () => sseClients.delete(res));
  }

  /** 路由：先 API、后静态。 */
  async function onRequest(req, res) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendJson(res, 400, { ok: false, error: { message: 'URL 无法解析', code: 'BAD_URL' } });
      return;
    }
    // 只接受 GET/POST：PUT/DELETE 之类在这套接口里没有语义，早拒比让它们落到静态分支好。
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: { message: `不支持 ${req.method}`, code: 'METHOD_NOT_ALLOWED' } });
      return;
    }

    if (urlPath === '/api/auth') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { message: '令牌校验只接受 POST', code: 'METHOD_NOT_ALLOWED' } });
        return;
      }
      await handleAuth(req, res);
      return;
    }
    if (urlPath.startsWith('/api/')) {
      // 除 /api/auth 外一律要求有效会话（401 而不是 403：不透露「这个端点存在」）。
      if (!authorized(req)) {
        sendJson(res, 401, { ok: false, error: { message: '未授权：请先用令牌换取会话', code: 'UNAUTHORIZED' } });
        return;
      }
      if (urlPath === '/api/capabilities' && req.method === 'GET') { handleCapabilities(req, res); return; }
      if (urlPath === '/api/wechat/call' && req.method === 'POST') { await handleCall(req, res); return; }
      if (urlPath === '/api/wechat/events' && req.method === 'GET') { handleEvents(req, res); return; }
      if (urlPath === '/api/status' && req.method === 'GET') { sendJson(res, 200, { ok: true, value: getState() }); return; }
      sendJson(res, 404, { ok: false, error: { message: `没有这个接口：${urlPath}`, code: 'NO_ROUTE' } });
      return;
    }

    // 静态资源：不需要会话（渲染层产物不是秘密；数据全在 /api/* 后面）。
    const target = urlPath === '/' ? '/index.html' : urlPath;
    const found = resolveStaticFile(deps.getUiDistDir(), target);
    if (!found.ok) {
      // 目录与缺失都回 404；穿越尝试额外留一行日志（那是有人在探这台机器）。
      if (found.reason === 'outside') warn('[remote-access] 拒绝越界路径请求: %s', req.url);
      sendJson(res, 404, { ok: false, error: { message: '没有这个资源', code: 'NOT_FOUND' } });
      return;
    }
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(); return; }
    sendFile(res, found.file, target);
  }

  /** 当前状态快照（不含令牌原文）。 */
  function getState() {
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    return {
      ...state,
      enabled: cfg.enabled,
      hasToken: cfg.token !== '',
      tokenMasked: maskToken(cfg.token),
      addresses: lanAddresses().map((a) => a.address),
      queue: queue.stats(),
      sseClients: sseClients.size,
      sessions: sessions.count(),
    };
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
          warn('[remote-access] 监听失败 %s:%d —— %s', host, port, err?.message ?? err);
          resolve(0);
        });
        srv.listen(port, host, () => {
          server = srv;
          // 长任务档是 10 分钟，socket 空闲超时与请求超时必须比它宽（或干脆关掉）——
          // 否则一个正常跑着的长调用会被服务端自己掐断，而界面只会看到「连接中断」。
          srv.timeout = 0;
          srv.requestTimeout = 0;
          srv.keepAliveTimeout = 75_000;
          srv.headersTimeout = 80_000;
          resolve(port);
        });
      };
      tryNext();
    });
  }

  /** 启动（幂等：已在跑就只刷新状态）。@returns 状态快照。 */
  async function start() {
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    if (state.running) return getState();
    // 两个条件都要成立（理由见文件头「默认关闭」那一节）。
    if (!cfg.enabled || cfg.token === '') {
      state = { ...state, running: false, enabled: cfg.enabled, hasToken: cfg.token !== '' };
      return getState();
    }
    const host = deps.bindHost || (lanAddresses()[0] || {}).address || '127.0.0.1';
    const port = await listenOn(host, cfg.port);
    if (port === 0) {
      warn('[remote-access] 端口 %d–%d 都不可用，未启动监听', cfg.port, cfg.port + PORT_ATTEMPTS - 1);
      return getState();
    }
    state = {
      running: true, port, address: host, preferredPort: cfg.port,
      enabled: true, hasToken: true, startedAt: Date.now(),
    };
    heartbeat = setInterval(() => {
      for (const res of sseClients) writeSse(res, { name: 'remote-access/heartbeat', args: [] });
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    // 定时与配置对齐：① 界面改了开关/端口要能生效（即使没人显式通知）；② DHCP 换址后
    // 旧地址就死了、手机会静默连不上，需要重绑。两件事都是「不做就静默坏」的类型。
    reconcileTimer = setInterval(() => { void syncWithConfig(); }, ADDRESS_WATCH_MS);
    reconcileTimer.unref?.();
    log('[remote-access] 已启动 http://%s:%d（手机与本机需在同一局域网）', host, port);
    return getState();
  }

  /** 地址变了就重绑（网卡切换 / DHCP 续租换址）。 */
  async function refreshBinding() {
    if (!state.running) return;
    const wanted = deps.bindHost || (lanAddresses()[0] || {}).address;
    if (!wanted || wanted === state.address) return;
    log('[remote-access] 本机地址变了（%s → %s），重新绑定', state.address, wanted);
    await stop();
    await start();
  }

  /**
   * 按当前配置对齐运行状态：该起就起、该停就停、端口或地址变了就重绑。
   *
   * 为什么要有它而不是只在启动时读一次配置：开关与端口是**用户随时会改**的，
   * 而配置住在数据根的 JSON 里、改它的是后端（`saveWechatConfig`），主进程收不到通知。
   * 界面改完可以显式调一次（立即生效），这里的定时器只是兜底。
   * @returns 状态快照。
   */
  async function syncWithConfig() {
    const cfg = readRemoteAccessConfig(deps.getDataRoot());
    const shouldRun = cfg.enabled && cfg.token !== '';
    if (!shouldRun) {
      if (state.running) {
        log('[remote-access] 配置已关闭，停止监听');
        await stop();
      }
      state = { ...state, enabled: cfg.enabled, hasToken: cfg.token !== '' };
      return getState();
    }
    if (!state.running) return start();
    if (cfg.port !== state.preferredPort) {
      log('[remote-access] 端口配置变了（%d → %d），重新绑定', state.preferredPort, cfg.port);
      await stop();
      return start();
    }
    await refreshBinding();
    return getState();
  }

  /** 停止监听并断开所有远程会话。 */
  async function stop() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    const drained = queue.drain('远程访问服务已停止');
    for (const res of sseClients) {
      try { res.end(); } catch { /* 已经断了 */ }
    }
    sseClients.clear();
    sessions.revokeAll();
    limiter.reset();
    const srv = server;
    server = null;
    state = { ...state, running: false, port: 0, address: '', startedAt: 0 };
    if (!srv) return getState();
    await new Promise((resolve) => {
      srv.close(() => resolve());
      // `close()` 只是「不再接受新连接」，它会**等既有的 keep-alive 连接自己超时**
      // （keepAliveTimeout 是 75 秒）—— 不主动关掉的话，这次 stop() 要挂 75 秒。
      // 实测过：端口改配置后 syncWithConfig 走 stop→start，整条重绑卡住一分钟以上，
      // 而界面看起来只是「开关没反应」。SSE 客户端上面已经 end() 过，这里再兜一次。
      srv.closeIdleConnections?.();
      srv.closeAllConnections?.();
    });
    log('[remote-access] 已停止监听（断开 %d 个排队请求）', drained);
    return getState();
  }

  /**
   * 把一个后端事件推给所有 SSE 客户端。
   *
   * payload 形状与 IPC 的 `wechat:event` **完全一致**（`{ name, args }`）——
   * 渲染层因此可以用同一套分发逻辑，7 个 CustomEvent 的名字与 detail 一字不改。
   */
  function pushEvent(name, args) {
    if (sseClients.size === 0) return;
    for (const res of sseClients) writeSse(res, { name, args });
  }

  return { start, stop, getState, pushEvent, syncWithConfig, refreshBinding, isRunning: () => state.running };
}

module.exports = {
  DEFAULT_PORT,
  PORT_ATTEMPTS,
  SSE_HEARTBEAT_MS,
  MAX_BODY_BYTES,
  lanAddresses,
  readRemoteAccessConfig,
  createRemoteAccessServer,
};

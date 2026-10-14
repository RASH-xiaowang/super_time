/**
 * 远程访问（手机端）的**令牌与会话**。
 *
 * ## 三段式，而不是「每个请求都带令牌」
 *
 * 令牌（长期凭据）只在**换取会话**那一刻出现一次：手机扫二维码得到
 * `http://<ip>:<port>/?t=<令牌>`，页面把它 POST 给 `/api/auth`，服务端比对通过后
 * 下发一个会话 Cookie，随后页面用 `history.replaceState` 把地址里的 `?t=` 抹掉。
 * 之后的每个请求只带 Cookie。
 *
 * 为什么不每个请求都带令牌：令牌会因此出现在**每一次**请求的 URL 或 header 里 ——
 * URL 会进代理日志、进浏览器历史、进 `Referer`。让它只出现一次，暴露面就小一个量级。
 *
 * 为什么用 Cookie 而不是 `Authorization` header：事件通道走的是 `EventSource`（SSE），
 * 而 **`EventSource` 不能自定义 header**（浏览器 API 的限制，不是我们的选择）。
 * Cookie 是唯一能让 SSE 连接自动带上凭据的办法。
 *
 * ## 这条链路上没有 TLS，所以要如实说
 *
 * 局域网里跑的是明文 HTTP（自签证书在手机上会触发安全警告，实际不可用）。
 * 后果：敌意网络（公共 Wi-Fi、被入侵的路由器）里，同网段的人能嗅探到令牌、会话 Cookie
 * 与查阅的数据；`Secure` 这个 Cookie 标志也用不上（它要求 HTTPS）。
 * 这一点写进了 `docs/PRIVACY.md` 第四节 H，也是「只在你信任的局域网里打开」那条提示的由来。
 *
 * ## 比对口径
 *
 * 用 `crypto.timingSafeEqual`，且**比的是两边的 SHA-256 摘要**而不是原文：
 * `timingSafeEqual` 在两个 buffer 长度不同时会**直接抛异常**，而「长度不同」正是
 * 「令牌猜错了」最常见的情况 —— 先比长度就等于把令牌长度泄漏给了攻击者，
 * 还得为抛异常再写一条分支。摘要化之后两边恒等长，既不会抛、也不泄漏长度。
 *
 * @module backend/http-auth
 */
const crypto = require('node:crypto');

/** 会话有效期：12 小时。手机锁屏放一晚上就该重新扫码，而不是永久有效。 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 会话 Cookie 的名字。 */
const SESSION_COOKIE = 'st_sess';

/** 令牌字节数：24 字节 → base64url 32 字符。够长到不可猜，够短到二维码装得下。 */
const TOKEN_BYTES = 24;

/** 生成一个新令牌（base64url，无 `+/=`，可以直接放进 URL 与二维码）。 */
function generateAccessToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** 生成一个会话 id（与令牌同强度；它只存在于内存与 Cookie 里）。 */
function generateSessionId() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * 定长比对两个凭据。
 *
 * 先摘要再比：① 两边恒等长，`timingSafeEqual` 不会因长度不同而抛；
 * ② 不泄漏原文长度；③ 任一边是空串/非字符串时**一律判不相等**（空令牌绝不能匹配成功，
 *    否则「还没生成令牌」的状态会变成「谁都进得来」）。
 * @param {unknown} provided - 调用方给的凭据。
 * @param {unknown} expected - 期望值。
 * @returns 相等为 true。
 */
function safeEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided === '' || expected === '') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 令牌的掩码形式（给界面显示用）。
 *
 * 为什么要掩码：设置卡片上如果直接印明文令牌，那么**任何能看到这块屏幕的人**
 * （投屏、截图、远程协助、肩窥）都拿到了完整凭据。掩码之后他们只知道「有个令牌」。
 * 真要拿到明文，只能通过二维码（同样在屏幕上，但那是用户主动扫码的一刻）或轮换。
 * @param {string} token - 原始令牌。
 * @returns 形如 `abcd…wxyz` 的掩码串；空令牌返回空串。
 */
function maskToken(token) {
  if (typeof token !== 'string' || token === '') return '';
  if (token.length <= 8) return '…';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * 解析 Cookie 头。
 *
 * 刻意手写而不是引依赖：本仓的运行时依赖要逐个登记进打包白名单（`package.json` 的
 * `build.files`），为一个 `split(';')` 多带一个包不划算。
 * @param {string | undefined} header - 请求的 `cookie` 头。
 * @returns 键值对（同名取**第一个**，与浏览器发送顺序一致）。
 */
function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === '' || Object.prototype.hasOwnProperty.call(out, k)) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim(); // 解不开就按原文存，别让一个坏 Cookie 掀掉整张表
    }
  }
  return out;
}

/**
 * 会话 Cookie 的属性串。
 *
 * - `HttpOnly`：脚本读不到 ⇒ 一处 XSS 偷不走会话（渲染层是自己加载的，但面板里会显示
 *   来自微信数据的文本，这道防线不能省）；
 * - `SameSite=Lax`：跨站请求不带它。手机访问时页面与 API **同源**（同一个 ip:port），
 *   Lax 不影响正常调用，但能挡掉「别的网站让你的手机浏览器向本机发请求」这类打法；
 * - **没有 `Secure`**：需要 HTTPS，而这条链路是明文 HTTP（见文件头）。这是已知代价，
 *   不是遗漏 —— 所以 `docs/PRIVACY.md` 第四节 H 明写了「只在信任的局域网里打开」；
 * - `Path=/`：整站都带（SSE 与 API 在不同路径上）。
 *
 * @param {string} id - 会话 id。
 * @param {number} maxAgeSec - `Max-Age`（秒）；传 0 表示立即失效（登出用）。
 * @returns `Set-Cookie` 的值。
 */
function sessionCookie(id, maxAgeSec) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  return attrs.join('; ');
}

/**
 * 内存态会话表。
 *
 * **刻意不落盘**：进程退出即全部失效，重启后手机要重新扫码。落盘会让「关掉应用」
 * 不再等于「断开所有远程会话」，而用户是按前者理解的。
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] - 会话有效期。
 * @param {() => number} [opts.now] - 时钟（测试注入用）。
 * @returns 会话管理器。
 */
function createSessionStore(opts = {}) {
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : SESSION_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** @type {Map<string, number>} id → 过期时刻（ms） */
  const sessions = new Map();

  /** 顺手清掉过期的：表很小（一台手机一两条），不需要定时器。 */
  function sweep() {
    const t = now();
    for (const [id, exp] of sessions) {
      if (exp <= t) sessions.delete(id);
    }
  }

  return {
    /** 新建一个会话。@returns `{ id, cookie }`（cookie 是可直接塞进 `Set-Cookie` 的值）。 */
    create() {
      sweep();
      const id = generateSessionId();
      sessions.set(id, now() + ttlMs);
      return { id, cookie: sessionCookie(id, ttlMs / 1000) };
    },
    /**
     * 校验一个会话 id。
     * @param {unknown} id - Cookie 里解出来的值。
     * @returns 有效为 true（过期与未知一律 false）。
     */
    verify(id) {
      if (typeof id !== 'string' || id === '') return false;
      const exp = sessions.get(id);
      if (exp === undefined) return false;
      if (exp <= now()) {
        sessions.delete(id);
        return false;
      }
      return true;
    },
    /** 作废全部会话（轮换令牌时调用：旧令牌换来的会话必须一起死）。 */
    revokeAll() {
      sessions.clear();
    },
    /** 当前有效会话数（给状态端点与测试用）。 */
    count() {
      sweep();
      return sessions.size;
    },
    /** 登出用的失效 Cookie。 */
    expireCookie() {
      return sessionCookie('', 0);
    },
  };
}

module.exports = {
  SESSION_TTL_MS,
  SESSION_COOKIE,
  generateAccessToken,
  safeEquals,
  maskToken,
  parseCookies,
  sessionCookie,
  createSessionStore,
};

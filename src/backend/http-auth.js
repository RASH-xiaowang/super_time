/**
 * 远程访问（手机端）的**令牌与会话**。
 *
 * ## 三段式，而不是「每个请求都带令牌」
 *
 * 扫码拿到的是**短命、成功后立即作废的配对码**，长期 `api_token` 不再进二维码与地址栏。
 * 手机打开 `http://<ip>:<port>/?t=<配对码>`，页面把它 POST 给 `/api/auth`，服务端比对通过后
 * 下发一个会话 Cookie，随后页面用 `history.replaceState` 把地址里的 `?t=` 抹掉。
 * 之后的每个请求只带 Cookie。
 *
 * 为什么不每个请求都带配对码 / 令牌：凭据会因此出现在**每一次**请求的 URL 或 header 里 ——
 * URL 会进代理日志、进浏览器历史、进 `Referer`。让配对码只出现一次且短时有效，
 * 即使它被截屏或嗅探，可重放窗口也从「直到用户轮换」缩到几分钟。
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

/** 配对码字节数：16 字节 → base64url 22 字符，短命凭据不需要与长期令牌同长。 */
const PAIRING_CODE_BYTES = 16;

/** 配对码有效期：5 分钟。用户从屏幕/二维码取码到手机发请求，不该让窗口无限期存在。 */
const PAIRING_TTL_MS = 5 * 60 * 1000;

/** 一个配对码最多允许的试错次数：容忍手输笔误，又不给无限穷举窗口。 */
const PAIRING_MAX_ATTEMPTS = 5;

/** 同时保留的未消费配对码上限：旧码被淘汰，内存不会被反复轮换撑大。 */
const PAIRING_MAX_PENDING = 8;

/** 生成一个新配对码。 */
function generatePairingCode() {
  return crypto.randomBytes(PAIRING_CODE_BYTES).toString('base64url');
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
  /** @type {Map<string, { exp: number, fullAccess: boolean }>} id → 过期时刻与权限级别 */
  const sessions = new Map();

  /** 顺手清掉过期的：表很小（一台手机一两条），不需要定时器。 */
  function sweep() {
    const t = now();
    for (const [id, entry] of sessions) {
      if (entry.exp <= t) sessions.delete(id);
    }
  }

  return {
    /**
     * 新建一个会话。
     * @param {{ fullAccess?: boolean }} [meta] - `fullAccess:true` 只由「打开网页」交接的配对码授予。
     * @returns `{ id, cookie }`（cookie 是可直接塞进 `Set-Cookie` 的值）。
     */
    create(meta = {}) {
      sweep();
      const id = generateSessionId();
      sessions.set(id, { exp: now() + ttlMs, fullAccess: meta.fullAccess === true });
      return { id, cookie: sessionCookie(id, ttlMs / 1000) };
    },
    /**
     * 校验一个会话 id。
     * @param {unknown} id - Cookie 里解出来的值。
     * @returns 有效为 true（过期与未知一律 false）。
     */
    verify(id) {
      if (typeof id !== 'string' || id === '') return false;
      const entry = sessions.get(id);
      if (entry === undefined) return false;
      if (entry.exp <= now()) {
        sessions.delete(id);
        return false;
      }
      return true;
    },
    /**
     * 该会话是不是「桌面交接」级会话（浏览器与桌面端同权限）。
     * @param {unknown} id - Cookie 里解出来的值。
     * @returns 持有有效 fullAccess 会话时为 true。
     */
    isFull(id) {
      if (typeof id !== 'string' || id === '') return false;
      const entry = sessions.get(id);
      if (entry === undefined) return false;
      if (entry.exp <= now()) {
        sessions.delete(id);
        return false;
      }
      return entry.fullAccess === true;
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

/**
 * 短命配对码表。
 *
 * 配对码**刻意不落盘**：它只在「桌面端刚生成二维码」到「手机第一次登录」之间存在。
 * 成功消费即删除，应用/远程服务停止也全部作废。长期 `api_token` 留在 `secrets.json`
 * 只用于满足「远程访问确实启用过」的硬条件，不再由二维码或界面透出。
 *
 * 用 `safeEquals` 逐个比对而不是按 key 直接查：挂起的码很少，遍历既保持比对口径与
 * 长期令牌一致，也避免 Map 查表给错误长度/不存在码额外计时差异。
 *
 * 错误猜测无法区分“冲着哪个码来的”，因此一次非空错误输入会**同时**消耗所有挂起码
 * 的剩余次数；某个码的次数耗尽即被删除。这样 `maxAttempts` 是真实可执行的预算，
 * 而不是一个永远不减少的摆设。
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] - 配对码寿命。
 * @param {number} [opts.maxAttempts] - 每个未消费码可承受的错误猜测次数。
 * @param {number} [opts.maxPending] - 未消费码上限。
 * @param {() => number} [opts.now] - 时钟（测试注入用）。
 */
function createPairingStore(opts = {}) {
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : PAIRING_TTL_MS;
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
    ? opts.maxAttempts
    : PAIRING_MAX_ATTEMPTS;
  const maxPending = Number.isInteger(opts.maxPending) && opts.maxPending > 0
    ? opts.maxPending
    : PAIRING_MAX_PENDING;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** @type {Map<string, { expiresAt: number, attemptsLeft: number, fullAccess: boolean }>} */
  const entries = new Map();

  function sweep() {
    const t = now();
    for (const [code, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(code);
    }
  }

  return {
    /**
     * 发一个新配对码。
     * @param {{ fullAccess?: boolean }} [meta] - `fullAccess:true` = 「打开网页」交接码。
     */
    issue(meta = {}) {
      sweep();
      const code = generatePairingCode();
      entries.set(code, { expiresAt: now() + ttlMs, attemptsLeft: maxAttempts, fullAccess: meta.fullAccess === true });
      while (entries.size > maxPending) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return code;
    },
    /**
     * 校验并消费一个配对码。
     * @param {unknown} provided - 浏览器提交的值。
     * @returns `{ ok: true }` 表示成功并已作废；否则 `{ ok: false, attemptsLeft }`。
     *   交接码成功时额外带 `fullAccess: true`（普通手机码没有这个字段）。
     */
    verify(provided) {
      sweep();
      if (typeof provided !== 'string' || provided === '') return { ok: false, attemptsLeft: 0 };
      let hit = null;
      for (const [code, entry] of entries) {
        if (safeEquals(provided, code)) hit = { code, entry };
      }
      if (!hit) {
        // 一次错误输入同时消耗所有挂起码：不这样做的话，maxAttempts 只会在“猜中后”
        // 被检查一次，而猜中本来就立即消费，预算形同虚设。
        let lowest = maxAttempts;
        for (const [code, entry] of entries) {
          entry.attemptsLeft -= 1;
          if (entry.attemptsLeft <= 0) {
            entries.delete(code);
            continue;
          }
          if (entry.attemptsLeft < lowest) lowest = entry.attemptsLeft;
        }
        return { ok: false, attemptsLeft: entries.size === 0 ? 0 : lowest };
      }
      entries.delete(hit.code);
      return {
        ok: true,
        attemptsLeft: 0,
        ...(hit.entry.fullAccess === true ? { fullAccess: true } : {}),
      };
    },
    /** 全部作废（停服、轮换、关闭开关时）。 */
    revokeAll() {
      entries.clear();
    },
    /** 当前未消费码数（诊断用）。 */
    count() {
      sweep();
      return entries.size;
    },
  };
}

module.exports = {
  SESSION_TTL_MS,
  SESSION_COOKIE,
  PAIRING_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_MAX_PENDING,
  generateAccessToken,
  generatePairingCode,
  safeEquals,
  maskToken,
  parseCookies,
  sessionCookie,
  createSessionStore,
  createPairingStore,
};

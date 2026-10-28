'use strict';

/**
 * RPA 图片**签名直链**的宿主侧（2026-10-23）。
 *
 * ## 它解决什么
 *
 * 任务命中关键词时可以把触发图片发给 RPA 厂商，但厂商的触发接口只有字符串参数：
 * 塞 base64 会撑爆参数上限（八爪鱼 40KB / 影刀 8000 字），所以改成发**链接**。
 * 后端为每张图片签一个短时令牌（算法见 `wechat-data/src/net/rpa-media.ts`，两边共用），
 * 参数里出现 `http://<可达地址>:<端口>/api/rpa-media/<token>`，机器人自己去取字节。
 *
 * ## 为什么挂在局域网监听面上，而不是新起一个端口
 *
 * 本应用**默认不监听任何端口**（见 `docs/PRIVACY.md` 第四节 H）。这条路由是**既有**
 * 监听面上的一条新路径：监听没开就没有这条链接，开了也只多这一条 —— 不新增端口、
 * 不新增常驻进程。反过来也意味着：**要发图片链接，必须先打开局域网访问**（否则后端
 * 根本不会生成链接，会在参数里如实写「未启用」而不是发一个取不到的地址）。
 *
 * ## 鉴权：令牌就是凭据
 *
 * 这条路由**不要求会话 Cookie**（机器人拿不到 Cookie），凭据完全在 URL 里：
 *  · HMAC-SHA256，密钥由 `secrets.json` 的 `api_token` 派生 ⇒ 轮换令牌即全部失效；
 *  · 一个令牌只对应**一张图片**（载荷里带 decoded 根内的相对路径）且**一小时后过期**；
 *  · 路径仍要过 `media-protocol.js` 的 `resolveDecodedFile`（根内 + 图片扩展名 + 拒绝 `..`），
 *    因此拿不到目录列表、读不到 decoded 根之外的任何文件；
 *  · 失败一律 404（不区分「格式错 / 签名错 / 过期」，不给探测者任何区分信号）。
 *
 * ## Host 例外名单
 *
 * `http-server.js` 的 Host 校验（防 DNS rebinding）默认只认当前监听地址。这条路由要能
 * 被两种正常来源取到：① 本机**其它**网卡地址（后端拼 URL 时挑的那个地址不一定等于监听
 * 地址）；② 用户自己配的反向代理/公网入口（`config.json` 的 `rpa_media_base_url`，云端
 * RPA 必须走它）。所以这里给出一份**额外允许的主机名**（只比对主机名，不比端口 —— 代理
 * 侧通常是 80/443）。名单里只有本机自己的地址与用户显式配置的那一个域名，任何攻击者
 * 可控的域名仍然过不了。
 *
 * @module backend/rpa-media
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MIME_BY_EXT, resolveDecodedFile } = require('./media-protocol.js');

/**
 * 路径前缀。与 `wechat-data/src/net/rpa-media.ts` 的 `RPA_MEDIA_PATH_PREFIX` **必须一致**
 * （两处各写一份是因为宿主层要在**同步**的路由分支里用它；`rpa-media.spec.ts` 有一条
 * 用例直接比对两边常量，改一边忘另一边会红）。
 */
const RPA_MEDIA_PATH_PREFIX = '/api/rpa-media/';

/** 额外允许主机名的缓存时长（网卡/配置变化后最多迟这么久生效）。 */
const ALLOWED_HOSTS_TTL_MS = 30_000;

/**
 * 命中直链时的缓存策略。
 *
 * 不缓存：轮换 `api_token`、停服或文件被清理后，旧 URL 必须立刻失效；这里没有
 * 需要 CDN 缓存的大流量场景，`no-store` 的确定性比省一次读取更重要。
 */
const MEDIA_CACHE_CONTROL = 'private, no-store';

/** 默认的令牌加载器：读宿主层那份独立小 bundle（与后端同一份源码产出）。 */
function defaultTokenModuleLoader() {
  return import('./wechat-data/lib/net/rpa-media.js');
}

/**
 * 本机可用于直链的 IPv4 地址（非 internal）。
 *
 * 这里**不做排序**（`http-server.js` 的 `lanAddresses()` 才负责「绑哪个」）：
 * 直链只要求「这个地址确实是本机的」，所以全部收下，避免与绑定逻辑各自漂移。
 * @returns {string[]} 地址列表（可能为空）。
 */
function localIPv4Addresses() {
  const out = [];
  let ifaces;
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return out;
  }
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      if (typeof a.address === 'string' && a.address !== '') out.push(a.address.toLowerCase());
    }
  }
  return out;
}

/**
 * 配置里的公网入口（`rpa_media_base_url`）→ 主机名。
 * 只接受 http/https 绝对地址；其余（空、写错、非 http 协议）一律忽略。
 * @param {string} baseUrl - 配置值。
 * @returns {string} 小写主机名，或空串。
 */
function hostnameOfBaseUrl(baseUrl) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (raw === '') return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 直链路由与 Host 例外名单。
 *
 * @param {object} deps - 由 `http-server.js` 注入。
 * @param {() => string} deps.getDecodedRoot - decoded_images 根（未就绪时为空串）。
 * @param {() => { token: string, mediaBaseUrl?: string }} deps.getMediaConfig - 读 `secrets.json`
 *   的 `api_token` 与 `config.json` 的 `rpa_media_base_url`（每次现取：轮换令牌立即生效）。
 * @param {object} [options] - 测试注入口。
 * @param {() => Promise<object>} [options.loadTokenModule] - 覆盖验签模块加载。
 * @returns {{ handleRpaMedia: (res: object, token: string) => Promise<void>, allowedHosts: () => string[] }}
 */
function createRpaMediaHandler(deps, options = {}) {
  const loadTokenModule = options.loadTokenModule || defaultTokenModuleLoader;
  /** @type {Promise<object> | null} 验签模块（首次用到才加载，之后复用同一份） */
  let tokenModulePromise = null;
  /** @type {{ at: number, hosts: string[] } | null} */
  let localHostCache = null;

  /** 取（并缓存 30 秒）验签模块；加载失败时下次请求重试。 */
  function tokenModule() {
    if (tokenModulePromise === null) {
      tokenModulePromise = Promise.resolve(loadTokenModule()).catch((e) => {
        tokenModulePromise = null;
        throw e;
      });
    }
    return tokenModulePromise;
  }

  /** 404：不区分「没配置 / 令牌坏 / 过期 / 文件不在」—— 都是「没有这个资源」。 */
  function notFound(res) {
    const body = Buffer.from(JSON.stringify({
      ok: false,
      error: { message: '图片不存在或链接已失效', code: 'MEDIA_NOT_FOUND' },
    }), 'utf8');
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  /**
   * 处理一次 `GET /api/rpa-media/<token>`。
   * @param {object} res - ServerResponse。
   * @param {string} token - 路径里那一段（已 decode）。
   * @returns {Promise<void>} 响应写完即 resolve。
   */
  async function handleRpaMedia(res, token) {
    const cfg = deps.getMediaConfig();
    const apiToken = cfg && typeof cfg.token === 'string' ? cfg.token : '';
    // 未配置令牌 = 入站面没启用过：这条路由等于不存在（不给探测者任何差别）。
    if (apiToken === '') {
      notFound(res);
      return;
    }
    let mod;
    try {
      mod = await tokenModule();
    } catch {
      // 产物缺失/加载失败属于部署问题：对外仍是 404，日志留给 http-server 的调用方。
      notFound(res);
      return;
    }
    const payload = mod.verifyRpaMediaToken(mod.rpaMediaTokenKey(apiToken), token, Date.now());
    if (payload === null) {
      notFound(res);
      return;
    }
    const root = String(deps.getDecodedRoot() || '');
    const abs = resolveDecodedFile(root, payload.rel);
    if (abs === null) {
      notFound(res);
      return;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      notFound(res);
      return;
    }
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': MEDIA_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline; filename="' + path.basename(abs).replace(/"/g, '') + '"',
    });
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch { /* 忽略 */ } });
    stream.pipe(res);
  }

  /**
   * Host 校验的额外允许名单（见文件头「Host 例外名单」）。
   * @returns {string[]} 小写主机名列表（含本机所有 IPv4 与配置的公网入口主机名）。
   */
  function localAllowedHosts() {
    const now = Date.now();
    if (localHostCache !== null && now - localHostCache.at < ALLOWED_HOSTS_TTL_MS) return localHostCache.hosts;
    localHostCache = { at: now, hosts: localIPv4Addresses() };
    return localHostCache.hosts;
  }

  /**
   * Host 校验的额外允许名单（见文件头「Host 例外名单」）。
   *
   * 本机网卡地址缓存 30 秒；配置里的公网入口**每次现取** —— 否则用户改完
   * `rpa_media_base_url` 后的第一次投递可能生成一个当前 Host 校验还不放行的地址。
   * 该函数只由 RPA 图片路由调用，不会给普通 API / 静态资源增加文件读取开销。
   * @returns {string[]} 小写主机名列表（含本机所有 IPv4 与配置的公网入口主机名）。
   */
  function allowedHosts() {
    const cfg = deps.getMediaConfig();
    const hosts = [...localAllowedHosts()];
    const publicHost = hostnameOfBaseUrl(cfg && typeof cfg.mediaBaseUrl === 'string' ? cfg.mediaBaseUrl : '');
    if (publicHost !== '' && !hosts.includes(publicHost)) hosts.push(publicHost);
    return hosts;
  }

  return { handleRpaMedia, allowedHosts };
}

module.exports = {
  RPA_MEDIA_PATH_PREFIX,
  createRpaMediaHandler,
  localIPv4Addresses,
  hostnameOfBaseUrl,
};

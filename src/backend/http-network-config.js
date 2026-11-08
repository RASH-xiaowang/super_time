/**
 * HTTP 远程访问的网络地址、配置文件与请求级辅助。
 *
 * 这些函数既要在后端就绪前读取配置，也会被路由、鉴权和生命周期共同调用。
 * 单独成文件后，`http-server.js` 只保留服务编排与路由顺序，避免主文件继续膨胀。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SECURITY_HEADERS } = require('./http-static');

/** 默认端口（配置键 `api_port` 的缺省值，与 `config/wechat-config.ts` 同口径）。 */
const DEFAULT_PORT = 5032;

/** 请求体上限：调用参数是 JSON（方法名 + 参数），4MB 已经很宽；图片是**返回**方向，不受此限。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * 入站消息 Webhook 的 JSON 请求体上限。
 *
 * 附件预算按解码后的二进制计 20 MB；JSON 里的 base64 会膨胀到约 4/3，
 * 再叠加转义与字段开销，30 MB 足够覆盖合法的 20 MB 总量。
 */
const MESSAGE_WEBHOOK_BODY_BYTES = 30 * 1024 * 1024;

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
  let score = 0;
  if (VIRTUAL_IFACE_HINTS.some((re) => re.test(iface))) score -= 1000;
  if (typeof addr.mac === 'string' && addr.mac !== '' && addr.mac !== '00:00:00:00:00:00') score += 20;
  if (/(^|[^a-z])(wi-?fi|wlan|wireless)([^a-z]|$)/i.test(iface)) score += 30;
  if (/ethernet|以太网|本地连接/i.test(iface)) score += 20;
  if (/^169\.254\./.test(addr.address)) score -= 500;
  if (addr.address === '0.0.0.0') score -= 900;
  return score;
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
 *
 * 多返回一个 `mediaBaseUrl`（`config.json` 的 `rpa_media_base_url`）：RPA 图片直链要发给
 * **外部**机器人，局域网地址对云端 RPA 不可达，所以允许用户填一个反代/公网入口；
 * 它是 Host 例外名单里唯一一个非本机地址（见 `rpa-media.js` 文件头）。
 * @param {string} dataRoot - 数据根（`wechatBoot.info.root`）。
 * @returns `{ enabled, port, token, mediaBaseUrl }`。
 */
function readRemoteAccessConfig(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot === '') {
    return { enabled: false, port: DEFAULT_PORT, token: '', mediaBaseUrl: '' };
  }
  const cfg = readJsonSafe(path.join(dataRoot, 'config.json'));
  const secrets = readJsonSafe(path.join(dataRoot, 'secrets.json'));
  const port = Number(cfg.api_port);
  return {
    enabled: cfg.api_enabled === true,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.floor(port) : DEFAULT_PORT,
    token: typeof secrets.api_token === 'string' ? secrets.api_token : '',
    mediaBaseUrl: typeof cfg.rpa_media_base_url === 'string' ? cfg.rpa_media_base_url : '',
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
 * `extraHosts` 是**额外**放行的主机名（当前只有 RPA 图片直链用得上，见 `rpa-media.js`
 * 的「Host 例外名单」）：只比对主机名、**不比端口** —— 反向代理侧的端口通常是 80/443，
 * 与监听端口无关。名单里只有本机自己的网卡地址与用户显式配置的那一个域名，
 * 攻击者可控的域名仍然过不了（DNS rebinding 的判据没变）。
 *
 * @param {string | undefined} authority - 请求的 `Host` 头。
 * @param {string} expectedAddress - 当前监听地址。
 * @param {number} expectedPort - 当前监听端口。
 * @param {string[]} [extraHosts] - 额外允许的主机名（小写，忽略端口）。
 * @returns {boolean} 允许该 Host 时为 true。
 */
function isHostAllowed(authority, expectedAddress, expectedPort, extraHosts = []) {
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
  if (extraHosts.includes(actual)) return true;
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
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

/**
 * 读请求体（带上限）。
 *
 * 超限**立刻销毁连接**而不是读完再拒：读满一个几 GB 的 body 本身就是攻击面。
 * @param {import('node:http').IncomingMessage} req
 * @returns JSON 解析结果；失败时 reject（带 `status`）。
 */
function readBody(req, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : MAX_BODY_BYTES;
  if (options.requireJson === true) {
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      const err = new Error('请求必须使用 application/json');
      err.status = 415;
      err.code = 'UNSUPPORTED_MEDIA_TYPE';
      return Promise.reject(err);
    }
  }
  const rawLength = req.headers['content-length'];
  let declaredLength;
  if (rawLength !== undefined) {
    const text = Array.isArray(rawLength) ? rawLength[0] : String(rawLength);
    if (!/^\d+$/.test(text)) {
      const err = new Error('Content-Length 无效');
      err.status = 400;
      err.code = 'BAD_CONTENT_LENGTH';
      return Promise.reject(err);
    }
    declaredLength = Number(text);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      const err = new Error('Content-Length 无效');
      err.status = 400;
      err.code = 'BAD_CONTENT_LENGTH';
      return Promise.reject(err);
    }
    if (declaredLength > maxBytes) {
      const err = new Error('请求体过大');
      err.status = 413;
      err.code = 'BODY_TOO_LARGE';
      return Promise.reject(err);
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err, destroy = false) => {
      if (settled) return;
      settled = true;
      reject(err);
      if (destroy) req.destroy();
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        const err = new Error('请求体过大');
        err.status = 413;
        err.code = 'BODY_TOO_LARGE';
        fail(err, true);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      if (declaredLength !== undefined && size !== declaredLength) {
        const err = new Error('请求体长度与 Content-Length 不一致');
        err.status = 400;
        err.code = 'BODY_LENGTH_MISMATCH';
        fail(err);
        return;
      }
      try {
        const buffer = Buffer.concat(chunks);
        const parsed = buffer.length === 0 ? {} : JSON.parse(buffer.toString('utf8'));
        if (options.requireObject === true
          && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
          const err = new Error('请求体必须是 JSON 对象');
          err.status = 400;
          err.code = 'BAD_JSON_SHAPE';
          fail(err);
          return;
        }
        settled = true;
        resolve(parsed);
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.status = 400;
        err.code = 'BAD_JSON';
        fail(err);
      }
    });
    req.on('aborted', () => {
      const err = new Error('请求体读取中断');
      err.status = 400;
      err.code = 'BODY_ABORTED';
      fail(err);
    });
    req.on('error', (e) => fail(e));
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

module.exports = {
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  MESSAGE_WEBHOOK_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  ADDRESS_WATCH_MS,
  lanAddresses,
  readJsonSafe,
  readRemoteAccessConfig,
  isHostAllowed,
  sendJson,
  readBody,
  createAuthLimiter,
};

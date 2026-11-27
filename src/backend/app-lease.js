/**
 * 应用授权票据（2026-11-24）。
 *
 * ## 为什么不是「签名文件」
 * 授权文件可以被复制到别的机器、也无法随许可证到期即时失效。这里改成
 * **短命票据**：SuperLanguage 每次启动/续期都向 Super Time 换一张，过期即失联。
 *
 * ## 为什么是 HMAC 而不是 Ed25519
 * SuperLanguage 是 Win32 C++ 程序，目标包含 Windows 10；CNG 在 Win10 上不保证
 * 有 Ed25519，而 HMAC-SHA256 全平台可用，C++ 侧只需 `BCrypt`。
 * 密钥在首次部署时由 Super Time 派生并写进实例目录（ACL 收紧），
 * 撤销 = 删登记行（旧票据 TTL 内自然失效）或轮换主密钥（全局吊销）。
 *
 * ## 票据格式（刻意不用 JSON）
 * 票据载荷是**换行分隔的纯文本**，随票据一起下发：
 *
 *   app \n instanceId \n seat \n licenseId \n iat \n exp \n jti \n caps \n
 *   maxJobsPerHour \n exeSha256 \n version
 *
 * C++ 侧只需要按 `\n` 切分，**不必重算规范化 JSON** —— 那是最容易两边漂移的地方。
 * 传输时整段 claim 用十六进制编码，因此字段里可以安全出现空格/逗号。
 *
 * 管道报文（单行）：
 *   HELLO <v> <instanceId> <exeSha256> <proofHex>
 *   RENEW <instanceId> <proofHex>
 *   TICKET <claimHex> <macHex>
 *   DENY <code> <message...>
 *
 * @module backend/app-lease
 */
const crypto = require('node:crypto');

const TICKET_VERSION = 1;
/** 票据有效期：够扛住一次短暂的主机重启，又必须让吊销及时生效。 */
const TICKET_TTL_MS = 10 * 60 * 1000;
/** 客户端在拿不到新票据时的宽限：跑完在飞任务，但不再领取新任务。 */
const LICENSE_GRACE_MS = 15 * 60 * 1000;
/** 允许的对时误差；超过就判 CLOCK_SKEW（防止把系统时钟调回去续命）。 */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * 十六进制小写校验。
 * @param {unknown} value - 待检查值。
 * @param {number} length - 期望长度（字符数）；0 表示不限制。
 * @returns {boolean} 是否合法。
 */
function isHex(value, length = 0) {
  if (typeof value !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(value)) return false;
  return length === 0 || value.length === length;
}

function hmacHex(secretHex, text) {
  const key = Buffer.from(String(secretHex), 'hex');
  if (key.length < 16) throw new Error('票据密钥过短');
  return crypto.createHmac('sha256', key).update(String(text), 'utf8').digest('hex');
}

/** 常量时间比较两个十六进制串（长度不同直接 false）。 */
function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** HELLO / RENEW 的客户端证明：证明自己持有该实例的密钥。 */
function clientProof(secretHex, op, instanceId, exeSha256 = '') {
  return hmacHex(secretHex, op + ':v1:' + String(instanceId) + ':' + String(exeSha256).toLowerCase());
}

/**
 * 把票据载荷拼成 claim 文本（顺序即协议，改顺序就是协议不兼容）。
 * @param {object} payload - 票据字段。
 * @returns {string} claim 文本。
 */
function claimOf(payload) {
  return [
    String(payload.app),
    String(payload.instanceId),
    String(payload.seat),
    String(payload.licenseId),
    String(payload.iat),
    String(payload.exp),
    String(payload.jti),
    Array.isArray(payload.caps) ? payload.caps.join(',') : '',
    String(payload.maxJobsPerHour),
    String(payload.exeSha256 || ''),
    String(TICKET_VERSION),
  ].join('\n');
}

/**
 * 签一张票据。
 * @param {object} input - `{ secret, app, instanceId, seat, licenseId, caps, maxJobsPerHour, exeSha256, ttlMs, now }`。
 * @returns {{ claim: string, claimHex: string, mac: string, payload: object }} 票据。
 */
function issueTicket(input) {
  const now = Number(input?.now) || Date.now();
  const ttlMs = Number(input?.ttlMs) > 0 ? Number(input.ttlMs) : TICKET_TTL_MS;
  const payload = {
    app: String(input?.app || 'superlanguage'),
    instanceId: String(input?.instanceId || ''),
    seat: Number(input?.seat) || 0,
    licenseId: String(input?.licenseId || ''),
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
    jti: crypto.randomBytes(8).toString('hex'),
    caps: Array.isArray(input?.caps) ? input.caps.map(String) : [],
    maxJobsPerHour: Number(input?.maxJobsPerHour) || 0,
    exeSha256: String(input?.exeSha256 || '').toLowerCase(),
  };
  if (!isHex(String(input?.secret), 0)) throw new Error('票据密钥格式无效');
  const claim = claimOf(payload);
  return {
    claim,
    claimHex: Buffer.from(claim, 'utf8').toString('hex'),
    mac: hmacHex(input.secret, claim),
    payload,
  };
}

/**
 * 校验票据（客户端同款逻辑，主机侧用于自检与回归测试）。
 * @param {object} input - `{ secret, claim, mac, instanceId, app, exeSha256, now, lastIat }`。
 * @returns {{ ok: true, payload: object } | { ok: false, code: string, message: string }}
 */
function verifyTicket(input) {
  const claim = String(input?.claim || '');
  if (claim === '') return { ok: false, code: 'BAD_TICKET', message: '票据为空' };
  if (!safeEqualHex(hmacHex(input?.secret, claim), input?.mac)) {
    return { ok: false, code: 'BAD_TICKET', message: '票据签名不匹配' };
  }
  const parts = claim.split('\n');
  if (parts.length !== 11) return { ok: false, code: 'BAD_TICKET', message: '票据字段数量不符' };
  const [app, instanceId, seat, licenseId, iatRaw, expRaw, jti, capsRaw, quotaRaw, exeSha256, version] = parts;
  if (version !== String(TICKET_VERSION)) {
    return { ok: false, code: 'BAD_TICKET', message: '票据版本不兼容' };
  }
  if (input?.app !== undefined && app !== String(input.app)) {
    return { ok: false, code: 'BAD_TICKET', message: '票据应用不匹配' };
  }
  if (input?.instanceId !== undefined && instanceId !== String(input.instanceId)) {
    return { ok: false, code: 'BAD_TICKET', message: '票据实例不匹配' };
  }
  if (input?.exeSha256 !== undefined
    && String(input.exeSha256).toLowerCase() !== '' && exeSha256 !== '' && exeSha256 !== String(input.exeSha256).toLowerCase()) {
    return { ok: false, code: 'EXE_CHANGED', message: '程序文件已变化，请重新部署' };
  }
  const now = Number(input?.now) || Date.now();
  const iat = Number(iatRaw) * 1000;
  const exp = Number(expRaw) * 1000;
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) {
    return { ok: false, code: 'BAD_TICKET', message: '票据时间无效' };
  }
  if (now + CLOCK_SKEW_MS < iat) {
    return { ok: false, code: 'CLOCK_SKEW', message: '本机时钟比授权主机慢，请校正系统时间' };
  }
  if (now - CLOCK_SKEW_MS > exp) {
    return { ok: false, code: 'TICKET_EXPIRED', message: '票据已过期，正在尝试续期' };
  }
  const lastIat = Number(input?.lastIat);
  if (Number.isFinite(lastIat) && iat < lastIat) {
    return { ok: false, code: 'CLOCK_SKEW', message: '检测到系统时间被调回（票据序号倒退）' };
  }
  return {
    ok: true,
    payload: {
      app,
      instanceId,
      seat: Number(seat) || 0,
      licenseId,
      iat,
      exp,
      jti,
      caps: capsRaw === '' ? [] : capsRaw.split(','),
      maxJobsPerHour: Number(quotaRaw) || 0,
      exeSha256,
    },
  };
}

module.exports = {
  TICKET_VERSION,
  TICKET_TTL_MS,
  LICENSE_GRACE_MS,
  CLOCK_SKEW_MS,
  claimOf,
  issueTicket,
  verifyTicket,
  hmacHex,
  clientProof,
  isHex,
  safeEqualHex,
};

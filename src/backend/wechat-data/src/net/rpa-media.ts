/**
 * RPA 触发图片的**签名直链**（2026-10-23）—— 后端 worker 与宿主层共用的一份实现。
 *
 * ## 解决的是什么
 *
 * 任务命中关键词时可以把触发记录里的图片发给触发方式。Webhook 能直接带字节
 * （JSON data URL / multipart），但 RPA 厂商的触发接口**只有字符串参数**：把图片塞进
 * 参数只能走 base64（体积 ×4/3，且八爪鱼 40KB / 影刀 8000 字这类参数上限直接爆掉）。
 * 所以 RPA 这一侧改为发**链接**：后端给每张图片签一个短时令牌，参数里只出现
 * `http://<可达地址>/api/rpa-media/<token>`，机器人自己去取字节。
 *
 * ## 为什么这个模块被两边共用
 *
 * 签名的是后端（`query/rpa/media-links.ts`），验签的是宿主层的 HTTP 服务
 * （`src/backend/rpa-media.js` 挂在局域网监听面上）。两边的算法必须逐字节一致，
 * 否则表现是「链接永远 404」这种最难排查的故障 —— 所以算法只写一份：
 * 后端 bundle 由 esbuild 内联本文件，宿主层另产一份独立小 bundle
 * （`lib/net/rpa-media.js`，与 `net/fetch-retry.ts` → `lib/net/fetch-retry.js` 同款做法），
 * 由 `http-server.js` 侧动态 import。
 *
 * ## 令牌的形状与安全边界
 *
 * `v1.<base64url(JSON 载荷)>.<base64url(HMAC-SHA256)>`，载荷是
 * `{ recordId, rel, expiresAt }`：
 *  · **HMAC 密钥**由 `secrets.json` 里的 `api_token` 派生（`rpaMediaTokenKey`）——
 *    用户轮换令牌 = 所有已发出的链接立即失效，不额外引入一份要保管的新密钥；
 *  · `rel` 必须是 decoded 根内的**相对图片路径**（`isSafeRpaMediaRel`），
 *    因此一个令牌只能换一张图片，取不到目录列表、也读不到 decoded 根之外的文件；
 *  · `expiresAt` 是绝对毫秒时间戳，过期即拒；TTL 上限 {@link RPA_MEDIA_MAX_TTL_MS}。
 *
 * 本模块**不碰文件系统、不发请求**：纯函数，方便两边各自单测与互相验签。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** 签名直链的路径前缀（后端拼 URL、宿主层路由都读它）。 */
export const RPA_MEDIA_PATH_PREFIX = '/api/rpa-media/'

/** 令牌版本号（写进令牌第一段；将来换算法时用它区分新旧）。 */
export const RPA_MEDIA_TOKEN_VERSION = 'v1'

/**
 * 默认有效期（毫秒）：1 小时。
 *
 * 取值的两边约束：太短会让排队中的云机器人拿到链接时已经过期（八爪鱼/来也这类
 * 云通道可能排几分钟到几十分钟），太长则等于给局域网里拿到 URL 的人更长的窗口。
 * 一小时覆盖常见排队，且链接只暴露那一张图片本身。
 */
export const RPA_MEDIA_DEFAULT_TTL_MS = 60 * 60 * 1000

/** 有效期上限（毫秒）：24 小时 —— 配置写多大都不越过它。 */
export const RPA_MEDIA_MAX_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 允许经签名直链读取的扩展名（与 `src/backend/media-protocol.js` 的 `MIME_BY_EXT` 同集合）。
 *
 * 为什么两处各写一份：宿主层的 `resolveDecodedFile` 是**真正决定能读到哪个文件**的那一道，
 * 这里的判定只负责「不给非图片路径签令牌」。两份都是白名单，收紧任何一份都不会放行文件。
 */
export const RPA_MEDIA_IMAGE_EXTS: readonly string[] = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif',
]

/** 令牌载荷（签名内容与验签结果都是它）。 */
export interface RpaMediaTokenPayload {
  /** 触发记录 id（排查用；也把令牌绑到某一条记录上）。 */
  recordId: number
  /** decoded 根内的相对图片路径（`/` 分隔，如 `wxid_ab/cd….jpg`）。 */
  rel: string
  /** 绝对过期时间（毫秒时间戳）。 */
  expiresAt: number
}

/** 相对路径长度上限（decoded 根内的真实路径远短于此）。 */
const REL_MAX = 300

/**
 * 由 `api_token` 派生签名密钥（HMAC-SHA256 的 key）。
 *
 * 为什么不是直接拿 `api_token` 当 key：那是**另一条链路**（手机配对/会话）的凭据，
 * 派生一层可以让两边即使将来换算法也互不影响；前缀串是域分隔，避免与其它用途撞上。
 * @param apiToken - `secrets.json` 里的 `api_token`（空串 = 未启用入站面，调用方应先拒）。
 * @returns 32 字节密钥。
 */
export function rpaMediaTokenKey(apiToken: string): Buffer {
  return createHash('sha256').update('supertime-rpa-media\0' + apiToken, 'utf8').digest()
}

/**
 * 相对路径是否可以作为直链目标。
 *
 * 只接受 decoded 根内的图片相对路径：拒绝空串、`\`、NUL、绝对路径、盘符、`..`/`.`
 * 与空段，并要求扩展名在白名单里。这是**签令牌前**的判定；宿主层取文件时还会用
 * `resolveDecodedFile` 再判一次（纵深防御，任一处收紧都不会放行）。
 * @param rel - 候选相对路径。
 * @returns 可以作为直链目标时为 true。
 */
export function isSafeRpaMediaRel(rel: unknown): rel is string {
  if (typeof rel !== 'string') return false
  if (rel === '' || rel.length > REL_MAX) return false
  if (rel.includes('\\') || rel.includes('\0') || rel.includes(':')) return false
  if (rel.startsWith('/')) return false
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false
  }
  const lower = rel.toLowerCase()
  return RPA_MEDIA_IMAGE_EXTS.some((ext) => lower.endsWith(ext))
}

/** 载荷 → base64url（字段顺序固定，保证同一份载荷签出同一个令牌）。 */
function encodePayload(payload: RpaMediaTokenPayload): string {
  return Buffer.from(
    JSON.stringify([payload.recordId, payload.expiresAt, payload.rel]),
    'utf8',
  ).toString('base64url')
}

/** 待签串：版本号 + 载荷（HMAC 覆盖两者，防止改版本号绕过）。 */
function signingInput(encoded: string): string {
  return RPA_MEDIA_TOKEN_VERSION + '.' + encoded
}

/**
 * 给一张图片签一个直链令牌。
 * @param key - {@link rpaMediaTokenKey} 的产物。
 * @param payload - 记录 id / 相对路径 / 过期时间。
 * @returns `v1.<载荷>.<签名>`（URL 安全，可直接拼进参数）。
 */
export function signRpaMediaToken(key: Buffer, payload: RpaMediaTokenPayload): string {
  const encoded = encodePayload(payload)
  const mac = createHmac('sha256', key).update(signingInput(encoded), 'utf8').digest().toString('base64url')
  return RPA_MEDIA_TOKEN_VERSION + '.' + encoded + '.' + mac
}

/**
 * 校验令牌（宿主层每次请求都会走这里）。
 *
 * 失败一律返回 null（不区分「格式错 / 签名错 / 过期」—— 对未授权的请求人，
 * 区分它们只会泄漏信息）；调用方按 404 处理。
 * @param key - 与签发方同一把密钥。
 * @param token - 路径里那一段。
 * @param nowMs - 当前时间（测试注入）。
 * @returns 合法且未过期时的载荷；否则 null。
 */
export function verifyRpaMediaToken(key: Buffer, token: string, nowMs: number): RpaMediaTokenPayload | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 1024) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [version, encoded, mac] = parts
  if (version !== RPA_MEDIA_TOKEN_VERSION || encoded === undefined || mac === undefined) return null
  if (encoded === '' || mac === '') return null
  let expected: Buffer
  let actual: Buffer
  try {
    expected = createHmac('sha256', key).update(signingInput(encoded), 'utf8').digest()
    actual = Buffer.from(mac, 'base64url')
  } catch {
    return null
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  // base64url 有非规范尾字符：不同字符串可能解码成同一段字节。要求重新编码后
  // 与输入逐字一致，避免「改一个字符仍能用」的令牌等价形态。
  if (actual.toString('base64url') !== mac) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    return null
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null
  const [recordId, expiresAt, rel] = decoded as [unknown, unknown, unknown]
  if (typeof recordId !== 'number' || !Number.isInteger(recordId) || recordId <= 0) return null
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) return null
  if (!isSafeRpaMediaRel(rel)) return null
  if (expiresAt <= nowMs) return null
  // 即便签名正确，也不接受超过上限的远期令牌：配置/调用方写错时不能变成长期凭据。
  if (expiresAt > nowMs + RPA_MEDIA_MAX_TTL_MS) return null
  return { recordId, expiresAt, rel }
}

/**
 * 拼出可直接放进 RPA 参数的绝对地址。
 * @param baseUrl - 基址（如 `http://192.168.1.10:5032`，末尾斜杠可有可无）。
 * @param token - {@link signRpaMediaToken} 的产物。
 * @returns 绝对 URL。
 */
export function rpaMediaUrl(baseUrl: string, token: string): string {
  return baseUrl.replace(/\/+$/, '') + RPA_MEDIA_PATH_PREFIX + token
}

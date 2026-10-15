/**
 * ClawBot 入站媒体的取数接缝 —— 按需下载、解密、落盘缓存（**第二个出网落点**）。
 *
 * ## 为什么单独成文件（而不是并进 `clawbot-ilink.ts`）
 *
 * iLink 那条接缝的纪律是「控制面请求 + 你主动发送的正文」；媒体取数是**另一类出网**：
 * 目的地是腾讯 CDN、内容是你收到的图片/语音/视频/文件字节。两类放在一个文件里，
 * 「出网台账按文件#函数登记」的粒度就糊了。所以：**clawbot-ilink.ts 管 API，
 * 本文件管 CDN 字节**；`clawbot-outbound.spec.ts` 对两个接缝分别扫描。
 *
 * ## 取数规则（协议事实来自 WeClaw `messaging/cdn.go`）
 *
 * - 加密引用：`GET https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=<param>`
 *   → 密文字节 → AES-128-ECB 解密 + 去 PKCS7；
 * - 密钥解析是**两步**：base64 → 得到 hex 字符串 → hex 解码 → 16 字节密钥（少一步都解不开）；
 * - 图片也可能带**明文 URL**（`media_key` 为空）⇒ 直接取，但仍要过主机白名单；
 * - 语音解密后是 silk：交给 `voice.ts#silkToWav`（仓库自带 wx_silk）转 wav 才能播。
 *
 * ## 纪律
 *
 * - **收到带附件的消息即自动取回**（无人值守，由接收通道的队列驱动）；
 *   界面点开某条消息时（`getClawbotMedia`）通常只是读本地缓存拿 dataUrl；
 * - 主机先过 `wechatCdnHostAllowed`（与其它所有媒体代取同一把尺子）——白名单外的
 *   一个字节都不发；加密引用走固定 CDN 基址；
 * - 单份上限 {@link CLAWBOT_MEDIA_MAX_BYTES}（体积提示已超限的连请求都不发）；
 *   缓存命中不再联网；失败会在下次同步 / 启动补扫时重试（永久类错误不重试）；
 * - 缓存落在 `<数据根>/clawbot-media/`（永久保留，删除数据根即整体消失）。
 *
 * @module query/clawbot/clawbot-media
 */
import { createDecipheriv } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cdnHostOf, wechatCdnHostAllowed } from '../cdn-hosts.ts'
import type { ClawbotMediaRef } from './clawbot-message.ts'
import { readClawbotMessageInternal } from './clawbot-message.ts'
import { silkToWav } from '../voice.ts'

/** 腾讯 iLink 的 CDN 基址（唯一出网目的地；与 API 主机同属 weixin.qq.com 域）。 */
export const CLAWBOT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** 单份媒体的下载上限（字节）。语音/图片远小于它；视频/文件超限明确报错，不截断。 */
export const CLAWBOT_MEDIA_MAX_BYTES = 32 * 1024 * 1024

/** 下载超时（WeClaw 同值 60s）。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000

/** 最小 fetch 形状（同 `clawbot-ilink.ts` 的注入约定：测试假 fetch，生产全局 fetch）。 */
export interface FetchLike {
  (url: string, init?: { method?: string, signal?: AbortSignal }): Promise<{
    ok: boolean
    status: number
    headers?: { get(name: string): string | null }
    arrayBuffer(): Promise<ArrayBuffer>
  }>
}

/** 注入点：假 fetch（测试）/ 假 silk 解码（测试无需真解码器）。 */
export interface MediaOptions {
  fetchImpl?: FetchLike
  /** 语音解码覆盖（测试注假实现；生产缺省走异步 wx_silk）。 */
  toWav?: (silk: Buffer, wavPath: string) => { ok: boolean, error?: string } | Promise<{ ok: boolean, error?: string }>
}

/** 取数结果：成功给出本机缓存路径与展示信息；失败给出可读中文（`permanent` = 重试无意义）。 */
export type ClawbotMediaOutcome =
  | { ok: true, path: string, kind: ClawbotMediaRef['kind'], name: string | null, bytes: number }
  | { ok: false, error: string, permanent?: boolean }

/** 缓存目录：`<数据根>/clawbot-media/`（数据根 = decryptedDir 的父级，与 clawbot.db 同级）。 */
export function clawbotMediaDir(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'clawbot-media')
}

/** 按「行 id + 类型」前缀找已缓存的成品文件（扩展名由落盘时决定，命中不看扩展名）。 */
function findCached(decryptedDir: string, id: number, kind: ClawbotMediaRef['kind']): string | null {
  const dir = clawbotMediaDir(decryptedDir)
  if (!existsSync(dir)) return null
  const prefix = `${String(id)}-${kind}.`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    /* v8 ignore next -- 目录刚被清掉属正常竞态：当没缓存。 */
    return null
  }
  const hit = names.find((f) => f.startsWith(prefix) && !f.endsWith('.part'))
  if (hit === undefined) return null
  const p = join(dir, hit)
  try {
    return statSync(p).size > 0 ? p : null
  } catch {
    /* v8 ignore next -- 同上：读不到当没缓存。 */
    return null
  }
}

/** 各类型的缓存缺省扩展名（图片/文件会按内容或原文件名再细化）。 */
const KIND_EXT: Record<ClawbotMediaRef['kind'], string> = {
  image: '.img',
  voice: '.wav',
  video: '.mp4',
  file: '.bin',
}

/** 从文件名安全地取扩展名（拒绝路径成分；没有就按类型缺省）。 */
function extFor(media: ClawbotMediaRef): string {
  if (media.kind === 'file' && media.name !== null) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(media.name)
    if (m !== null) return '.' + (m[1] ?? '').toLowerCase()
  }
  return KIND_EXT[media.kind]
}

/** 按魔数给图片一个靠谱扩展名（缓存文件名与「外部打开」体验都靠它）。 */
function imageExt(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return '.gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return '.webp'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return '.bmp'
  return '.img'
}

/** 图片字节 → data URL 的 MIME（与 {@link imageExt} 同一张魔数表）。 */
export function imageMimeOf(bytes: Buffer): string {
  switch (imageExt(bytes)) {
    case '.png': return 'image/png'
    case '.jpg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.bmp': return 'image/bmp'
    default: return 'application/octet-stream'
  }
}

/**
 * 全部出网的**唯一调用点**：一次 GET 拿回字节（含超时与上限检查）。
 *
 * `fetch` 用局部常量承接注入 —— 名字故意就叫 `fetch`：出网台账按字面 `fetch(` 扫描，
 * 改名会让这个点从台账里隐形。上限检查在**读体之前**看 Content-Length、读完之后再兜一次。
 * @param url - 完整地址（只由本模块用常量或白名单校验过的引用拼出）。
 * @param opts - 注入点（假 fetch）。
 * @returns 明文字节（下载到的原样；解密不在这一步）。
 */
async function downloadBytes(url: string, opts?: MediaOptions): Promise<Buffer> {
  const fetch = opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const ac = new AbortController()
  const timer = setTimeout(() => { ac.abort() }, MEDIA_DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const declared = Number(res.headers?.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > CLAWBOT_MEDIA_MAX_BYTES) {
      throw new Error(`媒体超过上限（${String(declared)} > ${String(CLAWBOT_MEDIA_MAX_BYTES)} 字节）`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > CLAWBOT_MEDIA_MAX_BYTES) {
      throw new Error(`媒体超过上限（${String(buf.byteLength)} > ${String(CLAWBOT_MEDIA_MAX_BYTES)} 字节）`)
    }
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解密 AES-128-ECB + 去 PKCS7。
 *
 * 密钥两步解析：base64 → hex 字符串 → 16 字节（WeClaw 同名实现；跳过 hex 这一步会得到
 * 一个长度对不上、或解出乱码的「密钥」）。
 * @param ciphertext - 密文字节（长度必须是 16 的倍数）。
 * @param keyBase64 - 消息里的 `aes_key`。
 * @returns 明文字节。
 * @throws 密钥/密文形状不合法（调用方翻成可读错误）。
 */
export function decryptMediaBytes(ciphertext: Buffer, keyBase64: string): Buffer {
  const keyHex = Buffer.from(keyBase64, 'base64').toString('utf8')
  if (!/^[0-9a-fA-F]{32}$/.test(keyHex)) throw new Error('aes_key 不是「base64(hex)」形状')
  const key = Buffer.from(keyHex, 'hex')
  if (ciphertext.byteLength === 0 || ciphertext.byteLength % 16 !== 0) throw new Error('密文长度不是 16 的倍数')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const plainPadded = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const padLen = plainPadded[plainPadded.byteLength - 1] ?? 0
  if (padLen < 1 || padLen > 16 || padLen > plainPadded.byteLength) throw new Error('PKCS7 填充不合法')
  return plainPadded.subarray(0, plainPadded.byteLength - padLen)
}

/**
 * 保证某条消息的媒体在本地有一份解密后的缓存；没有就下载。
 *
 * @param decryptedDir - 解密数据根。
 * @param id - 消息行 id。
 * @param opts - 注入点（测试用）。
 * @returns 缓存路径与展示信息；失败为可读中文错误（含「没有附件」「主机被拒」「超限」）。
 */
export async function ensureClawbotMedia(decryptedDir: string, id: number, opts?: MediaOptions): Promise<ClawbotMediaOutcome> {
  const row = readClawbotMessageInternal(decryptedDir, id)
  if (row === null) return { ok: false, error: '找不到这条消息（或本机库读不出来）', permanent: true }
  const media = row.media
  if (media === null) return { ok: false, error: '这条消息没有可取的附件', permanent: true }

  // 缓存命中：不再联网（按「行 id + 类型」前缀找成品文件）。
  const cached = findCached(decryptedDir, id, media.kind)
  if (cached !== null) {
    return { ok: true, path: cached, kind: media.kind, name: media.name, bytes: statSync(cached).size }
  }

  // 体积提示已知且超限：直接判永久失败（不必先下载 32MB+ 再丢）。
  if (media.size !== null && media.size > CLAWBOT_MEDIA_MAX_BYTES) {
    return { ok: false, error: `附件体积超过上限（${String(media.size)} > ${String(CLAWBOT_MEDIA_MAX_BYTES)} 字节），未取回`, permanent: true }
  }

  // 目标地址：明文 URL 要过白名单；加密参数走固定 CDN 主机。
  let url: string
  if (media.key === '') {
    if (!wechatCdnHostAllowed(media.ref)) {
      return { ok: false, error: `附件地址的主机不在白名单内（${cdnHostOf(media.ref) || '无法解析'}），拒绝下载`, permanent: true }
    }
    url = media.ref
  } else {
    url = CLAWBOT_CDN_BASE + '/download?encrypted_query_param=' + encodeURIComponent(media.ref)
  }

  let bytes: Buffer
  try {
    bytes = await downloadBytes(url, opts)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 超限是内容本身的属性（重试不会变小）；网络类错误可重试。
    return { ok: false, error: '下载失败：' + msg, permanent: msg.startsWith('媒体超过上限') }
  }
  if (media.key !== '') {
    try {
      bytes = decryptMediaBytes(bytes, media.key)
    } catch (e) {
      return { ok: false, error: '解密失败：' + (e instanceof Error ? e.message : String(e)), permanent: true }
    }
  }

  // 语音：silk → wav（wx_silk），解不了的原始 silk 对用户没有意义 ⇒ 直接报错。
  if (media.kind === 'voice') {
    const wavPath = join(clawbotMediaDir(decryptedDir), `${String(id)}-voice.wav`)
    try {
      mkdirSync(clawbotMediaDir(decryptedDir), { recursive: true })
    } catch (e) {
      return { ok: false, error: '落盘失败：' + (e instanceof Error ? e.message : String(e)) }
    }
    const decoded = await (opts?.toWav ?? silkToWav)(bytes, wavPath)
    if (!decoded.ok) return { ok: false, error: '语音解码失败：' + (decoded.error ?? '未知原因'), permanent: true }
    return { ok: true, path: wavPath, kind: media.kind, name: media.name, bytes: statSync(wavPath).size }
  }

  // 原子落盘（临时文件 + rename）：半截文件不会被当成缓存命中。
  try {
    mkdirSync(clawbotMediaDir(decryptedDir), { recursive: true })
    const ext = media.kind === 'image' ? imageExt(bytes) : extFor(media)
    const finalPath = join(clawbotMediaDir(decryptedDir), `${String(id)}-${media.kind}${ext}`)
    const tmp = finalPath + '.part'
    writeFileSync(tmp, bytes)
    renameSync(tmp, finalPath)
    return { ok: true, path: finalPath, kind: media.kind, name: media.name, bytes: bytes.byteLength }
  } catch (e) {
    return { ok: false, error: '落盘失败：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/** 读缓存字节（给「图片内联展示」用；只在确实需要时调，避免大文件进 IPC）。 */
export function readClawbotMediaBytes(path: string): Buffer {
  return readFileSync(path)
}

/**
 * 聊天图片「原图直取」：**只走消息里自带的免登录预签名直链**（`<img tpurl=… tphdurl=…>`）。
 *
 * ## 为什么只做这一类
 *
 * 本机实测（39,923 张图片消息）：93% 在本机只有缩略图 `_t.dat`，微信根本没存原图。
 * 消息 XML 里指向原图的字段分两类，能力完全不同：
 *
 * | 指针 | 本机覆盖率 | 拿到原图需要什么 |
 * |---|---|---|
 * | `tpurl` / `tphdurl` + `tpauthkey` | 16.2% | **什么都不用** —— 预签名 https 直链，GET 即明文图 |
 * | `cdnbigimgurl` / `cdnmidimgurl` | 47.6% | 微信登录态凭据 + 私有媒体 RPC（本应用不做，见下） |
 *
 * 后者要的是**会话凭据**（uin/sessionkey/authkey/设备签名），那不再是「读本机已存在的密钥」，
 * 而是「以你的身份向微信服务器发请求」：泄露面从「历史文件能被解开」扩大成「别人能以你身份
 * 发消息、读通讯录」，也直接推翻 README/PRIVACY 里「不登录、不连微信服务器同步」的承诺。
 * 所以本模块**只实现前者**，并在界面上如实说明剩下那 82% 只能回微信里点一次「查看原图」。
 *
 * ## 缓存键
 *
 * 取回的原图写成 `<decoded>/<md5>.<ext>`（**不带用户名子目录**）。这不是随手选的：
 * `decodeImageDataUrl` 的第 1a 步优先读的就是这个全局槽位（`media-image.ts:324-337`），
 * 所以下一次渲染这张图会自动命中原图，不需要改任何显示路径 —— 网络只花一次，之后离线可用。
 * 这里的 `md5` 必须是 `packed_info_data` 里那份，**不是** XML 的 `md5=`：实测后者与
 * `msg/attach` 下的文件名 0% 命中（4.x 它不是文件身份），只有前者 100% 命中。
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { fetchWithRetry } from '../../../llm-retry.js'
import { wechatCdnHostAllowed } from './cdn-hosts.ts'
import { CDN_DISABLED_MESSAGE, cdnFetchAllowed } from './cdn-policy.ts'
import { resolveImageResourceHint } from './media-image.ts'
import { shardCatalogDirs } from './meta.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 单张原图的字节上限：直链一旦被改成超大响应，宁可失败也不要拖垮渲染进程。 */
const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024

/**
 * 允许发起请求的主机后缀（腾讯系 CDN）。
 *
 * 判定本身搬到了 `cdn-hosts.ts`（M23：远程图片代理要走同一道门，两处各写一份迟早会漏一处）。
 * 消息 XML 是可被离线改写的文件，直链又是「带上凭据参数」的完整 URL，所以这里必须是白名单，
 * 而且判定用「等于或以 `.后缀` 结尾」——`endsWith('qq.com')` 会放过 `evilqq.com`。
 */
const hostAllowed = wechatCdnHostAllowed

/** `resolveImageOriginalLink()` 的结果：一条消息的原图直取信息。 */
export interface ImageOriginalLink {
  /** 缓存键（来自 `packed_info_data`，不是 XML 的 `md5=`）。 */
  md5: string
  /** 免登录预签名直链（`tphdurl` 优先，其次 `tpurl`）。 */
  url: string
  /** 直链是否带独立的高清档（有 `tphdurl`）。 */
  hasHd: boolean
  /** XML 声明的原图字节数（`hdlength` 优先，其次 `length`）；无声明时为 0。 */
  declaredBytes: number
}

/** 解 XML 里的 `&amp;` 等实体（直链被转义后直接用会 404）。 */
function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 把 message_content 单元格解成文本（4.x 是 zstd 压缩的，见 `messages.ts:99-121`）。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  const b = Buffer.isBuffer(v) ? v : (v instanceof Uint8Array ? Buffer.from(v) : null)
  if (b === null) return String(v)
  let out = b
  if (b.length >= 4 && b.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { out = Buffer.from(decompress(b)) } catch { /* 解不开就按原字节试 */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(out)
}

/**
 * 取一条图片消息的免登录原图直链。
 * @param decryptedDir - 解密数据根。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 * @returns 直链与元信息；这条消息没有可直取的原图（只有 CDN fileid）时返回 null。
 */
export function resolveImageOriginalLink(
  decryptedDir: string,
  username: string,
  localId: number,
): ImageOriginalLink | null {
  const hint = resolveImageResourceHint(decryptedDir, username, localId)
  const md5 = hint.md5
  if (!md5) return null
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  for (const shard of shardCatalogDirs(decryptedDir, ['message'])) {
    const meta = shard.tables.get(table)
    if (!meta) continue
    const contentCol = [...meta.cols].find((c) => String(c).toLowerCase().includes('message_content'))
    if (!contentCol) continue
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(shard.file, { readOnly: true }) } catch { continue }
    try {
      const row = db.prepare(`SELECT "${contentCol}" AS c FROM "${table}" WHERE local_id = ? LIMIT 1`).get(localId) as { c?: unknown } | undefined
      if (!row) continue
      const m = /<img\b([^>]*)>/i.exec(cellText(row.c))
      if (m === null) continue
      // 捕获组在类型上是 `string | undefined`；这个式子只有一个组、匹配成功就一定有值。
      // 兜成 `''` 的走向是「拿不到任何属性」⇒ 下面 url 为空 ⇒ 这一条被跳过，不会当成命中。
      const at: Record<string, string> = {}
      for (const p of (m[1] ?? '').matchAll(/([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g)) at[(p[1] ?? '').toLowerCase()] = unescapeXml(p[2] ?? '')
      const url = (at.tphdurl ?? '') !== '' ? (at.tphdurl as string) : (at.tpurl ?? '')
      if (url === '' || !/^https?:\/\//i.test(url) || !hostAllowed(url)) continue
      const n = (s: string | undefined): number => { const x = Number(String(s ?? '').trim()); return Number.isFinite(x) && x > 0 ? x : 0 }
      return {
        md5,
        url,
        hasHd: (at.tphdurl ?? '') !== '',
        declaredBytes: Math.max(n(at.hdlength), n(at.length), n(at.tplength)),
      }
    } catch { /* 这张分片读不动就试下一张 */ } finally {
      try { db?.close() } catch { /* 已关 */ }
    }
  }
  return null
}

/** 取回并落盘一张原图。**不把字节回传给调用方** —— 原图可达十几 MB，base64 走一遍 RPC
 * 既慢又占内存；落盘后由 `getImageDataUrl` 从缓存槽读，界面只需要知道成功与否。 */
export async function fetchImageOriginalToCache(
  link: ImageOriginalLink,
  decodedDir: string,
  opts: { cdnEnabled?: boolean } = {},
): Promise<{ format?: string; bytes?: number; error?: string }> {
  if (!cdnFetchAllowed(opts)) return { error: CDN_DISABLED_MESSAGE }
  if (!hostAllowed(link.url)) return { error: '原图直链的域名不在允许清单内，已拒绝请求' }
  let res
  try {
    res = await fetchWithRetry(fetch, link.url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, { timeoutMs: 15_000 })
  } catch (e) {
    return { error: '原图下载失败: ' + (e as Error).message }
  }
  if (!res.ok) return { error: '原图下载失败 HTTP ' + String(res.status) + '（直链可能已过期，需在微信里重新打开一次该图片）' }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length === 0) return { error: '原图下载回来是空文件' }
  if (bytes.length > MAX_ORIGINAL_BYTES) return { error: '原图超过 64MB 上限，已丢弃' }
  const fmt = sniffImageFormat(bytes)
  if (fmt === null) return { error: '原图下载回来不是可识别的图片格式（wxgf/HEVC 本机也无法渲染）' }
  try {
    mkdirSync(decodedDir, { recursive: true })
    writeFileSync(join(decodedDir, link.md5 + '.' + fmt), Buffer.from(bytes))
  } catch (e) {
    return { error: '原图已取回但写入缓存失败（下次仍会重新下载）: ' + (e as Error).message }
  }
  return { format: fmt, bytes: bytes.length }
}

/** 只认浏览器能直接渲染的那几种魔数（wxgf/hevc 那些取回来也显示不了）。 */
function sniffImageFormat(b: Uint8Array): string | null {
  if (b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

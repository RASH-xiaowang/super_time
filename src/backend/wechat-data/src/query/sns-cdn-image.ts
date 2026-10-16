/**
 * 朋友圈图片的 **CDN 取图 + 解密**通路。
 *
 * ## 实测依据（真机 2026-10-08，探针见 `tests/sns-image-tail-probe.manual.spec.ts`）
 *
 *   · `https://…/0?token=<token>&idx=1` → **HTTP 200 · image/jpeg**（库里存的裸地址一律 400）
 *   · 取回的字节**是密文**（实测头四字节 `ce 6c e7 d1`，不是 `ff d8`）⇒ 必须整份 WxIsaac64 解密
 *   · **图片是整文件加密**：整份解密后 9/9 张都得到合法 JPEG（头 `ff d8 ff e0`）；
 *     只解前 128 KB 则 9/9 张都没有合法结尾。所以走 `decryptSnsAll`，不是 `decryptSnsHead`
 *   · 种子是 `<url … key>` / `<thumb … key>` 上的属性（同一动态内多图共用一个）
 *
 * ## 微信 CDN 会在 JPEG 的 EOI **之后**再挂一段固定尾块
 *
 * 实测 9/9 张的结尾都是 `… ff d9 | 75 f0 d3 3c 00 00 00 00 …`，EOI 之后**恒定 24 字节**，
 * 前 9 字节逐张相同 —— 那是 CDN 的签名块。浏览器会忽略 EOI 之后的字节，所以图本来就能显示。
 *
 * ⚠️ 曾经的 `hasValidTail` 要求「最后两字节必须是 `ff d9`」，于是把 **9/9 张好图全判成失败**，
 * 界面呈现为一屏「图片加载失败」。所以这里改成**在尾部窗口内找结束标记并把尾块裁掉**。
 *
 * ## 本模块的纪律
 *
 *  · 主机仍受微信 CDN 白名单约束（`wechatCdnHostAllowed`）；
 *  · **没有种子就不请求**：解不开的密文拿去当图只会得到一个破图标；
 *  · 解密后**必须真的是图片**（魔数嗅探）才算成功，否则回错误 —— 绝不把密文塞进 `<img>`；
 *  · 错误文案只报**实测到的数字**（长度 / 头部 / x-enc），不断言成因 —— 上一版的
 *    「可能只解密了前 128 KB」就是个把成因写死的猜测，它把后来的人引到了错误的方向。
 *
 * ## 与参考项目对齐的两处（`WeChatDataAnalysis-main/src/wechat_decrypt_tool/sns_media.py`）
 *
 *  · **读 `X-Enc` 响应头**决定要不要解密（`:1234-1239`）。部分端点会直接返回已解码的图片，
 *    对这种响应再 XOR 一次只会把好图弄坏；
 *  · **解不开就退回原始字节**（`:1250-1254`）：原始本来就被认成图片时，不该因为解密失败而丢图；
 *  · 魔数识别补齐 AVIF/HEIF/HEIC/BMP/GIF/WebP（`:840-852`）—— 只认 JPEG/PNG 会把
 *    微信真给过的那些格式一律判成「不是图片」。
 *
 * @module query/sns-cdn-image
 */
import { wechatCdnHostAllowed } from './cdn-hosts.ts'
import { snsCdnUrl } from './sns-cdn-url.ts'
import { decryptSnsAll } from './sns-keystream.ts'

/** 取图结果：成功给 data URL，失败给可读原因（调用方据此回落本机解密或显示说明）。 */
export interface SnsCdnImageResult {
  dataUrl?: string
  error?: string
}

/** 本模块认得的图片类型（口径对齐参考项目 `sns_media.py:840-852`，外加 GIF/WebP）。 */
type ImageType =
  | 'image/jpeg' | 'image/png' | 'image/gif' | 'image/bmp'
  | 'image/webp' | 'image/avif' | 'image/heic' | 'image/heif'

/**
 * 结束标记允许距离文件末尾多少字节。
 *
 * 实测微信 CDN 的签名尾块恒定 24 字节，取 256 是为了给「尾块大小有变化」留余量，
 * 又不至于宽到把「整张图被截断」误判成通过（那种情况标记会远在几 KB 之外）。
 */
const END_SCAN_WINDOW = 256

/** 取图片魔数（只看头）。认不出就返回 `null` —— 调用方据此拒绝，绝不把密文当图。 */
function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp'
  // ISO BMFF（HEIF/HEIC/AVIF）：`....ftyp<brand>`
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = ascii(b, 8, 4)
    if (brand === 'avif') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') return 'image/heic'
    if (brand === 'heif' || brand === 'mif1' || brand === 'msf1') return 'image/heif'
  }
  return null
}

/** 从字节里读一段 ASCII（用于 `RIFF`/`WEBP`/`ftyp`/brand 这几个魔数）。 */
function ascii(b: Uint8Array, at: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(b[at + i] ?? 0)
  return s
}

/**
 * 找该类型的**结束标记**（JPEG 的 `FF D9`、PNG 的 `IEND`），返回「标记之后第一个字节」的下标。
 *
 * 只在末尾 {@link END_SCAN_WINDOW} 字节内找：CDN 尾块很小，而「图片真被截断」时标记会远在几 KB 之外 ——
 * 那两种情况必须分开，否则等于把判据取消。
 *
 * GIF/BMP/WebP/AVIF/HEIC **没有可靠的可搜索结束标记**，故返回 `-1` 表示「不适用」，
 * 由调用方决定不裁尾也不因此判失败（见 {@link trimToImageEnd}）。
 *
 * @returns 标记之后的字节下标；尾部窗口内找不到、或该类型无标记时为 `-1`。
 */
function imageEndAfter(b: Uint8Array, type: ImageType): number {
  const from = Math.max(0, b.length - END_SCAN_WINDOW)
  if (type === 'image/jpeg') {
    for (let i = b.length - 2; i >= from; i -= 1) {
      if (b[i] === 0xff && b[i + 1] === 0xd9) return i + 2
    }
    return -1
  }
  if (type === 'image/png') {
    const need = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
    for (let i = b.length - need.length; i >= from; i -= 1) {
      if (need.every((v, k) => b[i + k] === v)) return i + need.length
    }
    return -1
  }
  return -1
}

/**
 * 裁掉结束标记之后的字节（微信 CDN 的签名尾块），顺带当作「图是否完整」的判据。
 *
 * 三种结果，**必须分开看**：
 *  · `null` —— 尾部窗口内**没有**结束标记 ⇒ 图真的不完整（被截断 / 只解了头部）⇒ 失败；
 *  · `Buffer`（裁过）—— 找到了标记且后面有尾块 ⇒ 裁掉尾块，正常返回；
 *  · `Buffer`（原样）—— 找到了标记且**紧贴末尾**，或该类型本来就没有可搜的标记 ⇒ 原样返回。
 *
 * @returns 可交付的字节；图不完整时 `null`。
 */
function trimToImageEnd(b: Buffer, type: ImageType): Buffer | null {
  const after = imageEndAfter(b, type)
  if (after < 0) {
    // 无可搜标记的类型（GIF/WebP/AVIF/HEIC/BMP）不因「找不到标记」而判失败：
    // 它们的头已经证明是图片，剩下的完整性交给渲染器。
    return hasSearchableEnd(type) ? null : b
  }
  return after === b.length ? b : b.subarray(0, after)
}

/** 该类型是否有可搜索的结束标记（决定「找不到」是失败还是无所谓）。 */
function hasSearchableEnd(type: ImageType): boolean {
  return type === 'image/jpeg' || type === 'image/png'
}

/** 取头四字节的十六进制，供错误文案用（只报实测值，不断言成因）。 */
function headHex(b: Uint8Array): string {
  return [...b.subarray(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join(' ')
}

/**
 * 从 CDN 取一张朋友圈图片并解密成 data URL。
 *
 * @param rawUrl - 库里存的媒体地址（`http://…/0` 或 `/150`）。
 * @param token - 媒体标签上的 `token` 属性。
 * @param seed - 媒体 XML 里 `<url … key>` / `<thumb … key>` 的值（WxIsaac64 种子）。
 * @param fetchImpl - 取数实现（默认全局 `fetch`；测试注入用）。
 * @returns `{ dataUrl }` 或 `{ error }`。
 */
export async function fetchSnsCdnImage(
  rawUrl: string,
  token: string | undefined,
  seed: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SnsCdnImageResult> {
  const url = snsCdnUrl(rawUrl, token)
  if (url === '') return { error: '没有可用的 CDN 地址' }
  // 注意：`wechatCdnHostAllowed` 收的是**完整 URL**（它自己解析主机），别传 hostname
  try { void new URL(url) } catch { return { error: 'CDN 地址非法' } }
  if (!wechatCdnHostAllowed(url)) return { error: '图片主机不在微信 CDN 清单内，已拒绝请求' }
  // 没有种子就不解密 ⇒ 不请求（省一次外发，也避免前端画破图）
  const key = String(seed ?? '').trim()
  if (key === '') return { error: '缺少解密种子（<enc key>），无法还原图片' }

  let res: Response
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.49' } })
  } catch (e) {
    return { error: '取图请求失败：' + (e as Error).message }
  }
  if (!res.ok) return { error: 'CDN 返回 HTTP ' + String(res.status) }
  const raw = Buffer.from(await res.arrayBuffer())
  if (raw.length === 0) return { error: 'CDN 返回空响应' }

  // 实测响应头恒为 `x-enc: 1`。它与「响应体看起来是不是图片」一起决定要不要解密
  // （对齐参考项目 `sns_media.py:1234-1239`）：部分端点会直接给已解码的图片，
  // 对那种响应再 XOR 一次只会把好图弄坏。
  const rawType = sniffImage(raw)
  const xEnc = String(res.headers?.get?.('x-enc') ?? '').trim().toLowerCase()
  const xEncSaysEncrypted = xEnc !== '' && xEnc !== '0' && xEnc !== 'false'

  let bytes = raw
  let type = rawType
  let decrypted = false
  if (rawType === null || xEncSaysEncrypted) {
    try {
      const dec = (await decryptSnsAll(raw, key)).bytes
      const decType = sniffImage(dec)
      if (decType !== null) {
        bytes = Buffer.from(dec)
        type = decType
        decrypted = true
      } else if (rawType === null) {
        // 解密出来还不是图片，且原始也不是 ⇒ 没有可救的版本
        return { error: 'WxIsaac64 解密后仍不是图片（头四字节 ' + headHex(dec) + '）' }
      }
      // 原始本来就是图片而解密结果不是 ⇒ 保留原始（对齐参考项目 `sns_media.py:1250-1254`）
    } catch (e) {
      if (rawType === null) return { error: 'WxIsaac64 解密失败：' + (e as Error).message }
    }
  }
  if (type === null) return { error: '响应体不是图片（头四字节 ' + headHex(raw) + '）' }

  const trimmed = trimToImageEnd(bytes, type)
  if (trimmed === null) {
    return {
      error: '图片结尾标记缺失（尾部 ' + String(Math.min(END_SCAN_WINDOW, bytes.length)) + ' 字节内没有 '
        + (type === 'image/jpeg' ? 'JPEG EOI' : 'PNG IEND')
        + '；共 ' + String(bytes.length) + ' 字节，x-enc=' + (xEnc === '' ? '无' : xEnc)
        + (decrypted ? '，已整份解密' : '，未解密') + '）',
    }
  }
  return { dataUrl: 'data:' + type + ';base64,' + trimmed.toString('base64') }
}
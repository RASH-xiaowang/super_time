/**
 * 朋友圈图片的 **CDN 取图 + 解密**通路（2026-10-08）。
 *
 * ## 实测依据（真机，见 `sns-cdn-url.ts` 的表）
 *
 *   · `https://…/0?token=<token>&idx=1` → **HTTP 200 · image/jpeg**（我们之前一律 400，只因少了 `idx=1` 且尺寸段是 `/150`）
 *   · 取回的字节**是密文**（头四字节 `cb 92 4c bc`，不是 `ff d8`）⇒ 必须走 `WxIsaac64` 解密
 *   · 解密器与种子：`decryptSnsHead(bytes, seed)`（`sns-keystream.ts`），**种子 = 媒体 XML 里的 `<enc key="NNNN">`**
 *     —— 视频链路已这么用（`sns-video.ts:177`）
 *
 * ## 本模块的纪律
 *
 *  · 主机仍受微信 CDN 白名单约束（`wechatCdnHostAllowed`）；
 *  · **没有种子就不请求**：解不开的密文拿去当图只会得到一个破图标；
 *  · 解密后**必须真的是图片**（JPEG/PNG 魔数）才算成功，否则回错误 —— 绝不把密文塞进 `<img>`。
 *
 * @module query/sns-cdn-image
 */
import { wechatCdnHostAllowed } from './cdn-hosts.ts'
import { snsCdnUrl } from './sns-cdn-url.ts'
import { decryptSnsAll } from './sns-keystream.ts'

/** 取图结果：成功给 data URL，失败给可读原因（调用方据此回落本机解密或显示说明）。 */
/**
 * 结尾标记校验：JPEG 以 `FF D9` 收尾，PNG 以 `IEND` 块收尾。
 *
 * 为什么要单独看结尾：只解密前 128 KB 时**头部完全正确**，只嗅探魔数会放行一个坏文件，
 * 结果是「RPC 成功、图片渲染失败」，排查起来毫无线索（实测踩过）。
 *
 * @param b - 解密后的字节。
 * @param type - 已嗅探出的类型。
 * @returns 结尾标记是否完整。
 */
function hasValidTail(b: Uint8Array, type: 'image/jpeg' | 'image/png'): boolean {
  if (type === 'image/jpeg') return b.length > 3 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9
  // PNG 结尾固定是 IEND 块：49 45 4E 44 AE 42 60 82
  const n = b.length
  return n > 12 && b[n - 8] === 0x49 && b[n - 7] === 0x45 && b[n - 6] === 0x4e && b[n - 5] === 0x44
}

export interface SnsCdnImageResult {
  dataUrl?: string
  error?: string
}

/** 图片魔数判断（只认 JPEG/PNG；微信朋友圈图片就这两种）。 */
function sniffImage(b: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  return null
}

/**
 * 从 CDN 取一张朋友圈图片并解密成 data URL。
 *
 * @param rawUrl - 库里存的媒体地址（`http://mmsns.qpic.cn/.../0` 或 `/150`）。
 * @param token - 媒体标签上的 `token` 属性。
 * @param seed - 媒体 XML 里 `<enc key="…">` 的解密种子。
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
  // 没有种子 ⇒ 解出来一定是乱码，不如不请求（省一次外发，也避免前端画破图）
  if (String(seed ?? '').trim() === '') return { error: '缺少解密种子（<enc key>），无法还原图片' }

  let res: Response
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.49' } })
  } catch (e) {
    return { error: '取图请求失败：' + (e as Error).message }
  }
  if (!res.ok) return { error: 'CDN 返回 HTTP ' + String(res.status) }
  const raw = new Uint8Array(await res.arrayBuffer())
  if (raw.length === 0) return { error: 'CDN 返回空响应' }

  let bytes: Uint8Array
  try {
    // 图片是整文件加密：必须整份解（只解头会得到坏尾，见 `decryptSnsAll` 注释）
    bytes = (await decryptSnsAll(Buffer.from(raw), String(seed))).bytes
  } catch (e) {
    return { error: 'WxIsaac64 解密失败：' + (e as Error).message }
  }
  const type = sniffImage(bytes)
  if (type === null) {
    const hex = [...bytes.slice(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join(' ')
    // 注意：**不把密文当图返回** —— 上层的 `failed` 占位会显示这条原因
    return { error: '解密后仍不是图片格式（头四字节 ' + hex + '）' }
  }
  // 结尾完整性：只解前 128 KB 的坏文件**头是对的**，必须靠结尾才能识破（2026-10-08 的坑）
  if (!hasValidTail(bytes, type)) {
    return { error: '解密后图片不完整（结尾标记缺失，可能只解密了前 128 KB）' }
  }
  return { dataUrl: 'data:' + type + ';base64,' + Buffer.from(bytes).toString('base64') }
}

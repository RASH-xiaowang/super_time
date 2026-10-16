/**
 * 朋友圈 CDN 取图的 URL 构造（**按参考项目 WeChatDataAnalysis 的实测配方**）。
 *
 * ## 为什么需要它（2026-10-08 实测）
 *
 * 微信库里存的媒体地址**直接请求一律 HTTP 400**，实测矩阵：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `https://…/0` | 400 |
 * | `https://…/0?token=<token>` | 400 |
 * | `https://…/0?token=<token>&idx=1` | **200 · image/jpeg** ✅ |
 * | `https://…/150?token=<token>&idx=1` | 400（缩略图尺寸不给） |
 *
 * 即缺三样：**https**、**尺寸段归一到 `/0`**、**追加 `&idx=1`**。
 * 参考实现见 `WeChatDataAnalysis-main/src/wechat_decrypt_tool/sns_media.py:200-237`。
 *
 * ⚠️ 返回体是 **WxIsaac64 加密**的（实测头四字节 `cb 92 4c bc`，不是 `ff d8`），
 * 必须解密后才能当图片用 —— 本函数只负责把 URL 拼对。
 *
 * @module query/sns-cdn-url
 */

/** 腾讯系 SNS CDN 主机；不在其中的地址原样返回（与 `cdn-hosts.ts` 的白名单同源语义）。 */
const SNS_HOST_RE = /(^|\.)(qpic\.cn|qlogo\.cn|video\.qq\.com|weixin\.qq\.com)$/i

/** 图片尺寸段：`/0` 是原图，其余（60/150/200/480）CDN 会拒。 */
const SIZE_SEG_RE = /\/(?:60|150|200|480)(?=$|\?)/

/**
 * 把库里存的媒体地址构造成**能被 CDN 接受**的请求地址。
 *
 * @param rawUrl - 微信库里的地址（通常是 `http://mmsns.qpic.cn/.../0` 或 `.../150`）。
 * @param token - 媒体标签上的 `token` 属性（`<url token="…">` / `<thumb token="…">`）。
 * @returns 可直接请求的 https 地址；非腾讯系主机原样返回。
 */
export function snsCdnUrl(rawUrl: string, token: string | undefined): string {
  const raw = String(rawUrl ?? '').trim()
  if (raw === '') return ''
  let host = ''
  try { host = new URL(raw).hostname.toLowerCase() } catch { return raw }
  if (!SNS_HOST_RE.test(host)) return raw

  // ① http → https（库里存的绝大多数是 http，实测 https 才能通）
  let u = raw.replace(/^http:\/\//i, 'https://')
  // ② 尺寸段归一到原图 /0（/150 那种实测 400）
  u = u.replace(SIZE_SEG_RE, '/0')

  const tok = String(token ?? '').trim()
  if (tok === '') return u

  // ③ 先清掉已有的 token/idx（库里可能带旧的），再追加 token&idx=1
  const q = u.indexOf('?')
  const base = q >= 0 ? u.slice(0, q) : u
  const query = q >= 0 ? u.slice(q + 1) : ''
  const kept = query.split('&').filter((it) => {
    const k = it.split('=')[0]?.trim().toLowerCase() ?? ''
    return it !== '' && k !== 'token' && k !== 'idx'
  })
  const head = kept.length > 0 ? base + '?' + kept.join('&') : base
  return head + (head.includes('?') ? '&' : '?') + 'token=' + tok + '&idx=1'
}

/**
 * 微信 CDN 主机白名单 —— **判定「这个地址该不该由我们的后端去取」的唯一出处**。
 *
 * ## 为什么单独一个文件
 *
 * 这条判定原先只存在于 `query/image-original.ts`（聊天原图直链）。但「渲染层不许直接向
 * 消息里的任意 https 地址要图」（M23：去掉 CSP `img-src` 的 `https:` 通配）需要给
 * **所有**由后端代取的图片走同一道门 —— 而 XML 里的 URL 是**可被离线改写的文件内容**，
 * 白名单少一处判定就等于开一处口子。放在这里而不是让第二个模块去 import 第一个模块：
 * 「哪些主机可以外连」与「原图怎么解出来」不是同一件事，耦在一起将来只会有一处被漏改。
 *
 * ## 判据
 *
 * 用 `new URL()` 取 hostname，再要求「等于后缀」或「以 `.后缀` 结尾」。
 * 不能写 `host.endsWith('qq.com')` —— 那会放过 `evilqq.com`（这条原来就在
 * `image-original.ts` 的注释里写着，一并搬过来）。
 *
 * `user:pass@host` 这类带凭据的 URL 也一律拒：凭据既不该出现在消息 XML 里，也不该由
 * 我们的后端带着出门。
 */

/** 允许发起请求的腾讯系 CDN 主机后缀。 */
export const WECHAT_CDN_HOST_SUFFIXES: readonly string[] = [
  'qq.com',
  'wechat.com',
  'wechatcdn.cn',
  'qpic.cn',
  'weixin.qq.com',
]

/**
 * 这个 URL 的主机是否在白名单内（严格后缀匹配）。
 * @param url - 待判定的绝对 URL（通常来自消息 XML 或数据库字段）。
 * @returns false 表示解析失败、无主机、带凭据或主机不在清单内 —— 调用方必须**在发请求之前**拦下。
 */
export function wechatCdnHostAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') return false
  const host = parsed.hostname.toLowerCase()
  if (host === '') return false
  return WECHAT_CDN_HOST_SUFFIXES.some((suf) => host === suf || host.endsWith('.' + suf))
}

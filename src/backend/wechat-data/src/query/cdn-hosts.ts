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

/**
 * 允许发起请求的腾讯系 CDN 主机后缀。
 *
 * `qlogo.cn` 是 2026-09-23 随头像迁移（M23 第四刀）加进来的，**不是新增目的地**：
 * 实测 1,994 个联系人里 1,594 个的头像地址就是 `wx.qlogo.cn` / `thirdwx.qlogo.cn`，
 * 而在此之前这些地址一直由渲染层的 `<img>` 直接向它发请求 —— 既不读那两个出网开关、
 * 也不进操作记录、更没有缓存。加进来之后它反而被管住了：只有白名单判定通过、
 * 且「自动获取原图（CDN）」开着，后端才会去取。
 * （同一批数据里的 `mmhead.c2c.wechat.com` 与 `wework.qpic.cn` 早就被下面两条覆盖了。）
 */
export const WECHAT_CDN_HOST_SUFFIXES: readonly string[] = [
  'qq.com',
  'wechat.com',
  'wechatcdn.cn',
  'qpic.cn',
  'weixin.qq.com',
  'qlogo.cn',
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

/**
 * 企业微信（WeCom）的文件下载端点。
 *
 * ## 为什么需要单独一个判据
 *
 * 2026-09-26 实测（一次性探针，脚本不入库）：本机 8,604 条带 `tphdurl`/`tpurl` 的图片消息
 * **全部**指向 `wwfile.work.weixin.qq.com/cgi-bin/download?f=<216hex>&t=<576hex>&p=1`，
 * 而匿名 GET **一律 403**，且与下面三件事都无关：
 *   · **消息新旧**：距今 20 分钟的消息与 217 天的消息表现完全相同（都是 403、0 字节）；
 *   · **请求头**：裸 UA / 加 `Referer: https://work.weixin.qq.com/` / 加图片 `Accept` 三种都 403；
 *   · **URL 里有没有凭据参数**：它只有 `f`/`t`/`p` 三个参数，**没有** `tpauthkey` 之类的签名参数
 *     （`t` 是 576 位十六进制的服务端令牌，必须由企业微信客户端带着会话才能用）。
 *
 * 结论：这一类**不是免登录预签名直链**，与本应用「不登录、不连微信服务器同步」的边界冲突
 * （与 `cdnbigimgurl` 同一类待遇）。所以批量取原图要把它们**排除在候选之外** ——
 * 否则一次点击会白发几千个必然 403 的请求。
 *
 * ⚠ 这条判据是**按主机**判的，不是按「有没有签名参数」判：个人微信的 `tpurl` 真带
 * `tpauthkey`（那类能取），而企业微信这条链用的是服务端令牌 —— 按主机判比按参数名猜更稳。
 * @param url - 消息 XML 里的图片地址。
 * @returns true 表示这是企业微信的下载端点（需要企业微信登录态，我们不去取）。
 */
export function isWecomFileEndpoint(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return host === 'work.weixin.qq.com' || host.endsWith('.work.weixin.qq.com')
}

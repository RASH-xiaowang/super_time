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
export declare const WECHAT_CDN_HOST_SUFFIXES: readonly string[];
/**
 * 这个 URL 的主机是否在白名单内（严格后缀匹配）。
 * @param url - 待判定的绝对 URL（通常来自消息 XML 或数据库字段）。
 * @returns false 表示解析失败、无主机、带凭据或主机不在清单内 —— 调用方必须**在发请求之前**拦下。
 */
export declare function wechatCdnHostAllowed(url: string): boolean;

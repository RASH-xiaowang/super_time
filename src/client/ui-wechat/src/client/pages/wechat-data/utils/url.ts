/**
 * CSP 安全的图片地址助手 —— **全项目唯一实现**（第 41 轮从 `Moments.tsx` 提取出来）。
 *
 * 背景：`index.html` 的 CSP 写作 `img-src 'self' data: blob: https: file:` —— **不含 `http:`**。
 * 把 http 地址交给 `<img>` 会被直接拦截，实测后果有两个：
 *   1. 每张图写一条 CSP 违规日志（朋友圈曾一次刷出 500 条，把日志上限占满）；
 *   2. 先闪一下「图片加载失败」，随后才被本地解码结果替换。
 *
 * 微信库里存的图片/头像地址大量是 `http://`（实测朋友圈 1,125 张里 1,104 张、
 * 联系人头像 1,994 个里 400 个），所以**任何**把库里 URL 直接塞进 `src` 的地方都必须过这里。
 *
 * 第 41 轮提取的原因：`Contacts.tsx` 的头像快速路径直接把快照里的 `avatarUrl` 当 `src` 用
 * （注释还写着「优先后端解析的远程头像 URL」，其实绕过了后端），于是开启远端头像后
 * 一次进入通讯录就产生 **16 条 http 的 CSP 违规**。现在两处共用这一份实现。
 *
 * @param urls - 候选地址，按优先级排列。
 * @returns 第一个被 CSP 放行的地址；都不行则返回空串。
 */
export function cspSafeSrc(...urls: Array<string | undefined>): string {
  for (const u of urls) if (u && /^(https:|data:|blob:)/i.test(u)) return u
  return ''
}

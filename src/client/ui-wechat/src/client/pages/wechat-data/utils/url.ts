/**
 * 从一组候选地址里挑出「这一条值得去要」的那个 —— **全项目唯一实现**
 * （第 41 轮从 `Moments.tsx` 提取，原名 `cspSafeSrc`；M23 把 CSP 的 `img-src` 收紧成
 * 只剩本机来源之后那个名字已经不成立，故改名 `proxyableSrc`）。
 *
 * 现在的职责不是「躲开 CSP」，而是**决定这张图交给谁去取**：
 *   · `data:` / `blob:` 本来就是本机可画地址，直接用；
 *   · `https:` 是本机没有、值得让后端代理去取的那一类（`panels/remote-img.tsx` →
 *     `query/remote-image.ts`，主机白名单判在发请求之前）；
 *   · `http:` 一律丢掉 —— 后端代理只取 https（`fetchRemoteImage` 里明确拒），
 *     留着只会画出一个必然失败的 `<img>`。
 *
 * 为什么还要在渲染层先筛一遍：微信库里存的地址大量是 `http://`（实测朋友圈 1,125 张里
 * 1,104 张、联系人头像 1,994 个里 400 个）。不筛的话每一张都要白跑一趟 RPC 再被后端拒掉。
 *
 * @param urls - 候选地址，按优先级排列。
 * @returns 第一个能直接画或能代取的地址；都不行则返回空串（调用方按「这一格没有图」处理）。
 */
export function proxyableSrc(...urls: Array<string | undefined>): string {
  for (const u of urls) if (u && /^(https:|data:|blob:)/i.test(u)) return u
  return ''
}

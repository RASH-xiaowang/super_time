/**
 * 缩略图的**有界**缓存更新（一处实现，收藏与文件两个面板共用）。
 *
 * 为什么要有界、而且必须是纯函数：长列表虚拟化之后每一行都会反复挂载/卸载，缩略图那一份解码出来的
 * data URL（几十到几百 KB）不能跟着列表无限涨下去 —— 要淘汰。而淘汰有个不成对就出 bug 的动作：
 * **把「这个键已经请求过」的标记一起清掉**。只清值不清标记，滚回去的那一行既读不到缓存、
 * 又因为标记存在而不重新请求，表现是「滚远再滚回来，图永远是个占位」—— 这种坏法不报错、
 * 不在日志里，只有人在界面上滚一遍才看得见。
 *
 * `Files.tsx` 里同形的那两份状态（`fileImgs` / `imgFetched`）原本是手工配对的，
 * 所以这里把「清值 + 清标记 + 记顺序」收成一次调用：少写一半就凑不成一次完整的淘汰。
 */

/** 同时保留多少张缩略图（一屏十几到二十几格，60 张够来回滚不闪）。 */
export const THUMB_CACHE_LIMIT = 60

/** 三份互相咬合的状态：键 → data URL、最近使用顺序、已发起请求的键。 */
export interface ThumbCache {
  thumbs: Record<string, string>
  order: string[]
  fetched: Set<string>
}

/** 空缓存（三个面板各自从自己的 ref 起步时用）。 */
export function emptyThumbCache(): ThumbCache {
  return { thumbs: {}, order: [], fetched: new Set<string>() }
}

/**
 * 记下一条缩略图并做 LRU 淘汰；当前写入的那条**永不淘汰**（否则刚解出来就被丢掉）。
 * @param state - 现有三份状态（只读，不原地改）。
 * @param key - 这张图对应的键（收藏用 md5，文件用 `fileKey`）。
 * @param url - 解码出来的 data URL。
 * @param limit - 上界，默认 {@link THUMB_CACHE_LIMIT}。
 * @returns 新的三份状态（`order` 最旧在前，被淘汰的键同时从 `thumbs` 与 `fetched` 里消失）。
 */
export function rememberThumb(state: ThumbCache, key: string, url: string, limit = THUMB_CACHE_LIMIT): ThumbCache {
  if (!key || !url) return state
  const thumbs = { ...state.thumbs, [key]: url }
  const order = state.order.filter((k) => k !== key)
  order.push(key)
  const fetched = new Set(state.fetched)
  while (order.length > limit) {
    const old = order.shift()
    if (!old || old === key) continue
    delete thumbs[old]
    // 关键的一半：值丢了，请求标记必须一起丢，否则这一行再挂载也不会重新取图。
    fetched.delete(old)
  }
  return { thumbs, order, fetched }
}

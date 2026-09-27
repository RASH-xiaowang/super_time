/**
 * 收藏缩略图的**有界**缓存更新（#22 虚拟化的配套）。
 *
 * 为什么单独一份、而且必须是纯函数：虚拟化之后行会反复挂载/卸载，缩略图那一份解码出来的
 * data URL（几十到几百 KB）不能跟着列表无限涨下去 —— 要淘汰。而淘汰有个不成对就出 bug 的动作：
 * **把「这个 md5 已经请求过」的标记一起清掉**。只清值不清标记，滚回去的那一行既读不到缓存、
 * 又因为标记存在而不重新请求，表现是「滚远再滚回来，图永远是个占位」—— 这种坏法不报错、
 * 不在日志里，只有人在界面上滚一遍才看得见（`Files.tsx` 里同形的那两份状态是手工配对的，
 * 所以这里把「清值 + 清标记 + 记顺序」收成一次调用，让"只改一半"在类型上就过不去）。
 */

/** 同时保留多少张缩略图（与 `Files.tsx` 的格子数同量级；一屏十几行，60 张够来回滚不闪）。 */
export const FAV_THUMB_LIMIT = 60

/** 三份互相咬合的状态：md5 → data URL、最近使用顺序、已发起请求的 md5。 */
export interface FavThumbState {
  thumbs: Record<string, string>
  order: string[]
  fetched: Set<string>
}

/**
 * 记下一条缩略图并做 LRU 淘汰；当前写入的那条**永不淘汰**（否则刚解出来就被丢掉）。
 * @param state - 现有三份状态（只读，不原地改）。
 * @param md5 - 这条媒体对应的 md5。
 * @param url - 解码出来的 data URL。
 * @param limit - 上界，默认 {@link FAV_THUMB_LIMIT}。
 * @returns 新的三份状态（`order` 最旧在前，被淘汰的 md5 同时从 `thumbs` 与 `fetched` 里消失）。
 */
export function rememberThumb(state: FavThumbState, md5: string, url: string, limit = FAV_THUMB_LIMIT): FavThumbState {
  if (!md5 || !url) return state
  const thumbs = { ...state.thumbs, [md5]: url }
  const order = state.order.filter((k) => k !== md5)
  order.push(md5)
  const fetched = new Set(state.fetched)
  while (order.length > limit) {
    const old = order.shift()
    if (!old || old === md5) continue
    delete thumbs[old]
    // 关键的一半：值丢了，请求标记必须一起丢，否则这一行再挂载也不会重新取图。
    fetched.delete(old)
  }
  return { thumbs, order, fetched }
}

/**
 * 朋友圈面板的灯箱动作与卡片展开态算术（#22 虚拟化时从面板里搬出来付行数）。
 *
 * 搬的过程中真正值得钉住的是这一条：**同一个"当前这张图"，两个动作用的源不一样** ——
 * 保存图片要**本机解码出来的 data URL**（CDN 那份可能是加密流、也可能已经过期），
 * 复制链接要**CDN 原链**（本机那份是 2MB 的 base64，复制出去没人打得开）。
 * 两处顺序写反不会报错，只会存下来打不开 / 复制出去是一串 base64，
 * 所以这个优先级必须写成一份能被用例喂参数的东西，而不是散在面板里的两行 `||`。
 */

/** 翻转集合里的一个键（纯函数：给 React 的 updater 用，别原地改）。 */
export function toggleInSet(prev: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(prev)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * 灯箱当前这张图该用哪个源。
 * @param local - 本机解码出来的 data URL（没有就传空串）。
 * @param remote - CDN / 代理原链（没有就传空串）。
 * @param prefer - `'local'` = 本机优先（保存图片）；`'remote'` = 原链优先（复制链接）。
 * @returns 要用的源串；两个都为空时是空串（调用方据此什么都不做）。
 */
export function pickImageSrc(local: string, remote: string, prefer: 'local' | 'remote'): string {
  return prefer === 'local' ? (local || remote) : (remote || local)
}

/** 下载文件名：`moments-<灯箱序号>.<扩展名>`；序号取非负整数（越界或没传时是 0）。 */
export function imageDownloadName(index: number, ext: string): string {
  const n = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0
  return 'moments-' + String(n) + '.' + ext
}

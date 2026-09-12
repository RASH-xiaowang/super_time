/**
 * Misc helpers migrated from st_control utils (clipboard/log/percent).
 */

/**
 * Copy text to the clipboard with a fallback.
 * @param text - Text to copy.
 * @returns true when the copy succeeded, false otherwise.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    // Legacy fallback for browsers without the async Clipboard API.
    // execCommand('copy') is the only clipboard fallback where the async API is
    // missing; deprecated but deliberately retained.
    /* oxlint-disable-next-line typescript/no-deprecated */
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * Debug log (dev only).
 * @param args - Values to log.
 */
export function logDebug(...args: unknown[]): void {
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') console.debug('[wechat-data]', ...args)
}

/**
 * Error log.
 * @param tag - Log tag/context label.
 * @param e - The error or value to log.
 */
export function logError(tag: string, e: unknown): void {
  console.error('[wechat-data]' + tag, e)
}

/**
 * 写入有界缓存：达到上限时按插入顺序淘汰最旧的键。
 *
 * 面板里的头像/媒体缓存是模块级的，生命周期等于整个渲染进程；若不设上限，
 * 切换页签、滚动列表只会不断塞入 base64 数据（头像 data URL 单个可达数十 KB），
 * 永不释放。重复写入同一个键会刷新它的新鲜度。
 *
 * @param map - 模块级缓存。
 * @param key - 缓存键。
 * @param value - 缓存值。
 * @param max - 条目上限。
 */
export function cacheBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key)
  while (map.size >= max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
  map.set(key, value)
}

/**
 * 有界记录缓存：超出上限时按插入顺序淘汰最旧的键。
 *
 * 用于以普通对象形态持有的 base64 媒体缓存 —— 单条视频 data URL 可达数 MB，
 * 不做上限会随播放过的视频数量线性增长。
 *
 * @param rec - 记录对象。
 * @param max - 保留的最大键数量。
 * @returns 原对象（未超限）或只保留最后 max 个键的新对象。
 */
export function capRecord<V>(rec: Record<string, V>, max: number): Record<string, V> {
  const keys = Object.keys(rec)
  if (keys.length <= max) return rec
  const next: Record<string, V> = {}
  for (const k of keys.slice(keys.length - max)) next[k] = rec[k]
  return next
}

/**
 * Format a fraction as a percentage with one decimal.
 * @param part - Numerator (the part).
 * @param total - Denominator (the total; 0 yields 0%).
 * @returns Percentage string, e.g. '12.5%'.
 */
export function checkupPct(part: number, total: number): string {
  if (!total) return '0%'
  return ((part / total) * 100).toFixed(1) + '%'
}

/**
 * Format a rate percentage (x of total = pct).
 * @param x - Numerator.
 * @param total - Denominator.
 * @returns String like '3/10 (30.0%)'.
 */
export function checkupRatePct(x: number, total: number): string {
  return `${x}/${total} (${checkupPct(x, total)})`
}

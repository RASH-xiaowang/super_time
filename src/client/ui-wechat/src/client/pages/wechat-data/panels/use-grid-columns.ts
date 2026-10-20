/**
 * 现测网格列数（`repeat(auto-fill, minmax(Npx, 1fr))` 的列数随容器宽度变，不能写死）。
 *
 * 为什么单独一份：文件面板的虚拟化按"行"数格子，而一行有几格是布局说了算 ——
 * 拿常数列数去数，把窗口拉宽就会出现"最后一行被截掉"或"格子重叠"，
 * 这两种都不难看穿但都不报错。列数换算本身在 `files-grid.ts`（纯函数，直接喂数据测），
 * 这里只负责"什么时候去读一次"。
 */
import { useEffect, useState, type RefObject } from 'react'
import { resolveGridColumns } from './files-grid.ts'

/**
 * @param ref - 网格容器（同时也是滚动容器）。
 * @param minColPx - CSS `minmax()` 里那个最小列宽，样式改了这里要一起改。
 * @returns 当前列数（至少 1；容器还没挂上时先给 1）。
 */
export function useGridColumns(ref: RefObject<HTMLElement | null>, minColPx: number): number {
  const [cols, setCols] = useState(1)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      if (typeof getComputedStyle !== 'function') {
        setCols((current) => (current > 0 ? current : 1))
        return
      }
      const template = getComputedStyle(el).gridTemplateColumns
      const resolved = resolveGridColumns(template, el.clientWidth, minColPx)
      setCols(resolved > 0 ? resolved : 1)
    }
    read()
    // 没有 ResizeObserver 的环境（jsdom、老引擎）退化成"挂载时读一次"；
    // 若连宽度也拿不到，则保留 1 列，避免把 0 当作合法列数。
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [ref, minColPx])
  return cols
}

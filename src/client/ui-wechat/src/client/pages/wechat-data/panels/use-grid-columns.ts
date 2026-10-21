/**
 * 现测网格列数与**每格宽度**（2026-10-21：缩略图按格子实际宽度自适应）。
 *
 * 为什么单独一份：文件面板的虚拟化按"行"数格子，而一行有几格是布局说了算 ——
 * 拿常数列数去数，把窗口拉宽就会出现"最后一行被截掉"或"格子重叠"，
 * 这两种都不难看穿但都不报错。列数换算本身在 `files-grid.ts`（纯函数，直接喂数据测），
 * 这里只负责"什么时候去读一次"。
 *
 * 格宽同时喂给缩略图档位（`thumbWidthFor`）：固定 320px 在窄格/2x 屏上分别会糊或浪费。
 */
import { useEffect, useState, type RefObject } from 'react'
import { cellWidthFor, resolveGridColumns } from './files-grid.ts'

/** 网格实测结果。 */
export interface GridMetrics {
  /** 当前列数（至少 1）。 */
  cols: number
  /** 每格可用宽度（CSS px，已扣掉 gap 与容器左右 padding；拿不到时为 minColPx）。 */
  cellWidth: number
}

/** 与 `.grid { gap: 10px }` 同值；调用方传了就用调用方的。 */
const DEFAULT_GAP_PX = 10

/**
 * @param ref - 网格容器（同时也是滚动容器）。
 * @param minColPx - CSS `minmax()` 里那个最小列宽，样式改了这里要一起改。
 * @param gapPx - 网格 `gap`（px），与样式里的值保持一致。
 * @returns 列数与格宽（容器还没挂上时给 1 列 / minColPx）。
 */
export function useGridColumns(
  ref: RefObject<HTMLElement | null>,
  minColPx: number,
  gapPx = DEFAULT_GAP_PX,
): GridMetrics {
  const [metrics, setMetrics] = useState<GridMetrics>({ cols: 1, cellWidth: minColPx })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      let cols = 1
      let width = el.clientWidth
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(el)
        const template = style.gridTemplateColumns
        const resolved = resolveGridColumns(template, width, minColPx)
        cols = resolved > 0 ? resolved : 1
        // clientWidth 含 padding：内容宽要扣掉左右 padding 再分列，否则格宽偏大、档位多跳一档。
        const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
        width = Math.max(0, width - padX)
      } else if (width > 0) {
        cols = Math.max(1, Math.floor(width / minColPx))
      }
      const gap = Math.max(0, Number(gapPx) || 0)
      const measured = cellWidthFor(width, cols, gap)
      const cellWidth = measured > 0 ? measured : minColPx
      setMetrics((current) => (
        current.cols === cols && Math.abs(current.cellWidth - cellWidth) < 0.5
          ? current
          : { cols, cellWidth }
      ))
    }
    read()
    // 没有 ResizeObserver 的环境（jsdom、老引擎）退化成"挂载时读一次"；
    // 若连宽度也拿不到，则保留 1 列，避免把 0 当作合法列数。
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [ref, minColPx, gapPx])
  return metrics
}

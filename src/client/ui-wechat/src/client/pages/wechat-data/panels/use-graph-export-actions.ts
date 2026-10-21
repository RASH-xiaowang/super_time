/**
 * 图谱的 SVG / PNG / 海报导出动作。
 *
 * 从 `GraphPanel` 抽出：导出只依赖画布命令式句柄与海报选项，属于独立副作用，
 * 与节点菜单、筛选、选中状态无关。
 */
import { useCallback, useState } from 'react'
import type { GraphCanvasHandle } from './GraphCanvas.tsx'
import type { PosterRatio, PosterStyle } from './GraphExportMenu.tsx'
import type { RefObject } from 'react'

export interface UseGraphExportActionsOptions {
  canvasRef: RefObject<GraphCanvasHandle | null>
  posterStyle: PosterStyle
  posterRatio: PosterRatio
}

export interface GraphExportActions {
  exporting: boolean
  exportSvg: () => Promise<void>
  exportPng: () => Promise<void>
  exportPoster: () => Promise<void>
}

/**
 * 创建导出动作。
 * @param o - 画布句柄与海报选项。
 * @returns 三个动作与海报导出中的状态。
 */
export function useGraphExportActions(o: UseGraphExportActionsOptions): GraphExportActions {
  const [exporting, setExporting] = useState(false)

  const exportSvg = useCallback(async (): Promise<void> => {
    try {
      const svg = await o.canvasRef.current?.exportSvg() ?? ''
      if (!svg) { console.warn('SVG 导出失败:画布未就绪'); return }
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = '社交关系图谱.svg'
      a.click()
      setTimeout(() => { URL.revokeObjectURL(url) }, 2000)
    } catch (e) {
      console.error('SVG 导出失败', e)
    }
  }, [o.canvasRef])

  const exportPng = useCallback(async (): Promise<void> => {
    try {
      const url = await o.canvasRef.current?.exportPng(o.posterRatio, o.posterStyle)
      if (!url) return
      const a = document.createElement('a')
      a.href = url
      a.download = `社交图谱-${o.posterStyle}-${o.posterRatio}.png`
      a.click()
    } catch (e) {
      console.error('PNG 导出失败', e)
    }
  }, [o.canvasRef, o.posterRatio, o.posterStyle])

  const exportPoster = useCallback(async (): Promise<void> => {
    setExporting(true)
    try {
      const url = await o.canvasRef.current?.renderPoster(o.posterRatio, o.posterStyle)
      if (!url) return
      const a = document.createElement('a')
      a.href = url
      a.download = `社交图谱-${o.posterStyle}-${o.posterRatio}.jpg`
      a.click()
    } catch (e) {
      console.error('海报导出失败', e)
    } finally {
      setExporting(false)
    }
  }, [o.canvasRef, o.posterRatio, o.posterStyle])

  return { exporting, exportSvg, exportPng, exportPoster }
}

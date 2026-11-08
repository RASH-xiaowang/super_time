/**
 * 图谱的 SVG / PNG / 海报导出动作。
 *
 * 从 `GraphPanel` 抽出：导出只依赖画布命令式句柄与海报选项，属于独立副作用，
 * 与节点菜单、筛选、选中状态无关。
 */
import { useCallback } from 'react'
import type { GraphCanvasHandle } from './GraphCanvas.tsx'
import type { PosterRatio, PosterStyle } from './GraphExportMenu.tsx'
import type { RefObject } from 'react'
import { useExportTask, type ExportTaskState } from './export-task.ts'

export interface UseGraphExportActionsOptions {
  canvasRef: RefObject<GraphCanvasHandle | null>
  posterStyle: PosterStyle
  posterRatio: PosterRatio
}

export interface GraphExportActions {
  exportState: ExportTaskState
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
  const exportTask = useExportTask()

  const exportSvg = useCallback(async (): Promise<void> => {
    await exportTask.run(async () => {
      const svg = await o.canvasRef.current?.exportSvg() ?? ''
      if (!svg) throw new Error('画布尚未就绪，无法导出 SVG')
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = '社交关系图谱.svg'
      a.click()
      setTimeout(() => { URL.revokeObjectURL(url) }, 2000)
      return a.download
    }, {
      idPrefix: 'graph-svg',
      label: '导出图谱 SVG',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (filename) => `已导出 ${filename}`,
    })
  }, [exportTask, o.canvasRef])

  const exportPng = useCallback(async (): Promise<void> => {
    await exportTask.run(async () => {
      const url = await o.canvasRef.current?.exportPng(o.posterRatio, o.posterStyle)
      if (!url) throw new Error('画布尚未就绪，无法导出 PNG')
      const a = document.createElement('a')
      a.href = url
      a.download = `社交图谱-${o.posterStyle}-${o.posterRatio}.png`
      a.click()
      return a.download
    }, {
      idPrefix: 'graph-png',
      label: '导出图谱 PNG',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (filename) => `已导出 ${filename}`,
    })
  }, [exportTask, o.canvasRef, o.posterRatio, o.posterStyle])

  const exportPoster = useCallback(async (): Promise<void> => {
    await exportTask.run(async () => {
      const url = await o.canvasRef.current?.renderPoster(o.posterRatio, o.posterStyle)
      if (!url) throw new Error('海报渲染未返回图片')
      const a = document.createElement('a')
      a.href = url
      a.download = `社交图谱-${o.posterStyle}-${o.posterRatio}.jpg`
      a.click()
      return a.download
    }, {
      idPrefix: 'graph-poster',
      label: '导出图谱海报',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (filename) => `已导出 ${filename}`,
    })
  }, [exportTask, o.canvasRef, o.posterRatio, o.posterStyle])

  return { exportState: exportTask.state, exporting: exportTask.running, exportSvg, exportPng, exportPoster }
}

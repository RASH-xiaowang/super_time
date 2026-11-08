import { useCallback } from 'react'
import { apiExportDiagLog } from '../api.ts'
import { useExportTask, type ExportTaskState } from './export-task.ts'

export interface DiagLogExport {
  state: ExportTaskState
  exporting: boolean
  exportLog: () => Promise<void>
}

/** 诊断日志由主进程弹保存框并拼装文件，前端只显示不定量状态。 */
export function useDiagLogExport(refreshDiag: () => Promise<void>): DiagLogExport {
  const task = useExportTask()

  const exportLog = useCallback(async (): Promise<void> => {
    if (task.running) return
    await task.run(async () => {
      const r = await apiExportDiagLog()
      if (r.canceled) throw new Error('已取消导出')
      if (!r.ok) throw new Error(r.error ?? '未知原因')
      await refreshDiag()
      return r
    }, {
      idPrefix: 'settings-diag-log',
      label: '导出诊断日志',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (r) => `诊断日志已导出（${Math.max(1, Math.round((r.bytes ?? 0) / 1024))} KB）`,
    })
  }, [refreshDiag, task])

  return { state: task.state, exporting: task.running, exportLog }
}

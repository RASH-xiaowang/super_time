import { useCallback } from 'react'
import type { LedgerSnapshot, OverviewInsights, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { buildOverviewReport, downloadText } from './overview-export.ts'
import { useExportTask, type ExportTaskState } from './export-task.ts'

interface OverviewReportExportInput {
  data: OverviewSnapshot | null
  insights: OverviewInsights | null
  ledger: LedgerSnapshot | null
  storage: StorageSnapshot | null
  lastUpdated: number | null
  flash: (value: string, ms?: number) => void
  hold: (value: string) => void
}

export interface OverviewReportExport {
  state: ExportTaskState
  running: boolean
  exportText: (format: 'json' | 'md') => Promise<boolean>
}

function reportStamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}

/** JSON / Markdown 是本地瞬时下载，只有不定量进度，没有后端取消。 */
export function useOverviewReportExport(input: OverviewReportExportInput): OverviewReportExport {
  const task = useExportTask()

  const exportText = useCallback(async (format: 'json' | 'md'): Promise<boolean> => {
    const data = input.data
    if (!data || task.running) return false
    const now = new Date()
    const stamp = reportStamp(now)
    const filename = format === 'json'
      ? `微信数据总览-${stamp}.json`
      : `微信数据总览报告-${stamp}.md`
    const outcome = await task.run(async () => {
      if (format === 'json') {
        const payload = {
          exportedAt: now.toISOString(),
          updatedAt: input.lastUpdated ? new Date(input.lastUpdated).toISOString() : null,
          snapshot: data,
          insights: input.insights,
          ledger: input.ledger,
          storage: input.storage,
        }
        downloadText(filename, JSON.stringify(payload, null, 2), 'application/json')
      } else {
        downloadText(
          filename,
          buildOverviewReport(data, input.insights, input.ledger, input.storage, now, input.lastUpdated),
          'text/markdown;charset=utf-8',
        )
      }
      return filename
    }, {
      idPrefix: format === 'json' ? 'overview-json' : 'overview-markdown',
      label: format === 'json' ? '导出总览 JSON' : '导出总览报告',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (name) => `已导出 ${name}`,
    })
    if (outcome.ok) input.flash('已导出报告', 2500)
    else if (!outcome.canceled) input.hold(`${format === 'json' ? 'JSON' : 'Markdown'} 导出失败: ${outcome.error}`)
    return true
  }, [input.data, input.flash, input.hold, input.insights, input.lastUpdated, input.ledger, input.storage, task])

  return { state: task.state, running: task.running, exportText }
}


/**
 * 导出域的 @Remote 处理器（M21 第四十刀自 `gateway.ts` 搬出）。
 *
 * 域范围：会话消息导出（单会话 / 全部）、年度报告、朋友圈导出、CSV、导出历史（列表/删除/裁剪）、
 * 导出进度与取消。**流式任务的控制槽 `_streamJobs` 与两个私有辅助（streamControl / finishStreamJob）
 * 仍留在网关**（备份下载也用同一套槽），这里按 ctx 传进来。
 */
import { deleteExportHistory, listExportHistory, pruneExportHistory } from '../query/export-history.ts'
import { exportAllSessions, exportAnnualReport, exportCsv, exportMoments, exportSessionMessagesStreamed } from '../query/export.ts'
import { StreamControl } from '../query/zip.ts'
import { ExportHistoryDeleteResult, ExportHistoryPruneOptions, ExportHistoryQuery, ExportHistorySnapshot, ExportResult, ExportStatus, OperationCategory, OperationStatus } from '../types.ts'
import type { StreamJob } from '../gateway.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface ExportRemoteCtx {
  /** jobId 归一（网关与这里都要用；留在网关按函数传进来）。 */
  normalizeJobId: (jobId?: unknown) => string
  dirs: () => { decrypted: string; decoded: string }
  ctx: () => Context
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  recordExport: (input: { kind: string; label?: string; format?: string; path: string; rows?: number; status: ExportStatus; error?: string; params?: unknown }) => void
  streamControl: (jobId?: string) => StreamControl
  finishStreamJob: (jobId: string, error?: string) => void
  streamJobs: Map<string, StreamJob>
}

/** CSV 导出种类的中文说明（只用于导出历史的可读 label，不参与导出本身）。 */
const CSV_KIND_LABEL: Record<string, string> = {
  contacts: '通讯录',
  favorites: '收藏',
  records: '记录',
  moments: '朋友圈',
  privacy: '隐私扫描',
}

export function createExportRemotes(rc: ExportRemoteCtx) {
  const normalizeJobId = rc.normalizeJobId
  return {
    async exportSessionMessages(options: {
      username: string
      format: string
      count?: number
      dir?: string
      types?: number[]
      richTypes?: string[]
      from?: number
      to?: number
      filename?: string
      zip?: boolean
      /** 会话显示名，仅用于导出历史的可读说明（不参与导出本身）。 */
      sessionName?: string
      /** 进度/取消的任务标识（M3）：客户端按它认领 `wechat-export/progress` 事件。 */
      jobId?: string
    }): Promise<ExportResult> {
      const jobId = normalizeJobId(options?.jobId)
      try {
        // jobId 一转成 onProgress + AbortController（与 `exportAllSessions` 同一套）：
        // 不接就等于没接进度 —— 进度条不动、「中止」报「没有该导出任务」。
        const r = await exportSessionMessagesStreamed(rc.dirs().decrypted, {
          ...options,
          ...rc.streamControl(jobId),
        })
        rc.finishStreamJob(jobId)
        rc.op('export', 'export_session_messages', 'ok', options.username, `共 ${r.count} 条`)
        rc.recordExport({
          kind: 'session',
          label: options.sessionName ? `会话 · ${options.sessionName}` : `会话 · ${options.username}`,
          format: options.zip ? 'zip' : options.format,
          path: r.path,
          rows: r.count,
          status: 'ok',
          // 重跑所需的**全部**入参：少了 from/to 之类的范围条件，重新导出就会得到不同结果。
          params: options,
        })
        return r
      } catch (e) {
        rc.finishStreamJob(jobId, (e as Error).message)
        rc.op('export', 'export_session_messages', 'fail', options.username, (e as Error).message)
        // 尽力记一条结局。注意 `recordExport` 有一条**已测过的规则**：`path` 为空就不落库
        // （「没有路径的历史没有可操作性」），所以「收集阶段就失败/被取消」这一类只会留在
        // 上面的操作日志里，导出历史弹窗看不到 —— 界面靠 `已取消导出` / `导出失败: …` 说话。
        // 取消与失败分开记：路径已知的中途中断（写盘/压缩失败）不该在历史里显示成红叉。
        const canceled = /cancel|取消|abort/i.test((e as Error).message)
        rc.recordExport({
          kind: 'session',
          label: options.sessionName ? `会话 · ${options.sessionName}` : `会话 · ${options.username}`,
          format: options.zip ? 'zip' : options.format,
          path: '',
          status: canceled ? 'canceled' : 'fail',
          error: canceled ? '' : (e as Error).message,
          params: options,
        })
        throw e
      }
    },

    exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string }): ExportResult {
      try {
        const r = exportAnnualReport(rc.dirs().decrypted, options.year, options.format, options.dir, options.filename)
        rc.op('export', 'export_annual_report', 'ok', String(options.year), `共 ${r.count} 条`)
        rc.recordExport({
          kind: 'annual',
          label: `年度报告 · ${options.year} 年`,
          format: options.format,
          path: r.path,
          rows: r.count,
          status: 'ok',
          params: options,
        })
        return r
      } catch (e) {
        rc.op('export', 'export_annual_report', 'fail', String(options.year), (e as Error).message)
        rc.recordExport({
          kind: 'annual',
          label: `年度报告 · ${options.year} 年`,
          format: options.format,
          path: '',
          status: 'fail',
          error: (e as Error).message,
          params: options,
        })
        throw e
      }
    },

    async exportAllSessions(options?: { dir?: string; filename?: string; jobId?: string }): Promise<ExportResult> {
      const jobId = normalizeJobId(options?.jobId)
      try {
        // M3：进度/取消三件套（jobId → 本地 onProgress + AbortController）在本层接上，
        // 参数原样透传给 query 层（`& StreamControl`）—— 取消后写盘走 temp+rename，
        // 所以「取消」不会留下半成品文件。
        const r = await exportAllSessions(rc.dirs().decrypted, {
          ...(options?.dir !== undefined ? { dir: options.dir } : {}),
          ...(options?.filename !== undefined ? { filename: options.filename } : {}),
          ...rc.streamControl(jobId),
        })
        rc.finishStreamJob(jobId)
        rc.op('export', 'export_all_sessions', 'ok', '', `共 ${r.count} 条`)
        rc.recordExport({
          kind: 'all_sessions',
          label: '全部会话归档',
          format: 'zip',
          path: r.path,
          rows: r.count,
          status: 'ok',
          params: options ?? {},
        })
        return r
      } catch (e) {
        rc.finishStreamJob(jobId, (e as Error).message)
        rc.op('export', 'export_all_sessions', 'fail', '', (e as Error).message)
        // 取消也是一种正常结局，与「失败」分开记（`path` 为空时并不落库，口径见
        // `exportSessionMessages` 的说明）。
        const canceled = /cancel|取消|abort/i.test((e as Error).message)
        rc.recordExport({
          kind: 'all_sessions',
          label: '全部会话归档',
          format: 'zip',
          path: '',
          status: canceled ? 'canceled' : 'fail',
          error: canceled ? '' : (e as Error).message,
          params: options ?? {},
        })
        throw e
      }
    },

    cancelExportJob(options: { jobId: string }): { ok: boolean; error?: string } {
      const id = normalizeJobId(options?.jobId)
      const job = id ? rc.streamJobs.get(id) : undefined
      if (!job) return { ok: false, error: '没有该导出任务（jobId 不存在，或进程已重启）' }
      if (job.finished) return { ok: false, error: '该导出任务已结束' }
      job.ctrl.abort()
      rc.op('export', 'cancel_export_job', 'ok', id)
      return { ok: true }
    },

    getExportProgress(options: { jobId: string }): {
      found: boolean
      phase: string
      done: number
      total: number
      finished: boolean
      error?: string
    } {
      const id = normalizeJobId(options?.jobId)
      const job = id ? rc.streamJobs.get(id) : undefined
      if (!job) return { found: false, phase: '', done: 0, total: 0, finished: true }
      return {
        found: true,
        phase: job.progress?.phase ?? '',
        done: job.progress?.done ?? 0,
        total: job.progress?.total ?? 0,
        finished: job.finished,
        ...(job.error ? { error: job.error } : {}),
      }
    },

    async exportMoments(options?: {
      format?: string
      username?: string
      authorName?: string
      q?: string
      images?: boolean
      media?: string
      month?: string
      mine?: string
      zip?: boolean
      from?: number
      to?: number
      dir?: string
      filename?: string
      jobId?: string
    }): Promise<ExportResult> {
      const jobId = normalizeJobId(options?.jobId)
      try {
        // 与 exportAllSessions 同一套接线：进度事件 + 取消令牌都由 streamControl 提供。
        const r = await exportMoments(rc.dirs().decrypted, {
          ...(options?.format !== undefined ? { format: options.format } : {}),
          ...(options?.username !== undefined ? { username: options.username } : {}),
          ...(options?.authorName !== undefined ? { authorName: options.authorName } : {}),
          ...(options?.q !== undefined ? { q: options.q } : {}),
          ...(options?.images !== undefined ? { images: options.images } : {}),
          ...(options?.media !== undefined ? { media: options.media } : {}),
          ...(options?.month !== undefined ? { month: options.month } : {}),
          ...(options?.mine !== undefined ? { mine: options.mine } : {}),
          ...(options?.zip !== undefined ? { zip: options.zip } : {}),
          ...(options?.from !== undefined ? { from: options.from } : {}),
          ...(options?.to !== undefined ? { to: options.to } : {}),
          ...(options?.dir !== undefined ? { dir: options.dir } : {}),
          ...(options?.filename !== undefined ? { filename: options.filename } : {}),
          ...rc.streamControl(jobId),
        })
        rc.finishStreamJob(jobId)
        rc.op('export', 'export_moments', 'ok', options?.username ?? '', `共 ${r.count} 条`)
        rc.recordExport({
          kind: 'moments',
          label: options?.username ? `朋友圈 · ${options.authorName ?? options.username}` : '朋友圈 · 全部',
          format: options?.zip ? 'zip' : (options?.format ?? 'txt'),
          path: r.path,
          rows: r.count,
          status: 'ok',
          params: options ?? {},
        })
        return r
      } catch (e) {
        rc.finishStreamJob(jobId, (e as Error).message)
        rc.op('export', 'export_moments', 'fail', options?.username ?? '', (e as Error).message)
        const canceled = /cancel|取消|abort/i.test((e as Error).message)
        rc.recordExport({
          kind: 'moments',
          label: options?.username ? `朋友圈 · ${options.authorName ?? options.username}` : '朋友圈 · 全部',
          format: options?.zip ? 'zip' : (options?.format ?? 'txt'),
          path: '',
          status: canceled ? 'canceled' : 'fail',
          error: canceled ? '' : (e as Error).message,
          params: options ?? {},
        })
        throw e
      }
    },

    exportCsv(options: { kind: string; recordsKind?: string; dest?: string; category?: string }): ExportResult {
      const label = CSV_KIND_LABEL[options.kind] ?? options.kind
      try {
        const r = exportCsv(rc.dirs().decrypted, options.kind, options.recordsKind, options.dest, options.category)
        rc.op('export', 'export_csv', 'ok', options.kind, `共 ${r.count} 行`)
        rc.recordExport({
          kind: options.kind,
          label: options.category && options.category !== 'all' ? `${label} · ${options.category}` : label,
          format: 'csv',
          path: r.path,
          rows: r.count,
          status: 'ok',
          params: options,
        })
        return r
      } catch (e) {
        rc.op('export', 'export_csv', 'fail', options.kind, (e as Error).message)
        rc.recordExport({
          kind: options.kind,
          label,
          format: 'csv',
          path: '',
          status: 'fail',
          error: (e as Error).message,
          params: options,
        })
        throw e
      }
    },

    getExportHistory(options?: ExportHistoryQuery): ExportHistorySnapshot {
      return listExportHistory(rc.dirs().decrypted, options ?? {})
    },

    deleteExportHistory(options: { ids: number[]; deleteFiles?: boolean }): ExportHistoryDeleteResult {
      const ids = Array.isArray(options?.ids) ? options.ids : []
      const r = deleteExportHistory(rc.dirs().decrypted, ids, options?.deleteFiles === true)
      rc.op('delete', 'delete_export_history', r.removed > 0 ? 'ok' : 'skip', String(r.removed),
        `${r.removed} 条记录${options?.deleteFiles ? `，${r.filesDeleted} 个文件` : ''}`)
      return r
    },

    pruneExportHistory(options?: ExportHistoryPruneOptions): ExportHistoryDeleteResult {
      const r = pruneExportHistory(rc.dirs().decrypted, options ?? {})
      rc.op('delete', 'prune_export_history', r.removed > 0 ? 'ok' : 'skip', String(r.removed),
        `${r.removed} 条记录${options?.deleteFiles ? `，${r.filesDeleted} 个文件` : ''}`)
      return r
    },

  }
}

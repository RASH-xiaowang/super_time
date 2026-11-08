
/**
 * 导出域的 @Remote 处理器（M21 第四十刀自 `gateway.ts` 搬出）。
 *
 * 域范围：会话消息导出（单会话 / 全部）、年度报告、朋友圈导出、CSV、导出历史（列表/删除/裁剪）、
 * 导出进度与取消。**流式任务的控制槽 `_streamJobs` 与两个私有辅助（streamControl / finishStreamJob）
 * 仍留在网关**（备份下载也用同一套槽），这里按 ctx 传进来。
 */
import { deleteExportHistory, listExportHistory, pruneExportHistory } from '../query/export-history.ts'
import { exportAllSessions, exportAnnualReport, exportCsv, exportMoments, exportSessionMessagesStreamed } from '../query/export.ts'
import { canonicalChatReference, isMessageTableHash } from '../query/message-identity.ts'
import { ExportHistoryDeleteResult, ExportHistoryPruneOptions, ExportHistoryQuery, ExportHistorySnapshot, ExportResult, ExportStatus, OperationCategory, OperationStatus } from '../types.ts'
import type { StreamJob } from '../gateway.ts'
import { isCancelMessage, type ManagedStreamControl } from '../gateway-jobs.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface ExportRemoteCtx {
  /** jobId 归一（网关与这里都要用；留在网关按函数传进来）。 */
  normalizeJobId: (jobId?: unknown) => string
  dirs: () => { decrypted: string; decoded: string }
  rawWechatBase: (decrypted: string) => string
  ctx: () => Context
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  recordExport: (input: { kind: string; label?: string; format?: string; path: string; rows?: number; status: ExportStatus; error?: string; params?: unknown }) => void
  streamControl: (jobId?: string) => ManagedStreamControl
  finishStreamJob: (jobId: string, error?: string, token?: symbol, canceled?: boolean) => void
  streamJobs: Map<string, StreamJob>
}

/** CSV 导出种类的中文说明（只用于导出历史的可读 label，不参与导出本身）。 */
const CSV_KIND_LABEL: Record<string, string> = {
  contacts: '通讯录',
  favorites: '收藏',
  files: '文件',
  records: '记录',
  moments: '朋友圈',
  privacy: '隐私扫描',
}

/**
 * 两条入口（W2-8.2 补上取消三件套）：`exportAnnualReport` 与 `exportCsv`。
 *
 * 它们原先是 M3 那轮唯二漏掉的两条 —— 而恰好是最该有的两条：年报实测整段 4048ms
 * （`annual-report.ts` 里那句注释，全部导出入口里最长的一个），用户点完之后既看不到
 * 进度也停不下来；CSV 的 contacts/favorites/records 是几万行起步，逐行拼表就是全部耗时。
 *
 * 两条入口里的 `normalizeJobId(options?.jobId)` 是就地调用而不是提成局部变量 ——
 * 它是幂等的纯函数，两条路径各归一化一次即可，而 `createExportRemotes` 已在函数体棘轮上。
 */
/**
 * 流式导出的一次调用（jobId → 进度 + 取消令牌，跑完清在飞槽）。W2-8.2。
 *
 * 为什么抽出来：两条入口的形状完全一样（normalize jobId → 传 streamControl →
 * finish），各自写一遍就把 `createExportRemotes` 顶出棘轮。清在飞槽这一步不能省：
 * 少了它，同一个 jobId 的下一次调用会撞上「上一个还在跑」。
 * @param rc - 导出 Remote 的上下文。
 * @param jobId - 进度任务标识（空串表示「不是流式任务」，此时 streamControl 为空对象）。
 * @param run - 真正的导出调用，参数是那一份 StreamControl。
 * @returns 导出结果。
 */
async function withStreamJob<T>(rc: ExportRemoteCtx, jobId: string, run: (ctrl: ManagedStreamControl) => Promise<T>): Promise<T> {
  const ctrl = rc.streamControl(jobId)
  try {
    const result = await run(ctrl)
    rc.finishStreamJob(jobId, undefined, ctrl.jobToken)
    return result
  } catch (e) {
    const message = (e as Error).message
    rc.finishStreamJob(jobId, message, ctrl.jobToken, isCancelMessage(message))
    throw e
  }
}

/**
 * 流式导出失败路径的记账（W2-8.2）。清在飞槽 + 记操作日志，两条入口各调一次。
 * @param rc - 导出 Remote 的上下文。
 * @param jobId - 进度任务标识。
 * @param action - 记进操作日志的动作名。
 * @param key - 操作日志的定位字段（年份 / 导出类型）。
 * @param message - 失败原因。
 */
function failStreamJob(rc: ExportRemoteCtx, jobId: string, action: string, key: string, message: string): void {
  // 在飞槽已由 withStreamJob/exportSessionMessagesIn 按本轮 token 结算；这里只记账。
  rc.op('export', action, 'fail', key, message)
}

interface SessionExportOptions {
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
}

/**
 * 单会话导出的完整记账链路。抽在 `createExportRemotes` 外，避免该函数继续突破
 * 函数行数棘轮；入参、进度槽清理和导出历史字段均与原实现一致。
 */
async function exportSessionMessagesIn(rc: ExportRemoteCtx, options: SessionExportOptions): Promise<ExportResult> {
  const jobId = rc.normalizeJobId(options?.jobId)
  let normalizedOptions = options
  let ctrl: ManagedStreamControl | undefined
  try {
    ctrl = rc.streamControl(jobId)
    const dirs = rc.dirs()
    const identity = canonicalChatReference(dirs.decrypted, options?.username ?? '', '导出会话')
    normalizedOptions = {
      ...options,
      username: identity.username,
      ...(options.sessionName === undefined
        || options.sessionName.trim() === ''
        || isMessageTableHash(options.sessionName)
        ? { sessionName: identity.displayName }
        : {}),
    }
    if (identity.error !== undefined) throw new Error(identity.error)
    if (identity.username === '') throw new Error('未指定导出会话')
    const rawBase = rc.rawWechatBase(dirs.decrypted)
    const r = await exportSessionMessagesStreamed(dirs.decrypted, {
      ...normalizedOptions,
      decodedDir: dirs.decoded,
      ...(rawBase ? { wechatBaseDir: rawBase } : {}),
      ...ctrl,
    })
    rc.finishStreamJob(jobId, undefined, ctrl.jobToken)
    rc.op('export', 'export_session_messages', 'ok', normalizedOptions.username, `共 ${r.count} 条`)
    rc.recordExport({
      kind: 'session',
      label: normalizedOptions.sessionName ? `会话 · ${normalizedOptions.sessionName}` : `会话 · ${normalizedOptions.username}`,
      format: normalizedOptions.zip ? 'zip' : normalizedOptions.format,
      path: r.path,
      rows: r.count,
      status: 'ok',
      params: normalizedOptions,
    })
    return r
  } catch (e) {
    const message = (e as Error).message
    const canceled = isCancelMessage(message)
    rc.finishStreamJob(jobId, message, ctrl?.jobToken, canceled)
    rc.op('export', 'export_session_messages', 'fail', normalizedOptions.username, message)
    rc.recordExport({
      kind: 'session',
      label: normalizedOptions.sessionName ? `会话 · ${normalizedOptions.sessionName}` : `会话 · ${normalizedOptions.username}`,
      format: normalizedOptions.zip ? 'zip' : normalizedOptions.format,
      path: '',
      status: canceled ? 'canceled' : 'fail',
      error: canceled ? '' : message,
      params: normalizedOptions,
    })
    throw e
  }
}

export function createExportRemotes(rc: ExportRemoteCtx) {
  const normalizeJobId = rc.normalizeJobId
  return {
    async exportSessionMessages(options: SessionExportOptions): Promise<ExportResult> {
      return exportSessionMessagesIn(rc, options)
    },

    async exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string; jobId?: string }): Promise<ExportResult> {
      try {
        const r = await withStreamJob(rc, normalizeJobId(options?.jobId), (ctrl) => exportAnnualReport(rc.dirs().decrypted, options.year, options.format, options.dir, options.filename, ctrl))
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
        const message = (e as Error).message
        const canceled = isCancelMessage(message)
        failStreamJob(rc, normalizeJobId(options?.jobId), 'export_annual_report', String(options.year), message)
        rc.recordExport({
          kind: 'annual',
          label: `年度报告 · ${options.year} 年`,
          format: options.format,
          path: '',
          status: canceled ? 'canceled' : 'fail',
          error: canceled ? '' : message,
          params: options,
        })
        throw e
      }
    },

    async exportAllSessions(options?: { dir?: string; filename?: string; jobId?: string }): Promise<ExportResult> {
      const jobId = normalizeJobId(options?.jobId)
      let ctrl: ManagedStreamControl | undefined
      try {
        ctrl = rc.streamControl(jobId)
        // M3：进度/取消三件套（jobId → 本地 onProgress + AbortController）在本层接上，
        // 参数原样透传给 query 层（`& StreamControl`）—— 取消后写盘走 temp+rename，
        // 所以「取消」不会留下半成品文件。
        const r = await exportAllSessions(rc.dirs().decrypted, {
          ...(options?.dir !== undefined ? { dir: options.dir } : {}),
          ...(options?.filename !== undefined ? { filename: options.filename } : {}),
          ...ctrl,
        })
        rc.finishStreamJob(jobId, undefined, ctrl.jobToken)
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
        const message = (e as Error).message
        const canceled = isCancelMessage(message)
        rc.finishStreamJob(jobId, message, ctrl?.jobToken, canceled)
        rc.op('export', 'export_all_sessions', 'fail', '', message)
        // 取消也是一种正常结局，与「失败」分开记（`path` 为空时并不落库，口径见
        // `exportSessionMessages` 的说明）。
        rc.recordExport({
          kind: 'all_sessions',
          label: '全部会话归档',
          format: 'zip',
          path: '',
          status: canceled ? 'canceled' : 'fail',
          error: canceled ? '' : message,
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
      job.cancelRequested = true
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
      status: 'running' | 'ok' | 'error' | 'canceled'
      cancelRequested: boolean
      error?: string
    } {
      const id = normalizeJobId(options?.jobId)
      const job = id ? rc.streamJobs.get(id) : undefined
      if (!job) return { found: false, phase: '', done: 0, total: 0, finished: true, status: 'ok', cancelRequested: false }
      return {
        found: true,
        phase: job.progress?.phase ?? '',
        done: job.progress?.done ?? 0,
        total: job.progress?.total ?? 0,
        finished: job.finished,
        status: job.status,
        cancelRequested: job.cancelRequested === true,
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
      includeImages?: boolean
      includeVideos?: boolean
      includeLivePhotos?: boolean
      from?: number
      to?: number
      dir?: string
      filename?: string
      jobId?: string
    }): Promise<ExportResult> {
      const jobId = normalizeJobId(options?.jobId)
      let ctrl: ManagedStreamControl | undefined
      try {
        ctrl = rc.streamControl(jobId)
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
          ...(options?.includeImages !== undefined ? { includeImages: options.includeImages } : {}),
          ...(options?.includeVideos !== undefined ? { includeVideos: options.includeVideos } : {}),
          ...(options?.includeLivePhotos !== undefined ? { includeLivePhotos: options.includeLivePhotos } : {}),
          ...(options?.from !== undefined ? { from: options.from } : {}),
          ...(options?.to !== undefined ? { to: options.to } : {}),
          ...(options?.dir !== undefined ? { dir: options.dir } : {}),
          ...(options?.filename !== undefined ? { filename: options.filename } : {}),
          ...ctrl,
        })
        rc.finishStreamJob(jobId, undefined, ctrl.jobToken)
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
        const message = (e as Error).message
        const canceled = isCancelMessage(message)
        rc.finishStreamJob(jobId, message, ctrl?.jobToken, canceled)
        rc.op('export', 'export_moments', 'fail', options?.username ?? '', message)
        rc.recordExport({
          kind: 'moments',
          label: options?.username ? `朋友圈 · ${options.authorName ?? options.username}` : '朋友圈 · 全部',
          format: options?.zip ? 'zip' : (options?.format ?? 'txt'),
          path: '',
          status: canceled ? 'canceled' : 'fail',
          error: canceled ? '' : message,
          params: options ?? {},
        })
        throw e
      }
    },

    async exportCsv(options: { kind: string; recordsKind?: string; dest?: string; category?: string; jobId?: string }): Promise<ExportResult> {
      const label = CSV_KIND_LABEL[options.kind] ?? options.kind
      try {
        const r = await withStreamJob(rc, normalizeJobId(options?.jobId), (ctrl) => exportCsv(rc.dirs().decrypted, options.kind, options.recordsKind, options.dest, options.category, ctrl))
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
        const message = (e as Error).message
        const canceled = isCancelMessage(message)
        failStreamJob(rc, normalizeJobId(options?.jobId), 'export_csv', options.kind, message)
        rc.recordExport({
          kind: options.kind,
          label,
          format: 'csv',
          path: '',
          status: canceled ? 'canceled' : 'fail',
          error: canceled ? '' : message,
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

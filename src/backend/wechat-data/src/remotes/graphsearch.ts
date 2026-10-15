
/**
 * 知识图谱、消息检索与索引（含编辑历史复位） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { resetEditedMessage as resetEdit } from '../query/edit.ts'
import { readDocGraph } from '../query/kb/entities.ts'
import { mergeDocEntities, readDocEntities } from '../query/kb/extract.ts'
import { contactMeta } from '../query/meta.ts'
import { KnowledgeSnapshotRead, buildKnowledgeGraph } from '../query/notes.ts'
import { runSyntheticEval, syntheticIntentAccuracy } from '../query/retrieval/eval-dataset.ts'
import { formatEvalReport } from '../query/retrieval/eval.ts'
import { buildSearchIndex, searchIndexMessagesCancellable } from '../query/search.ts'
import { EditMutationResult, OperationCategory, OperationStatus, SearchBuildResult, SearchSnapshot } from '../types.ts'
import { RetrievalEvalResult } from '../types-retrieval.ts'

export interface createGraphSearchRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  searchJobs: Map<string, AbortController>
  searchSignal: (jobId?: string) => { signal: AbortSignal; done: () => void } | undefined
  /** W3-11.5：进度事件的出口（与 laya 分析同一套路）。 */
  ctx: () => { emit: (name: string, ...args: unknown[]) => void }
  /**
   * W3-11.5：索引构建的取消槽。
   *
   * **不复用 `searchJobs`**：搜索与构建会同时在跑，共用一个 Map 的话两个毫不相干的
   * jobId 会互相顶掉对方的令牌，「停止构建」会打到正在跑的搜索上。
   */
  searchIndexSignal: (jobId?: string) => { signal: AbortSignal; done: () => void } | undefined
  cancelSearchIndexJob: (jobId?: string) => boolean
}

export function createGraphSearchRemotes(rc: createGraphSearchRemotesInputs) {
  return {
    getKnowledgeGraph(kbId: number): KnowledgeSnapshotRead {
      const names = contactMeta(rc.dirs().decrypted).names
      const snap = buildKnowledgeGraph(rc.dirs().decrypted, kbId, names)
      const doc = readDocGraph(rc.dirs().decrypted, kbId, snap.notes.map(n => ({ id: n.id, title: n.title })))
      if (doc.readError !== undefined) {
        return { ...snap, readError: snap.readError ?? `文件库读取失败（图上没有文件节点，但不是「这个库没有文件」）：${doc.readError}` }
      }
      /**
       * 推断层合流：把「模型说这份文件里有哪些实体」变成 `ent:<key>` 节点 + `suggest` 边。
       * 与上面观测层的区别只在**可信度**，所以命名空间与边 kind 都另起一套，
       * 让画布能用虚线把它们分开画（同一 label 在多个文件被抽出 ⇒ 合成一个节点）。
       */
      const ent = mergeDocEntities(readDocEntities(rc.dirs().decrypted, kbId).items)
      return {
        ...snap,
        docFiles: doc.files,
        docSections: doc.sections,
        docEntities: ent.nodes,
        edges: [...snap.edges, ...doc.containEdges, ...doc.mentionEdges, ...ent.edges],
        summary: { ...snap.summary, fileCount: doc.files.length, sectionCount: doc.sections.length, entityCount: ent.nodes.length },
      }
    },

    async searchMessages(options: { query: string; limit?: number; username?: string; jobId?: string }): Promise<SearchSnapshot> {
      const job = rc.searchSignal(options?.jobId)
      try {
        return await searchIndexMessagesCancellable(rc.dirs().decrypted, options.query, options.limit, options.username,
          job ? { signal: job.signal } : undefined)
      } finally {
        job?.done()
      }
    },

    async buildSearchIndex(options?: { force?: boolean; jobId?: string }): Promise<SearchBuildResult> {
      // W3-11.5：进度事件 + 取消槽（与逐条分析同一套件：回调过不了 IPC，只能推事件）。
      const jobId = typeof options?.jobId === 'string' ? options.jobId.trim().slice(0, 64) : ''
      let lastProgressAt = 0
      const emitProgress = jobId === ''
        ? undefined
        : (done: number, total: number, rows: number): void => {
            const now = Date.now()
            if (done < total && now - lastProgressAt < 120) return
            lastProgressAt = now
            try {
              rc.ctx().emit('search-index/progress', { jobId, done, total, rows })
            } catch { /* 事件 best-effort */ }
          }
      const ctl = rc.searchIndexSignal(jobId)
      try {
        const r = await buildSearchIndex(rc.dirs().decrypted, options?.force, {
          ...(emitProgress ? { onProgress: emitProgress } : {}),
          ...(ctl ? { signal: ctl.signal } : {}),
        })
        // 被取消记 skip 而不是 fail：旧索引原封不动，索引没坏（口径同逐条分析的取消）。
        rc.op('sync', 'build_search_index', r.status === 'ok' ? 'ok' : 'skip', '', r.message ?? `rows=${r.rows ?? 0}`)
        return r
      } catch (e) {
        rc.op('sync', 'build_search_index', 'fail', '', (e as Error).message)
        throw e
      } finally {
        ctl?.done()
      }
    },

    /**
     * 停止一次正在跑的搜索索引构建（W3-11.5）。
     *
     * 取消只在分片边界（以及分片内每次让出）生效，且会 ROLLBACK ⇒ 旧索引原封不动。
     */
    cancelSearchIndexBuild(options: { jobId?: string }): { ok: boolean; message?: string } {
      const id = typeof options?.jobId === 'string' ? options.jobId.trim() : ''
      if (id === '') return { ok: false, message: '缺少任务标识' }
      return rc.cancelSearchIndexJob(id)
        ? { ok: true }
        : { ok: false, message: '这次构建已经结束了（或标识不认识），无需停止' }
    },

    evaluateRetrieval(options?: { k?: number }): RetrievalEvalResult {
      const k = options?.k ?? 10
      const hybrid = runSyntheticEval({ k })
      const sparseOnly = runSyntheticEval({ k, denseEnabled: false, structuredEnabled: false })
      const intentAccuracy = syntheticIntentAccuracy()
      const brief = (r: typeof hybrid): { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number } => ({
        precision: r.precision, recall: r.recall, mrr: r.mrr, ndcg: r.ndcg, map: r.map, cases: r.cases, hits: r.hits,
      })
      const report = [
        formatEvalReport('合成评测集（混合：稀疏+稠密+结构化）', hybrid, k),
        formatEvalReport('消融对照（仅稀疏）', sparseOnly, k),
        `意图分类准确率：${intentAccuracy.correct}/${intentAccuracy.total} = ${(intentAccuracy.accuracy * 100).toFixed(1)}%`,
      ].join('\n')
      rc.op('task', 'evaluate_retrieval', 'ok', '', `MRR ${hybrid.mrr.toFixed(3)} vs 稀疏 ${sparseOnly.mrr.toFixed(3)}`)
      return { report, hybrid: brief(hybrid), sparseOnly: brief(sparseOnly), intentAccuracy }
    },

    resetEditedMessage(options: { username: string; localId: number }): EditMutationResult {
      const r = resetEdit(rc.dirs().decrypted, options.username, options.localId)
      rc.op('edit', 'reset_edited_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? `localId=${options.localId}`)
      return r
    },

  }
}

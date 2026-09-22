
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

export interface createGraphSearchRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  searchJobs: Map<string, AbortController>
  searchSignal: (jobId?: string) => { signal: AbortSignal; done: () => void } | undefined
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

    async buildSearchIndex(options?: { force?: boolean }): Promise<SearchBuildResult> {
      try {
        const r = await buildSearchIndex(rc.dirs().decrypted, options?.force)
        rc.op('sync', 'build_search_index', r.status === 'ok' ? 'ok' : 'skip', '', r.message ?? `rows=${r.rows ?? 0}`)
        return r
      } catch (e) {
        rc.op('sync', 'build_search_index', 'fail', '', (e as Error).message)
        throw e
      }
    },

    evaluateRetrieval(options?: { k?: number }): {
      report: string
      hybrid: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
      sparseOnly: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
      intentAccuracy: { correct: number; total: number; accuracy: number }
    } {
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

/**
 * 批量摘要 / 实体按钮的确认与启动逻辑。
 *
 * 这三件事放在一起，是因为它们的失败方式相同：候选筛错、确认框没写清出网、
 * 或按钮调用了错误的 action。面板只负责渲染两个按钮，不再堆一大段确认文案。
 *
 * @module use-kb-batch-actions
 */
import { useCallback } from 'react'
import type { KbFileMeta } from '../types.ts'
import type { ConfirmFn } from '../ui/confirm.tsx'
import { pickBatchFiles } from './kb-batch-jobs.ts'
import type { KbBatchJobsState } from './use-kb-batch-jobs.ts'

/**
 * 生成文件详情里的操作按钮回执与启动函数。
 *
 * 批量摘要优先补缺；全部已有摘要时改用「全部重做」。实体总是取当前所有可出网文件。
 * 两者在打开确认框前都先核对候选数量，0 个时不打开空对话框。
 *
 * @param files - 当前库文件列表。
 * @param batchJobs - 批量队列。
 * @param confirm - 应用内确认框。
 * @param hold - 无法启动时的提示。
 * @returns 两个按钮的点击处理函数。
 */
export function useKbBatchActions(files: readonly KbFileMeta[], batchJobs: KbBatchJobsState, deps: {
  confirm: ConfirmFn
  hold: (msg: string) => void
}): { batchSummaries: () => Promise<void>; batchEntities: () => Promise<void> } {
  const { confirm, hold } = deps

  const batchSummaries = useCallback(async (): Promise<void> => {
    const missing = pickBatchFiles(files, 'summary', 'missing-summary')
    const scope = missing.length > 0 ? 'missing-summary' : 'all-rag'
    const targets = missing.length > 0 ? missing : pickBatchFiles(files, 'summary', 'all-rag')
    if (targets.length === 0) {
      hold('没有可生成摘要的文件：需要已解析且打开「参与语义检索（会出网）」的文件')
      return
    }
    const ok = await confirm({
      title: `批量生成 ${targets.length} 份摘要？`,
      message: '会依次把每份文件的正文片段发给你配置的模型（会出网）。'
        + ' 单份失败不会中断其余文件，完成后可以在「文档处理状态」里逐条查看结果。'
        + (scope === 'all-rag' ? ' 当前所有可出网文件都已有摘要，这次会全部重新生成。' : ''),
      confirmText: '开始生成',
    })
    if (!ok) return
    await batchJobs.start({ action: 'summary', scope }, files)
  }, [batchJobs, confirm, files, hold])

  const batchEntities = useCallback(async (): Promise<void> => {
    const targets = pickBatchFiles(files, 'entities', 'all-rag')
    if (targets.length === 0) {
      hold('没有可提取实体的文件：需要已解析且打开「参与语义检索（会出网）」的文件')
      return
    }
    const ok = await confirm({
      title: `批量提取 ${targets.length} 份文件的实体？`,
      message: '会依次把每份文件的正文片段发给你配置的模型（会出网），结果会进入知识图谱。'
        + ' 单份失败不会中断其余文件，完成后可以在「文档处理状态」里逐条查看结果。',
      confirmText: '开始提取',
    })
    if (!ok) return
    await batchJobs.start({ action: 'entities', scope: 'all-rag' }, files)
  }, [batchJobs, confirm, files, hold])

  return { batchSummaries, batchEntities }
}

/**
 * 「文件」面板的批量队列装配。
 *
 * 把三个彼此相关的生命周期收在一起：批量执行、页面动作（确认 / 启动）
 * 和每个文件完成后的静默刷新。面板只保留一行解构，不再同时管理三套依赖。
 *
 * @module use-kb-files-batch
 */
import { useCallback } from 'react'
import type { KbFileMeta } from '../types.ts'
import type { ConfirmFn } from '../ui/confirm.tsx'
import { useKbBatchActions } from './use-kb-batch-actions.ts'
import { useKbBatchJobs, type KbBatchJobsState } from './use-kb-batch-jobs.ts'

/** 面板需要的批量能力。 */
export interface KbFilesBatchState extends KbBatchJobsState {
  batchSummaries: () => Promise<void>
  batchEntities: () => Promise<void>
}

/**
 * 组装批量队列与两个页头动作。
 * @param kbId - 当前知识库。
 * @param files - 当前文件列表。
 * @param deps - 提示、确认与静默刷新。
 * @returns 队列状态与动作。
 */
export function useKbFilesBatch(kbId: number, files: readonly KbFileMeta[], deps: {
  flash: (msg: string) => void
  hold: (msg: string) => void
  confirm: ConfirmFn
  reload: () => Promise<void>
}): KbFilesBatchState {
  const { flash, hold, confirm, reload } = deps
  const silentReload = useCallback(() => reload(), [reload])
  const batchJobs = useKbBatchJobs(kbId, { flash, reload: silentReload })
  const { batchSummaries, batchEntities } = useKbBatchActions(files, batchJobs, { confirm, hold })
  return { ...batchJobs, batchSummaries, batchEntities }
}

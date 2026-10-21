/**
 * 「文件」页头的一键批量动作按钮。
 *
 * 按钮本身不判断候选：候选、出网数量与确认文案在 `use-kb-batch-actions`。
 * 这里只处理一个视觉与语义边界：批量任务进行中时禁用两个入口，并让当前动作的
 * 按钮说明它正在跑，避免用户重复点击启动第二条队列。
 *
 * @module kb-batch-actions
 */
import { Button } from '../ui/kit.tsx'
import type { KbBatchRun } from './kb-batch-jobs.ts'

export interface KbBatchActionButtonsProps {
  /** 当前队列；`null` = 从未启动。 */
  run: KbBatchRun | null
  /** 正在执行的文件 id；非空即整轮仍忙。 */
  runningId: number | null
  /** 语义索引也在出网时，批量入口跟着禁用，避免同时打满模型通道。 */
  indexing: boolean
  onSummaries: () => void
  onEntities: () => void
}

/**
 * 两个批量按钮。
 * @param props - 队列状态与点击回调。
 * @returns 两个 ghost 按钮。
 */
export function KbBatchActionButtons({
  run, runningId, indexing, onSummaries, onEntities,
}: KbBatchActionButtonsProps): React.JSX.Element {
  const busy = runningId !== null || indexing
  return (
    <>
      <Button
        variant="ghost"
        onClick={onSummaries}
        disabled={busy}
        title="为还没有摘要、且允许出网的文件依次生成摘要（会出网）"
      >
        {runningId !== null && run?.action === 'summary' ? '批处理中…' : '批量摘要'}
      </Button>
      <Button
        variant="ghost"
        onClick={onEntities}
        disabled={busy}
        title="为所有允许出网的文件依次提取实体，并同步到知识图谱（会出网）"
      >
        {runningId !== null && run?.action === 'entities' ? '批处理中…' : '批量实体'}
      </Button>
    </>
  )
}

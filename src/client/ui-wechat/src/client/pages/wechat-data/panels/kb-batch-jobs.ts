/**
 * 文件批量处理队列（摘要 / 实体抽取）的纯状态模型。
 *
 * 这一层只回答三个问题：下一份该跑什么、当前这一份跑到哪、结束后怎么汇总。
 * 真正的出网调用仍由面板注入 —— 这样顺序、失败隔离与取消语义都能在 node
 * 环境里直接测，不必假装有一个 DOM。
 *
 * 口径：
 *   · **严格串行**：一轮只发一次模型请求，避免批量按钮把厂商限流撞满；
 *   · **单文件失败不连坐**：失败原因留在该文件上，队列继续跑下一份；
 *   · **取消不丢已完成的回执**：只是不再认领后续条目；
 *   · **不伪造百分比**：请求没有逐字进度，状态只能是排队 / 处理中 / 成功 / 失败。
 *
 * @module kb-batch-jobs
 */
import type { KbFileMeta } from '../types.ts'

/** 批量动作：生成摘要或提取实体。 */
export type KbBatchAction = 'summary' | 'entities'

/** 队列内单条目的生命周期。 */
export type KbBatchItemStatus = 'queued' | 'running' | 'ok' | 'failed' | 'skipped'

/** 队列内一份文件的可观察状态。 */
export interface KbBatchItem {
  fileId: number
  /** 文件名快照：队列跑完后列表可能已被刷新，仍要能说清是哪一份。 */
  name: string
  status: KbBatchItemStatus
  /** 成功时的补充说明（摘要只回 ok；实体回写入条数）。 */
  detail: string
  /** 失败原因；`skipped` 时也写清为什么没跑。 */
  error: string
}

/** 一整轮批处理。 */
export interface KbBatchRun {
  action: KbBatchAction
  items: readonly KbBatchItem[]
  /** 是否已取消；已完成的条目仍保留结果。 */
  canceled: boolean
}

/** 单条执行结果。 */
export type KbBatchOutcome =
  | { status: 'ok'; detail?: string }
  | { status: 'failed'; error: string }

/** 候选选择口径：摘要按需/全部，实体按全部。 */
export type KbBatchScope = 'missing-summary' | 'all-rag'

/**
 * 生成候选文件列表。
 *
 * 两种动作共用两道硬边界：
 *   · **只有 `includeInRag=true` 的文件能出网**；
 *   · **只有已经解析出正文块的文件有东西可发**。排队 / 解析中 / 未解析的文件
 *     进入队列只会得到一条「没有可用正文」的失败，空占进度并误导用户。
 * 已关闭出网的文件不是「失败」，而是根本没有资格进入队列；把它们留在界面上
 * 会让用户以为点一下就能给敏感文件生成摘要。
 *
 * @param files - 当前库的文件列表。
 * @param action - 批量动作。
 * @param scope - `missing-summary` 只挑尚未生成摘要的文件；`all-rag` 取全部可出网文件。
 * @returns 保持列表原顺序的候选文件。
 */
export function pickBatchFiles(
  files: readonly KbFileMeta[],
  action: KbBatchAction,
  scope: KbBatchScope,
): KbFileMeta[] {
  const eligible = files.filter(f => (
    f.includeInRag
    && f.parseState === 'ready'
    && f.chunkCount > 0
  ))
  if (scope === 'all-rag') return eligible
  if (action === 'entities') return eligible
  return eligible.filter(f => (f.summary ?? '').trim() === '')
}

/**
 * 由候选文件构造一轮待执行队列。
 * @param files - 已选中的候选。
 * @param action - 批量动作。
 * @returns 所有条目初始为 `queued`。
 */
export function createBatchRun(files: readonly KbFileMeta[], action: KbBatchAction): KbBatchRun {
  return {
    action,
    canceled: false,
    items: files.map(f => ({ fileId: f.id, name: f.name, status: 'queued', detail: '', error: '' })),
  }
}

/**
 * 只把失败条目重新放回队列，不重跑已经成功的文件。
 *
 * 重试整轮会让已经成功的摘要 / 实体再次出网；对批量任务来说，这既慢又会产生
 * 不必要的模型费用。取消本轮已清 `canceled`，否则 `nextBatchIndex` 会立刻返回 -1。
 * @param run - 原队列。
 * @returns 新队列；没有失败项时原样返回。
 */
export function retryFailedBatchItems(run: KbBatchRun): KbBatchRun {
  let changed = false
  const items = run.items.map((it) => {
    if (it.status !== 'failed') return it
    changed = true
    return { ...it, status: 'queued' as const, detail: '', error: '' }
  })
  return changed ? { ...run, items, canceled: false } : run
}

/**
 * 找到下一条可执行的条目。
 *
 * 取消后返回 -1；否则返回第一个 `queued` 的下标。这个函数故意不自己改状态 ——
 * 执行者要在真正发请求前才能把条目标成 `running`，否则界面会在调用前先说「处理中」。
 * @param run - 当前队列。
 * @returns 下标；没有可执行项时为 -1。
 */
export function nextBatchIndex(run: KbBatchRun): number {
  if (run.canceled) return -1
  return run.items.findIndex(it => it.status === 'queued')
}

/**
 * 不可变地替换一条队列项。
 * @param run - 原队列。
 * @param index - 条目下标。
 * @param patch - 要覆盖的字段。
 * @returns 新队列；下标越界时原样返回。
 */
export function patchBatchItem(
  run: KbBatchRun,
  index: number,
  patch: Partial<Omit<KbBatchItem, 'fileId' | 'name'>>,
): KbBatchRun {
  if (index < 0 || index >= run.items.length) return run
  const items = run.items.map((it, i) => (i === index ? { ...it, ...patch } : it))
  return { ...run, items }
}

/**
 * 把队列标成取消。正在跑的那一条不强行中断（RPC 没有取消参数），
 * 但之后不会再认领新条目。
 * @param run - 原队列。
 * @returns 已取消的队列。
 */
export function cancelBatchRun(run: KbBatchRun): KbBatchRun {
  return run.canceled ? run : { ...run, canceled: true }
}

/**
 * 把尚未执行的条目标成 `skipped`，并写清原因（取消 / 已无候选）。
 * @param run - 原队列。
 * @param reason - 给用户看的跳过原因。
 * @returns 新队列。
 */
export function skipQueuedItems(run: KbBatchRun, reason: string): KbBatchRun {
  let changed = false
  const items = run.items.map((it) => {
    if (it.status !== 'queued') return it
    changed = true
    return { ...it, status: 'skipped' as const, error: reason }
  })
  return changed ? { ...run, items } : run
}

/** 一轮队列的汇总。 */
export interface KbBatchTally {
  total: number
  queued: number
  running: number
  ok: number
  failed: number
  skipped: number
  done: number
}

/**
 * 统计队列各状态数量。
 * @param run - 当前队列。
 * @returns 计数快照。
 */
export function tallyBatchRun(run: KbBatchRun): KbBatchTally {
  const out: KbBatchTally = {
    total: run.items.length, queued: 0, running: 0, ok: 0, failed: 0, skipped: 0, done: 0,
  }
  for (const it of run.items) {
    out[it.status] += 1
    if (it.status === 'ok' || it.status === 'failed' || it.status === 'skipped') out.done += 1
  }
  return out
}

/**
 * 队列是否已经跑完（成功、失败、跳过都算结束）。
 * @param run - 当前队列。
 * @returns 是否没有待执行或正在执行项。
 */
export function batchRunFinished(run: KbBatchRun): boolean {
  return run.items.every(it => it.status !== 'queued' && it.status !== 'running')
}

/**
 * 生成结束时的一句汇总。
 *
 * 失败和跳过要分开说：前者是模型 / 网络拒绝，后者是用户取消或没有候选。
 * 把两者合成「失败 N 个」会让用户去重试一批其实从未发出去的文件。
 * @param run - 当前队列。
 * @returns 提示文案；空队列返回空串。
 */
export function batchRunSummary(run: KbBatchRun): string {
  const t = tallyBatchRun(run)
  if (t.total === 0) return ''
  const action = run.action === 'summary' ? '摘要' : '实体'
  const parts = [`已处理 ${t.done}/${t.total} 份${action}`]
  if (t.ok > 0) parts.push(`成功 ${t.ok}`)
  if (t.failed > 0) parts.push(`失败 ${t.failed}`)
  if (t.skipped > 0) parts.push(`跳过 ${t.skipped}`)
  return parts.join(' · ')
}

/**
 * 单条目状态的界面文案。
 * @param status - 条目状态。
 * @returns 中文短标签。
 */
export function batchStatusLabel(status: KbBatchItemStatus): string {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '处理中'
  if (status === 'ok') return '已完成'
  if (status === 'failed') return '失败'
  return '已跳过'
}

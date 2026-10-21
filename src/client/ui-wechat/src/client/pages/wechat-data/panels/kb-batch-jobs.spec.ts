/**
 * 批量队列纯逻辑守卫。
 *
 * 这里钉的是几条不会让页面崩、却会让用户看到错误事实的边界：
 *   · 关闭出网的文件不能悄悄进入批量抽取；
 *   · 摘要批量只补没有摘要的，但也允许「全部重做」；
 *   · 单条失败不能连坐；
 *   · 取消后已完成的回执仍保留，未执行的明确标成跳过。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { KbFileMeta } from '../types.ts'
import {
  batchRunFinished,
  batchRunSummary,
  cancelBatchRun,
  createBatchRun,
  nextBatchIndex,
  patchBatchItem,
  pickBatchFiles,
  retryFailedBatchItems,
  skipQueuedItems,
  tallyBatchRun,
} from './kb-batch-jobs.ts'

function file(id: number, patch: Partial<KbFileMeta> = {}): KbFileMeta {
  return {
    id,
    kbId: 1,
    name: `f${id}.md`,
    ext: 'md',
    srcPath: `C:\\docs\\f${id}.md`,
    sha256: `sha-${id}`,
    blobName: `sha-${id}.md`,
    sizeBytes: 100,
    parseState: 'ready',
    parser: 'markdown',
    parseError: '',
    chunkCount: 2,
    charCount: 1000,
    includeInRag: true,
    summary: '',
    summaryModel: '',
    summaryAt: 0,
    summaryCoveredChars: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe('候选筛选', () => {
  it('批量摘要默认只挑已解析、有正文块、可出网且没有摘要的文件', () => {
    const got = pickBatchFiles([
      file(1),
      file(2, { summary: '已有摘要' }),
      file(3, { includeInRag: false }),
      file(4, { parseState: 'failed' }),
      file(5, { parseState: 'queued', chunkCount: 0 }),
      file(6, { parseState: 'unsupported', chunkCount: 0 }),
      file(7, { chunkCount: 0 }),
    ], 'summary', 'missing-summary')
    expect(got.map(f => f.id)).toEqual([1])
  })

  it('全部重做不会重复跳过已有摘要，但仍守住出网与失败边界', () => {
    const got = pickBatchFiles([
      file(1),
      file(2, { summary: '已有摘要' }),
      file(3, { includeInRag: false }),
      file(4, { parseState: 'failed' }),
      file(5, { parseState: 'parsing' }),
      file(6, { chunkCount: 0 }),
    ], 'summary', 'all-rag')
    expect(got.map(f => f.id)).toEqual([1, 2])
  })

  it('实体抽取不会因为已有摘要而被过滤', () => {
    const got = pickBatchFiles([file(1, { summary: '已有' }), file(2)], 'entities', 'all-rag')
    expect(got.map(f => f.id)).toEqual([1, 2])
  })
})

describe('队列状态机', () => {
  it('严格按顺序认领；取消后不再认领', () => {
    let run = createBatchRun([file(1), file(2)], 'summary')
    expect(nextBatchIndex(run)).toBe(0)
    run = patchBatchItem(run, 0, { status: 'running' })
    expect(nextBatchIndex(run)).toBe(1)
    run = cancelBatchRun(run)
    expect(nextBatchIndex(run)).toBe(-1)
  })

  it('单条失败不连坐，后续仍可执行；计数与完成判定同步', () => {
    let run = createBatchRun([file(1), file(2), file(3)], 'entities')
    run = patchBatchItem(run, 0, { status: 'failed', error: '模型超时' })
    expect(nextBatchIndex(run)).toBe(1)
    run = patchBatchItem(run, 1, { status: 'ok', detail: '写入 2 个实体' })
    run = patchBatchItem(run, 2, { status: 'ok', detail: '写入 1 个实体' })
    expect(tallyBatchRun(run)).toMatchObject({ total: 3, ok: 2, failed: 1, done: 3 })
    expect(batchRunFinished(run)).toBe(true)
    expect(batchRunSummary(run)).toBe('已处理 3/3 份实体 · 成功 2 · 失败 1')
  })

  it('取消只跳过未执行项，已完成结果不丢', () => {
    let run = createBatchRun([file(1), file(2), file(3)], 'summary')
    run = patchBatchItem(run, 0, { status: 'ok' })
    run = cancelBatchRun(run)
    run = skipQueuedItems(run, '已取消')
    expect(run.items.map(it => it.status)).toEqual(['ok', 'skipped', 'skipped'])
    expect(batchRunSummary(run)).toBe('已处理 3/3 份摘要 · 成功 1 · 跳过 2')
  })

  it('空队列有明确结束态，但不会说成处理了 0/0', () => {
    const run = createBatchRun([], 'summary')
    expect(batchRunFinished(run)).toBe(true)
    expect(batchRunSummary(run)).toBe('')
  })

  it('重试只把失败项放回队列，成功项不会被重复出网', () => {
    let run = createBatchRun([file(1), file(2), file(3)], 'summary')
    run = patchBatchItem(run, 0, { status: 'ok' })
    run = patchBatchItem(run, 1, { status: 'failed', error: '超时' })
    run = patchBatchItem(run, 2, { status: 'skipped', error: '已取消' })
    const retried = retryFailedBatchItems(run)
    expect(retried.items.map(it => it.status)).toEqual(['ok', 'queued', 'skipped'])
    expect(nextBatchIndex(retried)).toBe(1)
  })
})

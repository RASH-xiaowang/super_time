/**
 * 长任务槽位的判据（#20 第四个协作者：`gateway-jobs.ts`）。
 *
 * 这一族每条规则错的后果都是"某一次操作诡异地失败"，而不是任何报错：
 *  - 复用槽位时留着上一轮的 `finished`/`error` ⇒ 新一轮刚开始，进度查询就答复"已完成/失败"；
 *  - 复用那个**已经 abort 的** AbortController ⇒ 新一轮导出刚起步就抛「已取消」（注释里写着这是真踩过的）；
 *  - 到上限时把**当前正在复用的**槽自己挤掉 ⇒ 进度与取消令牌一起丢，任务跑完也没人知道。
 * 原先这段住在 `GatewayCore` 里，验一次就得把网关起起来；现在一张 `Map` + 一个假 emit 就够。
 * @module gateway-jobs
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STREAM_JOB_CAP, normalizeJobId } from '../src/gateway-support.ts'
import type { StreamJob } from '../src/gateway-support.ts'
import { finishStreamJobIn, streamControlFor } from '../src/gateway-jobs.ts'

let jobs: Map<string, StreamJob>
let emitted: Array<Record<string, unknown>>
let emit: ReturnType<typeof vi.fn>

const slot = (id: string): StreamJob | undefined => jobs.get(id)

beforeEach(() => {
  jobs = new Map<string, StreamJob>()
  emitted = []
  emit = vi.fn((detail: Record<string, unknown>): void => { emitted.push(detail) })
})

describe('jobId 的门槛与规整', () => {
  it('缺省 / 空白 / 非字符串 ⇒ 返回空控制（无进度、不可取消，旧调用方行为不变）', () => {
    for (const bad of [undefined, '', '   ', 42 as unknown as string, null as unknown as string]) {
      const ctrl = streamControlFor(jobs, emit, bad)
      expect(ctrl.signal, '给了空白 jobId 却发来令牌 ⇒ 调用方会以为这轮可以被取消').toBeUndefined()
      expect(ctrl.onProgress).toBeUndefined()
    }
    expect(jobs.size, '空白 jobId 不该占槽位').toBe(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('键是规整后的那个（trim + 截 64），所以带空白的同一个 id 复用同一个槽', () => {
    const long = 'x'.repeat(80)
    streamControlFor(jobs, emit, '  job-1  ')
    streamControlFor(jobs, emit, 'job-1')
    expect(jobs.size).toBe(1)
    expect(jobs.has(normalizeJobId('  job-1  ')), '规整后的键才对得上').toBe(true)
    streamControlFor(jobs, emit, long)
    expect(jobs.has(normalizeJobId(long)), '超长 id 要按截断后的形态存（否则表会被撑爆）').toBe(true)
    expect([...jobs.keys()].every((k) => k.length <= 64)).toBe(true)
  })
})

describe('复用同一个 jobId', () => {
  it('每次都换一个**新的**、未取消的 AbortController（复用已 abort 的那把 = 新一轮起步就抛「已取消」）', () => {
    const first = streamControlFor(jobs, emit, 'job-a')
    const second = streamControlFor(jobs, emit, 'job-a')
    expect(second.signal).not.toBe(first.signal)
    expect(second.signal?.aborted, '新令牌不该一拿到就已取消').toBe(false)

    // 真实形状：第一轮被用户取消（取消走的是槽里那把控制器，不是 control 本身），
    // 然后第二轮复用同一个 jobId
    first.signal?.addEventListener('abort', () => { /* 只是让监听存在 */ })
    slot('job-a')?.ctrl.abort()
    const third = streamControlFor(jobs, emit, 'job-a')
    expect(third.signal?.aborted, '把上一轮取消的令牌带进新一轮 ⇒ 导出刚起步就"已取消"').toBe(false)
    expect(jobs.get('job-a')?.ctrl.signal).toBe(third.signal)
  })

  it('上一轮的 progress / finished / error 必须被擦掉（留着就会答复"这次已完成"）', () => {
    streamControlFor(jobs, emit, 'job-b').onProgress?.({ phase: 'packing', done: 3, total: 10 })
    finishStreamJobIn(jobs, 'job-b', '用户取消')
    const stale = slot('job-b')
    expect(stale?.finished).toBe(true)
    expect(stale?.error).toBe('用户取消')

    streamControlFor(jobs, emit, 'job-b')
    const fresh = slot('job-b')
    expect(fresh?.finished, '新一轮还没跑就带着 finished ⇒ 进度查询直接答复"已完成"').toBe(false)
    expect(fresh?.error, '上一轮的取消原因还在 ⇒ 新一轮被当成失败').toBeUndefined()
    expect(fresh?.progress, '上一轮的进度还在 ⇒ 界面显示 3/10 而这一轮其实还没开始').toBeNull()
  })
})

describe('进度推送', () => {
  it('onProgress 同时写进槽位并发出带 jobId 的事件（两份是同一批数）', () => {
    const ctrl = streamControlFor(jobs, emit, 'job-c')
    ctrl.onProgress?.({ phase: 'writing', done: 7, total: 9 })
    expect(slot('job-c')?.progress).toEqual({ phase: 'writing', done: 7, total: 9 })
    expect(emitted).toEqual([{ jobId: 'job-c', phase: 'writing', done: 7, total: 9 }])
  })

  it('事件发不出去（渲染进程断了）不该影响任务：槽位照样记下，调用方不收到异常', () => {
    emit.mockImplementation(() => { throw new Error('IPC 断了') })
    const ctrl = streamControlFor(jobs, emit, 'job-d')
    expect(() => { ctrl.onProgress?.({ phase: 'zipping', done: 1, total: 2 }) }).not.toThrow()
    expect(slot('job-d')?.progress, '事件失败就把进度也丢掉 ⇒ 任务跑完了进度还停在 null').toEqual({ phase: 'zipping', done: 1, total: 2 })
  })
})

describe('槽表的上限', () => {
  it('到上限时淘汰最早那一个槽（Map 保持插入序）', () => {
    for (let i = 0; i < STREAM_JOB_CAP; i += 1) streamControlFor(jobs, emit, `old-${String(i)}`)
    expect(jobs.size).toBe(STREAM_JOB_CAP)
    streamControlFor(jobs, emit, 'brand-new')
    expect(jobs.size, '不淘汰就会无限涨（每个槽都握着一把 AbortController）').toBe(STREAM_JOB_CAP)
    expect(jobs.has('old-0'), '该淘汰最早那个').toBe(false)
    expect(jobs.has(`old-${String(STREAM_JOB_CAP - 1)}`)).toBe(true)
    expect(jobs.has('brand-new')).toBe(true)
  })

  it('复用**已存在**的 jobId 时一个都不淘汰（否则会把当前这轮的槽自己挤掉）', () => {
    for (let i = 0; i < STREAM_JOB_CAP; i += 1) streamControlFor(jobs, emit, `s-${String(i)}`)
    const ctrl = streamControlFor(jobs, emit, `s-${String(STREAM_JOB_CAP - 1)}`)
    expect(jobs.size).toBe(STREAM_JOB_CAP)
    expect(jobs.has(`s-${String(STREAM_JOB_CAP - 1)}`), '复用时被挤掉 ⇒ 进度与取消令牌一起丢').toBe(true)
    ctrl.onProgress?.({ phase: 'p', done: 1, total: 1 })
    expect(slot(`s-${String(STREAM_JOB_CAP - 1)}`)?.progress, '槽已丢，进度写进了空气里').toEqual({ phase: 'p', done: 1, total: 1 })
  })
})

describe('收尾', () => {
  it('未知 jobId ⇒ 静默返回（收尾一个早被淘汰的槽不该把任务本身弄失败）', () => {
    expect(() => { finishStreamJobIn(jobs, 'nope') }).not.toThrow()
    expect(jobs.size).toBe(0)
  })

  it('成功收尾：finished=true 且不带 error 键；槽位留着不删（迟到的 getExportProgress 要能读到终态）', () => {
    streamControlFor(jobs, emit, 'done-1')
    finishStreamJobIn(jobs, 'done-1')
    const job = slot('done-1')
    expect(job?.finished).toBe(true)
    expect('error' in (job ?? {}), '成功却带 error 键 ⇒ 界面按失败渲染').toBe(false)
    expect(jobs.has('done-1'), '槽位被删 ⇒ 迟到的进度查询读不到终态').toBe(true)
  })

  it('失败收尾要把原因留下（取消与真失败在界面上是两回事）', () => {
    streamControlFor(jobs, emit, 'fail-1')
    finishStreamJobIn(jobs, 'fail-1', 'database is locked')
    expect(slot('fail-1')).toMatchObject({ finished: true, error: 'database is locked' })
  })
})

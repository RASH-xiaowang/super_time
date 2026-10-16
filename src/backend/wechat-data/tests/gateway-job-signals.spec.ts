/**
 * 可取消任务槽位原语的判据（#20 第六个协作者）。
 *
 * 五类任务与模型下载共享的只有两条规则，但这两条都是「错了不报错，只会在复用 jobId
 * 或并发取消时诡异地失手」：
 *  - 缺省/空白 jobId 不占槽、不可取消（旧调用方行为不变）；
 *  - 取号每次都给新的 AbortController；
 *  - `done()` 只归还自己那一把控制器，先取消、再复用同一 id 时不能删掉新令牌；
 *  - 取消找不到任务时返回 false，调用方据此把「已结束」告诉用户。
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cancelJobIn, jobSignalFor, type AbortJobSlots } from '../src/gateway-job-signals.ts'

let jobs: AbortJobSlots

beforeEach(() => {
  jobs = new Map<string, AbortController>()
})

describe('取号', () => {
  it('缺省 / 空白 / 非字符串 ⇒ 不占槽、返回不可取消的 undefined', () => {
    for (const bad of [undefined, '', '   ', 42 as unknown as string, null as unknown as string]) {
      expect(jobSignalFor(jobs, bad)).toBeUndefined()
    }
    expect(jobs.size).toBe(0)
  })

  it('键是规整后的那个（trim + 截 64），所以带空白的同一个 id 复用同一个槽', () => {
    const long = 'x'.repeat(80)
    jobSignalFor(jobs, '  job-1  ')
    jobSignalFor(jobs, 'job-1')
    jobSignalFor(jobs, long)
    expect(jobs.has('job-1')).toBe(true)
    expect([...jobs.keys()].every((k) => k.length <= 64)).toBe(true)
  })

  it('每次取号都换一把新的、未取消的控制器（复用已 abort 的令牌会让新一轮刚起步就被判取消）', () => {
    const first = jobSignalFor(jobs, 'job-a')!
    const second = jobSignalFor(jobs, 'job-a')!
    expect(second.signal).not.toBe(first.signal)
    expect(second.signal.aborted).toBe(false)
  })
})

describe('归还', () => {
  it('只删自己那一把：先取消、再复用同一 id，旧任务收尾不能误删新令牌', () => {
    const oldToken = jobSignalFor(jobs, 'reuse')!
    cancelJobIn(jobs, 'reuse')
    const fresh = jobSignalFor(jobs, 'reuse')!
    oldToken.done()
    expect(jobs.get('reuse')?.signal).toBe(fresh.signal)
    expect(fresh.signal.aborted, '新令牌被误删或仍带旧取消态').toBe(false)
  })

  it('正常收尾后槽位释放', () => {
    const ctl = jobSignalFor(jobs, 'done')!
    ctl.done()
    expect(jobs.size).toBe(0)
  })
})

describe('取消', () => {
  it('缺省 / 空白 ⇒ 返回 false 且不碰槽表', () => {
    expect(cancelJobIn(jobs, undefined)).toBe(false)
    expect(cancelJobIn(jobs, '   ')).toBe(false)
    expect(jobs.size).toBe(0)
  })

  it('找不到任务 ⇒ false（调用方要如实说已结束，而不是假装取消成功）', () => {
    expect(cancelJobIn(jobs, 'missing')).toBe(false)
  })

  it('找到任务 ⇒ abort 对应控制器并返回 true', () => {
    const ctl = jobSignalFor(jobs, 'running')!
    expect(cancelJobIn(jobs, 'running')).toBe(true)
    expect(ctl.signal.aborted).toBe(true)
    expect(jobs.has('running'), '取消后槽位由任务自己的 finally/done 归还').toBe(true)
  })
})

/**
 * RPC 超时后的取消策略表（宿主层）。
 *
 * 主进程已经把调用判成超时；这份纯函数决定 worker 还能不能从原参数里找到 jobId
 * 并映射到对应的取消 Remote。这张表错了的表现是「超时后工作仍继续跑，且没有回执」，
 * 所以把它单独抽出并逐条钉住。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const hostSrc = readFileSync(join(HERE, '..', 'wechat-host.js'), 'utf8')
const {
  CALL_CANCEL_METHODS,
  NON_CANCELLABLE_LONG_CALLS,
  longCallsWithoutCancelPolicy,
  cancelPlanFor,
  injectFallbackJobId,
  jobIdFromCall,
  jobIdForCall,
} = require(join(HERE, '..', 'wechat-cancel.js'))
const { LONG_CALL_METHODS } = require(join(HERE, '..', 'remote-policy.js'))

describe('wechat-cancel：超时调用的取消计划', () => {
  it('带 jobId 的长任务能映射到对应的取消 Remote', () => {
    expect(cancelPlanFor('exportAllSessions', [{ jobId: ' export-1 ' }])).toEqual({
      ok: true,
      method: 'cancelExportJob',
      jobId: 'export-1',
    })
    expect(cancelPlanFor('searchMessages', [{ jobId: 'search-1' }])).toEqual({
      ok: true,
      method: 'cancelSearch',
      jobId: 'search-1',
    })
    expect(cancelPlanFor('askWechat', [{ jobId: 'ask-1' }])).toEqual({
      ok: true,
      method: 'cancelAsk',
      jobId: 'ask-1',
    })
  })

  it('没有 jobId 或方法不在策略表时明确说不能取消，不假装成功', () => {
    expect(cancelPlanFor('exportAllSessions', [{}]).ok).toBe(false)
    expect(cancelPlanFor('getSessions', [{ jobId: 'x' }])).toEqual({
      ok: false,
      reason: 'method-not-cancellable',
    })
  })

  it('jobId 只接受字符串、去空白并限长（与后端 normalizeJobId 同纪律）', () => {
    expect(jobIdFromCall([{ jobId: 123 }])).toBe('')
    expect(jobIdFromCall([{ jobId: '  abc  ' }])).toBe('abc')
    expect(jobIdFromCall([{ jobId: 'x'.repeat(80) }])).toHaveLength(64)
    expect(jobIdFromCall([])).toBe('')
  })

  it('策略表不是空表，且只映射到真实存在的取消方法名', () => {
    const entries = Object.entries(CALL_CANCEL_METHODS as Record<string, string>)
    expect(entries.length).toBeGreaterThanOrEqual(10)
    const validCancels = new Set([
      'cancelExportJob',
      'cancelSearch',
      'cancelAsk',
      'cancelLayaAnalysis',
      'cancelLayaDownload',
      'cancelSearchIndexBuild',
      'cancelKbIndexBuild',
      'cancelWhisperDownload',
    ])
    for (const [method, cancelMethod] of entries) {
      expect(method, '策略表方法名不能为空').not.toBe('')
      expect(validCancels, `${method} 映射到了未知取消方法 ${cancelMethod}`).toContain(cancelMethod)
    }
  })

  it('每个可取消方法都必须拿长任务窗口，避免 60 秒先放弃后 worker 仍在继续', () => {
    const missingLongWindow = Object.keys(CALL_CANCEL_METHODS)
      .filter((method) => !LONG_CALL_METHODS.has(method))
      .sort()
    expect(missingLongWindow, '可取消但没有长窗口的方法会提前把调用方超时掉').toEqual([])
  })

  it('长任务账本的取消策略必须闭环：可取消或明确登记不可取消，二者不许漂移', () => {
    expect(NON_CANCELLABLE_LONG_CALLS.size).toBeGreaterThan(0)
    expect(longCallsWithoutCancelPolicy(), '新增长任务漏登记取消策略').toEqual([])
  })

  it('宿主层真的按计划调用 gateway 上的取消方法（表与接线不能各漂各的）', () => {
    expect(hostSrc).toContain('const cancelFn = gateway[plan.method]')
    expect(hostSrc).toContain('fn.call(gateway, { jobId })')
    expect(hostSrc).toContain('async cancelCall(method, args = [], callHandle = \'\')')
  })

  it('没有显式 jobId 的可取消调用，宿主会注入稳定的 RPC jobId', () => {
    expect(jobIdForCall('exportAllSessions', [{ dir: 'D:/out' }], '42')).toBe('rpc:42')
    expect(jobIdForCall('exportAllSessions', [{ dir: 'D:/out', jobId: 'user-id' }], '42')).toBe('user-id')
    expect(injectFallbackJobId('askWechat', [{ question: 'hello' }], '7')).toEqual([{ question: 'hello', jobId: 'rpc:7' }])
    expect(injectFallbackJobId('installWhisperEngine', [], '9')).toEqual([{ jobId: 'rpc:9' }])
    expect(injectFallbackJobId('getSessions', [], '9')).toEqual([])
    expect(injectFallbackJobId('askWechat', [{ question: 'hello', jobId: 'user-id' }], '7')).toEqual([{ question: 'hello', jobId: 'user-id' }])
  })
})

/**
 * 调用闸优先级的分类判据。
 *
 * 只钉三条不变式：交互读/取消动作排最前、长任务排最后、未知方法回普通档。
 * 其余分类靠 `remote-policy` 自己的「长任务台账 == 真实方法面」判据守住。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  INTERACTIVE_METHODS,
  HEAVY_PRIORITY,
  INTERACTIVE_PRIORITY,
  NORMAL_PRIORITY,
  callPriorityFor,
} = require('../call-priority.js') as {
  INTERACTIVE_METHODS: ReadonlySet<string>
  HEAVY_PRIORITY: number
  INTERACTIVE_PRIORITY: number
  NORMAL_PRIORITY: number
  callPriorityFor: (method: unknown) => number
}

describe('callPriorityFor', () => {
  it('首屏读与取消动作进交互档', () => {
    expect(INTERACTIVE_METHODS.size).toBeGreaterThan(0)
    expect(callPriorityFor('getSessions')).toBe(INTERACTIVE_PRIORITY)
    expect(callPriorityFor('getOverview')).toBe(INTERACTIVE_PRIORITY)
    expect(callPriorityFor('cancelExportJob')).toBe(INTERACTIVE_PRIORITY)
  })

  it('RPC 长窗口台账里的方法进重活档', () => {
    expect(callPriorityFor('exportAllSessions')).toBe(HEAVY_PRIORITY)
    expect(callPriorityFor('fetchOriginalImagesBatch')).toBe(HEAVY_PRIORITY)
    expect(callPriorityFor('askWechat')).toBe(HEAVY_PRIORITY)
  })

  it('未知/非字符串方法回普通档（不猜测）', () => {
    expect(callPriorityFor('noSuchRemoteMethod')).toBe(NORMAL_PRIORITY)
    expect(callPriorityFor(null)).toBe(NORMAL_PRIORITY)
    expect(callPriorityFor(undefined)).toBe(NORMAL_PRIORITY)
  })
})

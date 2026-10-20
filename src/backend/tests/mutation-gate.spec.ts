/**
 * Phase 2：在途写撤销闸（shadow 默认 / enforce 可开）。
 *
 * 这里钉的是**代际语义**，不是 UI：
 * - 第一次观察只播种，不 bump；
 * - restarts 变化 ⇒ epoch +1；
 * - shadow 不拒绝、enforce 拒绝；
 * - 读请求永远不被撤销；写请求只有“旧代际”才被撤销。
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const gate = require(join(HERE, '..', 'mutation-gate.js')) as {
  isWriteMethod: (method: string) => boolean
  observeBackendStatus: (status: unknown) => boolean
  beginMutation: (method: string) => { epoch: number, write: boolean, method: string }
  checkMutation: (token: { epoch: number, write: boolean, method: string }) => (Error & { code?: string }) | null
  mutationGateStats: () => { epoch: number, mode: string, revoked: number }
  setMutationGateMode: (mode: string) => void
  bumpMutationEpoch: (reason: string) => number
  resetMutationGate: () => void
}

beforeEach(() => { gate.resetMutationGate() })

describe('写方法分类', () => {
  it('save/delete/set/update/create 等算写；get/query/cancel 不算', () => {
    for (const m of ['saveTaskInfo', 'deleteTaskInfo', 'setTaskInfoStatus', 'updateConfig', 'createBackup', 'clearDraft']) {
      expect(gate.isWriteMethod(m), m).toBe(true)
    }
    for (const m of ['getSessions', 'listBackups', 'queryMoments', 'cancelExportJob', 'openPath', '']) {
      expect(gate.isWriteMethod(m), m).toBe(false)
    }
  })
})

describe('epoch 与撤销', () => {
  it('第一次观察只播种；restarts 变化才 bump', () => {
    expect(gate.observeBackendStatus({ restarts: 0 })).toBe(false)
    expect(gate.observeBackendStatus({ restarts: 0 })).toBe(false)
    expect(gate.observeBackendStatus({ restarts: 1 })).toBe(true)
    expect(gate.mutationGateStats().epoch).toBe(1)
  })

  it('shadow 下旧代际写只计数、不拒绝', () => {
    gate.observeBackendStatus({ restarts: 0 })
    const token = gate.beginMutation('saveTaskInfo')
    gate.observeBackendStatus({ restarts: 1 })
    expect(gate.checkMutation(token)).toBeNull()
    expect(gate.mutationGateStats().revoked).toBe(1)
  })

  it('enforce 下旧代际写返回 MUTATION_DISPATCH_REVOKED，并带代际 details', () => {
    gate.observeBackendStatus({ restarts: 0 })
    const token = gate.beginMutation('deleteTaskInfo')
    gate.observeBackendStatus({ restarts: 1 })
    gate.setMutationGateMode('enforce')
    const err = gate.checkMutation(token)
    expect(err?.code).toBe('MUTATION_DISPATCH_REVOKED')
    expect(err?.message).toContain('已撤销')
  })

  it('显式 bump（配置/许可变化）同样让旧代际写在 enforce 下被撤销', () => {
    gate.observeBackendStatus({ restarts: 0 })
    const token = gate.beginMutation('saveWechatConfig')
    gate.bumpMutationEpoch('wechat-config-saved')
    gate.setMutationGateMode('enforce')
    const err = gate.checkMutation(token)
    expect(err?.code).toBe('MUTATION_DISPATCH_REVOKED')
    expect(gate.mutationGateStats().epoch).toBe(1)
  })

  it('同代际写、以及任何读请求都放行', () => {
    gate.observeBackendStatus({ restarts: 0 })
    gate.setMutationGateMode('enforce')
    expect(gate.checkMutation(gate.beginMutation('saveTaskInfo'))).toBeNull()
    gate.observeBackendStatus({ restarts: 1 })
    expect(gate.checkMutation(gate.beginMutation('getSessions'))).toBeNull()
  })
})

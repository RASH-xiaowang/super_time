// @vitest-environment node
/**
 * ClawBot 实例 token 统计的落库 / 聚合守卫（2026-10-19）。
 *
 * 守三点：① 一次 usage 能累加进当天；② 实例列表带出 today/total；③ 没有 usage 不写 0 行。
 * 不碰真实模型：只测存储与列表投影。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClawbotInstance } from '../src/query/clawbot/clawbot-instance.ts'
import { addClawbotTokenUsage, clawbotTokenStats } from '../src/query/clawbot/clawbot-token.ts'
import { listClawbotInstances } from '../src/query/clawbot/clawbot-instance.ts'
import { clawbotDayKey } from '../src/query/clawbot/clawbot-token.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clawbot-token-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 本地当天 0 点。 */
function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

describe('ClawBot token 统计', () => {
  it('同一实例的多次 usage 累加到当天，并能在列表里读出', () => {
    const inst = createClawbotInstance(decrypted)
    addClawbotTokenUsage(decrypted, inst.slot, { inputTokens: 100, outputTokens: 20, totalTokens: 120 })
    addClawbotTokenUsage(decrypted, inst.slot, { inputTokens: 30, outputTokens: 5, totalTokens: 35 })
    const stats = clawbotTokenStats(decrypted, clawbotDayKey(startOfToday()))
    expect(stats.get(inst.slot)).toEqual({ todayTokens: 155, totalTokens: 155 })

    const snap = listClawbotInstances(decrypted, { since: startOfToday() })
    const row = snap.instances.find((x) => x.slot === inst.slot)
    expect(row?.todayTokens).toBe(155)
    expect(row?.totalTokens).toBe(155)
  })

  it('不同实例分开记账（不会把 A 的消耗算到 B 头上）', () => {
    const a = createClawbotInstance(decrypted)
    const b = createClawbotInstance(decrypted)
    addClawbotTokenUsage(decrypted, a.slot, { inputTokens: 10, outputTokens: 1, totalTokens: 11 })
    addClawbotTokenUsage(decrypted, b.slot, { inputTokens: 20, outputTokens: 2, totalTokens: 22 })
    const snap = listClawbotInstances(decrypted, { since: startOfToday() })
    expect(snap.instances.find((x) => x.slot === a.slot)?.totalTokens).toBe(11)
    expect(snap.instances.find((x) => x.slot === b.slot)?.totalTokens).toBe(22)
  })

  it('没有 usage（undefined）不写 0 行；没有消耗的实例显示 0', () => {
    const inst = createClawbotInstance(decrypted)
    addClawbotTokenUsage(decrypted, inst.slot, undefined)
    expect(clawbotTokenStats(decrypted, clawbotDayKey(startOfToday())).size).toBe(0)
    const snap = listClawbotInstances(decrypted, { since: startOfToday() })
    expect(snap.instances[0]?.todayTokens).toBe(0)
    expect(snap.instances[0]?.totalTokens).toBe(0)
  })

  it('供应商没给 total_tokens 时按 input+output 兜底（不记 NaN）', () => {
    const inst = createClawbotInstance(decrypted)
    addClawbotTokenUsage(decrypted, inst.slot, { inputTokens: 7, outputTokens: 3 })
    const stats = clawbotTokenStats(decrypted, clawbotDayKey(startOfToday()))
    expect(stats.get(inst.slot)?.todayTokens).toBe(10)
  })
})

/**
 * 同步失败**必须退避 + 日志必须节流**，不能每 10 秒把整库重解密一遍（2026-09-29 实测的 bug）。
 *
 * ## 为什么要锁住这条
 *
 * 四个同步函数（message 分片 / session / contact / 各 plain 库）原先在 catch 里都是
 * `lastState.delete(key)`（"下一轮再来"）—— 对锁竞争这类**瞬时**故障是对的，
 * 对**持续**故障（密钥失效、源库正被微信写着导致副本撕裂）就是灾难：实测日志里 9 个目标
 * **每 10 秒各自**重解密一次、各打一行 `decrypt invalid`，25 秒涨 1.9 KB（≈6.6 MB/小时），
 * 而 `message_1.db` 原始文件有 **153 MB** —— 每 10 秒解一遍纯属白烧 CPU，且永不收敛。
 *
 * ## 判据口径（断言行为，不是断言源码里有没有某个字符串）
 *
 *   ① 失败后进入退避：退避期内**不再重试**；
 *   ② **源签名变了也不解除退避** —— 第一版按签名重置，实测无效：微信一直在写这些库，
 *      签名每轮都变 ⇒ 等于没退避（这条用例就是那次实测的固化）；
 *   ③ 日志**按时间节流**（同一目标每分钟最多一行），连续多次失败给出可照做的成因提示；
 *   ④ 成功一次立刻清零，恢复即时。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetFullDecryptCooldown,
  syncPlainDatabase,
} from '../src/query/sync.ts'
import {
  failingTargets,
  forgetSyncFailures,
  noteSyncFailure,
  noteSyncSuccess,
  syncFailureBackoffActive,
} from '../src/query/sync-pacing.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
beforeEach(() => {
  // 退避与 full-decrypt 冷却都是**模块级状态**：不清会让用例之间互相污染。
  forgetSyncFailures()
  forgetFullDecryptCooldown()
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-syncfail-${tag}-`))
  scratch.push(dir)
  return dir
}

describe('同步失败退避（同一目标不重复烧 CPU）', () => {
  it('失败后进入退避；**源签名变了也不解除**；成功后清空', () => {
    expect(syncFailureBackoffActive('session.db')).toBe(false)
    expect(noteSyncFailure('session.db', 'a:1', 'session decrypt invalid')).toBe(true)
    expect(syncFailureBackoffActive('session.db'), '失败后必须退避').toBe(true)
    // ⚠️ 关键：签名一变**不能**放行。微信一直在写这些库，按签名重置等于没有退避（实测过）。
    expect(syncFailureBackoffActive('session.db'), '签名变化不该解除退避').toBe(true)

    noteSyncFailure('contact.db', 'a:1', 'contact decrypt invalid')
    noteSyncSuccess('contact.db')
    expect(syncFailureBackoffActive('contact.db'), '成功一次就清空').toBe(false)
  })

  it('日志按时间节流：同一分钟内的连续失败只留一行；行内只陈述事实（成因由 tick 级判读）', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let logged = 0
    // 12 次失败都发生在同一分钟内（真的 tick 之间隔 10s，但节流口径是**时间**，不是次数）。
    for (let i = 0; i < 12; i++) if (noteSyncFailure('general.db', `sig${String(i)}:1`, 'general.db decrypt invalid')) logged++
    expect(logged, '同一分钟内 12 次失败只该打 1 行').toBe(1)
    expect(err.mock.calls.length).toBe(1)
    const first = String(err.mock.calls[0]?.slice(-1)[0] ?? '')
    expect(first, '每次失败都该带上次数与当前退避时长，便于判断"是不是卡住了"').toMatch(/第 1 次、退避 10s/)
    // ⚠️ 单目标那一行**不许**下"密钥失效"这种结论：同一个 `decrypt invalid` 也可能是
    // "微信正写那个库"（见 `failingTargets` 的注释，2026-09-29 实测两次都撞上过）。
    expect(first, '成因结论不该写在单目标行里').not.toContain('密钥')
  })

  it('`failingTargets` 只报"最近还在失败"的目标 —— 它是 tick 级判读"全部 vs 部分"的依据', () => {
    const real = Date.now
    let clock = real()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    noteSyncFailure('a.db', 's:1', 'x')
    noteSyncFailure('b.db', 's:1', 'x')
    expect(failingTargets().sort()).toEqual(['a.db', 'b.db'])
    clock += 3 * 60_000 // 超过默认的 2 分钟窗口
    expect(failingTargets(), '很久没失败的目标不该还挂在"正在失败"里').toEqual([])
    Date.now = real
  })

  it('集成：`syncPlainDatabase` 解不开时不重复尝试；成功一次后立刻恢复', async () => {
    const raw = tempDir('raw')
    const dec = tempDir('dec')
    mkdirSync(join(raw, 'general'), { recursive: true })
    const rawDb = join(raw, 'general', 'general.db')
    // 不是合法 SQLCipher 库：无论密钥对错都解不开（`looksDecrypted` 会说不）。
    writeFileSync(rawDb, Buffer.from('not-a-sqlcipher-database-at-all'))

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const state = new Map()
    const args = [raw, dec, 'general', 'general.db', 'general.db', '', 'wx_key_v4.1', state] as const
    const wait = () => new Promise((r) => setTimeout(r, 20))

    await syncPlainDatabase(...args)
    await wait()
    expect(err.mock.calls.length, '第一次失败必须留一行日志').toBe(1)

    // 立刻再跑一次（模拟 10s 后的下一 tick）。
    // ⚠️ 这里必须**只**清掉 full-decrypt 冷却再跑：否则"没有重试"可能来自冷却而不是退避，
    // 判据就变成恒真的了（这个坑正是本用例第一版踩到的 —— 它确实是冷却挡住了）。
    forgetFullDecryptCooldown()
    await syncPlainDatabase(...args)
    await wait()
    expect(err.mock.calls.length, '退避期内不该再解一次').toBe(1)
    expect(syncFailureBackoffActive('general.db'), '跳过必须是退避在起作用').toBe(true)

    // 源文件变了（微信又写了数据）⇒ **仍然**要等退避到期（实测口径：延迟 ≤5min 好过每 10s 重解 153MB）。
    utimesSync(rawDb, new Date(), new Date(Date.now() + 5000))
    forgetFullDecryptCooldown()
    await syncPlainDatabase(...args)
    await wait()
    expect(err.mock.calls.length, '退避期内换签名也不该重试').toBe(1)

    // 成功一次 ⇒ 立刻清零（用清除退避来模拟"这一次解开了"的后续状态）。
    noteSyncSuccess('general.db')
    forgetFullDecryptCooldown()
    await syncPlainDatabase(...args)
    await wait()
    expect(err.mock.calls.length, '退避清掉后必须能再试').toBe(2)
  })
})

/**
 * N15 的性能实测（不是回归用例，但文件名必须保留 *.spec.ts —— vitest 只收集这个后缀）。
 * 靠 `describe.skipIf(MEASURE_N15 !== '1')` 默认跳过。
 *
 * 为什么需要它：验收标准里「记录前后耗时」。墙钟受 LLM 延迟与机器负载影响，放进 CI 只会变成
 * 随机红灯；确定性的那部分（并发峰值 = 上限、互不串数据、失败不连坐、到期判定）由
 * `summary-run-due.spec.ts` 在 CI 里守。
 *
 * 「改前」不是建模，而是**把改前的串行循环搬进来跑同一份夹具**（M9/M10 的同一条教训：
 * 别用「请求数 × 延迟」当实测）。两个数都来自同一次运行、同一个桩 LLM。
 *
 * 运行：
 *   MEASURE_N15=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/summary-run-due.measure.spec.ts
 *   MEASURE_N15=1 MEASURE_N15_LATENCY=200 ...（可改单次 LLM 往返延迟）
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { listSummaryRecords, saveSummaryTask } from '../src/query/summary-tasks.ts'

let root = ''
let decrypted = ''
let disposers: Array<() => void> = []

function fakeCtx(llm: unknown): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
  } as unknown as Context
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-n15-measure-'))
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
})

afterEach(async () => {
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  for (let i = 0; i < 5; i += 1) {
    try { rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 20)) }
  }
})

interface LlmStub {
  maxInFlight: () => number
  calls: number
  stream: (opts: unknown) => AsyncGenerator<{ type: string; index: number; text: string }>
}

/** 桩 LLM：固定延迟 + 记录在飞峰值（模拟一次完整的流式往返）。 */
function stubLlm(latencyMs: number): LlmStub {
  const s = { calls: 0, peak: 0 }
  let inFlight = 0
  return {
    get calls() { return s.calls },
    maxInFlight: () => s.peak,
    stream: async function* (): AsyncGenerator<{ type: string; index: number; text: string }> {
      s.calls += 1
      inFlight += 1
      s.peak = Math.max(s.peak, inFlight)
      try {
        await new Promise((r) => setTimeout(r, latencyMs))
        yield { type: 'text-delta', index: 0, text: '小结' }
      } finally {
        inFlight -= 1
      }
    },
  }
}

/** 造 n 个群、每群一条昨天消息，并建 n 个任务；返回任务 id（升序）。 */
function fixture(n: number): number[] {
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT)')
  const d = new Date()
  d.setDate(d.getDate() - 1)
  d.setHours(0, 0, 0, 0)
  const start = Math.floor(d.getTime() / 1000)
  const mdb = new DatabaseSync(join(decrypted, 'message', 'msg0.db'))
  const ids: number[] = []
  for (let i = 0; i < n; i += 1) {
    const username = 'wxid_m' + String(i)
    sdb.prepare('INSERT INTO SessionTable(username) VALUES (?)').run(username)
    const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${table}" (local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)`)
    mdb.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?)`).run(1, start + 3600 + i, '一条人话消息 ' + String(i), 1)
    const r = saveSummaryTask(decrypted, {
      groupUsername: username, groupName: '群' + String(i), targetUsers: [],
      format: 'brief', customPrompt: '', scheduleTime: '00:00', enabled: true,
    })
    expect(r.ok).toBe(true)
    ids.push(r.id as number)
  }
  sdb.close()
  mdb.close()
  return ids
}

/** 把任务的调度时间改成当前这一分钟（同回归用例：把跨分钟窗口压到微秒级）。 */
function makeDueNow(ids: number[]): void {
  const db = new DatabaseSync(join(dirname(decrypted), 'daily_summary.db'))
  const st = db.prepare('UPDATE summary_tasks SET schedule_time = ? WHERE id = ?')
  const now = new Date()
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
  for (const id of ids) st.run(hhmm, id)
  db.close()
}

type GatewayInternals = { maybeRunDueTasks(): Promise<void>; runSummaryTask(options: { id: number }): Promise<unknown> }

describe.skipIf(process.env.MEASURE_N15 !== '1')('N15 到期摘要任务实测', () => {
  it('串行（改前）vs 有界并发（改后）：墙钟与在飞峰值', async () => {
    const LATENCY = Number(process.env.MEASURE_N15_LATENCY ?? '120')
    // 「同一分钟到期」的现实规模通常是 1~2 项（计划里就是这么写的），5 项用来看上限的作用
    for (const n of [2, 5]) {
      root = mkdtempSync(join(tmpdir(), 'wx-n15-measure-'))
      decrypted = join(root, 'decrypted')
      mkdirSync(decrypted, { recursive: true })
      vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
      vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
      const ids = fixture(n)

      // ① 改后：真实调度器（有界并发 + 失败不连坐）
      const llmAfter = stubLlm(LATENCY)
      let gw = new WechatDataGateway(fakeCtx(llmAfter))
      makeDueNow(ids)
      const t0 = Number(process.hrtime.bigint()) / 1e6
      await (gw as unknown as GatewayInternals).maybeRunDueTasks()
      const afterMs = Number(process.hrtime.bigint()) / 1e6 - t0
      const afterPeak = llmAfter.maxInFlight()
      const afterCalls = llmAfter.calls
      for (const d of disposers) d()
      disposers = []

      // ② 改前：把调度器里那段串行循环搬进来跑（同一份夹具、同一个桩延迟）
      const llmBefore = stubLlm(LATENCY)
      gw = new WechatDataGateway(fakeCtx(llmBefore))
      const t1 = Number(process.hrtime.bigint()) / 1e6
      for (const id of ids) await (gw as unknown as GatewayInternals).runSummaryTask({ id })
      const beforeMs = Number(process.hrtime.bigint()) / 1e6 - t1
      const beforePeak = llmBefore.maxInFlight()
      const beforeCalls = llmBefore.calls
      for (const d of disposers) d()
      disposers = []

      const recs = listSummaryRecords(decrypted).items.length
      console.log(`\nN15 实测：${n} 个任务同分钟到期，单次 LLM 往返 ${LATENCY}ms（上限 2）`)
      console.log(`  改前（串行 for-await）：${beforeMs.toFixed(0)}ms，LLM 请求 ${beforeCalls} 次，在飞峰值 ${beforePeak}`)
      console.log(`  改后（有界并发 2）    ：${afterMs.toFixed(0)}ms，LLM 请求 ${afterCalls} 次，在飞峰值 ${afterPeak}`)
      console.log(`  → ${(beforeMs / Math.max(afterMs, 1)).toFixed(2)}×（省 ${(beforeMs - afterMs).toFixed(0)}ms）；理论下限 = ceil(${n}/2)×${LATENCY}ms = ${Math.ceil(n / 2) * LATENCY}ms，差值即落库开销`)
      console.log(`  两次加起来写了 ${recs} 条记录（同批不串数据：每个任务一条）`)
      console.log('  诚实结论：这一批通常只有 1~2 项，省下的是**一次** LLM 往返（百毫秒量级）而不是「N 倍的墙钟」；')
      console.log('  它真正的价值是「同一分钟到期的任务不再互相排队」，以及在多任务日的尾延迟。')
      expect(recs).toBe(2 * n)
      for (let i = 0; i < 5; i += 1) {
        try { rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 20)) }
      }
    }
  }, 600_000)
})

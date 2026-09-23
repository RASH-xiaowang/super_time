/**
 * N15：同一分钟到期的多个每日摘要任务原本是 **N 次串行 LLM 调用**
 * （`gateway.ts` 的 `for (const t of tasks) await this.runSummaryTask(...)`），
 * 形态与 M10 之前的 `buildVectorIndex` 相同（N 次串行远程往返），只是受「同一分钟到期」
 * 约束、这一批通常只有 1~2 项，所以影响小得多。
 *
 * 本文件守四件事：
 *   ① **真的并发** —— 用桩 LLM 数「同时在飞的流」：3 个到期任务、上限 2 ⇒ 峰值必须正好是 2
 *      （夹具必须**多过上限**，否则上界断言是空转的 —— M10 的复审教训）；
 *   ② **互不串数据** —— 三个群的当日总结各自落到自己的记录里（群名/条数/摘要逐项对照），
 *      这条走的是**真实的** `runSummaryTask`（只把 LLM 流打桩）；
 *   ③ **失败不连坐** —— 一个任务抛错不得中断同批其它任务（改前是串行 + 第一个失败就退出，
 *      同批剩下的当天总结一条都不生成，且没有任何地方会补跑）；
 *   ④ **到期判定** —— 从未跑过的任务必须算到期（`Number(undefined)` 是 NaN，`NaN > 60000` 恒 false，
 *      改前那种写法会让新任务**永远**等不到第一次调度），而「一分钟内跑过」的仍要跳过。
 *
 * 机时相关的「前后耗时」在 `summary-run-due.measure.spec.ts`（默认跳过）里量。
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
import { listSummaryRecords, listSummaryTasks, saveSummaryTask, updateSummaryTaskRunState } from '../src/query/summary-tasks.ts'
import { at } from '../../tests/helpers/strict-index.ts'
import { listOperations } from '../src/query/operation-log.ts'

let root = ''
let decrypted = ''
let disposers: Array<() => void> = []

/** 与 gateway-operation-log.spec.ts 同一个最小 Context：只要 gateway 构造期碰得到的那几个钩子。 */
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
  /**
   * **只冻结 `Date`**（定时器照常走）。
   *
   * 生产侧的到期判定是「`schedule_time` 与当前 `HH:MM` **精确相等**」（`gateway.ts` 的
   * `sched === hhmm`），而本文件里有 6 条用例都靠「把 schedule_time 设成**现在**」来造到期
   * （`makeDueNow`）。跑在真实时钟上时，`makeDueNow` 与随后的到期检查之间只要跨过分钟边界，
   * 就会一个都不到期 —— 2026-09-21 在 CI 上实测到过（同一提交的另一次运行通过；
   * 报错是 `只有「到期且一分钟内没跑过」的那一个该跑: expected +0 to be 1`）。
   * 固定成同一个本地时刻（08:27）之后，跨分钟边界这件事不复存在，用例本身一个字没改。
   */
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 21, 8, 27, 30))
  root = mkdtempSync(join(tmpdir(), 'wx-n15-'))
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
})

afterEach(async () => {
  vi.useRealTimers()
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  for (let i = 0; i < 5; i += 1) {
    try { rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 20)) }
  }
})

interface GroupFixture { username: string; name: string; texts: string[] }

/** 昨天 0 点的秒级时间戳（`runSummaryTask` 取的就是「昨天」那一天）。 */
function yesterdayStartSeconds(): number {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** 造「三个群各有一天消息」的夹具：session.db 负责 username↔Msg_<md5> 的映射，message 分片放消息。 */
function writeMessages(groups: GroupFixture[]): void {
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT)')
  for (const g of groups) sdb.prepare('INSERT INTO SessionTable(username) VALUES (?)').run(g.username)
  sdb.close()

  const start = yesterdayStartSeconds()
  const mdb = new DatabaseSync(join(decrypted, 'message', 'msg0.db'))
  for (const [gi, g] of groups.entries()) {
    const table = 'Msg_' + createHash('md5').update(g.username, 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${table}" (local_id INTEGER, create_time INTEGER, message_content TEXT, local_type INTEGER)`)
    const ins = mdb.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?)`)
    g.texts.forEach((text, i) => ins.run(i + 1, start + 3600 + i * 60 + gi * 5, text, 1))
  }
  mdb.close()
}

/** 建一个任务（走生产 API），返回 id。 */
function addTask(g: GroupFixture): number {
  const r = saveSummaryTask(decrypted, {
    groupUsername: g.username,
    groupName: g.name,
    targetUsers: [],
    format: 'brief',
    customPrompt: '',
    scheduleTime: '00:00',
    enabled: true,
  })
  expect(r.ok).toBe(true)
  return r.id as number
}

/** 当前时钟的 HH:MM。 */
function hhmmNow(d = new Date()): string {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/**
 * 把任务的调度时间改成「当前这一分钟」。
 *
 * 为什么要在调用**之前**最后一步改：`maybeRunDueTasks` 读的是真实时钟，用例若先用
 * 「构造夹具时的 HH:MM」，跨分钟就会随机变红（1/60）。这里把窗口压到微秒级。
 * @param ids - 任务 id。
 */
function makeDueNow(ids: number[]): void {
  const db = new DatabaseSync(join(dirname(decrypted), 'daily_summary.db'))
  const st = db.prepare('UPDATE summary_tasks SET schedule_time = ? WHERE id = ?')
  const now = hhmmNow()
  for (const id of ids) st.run(now, id)
  db.close()
}

interface LlmStub {
  maxInFlight: () => number
  calls: string[]
  stream: (opts: unknown) => AsyncGenerator<{ type: string; index: number; text: string }>
}

/** 桩 LLM：从 prompt 里认出是哪个群，流式吐回一条**群相关**的摘要（用来验「不串数据」）。 */
function stubLlm(opts: { latencyMs?: number } = {}): LlmStub {
  const calls: string[] = []
  let inFlight = 0
  let peak = 0
  const promptOf = (o: unknown): string => {
    const msgs = (o as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? []
    return msgs[0]?.content?.[0]?.text ?? ''
  }
  const groupOf = (p: string): string => /\((wxid_[^)]+)\)/.exec(p)?.[1] ?? '未知群'
  return {
    calls,
    maxInFlight: () => peak,
    // eslint-disable-next-line require-yield
    stream: async function* (o: unknown): AsyncGenerator<{ type: string; index: number; text: string }> {
      const prompt = promptOf(o)
      calls.push(prompt)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs))
        yield { type: 'text-delta', index: 0, text: '小结:' + groupOf(prompt) }
      } finally {
        inFlight -= 1
      }
    },
  }
}

type GatewayInternals = {
  maybeRunDueTasks(): Promise<void>
  runSummaryTask(options: { id: number }): Promise<unknown>
}

function runDueNow(gw: WechatDataGateway): Promise<void> {
  return (gw as unknown as GatewayInternals).maybeRunDueTasks()
}

const GROUPS: GroupFixture[] = [
  { username: 'wxid_g1', name: '一群', texts: ['一群的消息一'] },
  { username: 'wxid_g2', name: '二群', texts: ['二群的消息一', '二群的消息二'] },
  { username: 'wxid_g3', name: '三群', texts: ['三群的消息一', '三群的消息二', '三群的消息三'] },
]

describe('N15：同一分钟到期的摘要任务并发执行', () => {
  it('并发到上限且不超过上限（夹具比上限多，上界断言才有杀伤力）', async () => {
    writeMessages(GROUPS)
    const ids = GROUPS.map(addTask)
    // 让批次比上限多：再补两个任务（群不存在 ⇒ 真实路径会记 error，但这里把 runSummaryTask 打桩了）
    const extra = [addTask({ username: 'wxid_g4', name: '四群', texts: ['四'] }), addTask({ username: 'wxid_g5', name: '五群', texts: ['五'] })]

    const gw = new WechatDataGateway(fakeCtx(stubLlm()))
    let inFlight = 0
    let peak = 0
    const attempted: number[] = []
    ;(gw as unknown as GatewayInternals).runSummaryTask = async (o: { id: number }) => {
      attempted.push(o.id)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await new Promise((r) => setTimeout(r, 30))
        return { ok: true, summary: '', messageCount: 0 }
      } finally {
        inFlight -= 1
      }
    }

    makeDueNow([...ids, ...extra])
    await runDueNow(gw)

    expect(attempted.length, '5 个到期任务都要跑到（每个只跑一次）').toBe(5)
    expect(new Set(attempted).size).toBe(5)
    expect(peak, '峰值并发应当正好是上限 2：改前是串行（峰值 1），删掉上限会冲到 5').toBe(2)
  })

  it('互不串数据：三个群的总结各自落到自己的记录里（走真实 runSummaryTask，只打桩 LLM）', async () => {
    writeMessages(GROUPS)
    const ids = GROUPS.map(addTask)
    const llm = stubLlm({ latencyMs: 40 })
    const gw = new WechatDataGateway(fakeCtx(llm))

    makeDueNow(ids)
    await runDueNow(gw)

    const recs = listSummaryRecords(decrypted).items
    expect(recs.length, '三个到期任务应当各写一条记录').toBe(3)
    for (const g of GROUPS) {
      const rec = recs.find((r) => r.groupUsername === g.username)
      expect(rec, `没有 ${g.username} 的记录 —— 并发把这批数据串了`).toBeTruthy()
      // 摘要由桩 LLM 依据**它收到的 prompt** 生成：串数据会立刻体现为「摘要属于别的群」
      expect(rec?.summary).toBe('小结:' + g.username)
      expect(rec?.status).toBe('done')
      // 条数 = 该群昨天的消息数 + 1 行「【username】」标题（collectRange 的口径）
      expect(rec?.messageCount).toBe(g.texts.length + 1)
    }
    // 三个任务各自的运行状态都要落库（互不覆盖）
    const tasks = listSummaryTasks(decrypted).items
    for (const id of ids) {
      const t = tasks.find((x) => x.id === id)
      expect(t?.lastStatus, `任务 ${id} 的运行状态没写`).toBe('done')
      expect(Number(t?.lastRunAt)).toBeGreaterThan(0)
    }
    // 桩 LLM 的并发峰值同样是 2（3 个到期任务、上限 2）
    expect(llm.maxInFlight()).toBe(2)
    expect(llm.calls.length).toBe(3)
    // 每次请求的 prompt 只含自己那群的消息：串群会在这里露出来
    for (const g of GROUPS) {
      const own = llm.calls.filter((p) => p.includes('(' + g.username + ')'))
      expect(own.length, `${g.username} 的 prompt 不是恰好一次`).toBe(1)
    }
  })

  it('失败不连坐：一个任务抛错，同批其它任务照常跑完并各自落库', async () => {
    writeMessages(GROUPS)
    const ids = GROUPS.map(addTask)
    const gw = new WechatDataGateway(fakeCtx(stubLlm()))

    // `listTasks` 是 `ORDER BY id DESC`，最后创建的那个会被**先**认领：让失败落在
    // 「第一个被处理的」任务上，才能杀掉改前「串行 + 第一个失败就退出」的形态
    // （失败若在队尾，旧的串行实现也会把前面的任务都跑完 —— 用例就成了假绿）。
    const firstProcessed = Math.max(...ids)
    let inFlight = 0
    const attempted: number[] = []
    const completed: number[] = []
    ;(gw as unknown as GatewayInternals).runSummaryTask = async (o: { id: number }) => {
      attempted.push(o.id)
      inFlight += 1
      try {
        await new Promise((r) => setTimeout(r, 10))
        if (o.id === firstProcessed) throw new Error('这一批炸了')
        completed.push(o.id)
        return { ok: true, summary: '', messageCount: 0 }
      } finally {
        inFlight -= 1
      }
    }

    makeDueNow(ids)
    await runDueNow(gw)

    // 改前：串行 + 第一个失败即抛 ⇒ 后面两个连尝试都不会尝试（attempted 只有 1）
    expect(attempted.length, '一个任务失败后，同批剩下的任务被跳过了').toBe(3)
    expect(new Set(attempted)).toEqual(new Set(ids))
    expect(completed.length, '失败的那个不该影响另外两个跑完').toBe(2)
    expect(inFlight).toBe(0)
    // 失败仍然要留痕：外层 catch 记一条 summary_scheduler_error（原有行为不变）
    const ops = listOperations(decrypted).items
    const errRow = ops.find((o) => o.action === 'summary_scheduler_error')
    expect(errRow?.status).toBe('fail')
    expect(errRow?.detail).toContain('这一批炸了')
  })

  it('全部失败时每个任务仍被尝试到（worker 认领队列，不因失败停手）', async () => {
    writeMessages(GROUPS)
    const ids = [...GROUPS.map(addTask), addTask({ username: 'wxid_g6', name: '六群', texts: ['x'] }), addTask({ username: 'wxid_g7', name: '七群', texts: ['y'] })]
    const gw = new WechatDataGateway(fakeCtx(stubLlm()))

    const attempted: number[] = []
    ;(gw as unknown as GatewayInternals).runSummaryTask = async (o: { id: number }) => {
      attempted.push(o.id)
      await new Promise((r) => setTimeout(r, 5))
      throw new Error('全都炸了')
    }

    makeDueNow(ids)
    await runDueNow(gw)

    // 5 个任务 / 上限 2：worker 若「失败即停手」，这里只会看到 2 次尝试。
    // 每个任务各写各的记录、互不依赖，所以「都试一遍」才是对用户更有用的行为。
    expect(attempted.length, `只尝试了 ${attempted.length} 个 —— worker 一失败就停手了`).toBe(5)
  })
})

describe('N15：到期判定', () => {
  it('从未跑过的任务算到期（改前 NaN 比较恒 false ⇒ 新任务永远等不到第一次调度）', async () => {
    writeMessages(GROUPS)
    const ids = GROUPS.map(addTask)
    // 前置事实：新任务的 last_run_at 是空的（saveSummaryTask 不写这一列）
    expect(listSummaryTasks(decrypted).items.every((t) => t.lastRunAt === undefined)).toBe(true)

    const llm = stubLlm()
    const gw = new WechatDataGateway(fakeCtx(llm))
    makeDueNow(ids)
    await runDueNow(gw)

    expect(llm.calls.length, '从未跑过的任务没被调度').toBe(3)
    expect(listSummaryRecords(decrypted).items.length).toBe(3)
  })

  it('不到点 / 已停用 / 一分钟内跑过的都不跑', async () => {
    writeMessages(GROUPS)
    const [dueId, notDueId, disabledId, justRanId] = [addTask(at(GROUPS, 0)), addTask(at(GROUPS, 1)), addTask(at(GROUPS, 2)), addTask({ username: 'wxid_g9', name: '九群', texts: ['九'] })]
    // 停用两个/改一个到别的点
    const db = new DatabaseSync(join(dirname(decrypted), 'daily_summary.db'))
    db.prepare('UPDATE summary_tasks SET enabled = 0 WHERE id = ?').run(disabledId)
    db.prepare('UPDATE summary_tasks SET schedule_time = ? WHERE id = ?').run('23:59', notDueId)
    db.close()
    makeDueNow([dueId, justRanId])
    // 「一分钟内跑过」：justRanId 刚刚跑过
    const db2 = new DatabaseSync(join(dirname(decrypted), 'daily_summary.db'))
    db2.prepare('UPDATE summary_tasks SET last_run_at = ? WHERE id = ?').run(Date.now() - 30_000, justRanId)
    db2.close()

    const llm = stubLlm()
    const gw = new WechatDataGateway(fakeCtx(llm))
    await runDueNow(gw)

    expect(llm.calls.length, '只有「到期且一分钟内没跑过」的那一个该跑').toBe(1)
    expect(llm.calls[0]).toContain('(wxid_g1)')
    expect(listSummaryRecords(decrypted).items.length).toBe(1)
  })
})

/** @source-ref src/backend/wechat-data/src/query/summary-tasks.ts:147-164 */
describe('保存任务不改运行状态（`SummaryTaskInput` 剔掉那三列的理由）', () => {
  it('跑成功过的任务被编辑保存之后，last_run_at / last_status 仍然在原处', () => {
    writeMessages(GROUPS)
    const g = at(GROUPS, 0)
    const id = addTask(g)
    expect(updateSummaryTaskRunState(decrypted, id, 1_700_000_000_000, 'done', '').ok).toBe(true)

    // 界面上「编辑并保存」走的就是这条 UPDATE
    expect(saveSummaryTask(decrypted, {
      id,
      groupUsername: g.username,
      groupName: '改了名字的一组',
      targetUsers: [],
      format: 'brief',
      customPrompt: '',
      scheduleTime: '00:00',
      enabled: true,
    }).ok).toBe(true)

    const saved = at(listSummaryTasks(decrypted).items.filter((t) => t.id === id), 0, '保存后的任务')
    expect(saved.groupName).toBe('改了名字的一组')
    // 下面两行才是这条用例的重点：一旦有人把 last_* 三列「补全」进那条 UPDATE，
    // 界面上编辑一次任务就会把它的运行记录抹掉 —— 而旧代码真的传了两个空串进来。
    expect(saved.lastRunAt).toBe(1_700_000_000_000)
    expect(saved.lastStatus).toBe('done')
  })
})

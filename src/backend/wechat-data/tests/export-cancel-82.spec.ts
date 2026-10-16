// @vitest-environment node
/**
 * W2-8.2：`exportCsv` / `exportAnnualReport` 补取消与进度（gateway 接线验收）。
 *
 * ## 为什么要单独一层
 *
 * 与 M3 那份（`gateway-export-stream-progress.spec.ts`）同一形状：`export-stream.spec.ts`
 * 覆盖的是 query 层的 `onProgress`/`signal` 语义，而「界面能不能拿到进度、能不能取消」
 * 取决于 gateway —— 两者之间的接线（jobId → 本地 onProgress + AbortController）断了的话，
 * query 层用例全绿而功能为零。
 *
 * ## 这两条入口原先是什么样
 *
 * `exportAllSessions` / `exportMoments` / `exportSessionMessages` 早就有 jobId；
 * 这两条没有。而它们**恰好是最该有的两条**：
 *   · `exportAnnualReport` —— 实测整段 4048ms（`annual-report.ts` 里那句注释），
 *     全部导出入口里最长的一个，用户点完之后既看不到进度也停不下来；
 *   · `exportCsv` 的 contacts/favorites/records 三种 —— 几万行起步，逐行拼表就是全部耗时。
 *
 * ## 三条不许退化的纪律
 *
 * ① 取消是 `AbortError`，不是普通失败（界面据此不弹错误框）。
 * ② 取消后**一个文件都不许留**。
 * ③ 不带 jobId 的老调用方行为不变（没有事件、照常成功）—— 这是既有约定，别顺手改掉。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
/** 后端 `wechat-export/progress` 事件的最小形状（M3 那份 spec 同款，本地声明以免多引一个模块）。 */
interface ProgressEvent {
  jobId: string
  phase: string
  done: number
  total: number
}

let root = ''
let decrypted = ''
let outDir = ''

/** 造一个能导出年报 / CSV 的最小数据根。 */
function makeRoot(): void {
  root = mkdtempSync(join(tmpdir(), 'wx-82-'))
  decrypted = join(root, 'decrypted')
  outDir = join(root, 'out')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  const msgDir = join(decrypted, 'message')
  mkdirSync(msgDir, { recursive: true })
  // ⚠ 年报那条扫描只访问「表名 == `Msg_<md5(username)>` 且 username 在联系人名单里」的表
  //   （`computeAnnualReport` 先 `loadUsernames` 再建 `tableToUser`）。
  //   随手起个 `Msg_t` ⇒ 它压根不会被扫到，于是 count=0、进度事件 0 个 —— 第一版就栽在这。
  const ALPHA = 'wxid_alpha000'
  const table = 'Msg_' + createHash('md5').update(ALPHA, 'utf8').digest('hex')
  const db = new DatabaseSync(join(msgDir, 'msg_1.db'))
  db.exec('CREATE TABLE "' + table + '" (local_id INTEGER, local_type INTEGER, create_time INTEGER, message_content BLOB)')
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO "' + table + '" (local_id, local_type, create_time, message_content) VALUES (?, ?, ?, ?)')
  // ⚠ 行数要过 `YIELD_EVERY_ROWS`（2000）：年报的进度/取消检查点就挂在**让出点**上，
  //   那是「这一大坨 CPU 重活」的天然边界。行数不够就永远到不了检查点 ——
  //   第一版写这条用例时正是这样：400 行 ⇒ 零事件、零取消。
  // ⚠ 正文别用 `<![CDATA[…]]>`：`stripXml` 的 `<[^>]*>` 会一路吃到 `]]>` 的 `>`，
  //   整段正文被当成标签删掉 ⇒ 扫出来 0 条。
  for (let i = 0; i < 2600; i += 1) {
    ins.run(i, 1, 1704067200 + i, Buffer.from('<msg><content>今年去了杭州 天气不错</content></msg>', 'utf8'))
  }
  db.exec('COMMIT')
  db.close()
  // 联系人库（`loadUsernames` 的来源）
  const cdb = join(decrypted, 'contact', 'contact.db')
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  const c = new DatabaseSync(cdb)
  c.exec('CREATE TABLE contact (rowid INTEGER PRIMARY KEY, username TEXT, type INTEGER, remark TEXT, nickname TEXT, pyinitial TEXT, quanpin TEXT, alias TEXT, domain_list TEXT, con_type INTEGER)')
  c.exec('BEGIN')
  const ci = c.prepare('INSERT INTO contact (rowid, username, type, remark, nickname, pyinitial, quanpin, alias, domain_list, con_type) VALUES (?,?,?,?,?,?,?,?,?,?)')
  ci.run(1, ALPHA, 3, '', '甲', 'J', 'jia', '', '', 0)
  for (let i = 0; i < 200; i += 1) ci.run(i + 2, 'wxid_c' + String(i).padStart(4, '0'), 3, '', '好友' + i, 'H', 'haoyou' + i, '', '', 0)
  c.exec('COMMIT')
  c.close()
  // ⚠ 年报的会话名单来自 **session.db 的 SessionTable**，不是 contact 库
  //   （`loadUsernames`）。只建 contact 库时它返回空数组 ⇒ 一张表都不扫 ⇒ 又一次 0 条。
  const sdb = join(decrypted, 'session', 'session.db')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  const s = new DatabaseSync(sdb)
  s.exec('CREATE TABLE SessionTable (username TEXT, type INTEGER, content TEXT)')
  s.prepare('INSERT INTO SessionTable (username, type, content) VALUES (?, ?, ?)').run(ALPHA, 1, '')
  s.close()
}

function fakeCtx(onEvent?: (event: string, payload: ProgressEvent) => void): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => fn(),
    emit: (event: string, payload: unknown) => { onEvent?.(event, payload as ProgressEvent) },
    llm: { stream: async function* () { /* 不测生成 */ }, embed: async (t: string[]) => t.map(() => new Array(8).fill(0.1)) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
  } as unknown as Context
}

/**
 * ⚠ 必须 stub 数据根：网关的 `rc.dirs()` 读 `DSH_WECHAT_DECRYPTED_DIR` 环境变量，
 * 不 stub 就去读真实默认路径 —— 于是「扫到 0 条、0 个进度事件」，
 * 用例看上去像是功能没实现，其实是自己没把夹具接上（M3 那份 spec 同款做法）。
 */
function gateway(onEvent?: (event: string, payload: ProgressEvent) => void): InstanceType<typeof WechatDataGateway> {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  return new WechatDataGateway(fakeCtx(onEvent))
}

beforeEach(() => { makeRoot() })
afterEach(() => {
  vi.unstubAllEnvs()
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 下一条用例自己会报 */ }
})

describe('W2-8.2 年报：进度推得出去、取消真的停得住', () => {
  it('jobId 让进度事件推得出去（collect 阶段先报一次）', async () => {
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })
    const r = await gw.exportAnnualReport({ year: 2024, format: 'md', dir: outDir, filename: 'a.md', jobId: 'j-a' })
    expect(r.count).toBeGreaterThan(0)
    expect(events.length, '年报一个进度事件都没推 ⇒ 界面进度条不会动').toBeGreaterThan(0)
    expect(events.every(e => e.jobId === 'j-a')).toBe(true)
    expect(events.some(e => e.phase === 'collect'), '缺 collect 阶段').toBe(true)
    expect(events.some(e => e.phase === 'write' && e.done === 1), '写盘阶段没有收尾事件').toBe(true)
  })

  it('取消 ⇒ AbortError + 一个文件都不留', async () => {
    const events: ProgressEvent[] = []
    let gw: InstanceType<typeof WechatDataGateway>
    let cancelled = false
    gw = gateway((event, payload) => {
      if (event !== 'wechat-export/progress') return
      events.push(payload)
      // 第一个事件到达就取消：取消必须从 RPC 入口真的贯通到 query 层扫描里的检查点。
      if (!cancelled) {
        cancelled = true
        expect(gw.cancelExportJob({ jobId: payload.jobId }).ok).toBe(true)
      }
    })
    const err = await gw.exportAnnualReport({ year: 2024, format: 'md', dir: outDir, filename: 'b.md', jobId: 'j-b' }).catch((e: unknown) => e)
    expect(cancelled, '年报没推进度 ⇒ 取消用例失去意义').toBe(true)
    expect((err as Error).name, '取消必须是 AbortError（界面据此不弹错误框）').toBe('AbortError')
    expect(existsSync(join(outDir, 'b.md')), '取消后留下了半成品').toBe(false)
    const st = gw.getExportProgress({ jobId: 'j-b' })
    expect(st.found).toBe(true)
    expect(st.finished).toBe(true)
  })

  it('不带 jobId 的老调用方行为不变：没有事件、照常产出文件', async () => {
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })
    const r = await gw.exportAnnualReport({ year: 2024, format: 'md', dir: outDir, filename: 'c.md' })
    expect(r.count).toBeGreaterThan(0)
    expect(existsSync(join(outDir, 'c.md'))).toBe(true)
    expect(events, '不带 jobId 也推事件 ⇒ 老调用方会被无关事件打扰').toEqual([])
  })
})

describe('W2-8.2 CSV：进度推得出去、取消真的停得住', () => {
  it('jobId 让进度事件推得出去（collect → write 两段都有）', async () => {
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })
    const r = await gw.exportCsv({ kind: 'contacts', dest: join(outDir, 'contacts.csv'), jobId: 'j-c' })
    expect(r.count).toBeGreaterThan(0)
    expect(events.length, 'CSV 一个进度事件都没推').toBeGreaterThan(0)
    expect(events.every(e => e.jobId === 'j-c')).toBe(true)
    expect(events.some(e => e.phase === 'collect' && e.done === r.count && e.total === r.count),
      'collect 阶段没有「行数 = 总行数」的收尾事件 ⇒ 进度条永远到不了 100%').toBe(true)
    expect(events.some(e => e.phase === 'write' && e.done === 1)).toBe(true)
  })

  it('取消 ⇒ AbortError + 没有 .csv', async () => {
    const events: ProgressEvent[] = []
    let gw: InstanceType<typeof WechatDataGateway>
    let cancelled = false
    gw = gateway((event, payload) => {
      if (event !== 'wechat-export/progress') return
      events.push(payload)
      if (!cancelled) {
        cancelled = true
        expect(gw.cancelExportJob({ jobId: payload.jobId }).ok).toBe(true)
      }
    })
    const err = await gw.exportCsv({ kind: 'contacts', dest: join(outDir, 'contacts.csv'), jobId: 'j-d' }).catch((e: unknown) => e)
    expect(cancelled, 'CSV 没推进度 ⇒ 取消用例失去意义').toBe(true)
    expect((err as Error).name).toBe('AbortError')
    expect(existsSync(join(outDir, 'contacts.csv')), '取消后留下了半张 CSV').toBe(false)
    expect(readdirSync(outDir).filter(f => f.endsWith('.csv')).length).toBe(0)
  })

  it('不带 jobId 的老调用方行为不变', async () => {
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })
    const r = await gw.exportCsv({ kind: 'contacts', dest: join(outDir, 'plain.csv') })
    expect(r.count).toBeGreaterThan(0)
    expect(existsSync(join(outDir, 'plain.csv'))).toBe(true)
    expect(events).toEqual([])
  })
})

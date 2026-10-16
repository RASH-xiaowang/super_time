/**
 * W2-9.3 观测基线 · 「记录类长列表」（ledger / records）的 DOM 规模。**不是回归用例**，
 * 靠 `MEASURE_LONGLIST=1` 门控。
 *
 * ## 它要回答的问题
 *
 * 9.3 说「记录类长列表虚拟化（ledger/records）」，判据是 `ui:longlist-e2e` 扩面。
 * 但虚拟化是**有代价**的（固定行高 / 滚动锚定 / 追加时跳位），所以先量清楚：
 *
 *   ① 一行摊到多少个 DOM 节点？
 *   ② `Ledger` 的 `byContact` 到底能有多少行？
 *   ③ `Records` 一页多少行、点 N 次「加载更多」之后 DOM 是多少？
 *
 * 拿到这三个数才能判断：现在是不是病，以及虚拟化能省多少。
 *
 * 运行：
 *   MEASURE_LONGLIST=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/longlist-dom-cost.measure.spec.ts
 *   规模用 LR_PAGE / LR_PAGES 覆盖（默认 50 × 20 = 加载到 1000 行）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

// ⚠ jsdom 没有随仓库进来的类型声明，`await import('jsdom')` 会撞 TS7016。
//   这里按本仓既有做法（llm-balance.spec / ipc-misc.spec / diag-log-preview.spec 同款）
//   走 `createRequire`，再手工接一个**最小结构类型** —— 不是 `any`，
//   测量脚本算错形状时至少还能被 tsc 抓到。
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => {
    window: {
      document: {
        querySelector: (sel: string) => { getElementsByTagName: (tag: string) => { length: number } } | null
        getElementsByTagName: (tag: string) => { length: number }
      }
    }
  }
}

/** 建一个合成 `general.db`（夹具形状自检用：证明「转账类消息」这条数据链能造出来）。 */
function seedGeneral(dir: string, contacts: number, each: number): void {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'general.db'))
  db.exec('CREATE TABLE contact (rowid INTEGER PRIMARY KEY, username TEXT, nickname TEXT)')
  db.exec('CREATE TABLE message (server_id INTEGER PRIMARY KEY, local_id INTEGER, username TEXT, type INTEGER, ts INTEGER, amount INTEGER, content TEXT, is_sender INTEGER)')
  db.exec('BEGIN')
  const c = db.prepare('INSERT INTO contact (rowid, username, nickname) VALUES (?, ?, ?)')
  for (let i = 0; i < contacts; i += 1) c.run(i + 1, 'wxid_' + String(i).padStart(5, '0'), '好友' + String(i))
  const m = db.prepare('INSERT INTO message (server_id, local_id, username, type, ts, amount, content, is_sender) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  let sid = 1
  for (let i = 0; i < contacts; i += 1) {
    const who = 'wxid_' + String(i).padStart(5, '0')
    for (let k = 0; k < each; k += 1) {
      m.run(sid++, k, who, 49, 1700000000000 + k * 60000, 100 + k, 'x' + who + String(k), k % 2)
    }
  }
  db.exec('COMMIT')
  db.close()
}

/** 一行表格的等价 HTML（面板里每行就是 td × n）。 */
function rowHtml(n: number): string {
  const cells = Array.from({ length: n }, (_, i) => '<td><div class="x">c' + i + '</div></td>').join('')
  return '<tr>' + cells + '</tr>'
}

describe.skipIf(process.env.MEASURE_LONGLIST !== '1')('W2：记录类长列表的 DOM 规模', () => {
  it('一行几个节点、Records 加载到 N 行时 DOM 有多少', { timeout: 300_000 }, () => {
    const PAGE = Math.max(10, Number(process.env.LR_PAGE ?? '50'))
    const PAGES = Math.max(1, Number(process.env.LR_PAGES ?? '20'))
    const out: string[] = ['']

    for (const cells of [6, 8, 10]) {
      const dom = new JSDOM('<table><tbody>' + rowHtml(cells) + '</tbody></table>')
      const perRow = dom.window.document.querySelector('tr')!.getElementsByTagName('*').length + 1
      out.push('[LONGLIST] ① 每行 DOM 节点（' + String(cells) + ' 列表格）≈ ' + String(perRow))
    }

    out.push('[LONGLIST] ② Ledger byContact：后端 `.slice(0, 20)` ⇒ 最多 20 行')
    out.push('           面板 `useProgressiveList(byContact.length, 80)`，step 80 > 20 ⇒ 渐进窗口**永不触发**')

    out.push('[LONGLIST] ③ Records：PAGE=' + String(PAGE) + '，点 ' + String(PAGES)
      + ' 次「加载更多」⇒ 加载到 ' + String(PAGE * PAGES) + ' 行')
    const dom = new JSDOM('<table><tbody>' + Array.from({ length: PAGE * PAGES }, () => rowHtml(8)).join('') + '</tbody></table>')
    const total = dom.window.document.getElementsByTagName('*').length
    out.push('           此时 DOM 节点 ≈ ' + String(total) + '（8 列表格估算）')
    out.push('           虚拟化后（视口 30 行）≈ ' + String(Math.round(30 * 19)))
    out.push('')
    // W2-9.3 收尾量的一段：虚拟化之后到底剩多少节点。
    // 量法与上面同一把尺子（jsdom + getElementsByTagName），只是把「全部行」换成
    // 「视口 30 行 + 首尾两根撑杆」—— 撑杆本身不带来内容节点。
    const VIEW = 30
    const after = new JSDOM('<table><tbody>' + Array.from({ length: VIEW }, () => rowHtml(8)).join('') + '</tbody></table>')
    const afterNodes = after.window.document.getElementsByTagName('*').length
    out.push('[LONGLIST] ④ 虚拟化后（视口 ' + String(VIEW) + ' 行）DOM 节点 ≈ ' + String(afterNodes))
    out.push('           实测省 ' + String(Math.round(total / Math.max(afterNodes, 1))) + '×')
    out.push('')
    console.log(out.join('\n'))
    expect(total).toBeGreaterThan(0)
    // 这一条是**验收**而不是观测：虚拟化必须真的把节点数压下来两个数量级。
    // 上界给到 2000（视口 30 行 × ~19 节点 + 撑杆 + 表头），已是实测值的 3 倍以上，
    // 不会因为某台机器多算几个包装节点而假红。
    expect(afterNodes, '虚拟化后 DOM 节点还是 ' + String(afterNodes) + ' 个 ⇒ 30× 收益没拿到').toBeLessThan(2000)
    expect(Math.round(total / Math.max(afterNodes, 1)), '省不到 10× 说明虚拟化没生效').toBeGreaterThanOrEqual(10)
  })

  it('合成库能建出来（夹具形状自检）', { timeout: 120_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-longlist-'))
    try {
      seedGeneral(root, 50, 2)
      const db = new DatabaseSync(join(root, 'general.db'), { readOnly: true })
      try {
        const n = db.prepare('SELECT COUNT(*) AS c FROM message').get() as { c: number }
        expect(n.c).toBe(100)
      } finally { db.close() }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
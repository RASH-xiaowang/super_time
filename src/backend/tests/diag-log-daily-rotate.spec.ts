// @vitest-environment node
/**
 * W3-1.4：诊断日志的**双触轮转**（按大小 + 按天）。
 *
 * ## 为什么「按天」不是锦上添花
 *
 * 大小触发只保证「文件不超上界」。它有一个真实的盲区：一份写得很少的 `app.log`
 * 会**一直贴着新事件写**——排查「今天出了什么事」时，得在同一份文件里翻过多天的记录；
 * 而按大小转出去的那份又往往还没写满。跨天换一份，「今天」才自成一篇。
 *
 * ## 判据怎么量（不打瞌睡）
 *
 * 时钟是**注入**的（`createDiagLog({ now })`），所以「过了一天」不需要真的等一天：
 * 同一个 `maxBytes` 给得很大（大小触发永远不命中），只让 `now()` 往后跳一天，
 * 再写一行 ⇒ 必须发生轮转。四条断言分别钉：
 *   ① 跨天写 ⇒ 真的轮转（新的一份从当天开始，旧的被推到 app.1.log）；
 *   ② 同一天继续写 ⇒ **不**轮转（否则一天能转出几十份，反而更难查）；
 *   ③ 轮转后旧内容仍在 app.1.log 里（轮转是搬家，不是丢弃）；
 *   ④ 空文件不轮转（新一天的第一行本该写进空文件，白转一份只有时间戳的没意义）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { createDiagLog } = require('../diag-log.js')

const scratch: string[] = []
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), 'diag-day-'))
  scratch.push(d)
  return d
}
afterEach(() => {
  for (const d of scratch.splice(0, scratch.length)) rmSync(d, { recursive: true, force: true })
})

/** 一个可拨的时钟：从 2026-10-10 00:00 开始，`advanceDays(n)` 跳到 n 天后。 */
function clock(): { now: () => Date; advanceDays: (n: number) => void } {
  const base = Date.parse('2026-10-10T00:00:00Z')
  let off = 0
  return {
    now: () => new Date(base + off),
    advanceDays: (n: number) => { off += n * 86_400_000 },
  }
}

describe('W3-1.4：按天轮转', () => {
  it('跨天写第一行 ⇒ 发生轮转，且旧内容被推到 app.1.log（搬家不是丢弃）', () => {
    const dir = mk()
    const clk = clock()
    // maxBytes 给得很大：确保触发轮转的**不是**大小。
    const log = createDiagLog({ dir, maxBytes: 10 * 1024 * 1024, maxFiles: 3, now: clk.now })
    log.write('info', ['day-1 的一行'])
    expect(readFileSync(log.path, 'utf8')).toContain('day-1 的一行')

    clk.advanceDays(1)
    log.write('info', ['day-2 的一行'])

    const cur = readFileSync(log.path, 'utf8')
    expect(cur, '新的一份必须从当天开始（不许新旧混在同一份里）').not.toContain('day-1 的一行')
    expect(cur).toContain('day-2 的一行')
    const first = readFileSync(log.files()[1], 'utf8')
    expect(first, '轮转必须是搬家：旧内容还得在 app.1.log 里').toContain('day-1 的一行')
  })

  it('同一天继续写 ⇒ 不轮转（否则一天能转出几十份）', () => {
    const dir = mk()
    const clk = clock()
    const log = createDiagLog({ dir, maxBytes: 10 * 1024 * 1024, maxFiles: 3, now: clk.now })
    for (let i = 0; i < 20; i += 1) log.write('info', ['同一天第 ' + String(i) + ' 行'])
    // 还停在第 0 份：20 行全在同一份里，一份都没转出去。
    expect(existsSync(log.files()[1]!), '同一天不该有转出去的份').toBe(false)
    expect(readFileSync(log.path, 'utf8')).toContain('同一天第 19 行')
  })

  it('空文件不轮转（新一天的第一行本该写进空文件）', () => {
    const dir = mk()
    const clk = clock()
    const log = createDiagLog({ dir, maxBytes: 10 * 1024 * 1024, maxFiles: 3, now: clk.now })
    // 从来没写过 ⇒ app.log 不存在。直接拨到第二天再写第一行。
    clk.advanceDays(1)
    log.write('info', ['新一天的第一行'])
    expect(readFileSync(log.path, 'utf8')).toContain('新一天的第一行')
    expect(existsSync(log.files()[1]!),
      '空文件不该被推成一份只有时间戳的 app.1.log').toBe(false)
  })

  it('按大小仍然优先（既超大小又跨天时只转一次）', () => {
    const dir = mk()
    const clk = clock()
    // 阈值故意给得极小：第一行就会超。
    const log = createDiagLog({ dir, maxBytes: 20, maxFiles: 3, now: clk.now })
    log.write('info', ['第一行'])
    clk.advanceDays(1)
    log.write('info', ['第二行'])
    clk.advanceDays(1)
    log.write('info', ['第三行'])
    // 三次写、三次轮转 ⇒ 三份各一行，且都不含别的行的内容。
    const [c0, c1, c2] = log.files().map((f: string) => readFileSync(f, 'utf8'))
    expect(c0).toContain('第三行')
    expect(c1).toContain('第二行')
    expect(c2).toContain('第一行')
  })
})
/**
 * `tests/helpers/ci-board-history.ts` 的应用例 —— 喂真日志形状，不靠「真去拉一次 CI」才知道解析对不对。
 *
 * 两份榜的 fixture 是 2026-09-24 同一次提交（#98 的 `d5d1808`）两次运行的真实读数：
 * 第一次榜首 `overview.spec.ts` 104.5 秒（越线，且那一轮真的出现了假红），
 * 第二次榜首 `search-cursor.spec.ts` 20.8 秒（没有假红）。这正是「一张绿榜不构成验收」的证据本体。
 *
 * @module tests/ci-board-history
 */
import { describe, expect, it } from 'vitest'

import {
  LINE_MS,
  formatHistory,
  parseRunLog,
  stripLogNoise,
  worstOf,
  type RunBoard,
} from './helpers/ci-board-history.ts'
import { at } from './helpers/strict-index.ts'

const TS = '2026-09-24T00:22:44.7278251Z '

/** 第一次运行（真红的那次）：越线的榜首 + 假红症状行。 */
const LOG_RED = [
  TS + 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
  TS + ' Test Files  221 passed | 10 skipped (231)',
  TS + '     Errors  1 error',
  TS + '\x1b[32m[耗时榜]\x1b[39m 231 个测试文件，最慢的前 10 名：',
  TS + '  1.  104.5s   ⚠ 已越过 60 秒线（历史上每次假红都有一个这样的文件）  src/backend/wechat-data/tests/overview.spec.ts',
  TS + '  2.   45.4s   距线 1.32×  src/backend/wechat-data/tests/operation-log.spec.ts',
].join('\n')

/** 同一提交的重跑：榜首换人，且没有假红。 */
const LOG_CLEAN = [
  TS + '[耗时榜] 231 个测试文件，最慢的前 10 名：',
  '  1.   20.8s   距线 2.88×  src/backend/wechat-data/tests/search-cursor.spec.ts',
  '  2.   11.8s   距线 5.08×  src/backend/wechat-data/tests/kb-vector-index.spec.ts',
].join('\n')

const b = (label: string, topMs: number, opts: { crossed?: boolean, red?: boolean, file?: string } = {}): RunBoard => ({
  label,
  topMs,
  topFile: opts.file ?? `x-${label}.spec.ts`,
  crossed: opts.crossed ?? false,
  ratio: LINE_MS / Math.max(1, topMs),
  sawRpcTimeout: opts.red ?? false,
})

describe('CI 榜历史：解析、最差值与「拿不到榜」的明说', () => {
  it('去噪：ANSI 与行首时间戳都去掉，但行内缩进保留', () => {
    const clean = stripLogNoise(LOG_RED)
    expect(clean).not.toContain('\x1b[')
    expect(clean).not.toContain('2026-09-24T')
    expect(clean, '榜首那行的缩进不能被吃掉（rank 与「第几名」就靠它）').toContain('  1.  104.5s')
  })

  it('秒与毫秒两种写法都解成毫秒，第一名与文件名对上', () => {
    const one = parseRunLog(LOG_RED, '35937239035')
    if (one === null) throw new Error('榜首行没解析出来 —— TOP_ROW 与榜的格式对不上了')
    expect(one.topMs).toBe(104500)
    const two = parseRunLog([
      TS + '[耗时榜] 3 个测试文件，最慢的前 3 名：',
      '  1.     4ms   距线 15288.96×  src/backend/tests/slowest-files.spec.ts',
    ].join('\n'), 'local')
    if (two === null) throw new Error('毫秒那行没解析出来 —— 单位分支坏了')
    expect(two.topMs).toBe(4)
    expect(two.topFile).toContain('slowest-files.spec.ts')
  })

  it('越线分支自己带 ⚠，倍率分支自己带倍数 —— 两分支不共享字段', () => {
    const red = parseRunLog(LOG_RED, '35937239035')
    expect(red?.crossed, '榜首那行写着「已越过 60 秒线」，解析必须认出来').toBe(true)
    expect(red?.ratio, '104.5 秒的距线倍数必须 <1').toBeLessThan(1)
    const clean = parseRunLog(LOG_CLEAN, '35937239035-attempt2')
    expect(clean?.crossed).toBe(false)
    expect(clean?.ratio, '20.8 秒 ⇒ 距线约 2.88 倍（榜上印的就是这个数）').toBeCloseTo(2.885, 1)
  })

  it('假红症状要扫整份日志 —— 那行出现在榜之前，只扫榜之后会漏', () => {
    expect(parseRunLog(LOG_RED, 'a')?.sawRpcTimeout).toBe(true)
    expect(parseRunLog(LOG_CLEAN, 'b')?.sawRpcTimeout, '重跑那次没有 [vitest-worker] 超时，必须报 false').toBe(false)
  })

  it('没有榜的运行返回 null，而不是 0 毫秒 —— 把「没数据」算成「很快」是最坏的一种错', () => {
    expect(parseRunLog('Run npm test\n ✓ everything passed\n', 'older-run')).toBeNull()
    const zero = parseRunLog([
      '[耗时榜] 231 个文件、耗时全部为 0 —— 报告器读错字段了，这张榜不作数。',
    ].join('\n'), 'broken-reporter')
    expect(zero, '自我声明失效的那行里没有第一名行，必须也算「拿不到」').toBeNull()
  })

  it('同一份日志里出现两次榜时取最后一次（最终那份才算这次运行的结果）', () => {
    const twice = [
      '[耗时榜] 1 个测试文件，最慢的前 1 名：',
      '  1.   99.9s   ⚠ 已越过 60 秒线  old.spec.ts',
      '[耗时榜] 1 个测试文件，最慢的前 1 名：',
      '  1.    3.0s   距线 20.00×  new.spec.ts',
    ].join('\n')
    expect(parseRunLog(twice, 'x')?.topFile).toBe('new.spec.ts')
  })

  it('最差值 = 榜首耗时最长的那一次；空历史没有最差值', () => {
    const hist = [b('a', 20800), b('b', 104500, { crossed: true }), b('c', 45400)]
    expect(worstOf(hist)?.label).toBe('b')
    expect(worstOf([]), '一次运行都没拉到时不能凭空给出一个最差值').toBeNull()
  })

  it('报告里明说「多少次拿不到榜」，否则 12 次里只有 3 次有榜会被读成覆盖了 12 次', () => {
    const lines = formatHistory([b('a', 20800), b('b', 104500, { crossed: true, red: true })], ['r1', 'r2', 'r3'])
    const text = lines.join('\n')
    expect(text).toContain('另有 3 次运行拉到了日志却没有 [耗时榜]')
    expect(text).toContain('r1, r2, r3')
    expect(text, '出现假红的那次必须被点名').toContain('出现假红的运行：b')
    expect(text).toContain('104.5s')
    expect(text).toContain('⚠ 越线')
  })

  it('判决按倍数说「满足 / 还差几倍」，全部拿不到榜时不许说「都很快」', () => {
    const ok = formatHistory([b('a', 10000)], [])
    expect(at(ok, ok.length - 2, '判决行')).toContain('满足「≥4×」')
    const bad = formatHistory([b('a', 20800)], [])
    expect(at(bad, bad.length - 2, '判决行')).toContain('不满足「≥4×」')
    expect(at(bad, bad.length - 2, '判决行')).toContain('还差 1.39 倍')
    const none = formatHistory([], ['r1', 'r2'])
    expect(at(none, none.length - 1, '全拿不到时的收尾行')).toContain('这个「最差值」不存在')
  })
})

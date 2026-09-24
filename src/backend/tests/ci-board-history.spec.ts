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
  fileHistory,
  formatFileHistory,
  formatHistory,
  medianOf,
  medianTopMs,
  parseRunLog,
  stripLogNoise,
  worstOf,
  type BoardRow,
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

const b = (label: string, topMs: number, opts: { crossed?: boolean, red?: boolean, file?: string, rows?: BoardRow[], sha?: string } = {}): RunBoard => {
  const topFile = opts.file ?? `x-${label}.spec.ts`
  return {
    label,
    topMs,
    topFile,
    crossed: opts.crossed ?? false,
    ratio: LINE_MS / Math.max(1, topMs),
    sawRpcTimeout: opts.red ?? false,
    rows: opts.rows ?? [{ rank: 1, file: topFile, ms: topMs, crossed: opts.crossed ?? false }],
    ...(opts.sha === undefined ? {} : { sha: opts.sha }),
  }
}

/**
 * 按内容标记取报告里的那一行 —— **不要**用「倒数第几行」这种偏移。
 *
 * 报告每加一行自我声明，所有偏移就整体错位（第一版就是这么写的，加一行就全红）。
 * 找不到就直接抛：让「判决行没印出来」响成异常，而不是 `at(undefined)` 的模糊报错。
 */
function pick (lines: readonly string[], marker: string): string {
  const hit = lines.find((l) => l.includes(marker))
  if (hit === undefined) throw new Error(`报告里没有含「${marker}」的行；实际印出的是：\n${lines.join('\n')}`)
  return hit
}

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

  it('① 那半条按中位数判，并且自己说清「这个中位是全体榜首的、不是 A 类的」', () => {
    const ok = formatHistory([b('a', 10000), b('b', 12000), b('c', 14000)], [])
    const verdict = pick(ok, '① A 类榜首中位')
    expect(verdict).toContain('整张榜第一名」的中位 12.0s')
    expect(verdict, '12 秒 ≤ 15 秒预算 ⇒ 满足（上界都达标，A 类必然达标）').toContain('**满足**')
    const bad = formatHistory([b('a', 20800), b('b', 22000), b('c', 90000, { crossed: true, red: true })], [])
    const badVerdict = pick(bad, '① A 类榜首中位')
    expect(badVerdict, '超预算时只能说「判不了」—— 这是上界，B 类混在里面只会抬高它').toContain('**判不了**')
    expect(badVerdict, '中位数是 22.0 秒（不是最差的那个）').toContain('整张榜第一名」的中位 22.0s')
    for (const lines of [ok, bad]) {
      expect(pick(lines, '⚠ ①'), '两种判决都要带那句自我声明（少了它，读的人会把上界当成 A 类实测）')
        .toContain('「判不了」不等于「不满足」')
    }
    const clause2 = pick(bad, '② B 类越线')
    expect(clause2).toContain('越线 1 次')
    expect(clause2).toContain('c 90.0s')
    expect(clause2).toContain('出现过假红的 1 次')
  })

  it('中位数：奇数取中间、偶数取两中平均；一次都没有时是 null 而不是 0', () => {
    expect(medianTopMs([b('a', 3000), b('b', 1000), b('c', 2000)])).toBe(2000)
    expect(medianTopMs([b('a', 3000), b('b', 1000), b('c', 2000), b('d', 4000)])).toBe(2500)
    expect(medianTopMs([]), '没有一次有榜时不能报 0 —— 那会被读成「榜首都是 0 秒」').toBeNull()
  })

  it('全部拿不到榜时不许说「都很快」', () => {
    const none = formatHistory([], ['r1', 'r2'])
    expect(at(none, none.length - 1, '全拿不到时的收尾行')).toContain('这两条口径都判不了')
    const mixed = formatHistory([b('a', 9000)], ['r1'])
    expect(pick(mixed, '另有 1 次运行拉到了日志却没有 [耗时榜]'), '覆盖数要带上「没有榜」的那几次').toContain('r1')
  })
})

describe('单文件跨运行历史：整份榜、没上榜不是 0、以及 run→commit', () => {
  it('解析要留下**整份**榜，不是只留榜首', () => {
    const one = parseRunLog(LOG_RED, 'r')
    if (one === null) throw new Error('这份真日志解不出来了')
    expect(one.rows.map((r) => r.rank), 'LOG_RED 里有两名').toEqual([1, 2])
    expect(at(one.rows, 1, '第二名').file).toContain('operation-log.spec.ts')
    expect(at(one.rows, 1, '第二名').ms).toBe(45400)
    expect(one.topFile, '榜首仍按名次取第一行').toContain('overview.spec.ts')
  })

  it('榜只读到它自己结束为止 —— 后面任何一张表的行都不许并进来', () => {
    // 今天 CI 日志里 `[用例榜]` 的行以「› 用例名」结尾，形状上不会被 `RANKED_ROW` 抓到；
    // 但「遇到第一根非榜行就收尾」这条守卫防的不是今天，而是**下一张表哪天印出同样形状的行**
    // （例如用例名恰好是一个路径、或多了一张 `[某榜]` 用同一套排版）。没有这条收尾，
    // 那张表里的 999 秒就会变成这一次的「榜首」，而这是那种会一路传到验收结论里的错。
    const text = [
      '[耗时榜] 2 个测试文件，最慢的前 2 名：',
      '  1.   20.8s   距线 2.88×  src/a.spec.ts',
      '  2.   11.8s   距线 5.08×  src/b.spec.ts',
      '[用例榜] 2 个用例，最慢的前 2 名：',
      '  1.  999.0s   距线 0.06×  src/z.spec.ts',
      '  2.  888.0s   距线 0.07×  src/y.spec.ts',
    ].join('\n')
    const one = parseRunLog(text, 'r')
    expect(one?.rows.length, '只能有文件榜那两行').toBe(2)
    expect(one?.topMs, '榜首必须是 20.8 秒，不是后面那张表的 999 秒').toBe(20800)
    expect(one?.rows.map((x) => x.file), '文件名不许被后面那张表顶掉')
      .toEqual(['src/a.spec.ts', 'src/b.spec.ts'])
  })

  it('名次不连续、顺序打乱也要按名次排好；毫秒与秒两种单位都认', () => {
    const text = [
      '[耗时榜] 3 个测试文件，最慢的前 3 名：',
      '  3.   700ms   距线 85.71×  src/c.spec.ts',
      '  1.   20.8s   距线 2.88×  src/a.spec.ts',
      '  2.     4.5s   距线 13.33×  src/b.spec.ts',
    ].join('\n')
    const rows = parseRunLog(text, 'r')?.rows ?? []
    expect(rows.map((r) => `${String(r.rank)}:${String(r.ms)}`)).toEqual(['1:20800', '2:4500', '3:700'])
  })

  it('某个文件没上榜的那次是 null，不是 0 毫秒', () => {
    const boards = [b('435', 26000, { file: 'kb-vector-index.spec.ts' }), b('436', 9000, { file: 'kb-vector-index.spec.ts', rows: [{ rank: 2, file: 'kb-vector-index.spec.ts', ms: 9000, crossed: false }, { rank: 3, file: 'other.spec.ts', ms: 5000, crossed: false }] })]
    const pts = fileHistory(boards, 'kb-vector')
    expect(pts.map((p) => p.ms)).toEqual([26000, 9000])
    expect(at(pts, 1, '第二名').rank).toBe(2)
    expect(fileHistory(boards, 'search-cursor').map((p) => p.ms), '两次都没上榜 ⇒ 两个 null，而不是两个 0').toEqual([null, null])
  })

  it('单文件历史要说清「几次上榜、几次没进前十」，中位只按上榜的那些次算', () => {
    const boards = [
      b('435', 26000, { file: 'kb-a.spec.ts', sha: 'aaa1111' }),
      b('436', 11000, { file: 'kb-b.spec.ts', rows: [{ rank: 1, file: 'kb-b.spec.ts', ms: 11000, crossed: false }, { rank: 5, file: 'kb-a.spec.ts', ms: 12000, crossed: false }] }),
      b('437', 8000, { file: 'kb-b.spec.ts', rows: [{ rank: 1, file: 'kb-b.spec.ts', ms: 8000, crossed: false }] }),
    ]
    const lines = formatFileHistory(fileHistory(boards, 'kb-a'), 'kb-a')
    expect(at(lines, 0, '表头')).toContain('3 次运行里上榜 2 次')
    expect(at(lines, 0, '表头'), '没上榜的次数要明说不是 0 秒').toContain('没上榜**不是 0 秒**')
    expect(pick(lines, 'run 435'), '有 sha 的那次要把短 sha 印出来（跨运行比的是同一个提交吗，全靠它）').toContain('@aaa1111')
    expect(pick(lines, 'run 437')).toContain('未上榜')
    expect(pick(lines, '中位')).toContain('中位 19.0s')
    expect(pick(lines, '中位'), '19 秒 > 15 秒预算 ⇒ 超了').toContain('**超了**')
  })

  it('一次都没上榜时不许凭空给出一个中位数', () => {
    const lines = formatFileHistory(fileHistory([b('1', 5000, { file: 'x.spec.ts' })], 'kb'), 'kb')
    expect(at(lines, lines.length - 1, '没有中位数时的收尾行')).toContain('没有中位数可算')
    expect(lines.join('\n')).not.toMatch(/NaN|Infinity/)
    expect(medianOf([]), '空集合的中位数是 null').toBeNull()
    expect(medianOf([3, 1, 2])).toBe(2)
    expect(medianOf([4, 1, 2, 3])).toBe(2.5)
  })
})

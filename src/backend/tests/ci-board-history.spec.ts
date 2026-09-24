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
  HARD_CEILING_MS,
  LINE_MS,
  MIN_FOR_BAND,
  MIN_OBS_TO_JUDGE,
  OVER_SHARE_MAX,
  classifyRun,
  compareWindows,
  distVerdict,
  fileHistory,
  formatCompare,
  formatDistVerdict,
  formatFileHistory,
  formatHistory,
  formatProofs,
  formatVerdict,
  medianATop,
  medianOf,
  medianTopMs,
  parseRunLog,
  proveCrossings,
  robustSigma,
  stripLogNoise,
  verdictOf,
  wilsonInterval,
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

const b = (label: string, topMs: number, opts: { crossed?: boolean, red?: boolean, file?: string, rows?: BoardRow[], sha?: string, count?: number } = {}): RunBoard => {
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
    ...(opts.count === undefined ? {} : { fileCount: opts.count }),
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
      expect(pick(lines, '只能给上界'), '两种判决都要带那句自我声明（少了它，读的人会把上界当成 A 类实测）')
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

describe('按本机基线把 A/B 分开之后，① 才算得出真数', () => {
  const rows = (...r: Array<[string, number, number | null]>): RunBoard => ({
    label: 'r',
    topMs: Math.max(...r.map(([, ms]) => ms)),
    topFile: r.find(([, ms]) => ms === Math.max(...r.map(([, x]) => x)))?.[0] ?? '',
    crossed: false,
    ratio: 1,
    sawRpcTimeout: false,
    rows: r.map(([file, ms], i) => ({ rank: i + 1, file, ms, crossed: false })),
  })
  /** 榜：A（本机 3.7 秒）20 秒；B（本机 605 毫秒）17.5 秒；第三条本机查不到，30 秒。 */
  const mixed = rows(['a.spec.ts', 20000, 3700], ['g.spec.ts', 17500, 605], ['z.spec.ts', 30000, null])
  const look = (table: Record<string, number>) => (file: string): number | null => table[file] ?? null
  const table = { 'a.spec.ts': 3700, 'g.spec.ts': 605 }

  it('A 类榜首只数判成 A 的那个；比它更慢又查不到基线的行 ⇒ 这次算含糊', () => {
    const r = classifyRun(mixed, look(table))
    expect(r.aTop, '只有 a.spec.ts 判成 A（g 是 ×29 的停顿，z 查不到基线）').toEqual({ file: 'a.spec.ts', ms: 20000 })
    expect(r.bFiles).toEqual(['g.spec.ts'])
    expect(r.unknown).toBe(1)
    expect(r.ambiguous, 'z 排得比 A 榜首还慢，而基线认不出它 ⇒ 这次的 A 榜首可能是它，不能当真数').toBe(true)
  })

  it('认不出的行排在 A 榜首之后 ⇒ 不影响这次（它改不了最大值）', () => {
    const ok = rows(['a.spec.ts', 20000, 3700], ['g.spec.ts', 17500, 605], ['z.spec.ts', 5000, null])
    const r = classifyRun(ok, look(table))
    expect(r.ambiguous, 'z 只有 5 秒，翻不了榜').toBe(false)
    expect(r.unknown, '但"有几行查不到"仍要如实报出来').toBe(1)
  })

  it('中位数只收不含糊的那些次，并把跳过多少说清楚', () => {
    const runs = [
      classifyRun(mixed, look(table)),
      classifyRun(rows(['a.spec.ts', 12000, 3700]), look(table)),
      classifyRun(rows(['a.spec.ts', 14000, 3700]), look(table)),
    ]
    const r = medianATop(runs)
    expect(r.used, '两次干净（12 秒、14 秒）⇒ 中位 13 秒').toBe(2)
    expect(r.skipped).toBe(1)
    expect(r.median).toBe(13000)
    expect(medianATop([classifyRun(mixed, look(table))]).median, '全含糊时不凭空给一个中位数').toBeNull()
  })

  it('给了基线，① 就按 A 类判；不给，只能印那条上界判决 —— 两者的措辞不能混', () => {
    // 带（噪声带）要至少 MIN_FOR_BAND 个样本才给，所以这里喂 6 次，而不是以前那样一次就下结论。
    const aTops = [13000, 13500, 12500, 13000, 12800, 13200]
    const withBase = formatHistory(aTops.map((ms, i) => b(`r${String(i)}`, ms, {
      file: 'other.spec.ts',
      rows: [{ rank: 1, file: 'other.spec.ts', ms, crossed: false }],
    })), [], 15000, () => 3700)
    const v = pick(withBase, '① A 类榜首中位')
    expect(v, 'A 榜首中位 13.0 秒 ≤ 15 秒预算，且差 2 秒远大于 ±0.24 秒的带 ⇒ 满足').toContain('**满足**')
    expect(v).toContain('中位 13.0s')
    expect(v, '判决要带上噪声带与样本数，否则读的人不知道这句话说得多硬').toMatch(/±\d+\.\d+s/)
    expect(v).toContain('n=6')
    expect(withBase.join('\n'), '按类别判了就不该再挂那句「只是上界」').not.toContain('但这只是**上界**')
    expect(withBase.join('\n'), '用户追加的口径也要印出来：差要超过带才算数').toContain('与预算的差要超过噪声带')

    const noBase = formatHistory([rows(['a.spec.ts', 40000, 3700], ['g.spec.ts', 45000, 605])], [], 15000)
    expect(pick(noBase, '① A 类榜首中位'), '没有基线时那个数是上界，判决只能是「判不了」').toContain('**判不了**')
    expect(noBase.join('\n')).toContain('只能给上界')
  })

  it('有基线但每次都判不出 A（全含糊）⇒ 退回上界，并且说清是基线的问题', () => {
    const lines = formatHistory([mixed], [], 15000, () => null)
    expect(pick(lines, '① A 类榜首中位'), '一次都判不出 ⇒ 只能给上界').toContain('**判不了**')
    expect(lines.join('\n')).toContain('npm run ci:baseline')
  })
})

describe('噪声带：① 的「达没达标」与「这一刀有没有效」都要能站得住（用户 2026-09-24 追加）', () => {
  const six = [10000, 12000, 14000, 16000, 18000, 20000]

  it('σ̂ = 1.4826 × MAD，长尾样本不能被离群撑大（10..20 秒 ⇒ σ̂ = 4.45 秒）', () => {
    // median=15000；离差 [5,3,1,1,3,5]×1000 ⇒ MAD=3000 ⇒ σ̂=1.4826×3000=4447.8
    expect(robustSigma(six) ?? 0).toBeCloseTo(4447.8, 1)
    // 同一个中位、但有一个 100 秒的离群：σ 会被它抬起来，MAD 几乎不动 —— 这就是选它的原因
    const withOutlier = [...six, 100000, 110000]
    const mad = robustSigma(withOutlier) ?? 0
    const plain = Math.sqrt(withOutlier.reduce((a, x) => a + (x - 37500) ** 2, 0) / withOutlier.length)
    expect(mad, 'MAD 版本必须明显小于被离群抬起来的样本标准差').toBeLessThan(plain)
  })

  it('样本不足 MIN_FOR_BAND 时不给带 —— 猜出来的带不能冒充测量', () => {
    expect(robustSigma([1, 2, 3, 4, 5])).toBeNull()
    expect(verdictOf([1, 2, 3, 4, 5])).toBeNull()
    expect(verdictOf(six), '刚好够 ⇒ 给得出').toBeTruthy()
  })

  it('verdictOf 的带 = 1.96 × σ̂ / √n（n=6 的 10..20 秒 ⇒ 中位 15.0 秒、带 ±3.6 秒）', () => {
    const v = verdictOf(six)
    if (v === null) throw new Error('六个样本该给得出判决包')
    expect(v.median).toBe(15000)
    expect(v.n).toBe(6)
    expect(v.band, '带 = 1.96 × 4447.8 / √6 = 3559ms（手算）').toBeCloseTo(3559, 0)
  })

  it('判决三种措辞不许串：满足、不满足、差在带里 ⇒「判不准」', () => {
    expect(formatVerdict({ median: 10000, band: 500, n: 12 }, 15000)).toContain('**满足**')
    expect(formatVerdict({ median: 20000, band: 500, n: 12 }, 15000)).toContain('**不满足**')
    const tight = formatVerdict({ median: 15400, band: 1000, n: 12 }, 15000)
    expect(tight, '只差 400ms 而带是 ±1s ⇒ 没资格说达没达标').toContain('**判不准**')
    expect(tight).toContain('还没资格说')
    // 边界取「含等号 ⇒ 判不准」：差值刚好等于带时不能算超过。
    expect(formatVerdict({ median: 16000, band: 1000, n: 12 }, 15000)).toContain('**判不准**')
    expect(formatVerdict({ median: 16001, band: 1000, n: 12 }, 15000)).toContain('**不满足**')
    expect(formatVerdict(null, 15000), '样本不足要说「判不了」而不是「满足」').toContain('样本不足')
  })

  it('两窗口比较：差值要超过两边带之和才算动了', () => {
    const before = { median: 16100, band: 2400, n: 12 }
    const small = { median: 15000, band: 2400, n: 12 }
    const big = { median: 10000, band: 1000, n: 12 }
    expect(compareWindows(small, before).real, '减了 1.1 秒但两边带各 2.4 秒 ⇒ 不能算效果').toBe(false)
    expect(compareWindows(big, before).real, '减了 6.1 秒 > 3.4 秒 ⇒ 真的动了').toBe(true)
    // 恰好等于「两边带之和」不算超过（要严格大于）：16100-12100 = 4000 = 1600 + 2400。
    expect(compareWindows({ median: 12100, band: 1600, n: 12 }, before).real, '差 4000 = 要超过的 4000 ⇒ 还不算').toBe(false)
    expect(compareWindows({ median: 12099, band: 1600, n: 12 }, before).real, '再多 1ms 才算动').toBe(true)
    const lines = formatCompare(big, before)
    expect(at(lines, 1, '结论行')).toContain('**这一步真的动了**')
    expect(at(lines, 1, '结论行'), '方向也要说出来').toContain('（变快）')
    expect(at(formatCompare(small, before), 1, '结论行')).toContain('**落在噪声带里，不能算效果**')
  })
})


describe('① 的分布口径（用户 2026-09-24 第二次改定：预算 15 秒不动，改量「有多少文件在线以上」）', () => {
  /** 所有文件本机都算 3 秒 ⇒ CI 读数只要不超过 60 秒就判成 A（`B_RATIO` 倍以内）。 */
  const local = (): number | null => 3000
  const mkRows = (ms: number[]): BoardRow[] => ms.map((m, i) => ({ rank: i + 1, file: `f${String(i)}.spec.ts`, ms: m, crossed: false }))
  const mkBoard = (label: string, ms: number[], count = 240): RunBoard => b(label, ms[0] ?? 0, { file: 'f0.spec.ts', rows: mkRows(ms), count })

  it('榜表头那句「243 个测试文件」要能解成分母；解不出来是 undefined，不是 0', () => {
    const withHead = parseRunLog(LOG_CLEAN, '1')
    expect(withHead?.fileCount, '这份表头写的就是 231 个测试文件').toBe(231)
    const noHead = parseRunLog([
      TS + '[耗时榜]（这份是旧的，表头没写文件总数）',
      TS + '  1.   20.8s   距线 2.88×  src/backend/wechat-data/tests/search-cursor.spec.ts',
    ].join('\n'), '2')
    expect(noHead?.fileCount, '读不到分母时必须自认读不到 —— 拿 0 当分母会让「占比」变成除零').toBeUndefined()
  })

  it('Wilson 区间：一次都没超预算 ≠ 铁证（k=0 也要给出一条有宽度的上界）', () => {
    const big = wilsonInterval(0, 240)
    expect(big.lo, 'k=0 时下界必然是 0').toBe(0)
    expect(big.hi, '240 个文件里 0 个超预算 ⇒ 上界要收窄到 5% 以内才谈得上「满足」').toBeLessThanOrEqual(OVER_SHARE_MAX)
    const small = wilsonInterval(0, 10)
    expect(small.hi, '只有 10 个分母时不许判「满足」—— 正态近似在 k=0 会给出宽度 0 的区间，那是假铁证').toBeGreaterThan(OVER_SHARE_MAX)
  })

  // 三份榜：每个文件都上榜 3 次 ⇒ 够判「平时」（`MIN_OBS_TO_JUDGE`），
  // 不然下面的「满足」会是**因为没东西可判**而满足 —— 那是这条口径最容易骗自己的方式。
  const okBoard = (label: string, top = 12000): RunBoard =>
    mkBoard(label, [top, 11000, 9000, 8000, 7000, 6000, 5000, 4000, 3500, 3000])

  it('满足：A 类里没有一个文件平时超预算，且第十名在线下（榜外必然也在线下）', () => {
    const v = distVerdict([okBoard('1'), okBoard('2'), okBoard('3')], local)
    expect(v?.verdict, v?.why ?? '').toBe('满足')
    expect(v?.slow).toEqual([])
    expect(v?.thin, '三个样本的文件不该被当成「判不了」').toEqual([])
    expect(v?.closed).toBe(true)
  })

  it('平时超预算的文件要被抓出来（哪怕占比还在 5% 以内 —— 名字必须印出来）', () => {
    const v = distVerdict([okBoard('1', 20000), okBoard('2', 21000), okBoard('3', 22000)], local)
    expect(v?.slow.map((s) => s.file), 'f0 三次都在 20 秒以上 ⇒ 它「平时」就超预算').toEqual(['f0.spec.ts'])
    expect(v?.slow[0]?.obs).toBe(3)
    expect(v?.verdict, `1/240 = 0.4% 还在 5% 上限内：${v?.why ?? ''}`).toBe('满足')
    expect(v?.readings, '但读数那一半要说出来：三条读数确实在线以上').toEqual({ a: 30, over: 3, b: 0 })
  })

  it('硬顶量的是「平时」：一个文件三次都在 40 秒以上 ⇒ 不满足，占比达标抵不过', () => {
    const v = distVerdict([okBoard('1', HARD_CEILING_MS + 1000), okBoard('2', HARD_CEILING_MS + 2000), okBoard('3', HARD_CEILING_MS + 3000)], local)
    expect(v?.ceiling.map((c) => c.file)).toEqual(['f0.spec.ts'])
    expect(v?.verdict).toBe('不满足')
    expect(v?.why).toContain('平时')
  })

  it('单点越顶不算 ① 的账（那是「按最差值判」还魂），但必须印出来交给 ②', () => {
    const v = distVerdict([okBoard('1', 45000), okBoard('2'), okBoard('3')], local)
    expect(v?.ceiling, '只越了一次 ⇒ 不是「平时」').toEqual([])
    expect(v?.verdict, v?.why ?? '').toBe('满足')
    expect(v?.spikes.map((s) => `${s.file}@${s.label}`)).toEqual(['f0.spec.ts@1'])
    const j = formatDistVerdict(v).join('\n')
    expect(j).toContain('单点')
    expect(j).toContain('run1')
    expect(j, '偶发单点要指回 ②（同一次日志自证慢在哪段）').toContain('归 ②')
  })

  it('只上榜一两次的文件不许被当成「平时」—— 榜只有前十，上榜多半正因为它那次慢', () => {
    expect(MIN_OBS_TO_JUDGE, '门槛是 3 次 ⇒ 下面这两份榜里没有任何文件够判「平时」').toBe(3)
    const v = distVerdict([
      mkBoard('1', [30000, 11000, 9000, 8000, 7000, 6000, 5000, 4000, 3500, 3000]),
      mkBoard('2', [31000, 11000, 9000, 8000, 7000, 6000, 5000, 4000, 3500, 3000]),
    ], local)
    expect(v?.slow, '两次读数 ⇒ 判不了「平时」').toEqual([])
    expect(v?.thin.map((t) => t.file), '但也不能悄悄丢掉').toEqual(['f0.spec.ts'])
    expect(formatDistVerdict(v).join('\n')).toContain('看过但判不了')
  })

  it('第十名自己就在预算之外 ⇒ 判不准，不许把「榜上没别的文件超线」读成达标', () => {
    // 整份榜都在 16 秒以上 ⇒ 第十名也超预算 ⇒ 「前十以外还有没有慢文件」这件事看不见。
    const highBoard = (label: string): RunBoard => mkBoard(label, [20000, 19500, 19000, 18500, 18000, 17500, 17000, 16500, 16200, 16000])
    const v = distVerdict([highBoard('1'), highBoard('2'), highBoard('3')], local)
    expect(v?.verdict).toBe('判不准')
    expect(v?.why, '唯一的盲点是「前十以外看不见」，闭合条件不成立就必须说出来').toContain('第十名')
    expect(v?.closed).toBe(false)
  })

  it('榜不满十行 ⇒ 前十以外看不见，判不了而不是「满足」', () => {
    const v = distVerdict([mkBoard('1', [9000, 8000, 7000])], local)
    expect(v?.verdict).toBe('判不准')
    expect(v?.why).toContain('不满十行')
  })

  it('没有分母（表头读不到）时不许给判决，也不许印成「满足」', () => {
    const board = mkBoard('1', [12000, 11000, 9000, 8000, 7000, 6000, 5000, 4000, 3500, 3000], 0)
    expect(distVerdict([board], local), 'fileCount 缺失时返回 null，而不是拿 0 当分母').toBeNull()
    const j = formatDistVerdict(null).join('\n')
    expect(j).toContain('判不了')
    expect(j).not.toContain('**满足**')
  })

  it('B 类文件不算进「超预算的文件」—— 它慢在 runner，不在代码里', () => {
    // f0 本机 10 毫秒、CI 上 45 秒（4500 倍）⇒ 判 B；其余文件本机 3 秒 ⇒ 判 A 且都在线下。
    const loc = (file: string): number | null => (file === 'f0.spec.ts' ? 10 : 3000)
    const v = distVerdict([okBoard('1', 45000), okBoard('2', 45000), okBoard('3', 45000)], loc)
    expect(v?.slow, '把一个 B 类文件算成「超预算的文件」等于把 runner 的抖动记在代码账上 —— 那正是第一次口径被推翻的原因').toEqual([])
    expect(v?.ceiling, '同理，「平时越硬顶」也不把 B 类算进来').toEqual([])
    expect(v?.verdict, v?.why ?? '').toBe('满足')
    expect(v?.spikes.length, '但它越过硬顶的那三次要留在纸上，交给 ② 去自证').toBe(3)
    expect(v?.readings.b, '被 A/B 分类挡在外面的读数要**数出来** —— 不然「满足」可能只是分类吃掉了慢文件').toBe(3)
    expect(formatDistVerdict(v).join('\n'), '印的时候也要带上这个数').toContain('3 条读数判成了 B')
  })

  it('报告里分布口径是判决，旧的中位口径降为参考并说明为什么被替代', () => {
    const j = formatHistory([okBoard('1'), okBoard('2'), okBoard('3')], [], 15000, local).join('\n')
    expect(j).toContain('① 分布口径 ⇒ **满足**')
    expect(j).toContain('参考（旧口径 ①')
    expect(j).toContain('第二次改定')
    expect(j, '新口径更松 ⇒ 它必须自己说清「换口径不等于问题消失」').toContain('换口径不等于问题消失')
  })
})

describe('② 的自证：三份材料并起来才是一行判决（夹具是 2026-09-24 运行 469 的真形状）', () => {
  const F = 'src/backend/wechat-data/tests/kb-b-endtoend.spec.ts'
  /** 真日志：榜首 82.8 秒越线、90% 集中在一条用例、文件内账说占比 100%。 */
  const LOG_469 = [
    TS + '[耗时榜] 241 个测试文件，最慢的前 10 名：',
    TS + `  1.   82.8s   ⚠ 已越过 60 秒线（历史上每次假红都有一个这样的文件）  ${F}`,
    '',
    TS + '[用例榜] 2493 个用例，最慢的前 10 名：',
    TS + `  1.   74.4s      占该文件 90%  ${F} › 登记 → 排队 → 解析 → 可检索（H3 的主链路） › drainKbQueue 把它们全部推到 ready，且各自用了对的解析器`,
    TS + '  2.    6.1s      占该文件 12%  src/backend/wechat-data/tests/other.spec.ts › 别的组 › 另一条用例',
    '',
    TS + '[文件内账] 时间落在哪：把「文件总时长 − 用例合计」当成「不在用例里的那段」的量级',
    TS + `  ${F}     文件   82.8s  用例合计   82.8s（13 条，占 100%）  ⇒ 时间几乎都在用例里（这个文件自己的活，减夹具才有用）`,
    TS + '  src/backend/wechat-data/tests/other.spec.ts     文件    7.9s  用例合计   6.1s（4 条，占 77%）  ⇒ 77% 不在任何用例里（收集/夹具/收尾/runner 停顿）',
  ].join('\n')

  it('三张表都要解出来，而 `[耗时榜]` 的边界不许被 `[用例榜]` 顶掉', () => {
    const board = parseRunLog(LOG_469, '469')
    expect(board?.rows.length, '耗时榜只有第一名这一行 —— 用例行被吃进来的话「榜首」就变成了用例').toBe(1)
    expect(board?.fileCount).toBe(241)
    expect(board?.cases?.length).toBe(2)
    expect(board?.cases?.[0]?.sharePct).toBe(90)
    expect(board?.accounts?.length).toBe(2)
    expect(board?.accounts?.[0]?.cases).toBe(13)
  })

  it('B 类（本机 803 毫秒 / CI 82.8 秒 = ×103）：可自证，而且要说破「占比 100% 不等于在做事」', () => {
    const board = parseRunLog(LOG_469, '469')
    const p = proveCrossings(board ?? { label: '', topMs: 0, topFile: '', crossed: false, ratio: 0, sawRpcTimeout: false, rows: [] }, () => 803)
    expect(p.length).toBe(1)
    expect(p[0]?.isB, '×103 远超 B_RATIO ⇒ 这是停顿，不是代码').toBe(true)
    expect(p[0]?.complete).toBe(true)
    expect(p[0]?.says).toContain('×103.1')
    expect(p[0]?.says).toContain('停顿，不在代码里')
    expect(p[0]?.says, '这一句是整套自证的核心陷阱：停顿落在某条用例体内时占比照样接近 100%').toContain('不等于')
    expect(p[0]?.topCase?.name).toContain('drainKbQueue')
    expect(formatProofs(p, 1).join('\n')).toContain('✓ 可自证')
  })

  it('A 类（本机 30 秒 / CI 82.8 秒 = ×2.8）：越线要减代码，重跑不算自证', () => {
    const board = parseRunLog(LOG_469, '469')
    const p = proveCrossings(board ?? { label: '', topMs: 0, topFile: '', crossed: false, ratio: 0, sawRpcTimeout: false, rows: [] }, () => 30000)
    expect(p[0]?.isB).toBe(false)
    expect(p[0]?.says).toContain('真活')
    expect(p[0]?.says).toContain('重跑不算自证')
  })

  it('缺任何一份材料都只能报「证据不齐」，不许把缺证据混进「已自证」或「假红没解释」', () => {
    const shape = { label: '', topMs: 0, topFile: '', crossed: false, ratio: 0, sawRpcTimeout: false, rows: [] }
    const noBaseline = proveCrossings(parseRunLog(LOG_469, '469') ?? shape, () => null)
    expect(noBaseline[0]?.complete).toBe(false)
    expect(noBaseline[0]?.says).toContain('本机基线查不到')
    const bare = proveCrossings({ ...shape, rows: [{ rank: 1, file: F, ms: 82800, crossed: true }] }, () => 803)
    expect(bare[0]?.complete).toBe(false)
    expect(bare[0]?.says, '只有耗时榜 ⇒ 说不出时间落在哪一段').toContain('没有 `[文件内账]`')
    expect(bare[0]?.says).toContain('`[用例榜]` 里没有这个文件的用例')
    expect(formatProofs(bare, 1).join('\n')).toContain('⚠ 证据不齐')
    expect(formatProofs(bare, 1).join('\n')).toContain('不能**记成')
  })

  it('零次越线要说「今天没有需要自证的对象」，而不是「这条过了」', () => {
    const j = formatProofs([], 12).join('\n')
    expect(j).toContain('越线 0 次')
    expect(j).toContain('零次不等于永远不会')
  })

  it('报告里 ② 那一段现在给的是逐次自证（不再是「工具只能数次数」）', () => {
    const board = parseRunLog(LOG_469, '469')
    const j = formatHistory([board ?? { label: '', topMs: 0, topFile: '', crossed: false, ratio: 0, sawRpcTimeout: false, rows: [] }], [], 15000, () => 803).join('\n')
    expect(j).toContain('② 越线 1 次')
    expect(j).toContain('✓ 可自证')
    expect(j).not.toContain('工具只能数次数')
  })
})

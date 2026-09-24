/**
 * `tests/helpers/slowest-files.ts` 的应用例 —— 两张榜的排序、破平、倍率/占比与空表都要判得动。
 *
 * 这两张榜是 N36 的判据面（CI 上那条假红线是 vitest 硬编码的 60 秒），所以它们自己不能是
 * 「只能靠真跑一轮才知道对不对」的东西：这里直接喂数据，把顺序、并列、余量与占比钉死。
 *
 * @module tests/slowest-files
 */
import { describe, expect, it } from 'vitest'

import { RPC_TIMEOUT_MS, collectTestTimings, formatBoard, formatRow, formatTestBoard, formatTestRow, topSlowest, topSlowestTests, type FileTiming, type ReportTask, type TestTiming } from './helpers/slowest-files.ts'
import { at, grp } from './helpers/strict-index.ts'

const f = (name: string, ms: number): FileTiming => ({ name, ms })
const t = (file: string, name: string, ms: number): TestTiming => ({ file, name, ms })

describe('N36 耗时榜：排序、破平、倍率与空表', () => {
  it('按耗时从大到小，且不改动入参', () => {
    const input = [f('a.spec.ts', 1200), f('b.spec.ts', 46000), f('c.spec.ts', 900)]
    const ranked = topSlowest(input, 3)
    expect(ranked.map((r) => r.name), '名次顺序不对').toEqual(['b.spec.ts', 'a.spec.ts', 'c.spec.ts'])
    expect(at(input, 0, '入参').name, '排序不该改动入参（同一份数据要能反复量）').toBe('a.spec.ts')
  })

  it('耗时相同的按文件名升序破平 —— 跨运行比较要求同一批数据给出同一张榜', () => {
    const ranked = topSlowest([f('zeta.spec.ts', 5000), f('alpha.spec.ts', 5000), f('mid.spec.ts', 5000)], 3)
    expect(ranked.map((r) => r.name)).toEqual(['alpha.spec.ts', 'mid.spec.ts', 'zeta.spec.ts'])
  })

  it('只截断到 n 名，n 为 0 或负数时给出空榜而不是整张', () => {
    const many = [f('a.ts', 3), f('b.ts', 2), f('c.ts', 1)]
    expect(topSlowest(many, 2).map((r) => r.name)).toEqual(['a.ts', 'b.ts'])
    expect(topSlowest(many, 0)).toEqual([])
    expect(topSlowest(many, -5), '负数不该被当成「不限长度」').toEqual([])
  })

  it('余量按「线 ÷ 实测」算，越线的那名要自己喊出来', () => {
    const row = formatRow(1, f('slow.spec.ts', 30000))
    const m = row.match(/距线 ([0-9.]+)×/)
    if (m === null) throw new Error(`那行没写出「距线 N×」，格式改了要同步这条判据：${row}`)
    expect(Number(grp(m, 1, '余量倍率')), '30 秒的文件应该离 60 秒线正好 2 倍').toBeCloseTo(2, 1)
    expect(formatRow(2, f('over.spec.ts', 61000))).toContain('已越过 60 秒线')
    expect(formatRow(1, f('zero.spec.ts', 0)), '0 毫秒不能把倍率算成 Infinity')
      .not.toContain('Infinity')
  })

  it('空表给出警告而不是空输出 —— 一张静默缺席的榜会被读成「没有慢文件」', () => {
    const board = formatBoard([])
    expect(at(board, 0, '空榜输出')).toContain('一个文件的耗时都没拿到')
    expect(formatBoard([f('only.spec.ts', 7000)], 10)).toHaveLength(2)
  })

  it('有文件但耗时全是 0 ⇒ 也喊警告 —— 这正是 vitest 换字段名时的失效形状', () => {
    const board = formatBoard([f('a.spec.ts', 0), f('b.spec.ts', 0)])
    expect(board).toHaveLength(1)
    expect(at(board, 0, '全 0 榜的输出')).toContain('读错字段')
    // 只要有一个非 0，就不该再走警告分支（否则真数据会被误判成没数据）
    expect(at(formatBoard([f('a.spec.ts', 0), f('b.spec.ts', 5)]), 0, '有数据时的表头')).toContain('最慢的前')
  })

  it('整张榜的表头带上「一共多少文件」，不然看不出榜是被截断还是就这么点', () => {
    const files = Array.from({ length: 25 }, (_, i) => f(`f${String(i)}.spec.ts`, i * 1000))
    const board = formatBoard(files, 10)
    expect(board).toHaveLength(11)
    expect(at(board, 0, '表头')).toContain('25 个测试文件')
    expect(at(board, 1, '第一名')).toContain('24.0s')
  })

  it('一秒以内用毫秒显示 —— 否则单文件榜会出现一排看着像「0.0s」的行', () => {
    expect(formatRow(1, f('tiny.spec.ts', 170))).toContain('170ms')
    expect(formatRow(1, f('almost.spec.ts', 999))).toContain('999ms')
    expect(formatRow(1, f('one.spec.ts', 1000))).toContain('1.0s')
  })

  it('参照线就是 vitest 里那条硬编码值 —— 有人改了常量时这里要响', () => {
    expect(RPC_TIMEOUT_MS, 'vitest 的 birpc 默认超时是 6e4（见 helper 注释的出处）').toBe(60000)
  })
})

/** 与报告器里那一处调用同形：榜要的是「拿真任务树喂进来」这条路径也被钉住。 */
function flatten (files: readonly ReportTask[]): TestTiming[] {
  const out: TestTiming[] = []
  for (const file of files) collectTestTimings(file.tasks ?? [], [file.name ?? '(无名文件)'], out)
  return out
}

describe('N36 用例榜：摊平任务树、占比与自我声明', () => {
  it('嵌套 describe 里的用例摊得出来，且用例名带上所属套件链', () => {
    const out = flatten([{
      name: 'a.spec.ts',
      result: { duration: 5000 },
      tasks: [
        {
          type: 'suite',
          name: '外层',
          tasks: [{ type: 'suite', name: '内层', tasks: [{ type: 'test', name: '慢的那条', result: { duration: 4800 } }] }],
        },
        { type: 'test', name: '顶层那条', result: { duration: 200 } },
      ],
    }])
    expect(out, '只数一层的话这里会是空榜 —— 那正是这张榜最危险的失效形状').toHaveLength(2)
    expect(at(out, 0, '深嵌套用例').name).toBe('外层 › 内层 › 慢的那条')
    expect(at(out, 1, '顶层用例').name).toBe('顶层那条')
    for (const r of out) expect(r.file, '每条都要知道自己属于哪个文件，占比才有出处').toBe('a.spec.ts')
    expect(at(out, 0, '深嵌套用例').ms).toBe(4800)
  })

  it('占比这一列把两种不同的病分开：一条独大 vs 整档都慢', () => {
    // 同样是「文件 104.5 秒」：一条用例 104.5s（占 100%）与三条各 34.8s（各占 33%）
    // 是完全不同的处置 —— 前者去看那一条，后者减夹具/换隔离粒度才有用。
    const one = formatTestRow(1, t('overview.spec.ts', '一条独大', 104541), 104541)
    const three = formatTestRow(1, t('overview.spec.ts', '三条之一', 34847), 104541)
    expect(one).toContain('占该文件 100%')
    expect(three).toContain('占该文件 33%')
  })

  it('拿不到文件总耗时时写「占比未知」，绝不写出 NaN 或 Infinity', () => {
    for (const ms of [0, 1200]) {
      const row = formatTestRow(1, t('x.spec.ts', '某条', ms), 0)
      expect(row).toContain('占比未知')
      expect(row, '除数是 0 时必须走「未知」分支，不能把 NaN 印到榜上').not.toMatch(/NaN|Infinity/)
    }
  })

  it('一秒以内用毫秒、排序与破平同文件榜、n 只管截断', () => {
    const tests = [t('b.spec.ts', '甲', 5000), t('a.spec.ts', '乙', 5000), t('a.spec.ts', '丙', 9000)]
    expect(topSlowestTests(tests, 3).map((x) => `${x.file}›${x.name}`))
      .toEqual(['a.spec.ts›丙', 'a.spec.ts›乙', 'b.spec.ts›甲'])
    expect(topSlowestTests(tests, 1)).toHaveLength(1)
    expect(topSlowestTests(tests, -1), '负数不该被当成「不限长度」').toEqual([])
    expect(formatTestRow(1, t('a.spec.ts', 'tiny', 170), 1000)).toContain('170ms')
  })

  it('空榜与全 0 榜都要自己喊出来 —— 静默的榜会被读成「没有慢用例」', () => {
    expect(at(formatTestBoard([], new Map()), 0, '空榜')).toContain('一个用例的耗时都没拿到')
    const zeros = [t('a.spec.ts', '甲', 0), t('b.spec.ts', '乙', 0)]
    const z = formatTestBoard(zeros, new Map([['a.spec.ts', 0], ['b.spec.ts', 0]]))
    expect(z).toHaveLength(1)
    expect(at(z, 0, '全 0 榜')).toContain('读错字段')
    // 只要有一条非 0，就不许再走警告分支
    const mixed = formatTestBoard([...zeros, t('c.spec.ts', '丙', 9)], new Map([['c.spec.ts', 9]]))
    expect(at(mixed, 0, '有数据时的表头')).toContain('最慢的前 3 名')
    expect(at(mixed, 1, '第一名')).toContain('c.spec.ts')
  })
})

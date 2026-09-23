/**
 * `tests/helpers/slowest-files.ts` 的应用例 —— 榜的排序、破平、倍率与空表都要判得动。
 *
 * 这张榜是 N36 的判据面（CI 上那条假红线是 vitest 硬编码的 60 秒），所以它自己不能是
 * 「只能靠真跑一轮才知道对不对」的东西：这里直接喂数据，把顺序、并列、余量算法钉死。
 *
 * @module tests/slowest-files
 */
import { describe, expect, it } from 'vitest'

import { RPC_TIMEOUT_MS, formatBoard, formatRow, topSlowest, type FileTiming } from './helpers/slowest-files.ts'
import { at, grp } from './helpers/strict-index.ts'

const f = (name: string, ms: number): FileTiming => ({ name, ms })

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

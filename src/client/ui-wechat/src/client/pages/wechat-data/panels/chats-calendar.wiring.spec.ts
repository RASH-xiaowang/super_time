/**
 * 日历那一族的**接线**守卫（#19 第三刀的另一半）。
 *
 * 与前两刀同一个理由：搬出去的逻辑若没人挂，界面不坏、只是那段算术又长回 `ChatsPanel`；
 * 而日历的六个派生值一旦散回面板，就又只剩"看代码的人自己算对了"这一种保障。
 * 扫描走 `readStripped`（先剥注释）：`chats-calendar.ts` 的注释里写着「按 30 天算」
 * 「闰年 2 月」这类字样，按文本匹配会把说明文字当成代码。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname

/** 旧形状（就地写在面板里时的那种拼法）：出现在面板里就说明那一族又长回去了。 */
const CAL_FINGERPRINTS = [
  'apiGetDailyCounts',
  'new Date(calYear, calMonth, 0)',
  'new Date(calYear, calMonth - 1, 1)',
  'Object.entries(calCounts)',
  'Math.min(0.15',
] as const

/** 搬走之后这些必须在模块里（少一支就是搬漏了，而不是"面板里也没有、模块里也没有"）。 */
const MOD_MARKS = [
  'apiGetDailyCounts',
  'new Date(year, month, 0)',
  'new Date(year, month - 1, 1)',
  'Object.entries(counts)',
  'HEAT_CAP',
] as const

describe('日历族的接线', () => {
  const panel = readStripped(join(HERE, 'Chats.tsx'))
  const mod = readStripped(join(HERE, 'chats-calendar.ts'))

  it('两张清单不是空的（清单被清空 ⇒ 下面两组判据全变恒真）', () => {
    expect(CAL_FINGERPRINTS.length).toBeGreaterThanOrEqual(5)
    expect(MOD_MARKS.length).toBeGreaterThanOrEqual(5)
  })

  it('哨兵：两份都真读到了东西（读空 ⇒ 下面的「不含」全恒真）', () => {
    expect(panel.length, 'Chats.tsx 没读到').toBeGreaterThan(5000)
    expect(mod.length, 'chats-calendar.ts 没读到').toBeGreaterThan(2000)
  })

  it('ChatsPanel 真的在挂 useChatsCalendar（摘掉它 = 日历弹窗永远拿不到数据）', () => {
    expect(panel).toContain('useChatsCalendar(')
  })

  it('日历的算术与取数不许再留在面板里', () => {
    for (const fp of CAL_FINGERPRINTS) {
      expect(panel, `Chats.tsx 里又出现了 ${fp} —— 那一族要待在 chats-calendar.ts`).not.toContain(fp)
    }
  })

  it('chats-calendar.ts 自己五件齐全（少一件就是搬漏了一支）', () => {
    for (const mark of MOD_MARKS) {
      expect(mod, `chats-calendar.ts 里少了 ${mark}`).toContain(mark)
    }
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    const fake = panel + '\nconst leak = Object.entries(calCounts)\n'
    const bites = CAL_FINGERPRINTS.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的').toBeGreaterThan(0)
    expect(panel, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})

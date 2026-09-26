/**
 * 导出弹窗的**接线**守卫（#19 第四刀的另一半）。
 *
 * 同一句老话：搬出去的 JSX 若没人挂，界面不坏、只是那段表单又长回 `ChatsView` 那棵树，
 * 而这一屏的规矩（遮罩判断、空类型=全部、`total<=0` 走不确定态、导出中锁按钮给中止）
 * 全都没有第二处能看见。扫描走 `readStripped`（先剥注释）：`chats-export-dialog.tsx`
 * 的说明文字里正好写着「e.target === e.currentTarget」「全部消息」这些被钉的字样。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from './wiring-kit.ts'
import { readChatsSource } from './chats-source.ts'

const HERE = import.meta.dirname

/** 旧形状：弹窗 JSX 就地写在渲染树里时的那些拼法，出现在 `chats-view.tsx` 就是又长回去了。 */
const VIEW_FINGERPRINTS = [
  'data-st-dialog="chats-export"',
  'exportFormatCard',
  'exportCountBadge',
  'setExpTypes(prev',
  'chooseExportDir()',
  'pctOf(',
] as const

/** 搬走之后这些必须在弹窗模块里（少一支就是搬漏了，而不是「两边都没有」）。 */
const MOD_MARKS = [
  'if (!exportOpen) return null',
  'e.target === e.currentTarget',
  'expTypes.length === 0 ? ',
  'progress.total > 0',
  'Math.min(100,',
  'indeterminate={exportProgress.total <= 0}',
  'onClick={cancelExport}',
  'disabled={exporting}',
] as const

describe('导出弹窗的接线', () => {
  const view = readStripped(join(HERE, 'chats-view.tsx'))
  const mod = readStripped(join(HERE, 'chats-export-dialog.tsx'))

  it('两张清单不是空的（清单被清空 ⇒ 下面两组判据全变恒真）', () => {
    expect(VIEW_FINGERPRINTS.length).toBeGreaterThanOrEqual(6)
    expect(MOD_MARKS.length).toBeGreaterThanOrEqual(8)
  })

  it('哨兵：两份都真读到了东西（读空 ⇒ 上面的「不含」全恒真）', () => {
    expect(view.length, 'chats-view.tsx 没读到').toBeGreaterThan(5000)
    expect(mod.length, 'chats-export-dialog.tsx 没读到').toBeGreaterThan(2000)
  })

  it('渲染树真的挂上 <ChatsExportDialog（摘掉它 = 导出按钮再也叫不出弹窗）', () => {
    expect(view).toContain('<ChatsExportDialog')
    expect(view).toContain("from './chats-export-dialog.tsx'")
  })

  it('导出弹窗的 JSX 不许再留在渲染树里', () => {
    for (const fp of VIEW_FINGERPRINTS) {
      expect(view, `chats-view.tsx 里又出现了 ${fp} —— 那一屏要待在 chats-export-dialog.tsx`).not.toContain(fp)
    }
  })

  it('chats-export-dialog.tsx 八件齐全（少一件就是搬漏了一支）', () => {
    for (const mark of MOD_MARKS) {
      expect(mod, `chats-export-dialog.tsx 里少了 ${mark}`).toContain(mark)
    }
  })

  /**
   * 道具袋与形参表必须仍然对得上：`ChatsView` 传的是一个 150 字段的 `state` 袋，
   * 少传一个 prop 会被 TS 拦住，但**把某个 setter 悄悄换成常量**不会 —— 所以钉住
   * 弹窗调用点确实从 `state` 上取那三个最容易写错的（时间两端与类型表）。
   */
  it('调用点仍从 state 袋取时间/类型/进度', () => {
    const at = view.indexOf('<ChatsExportDialog')
    expect(at).toBeGreaterThan(-1)
    const blk = view.slice(at, at + 1400)
    for (const p of ['expFrom={', 'expTo={', 'expTypes={', 'exportProgress={', 'setExpTypes={', 'EXPO_TYPES={']) {
      expect(blk, `弹窗调用点少了 ${p}`).toContain(p)
    }
  })

  /**
   * 「加一种格式要记着改几处」是这一族搬进来时顺手收掉的第二件事：那串字面量联合原先在
   * `chats-export.tsx` 的 state、`chats-view.tsx` 的形参表、弹窗自己的 props 里各写一遍。
   * 收成 `ExpFormat` 之后只许有一份出处 —— 抄第二份不会有编译错误，只会在下次加格式时漏改一处。
   */
  it('导出格式那串字面量联合只有一份出处', () => {
    const hits = (readChatsSource().match(/'txt'\s*\|\s*'html'/g) ?? []).length
    expect(hits, `'txt' | 'html' 这一族里出现了 ${hits} 次（应当只有 ExpFormat 那一份）`).toBe(1)
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    const fake = view + '\nconst leak = <span data-st-dialog="chats-export" />\n'
    const bites = VIEW_FINGERPRINTS.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的').toBeGreaterThan(0)
    expect(view, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})

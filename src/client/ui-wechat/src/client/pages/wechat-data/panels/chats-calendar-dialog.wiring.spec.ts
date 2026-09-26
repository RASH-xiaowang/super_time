/**
 * 第七刀两块浮层的**接线**守卫（日历弹窗 + 已编辑消息浮层）。
 *
 * 搬 JSX 的风险与搬逻辑不同：组件写好了却没人挂，界面就少一屏；调用点道具名写错，
 * React 只会静默拿到 undefined。所以这里两头都查：旧形状不许长回渲染树、新模块必须被挂上、
 * 而「遮罩那一判」在两块浮层里都得在场（本轮就是被它咬出来的 bug）。
 * 扫描走 `readStripped`（先剥注释）：这几份文件的注释里写着 `e.target === e.currentTarget`
 * 与 `setEditedOpen(false)` 这类代码字样，按文本匹配会把说明文字当成代码。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from './wiring-kit.ts'

const HERE = import.meta.dirname

/** 两块浮层的旧写法：出现在 `chats-view.tsx` 里就说明那一屏又长回渲染树了。 */
const OLD_SHAPES = [
  'data-st-dialog="chats-cal"',
  'data-st-dialog="chats-edited"',
  'calDayCnt',
  'editRowInfo',
] as const

/** 搬走之后必须在模块里（少一支就是搬漏了，而不是"渲染树里也没有、模块里也没有"）。 */
const CAL_MARKS = [
  'data-st-dialog="chats-cal"',
  'e.target === e.currentTarget',
  'aria-label="上一月"',
  'aria-label="下一月"',
  'calDayCnt',
  'calHeat(cnt)',
  '加载中…',
] as const

const EDITED_MARKS = [
  'data-st-dialog="chats-edited"',
  'e.target === e.currentTarget',
  'aria-label="关闭"',
  'disabled={editing}',
  '暂无编辑记录',
  'editedRowLabel',
] as const

describe('第七刀两块浮层的接线', () => {
  const view = readStripped(join(HERE, 'chats-view.tsx'))
  const cal = readStripped(join(HERE, 'chats-calendar-dialog.tsx'))
  const edited = readStripped(join(HERE, 'chats-edited-dialog.tsx'))

  it('四张清单不是空的（清单被清空 ⇒ 下面几组判据全变恒真）', () => {
    expect(OLD_SHAPES.length).toBeGreaterThanOrEqual(4)
    expect(CAL_MARKS.length).toBeGreaterThanOrEqual(6)
    expect(EDITED_MARKS.length).toBeGreaterThanOrEqual(5)
    // 三份文件都得真读到东西：读空会让上面那些「不含」全部恒真
    expect(view.length, 'chats-view.tsx 没读到').toBeGreaterThan(5000)
    expect(cal.length, 'chats-calendar-dialog.tsx 没读到').toBeGreaterThan(1500)
    expect(edited.length, 'chats-edited-dialog.tsx 没读到').toBeGreaterThan(800)
  })

  it('渲染树里不许再留这两块浮层的 JSX', () => {
    for (const fp of OLD_SHAPES) {
      expect(view, `chats-view.tsx 里又出现了 ${fp} —— 那一屏要待在弹窗模块里`).not.toContain(fp)
    }
  })

  it('两块浮层都真的被挂上（组件写好没人挂 = 界面少一屏，且测试全绿）', () => {
    expect(view).toContain('<ChatsCalendarDialog')
    expect(view).toContain('<ChatsEditedDialog')
    expect(view).toContain("from './chats-calendar-dialog.tsx'")
    expect(view).toContain("from './chats-edited-dialog.tsx'")
  })

  it('调用点把开合位与动作都交出去（漏一个就是点了没反应）', () => {
    const call = view.slice(view.indexOf('<ChatsCalendarDialog'), view.indexOf('/>', view.indexOf('<ChatsCalendarDialog')))
    for (const prop of ['calOpen={calOpen}', 'switchCalMonth={switchCalMonth}', 'jumpToDay={jumpToDay}', 'setCalOpen={setCalOpen}', 'calHeat={calHeat}']) {
      expect(call, `日历调用点少了 ${prop}`).toContain(prop)
    }
    const call2 = view.slice(view.indexOf('<ChatsEditedDialog'), view.indexOf('/>', view.indexOf('<ChatsEditedDialog')))
    for (const prop of ['editedOpen={editedOpen}', 'edits={edits}', 'editing={editing}', 'doReset={doReset}', 'setEditedOpen={setEditedOpen}']) {
      expect(call2, `已编辑浮层调用点少了 ${prop}`).toContain(prop)
    }
  })

  it('两块模块各自齐全（少一件就是搬漏了一支）', () => {
    for (const mark of CAL_MARKS) {
      expect(cal, `chats-calendar-dialog.tsx 里少了 ${mark}`).toContain(mark)
    }
    for (const mark of EDITED_MARKS) {
      expect(edited, `chats-edited-dialog.tsx 里少了 ${mark}`).toContain(mark)
    }
  })

  /**
   * 本轮那条 bug 的**结构性**判据：两块浮层都必须带 `e.target === e.currentTarget` 那一判，
   * 而且浮层的 onClick 不许写成无条件关窗。只靠行为用例的话，将来有人"顺手简化"这行
   * 只会红在用例上；这条红在源码上，指得出是哪一块、哪一行。
   */
  it('遮罩那一判不许被"顺手简化"掉', () => {
    // 正面判据：两块浮层各自的遮罩 onClick 都必须是「判过再关」那一整句。
    // 只断言"文件里 somewhere 有这个式子"是不够的 —— 写进别的处理器也算在场。
    expect(cal).toContain('onClick={(e) => { if (e.target === e.currentTarget) setCalOpen(false) }}')
    expect(edited).toContain('onClick={(e) => { if (e.target === e.currentTarget) setEditedOpen(false) }}')
    for (const [name, src] of [['chats-calendar-dialog.tsx', cal], ['chats-edited-dialog.tsx', edited]] as const) {
      const overlayLine = src.split('\n').find((l) => l.includes('data-st-dialog=')) ?? ''
      expect(overlayLine.length, `${name} 的遮罩节点找不到（data-st-dialog 那一行搬没了？）`).toBeGreaterThan(0)
    }
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    const fake = view + '\n<div data-st-dialog="chats-edited" onClick={() => setEditedOpen(false)} />\n'
    const bites = OLD_SHAPES.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的').toBeGreaterThan(0)
    expect(view, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})

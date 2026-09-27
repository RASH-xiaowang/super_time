/**
 * 第九刀：`state` 袋按消费方分组的**接线与反退化**守卫。
 *
 * 这一刀的收益是「一份出处」：日历/已编辑/导出/群信息这四袋的道具清单，原先在
 * ① 袋的类型、② 渲染树的调用点、③ 面板的 `viewState` 字面量 里各写一遍，
 * 加一件道具要记着改三处，漏一处不报错 —— 那一屏只是读不到值。
 * 分组之后 ①② 都只是引用，唯一的清单住在弹窗自己的 props 里（③ 由 typecheck 保证供得上）。
 *
 * 所以这条守卫要防的是**把分组改回去**（有人觉得"传一个组对象麻烦"就重新摊平）与
 * **只在一处接上**（组件写了但没人挂 / 面板供了但渲染树没展开）。
 * 组成员名单在运行时从四份 props 接口现取 —— 加一件道具不需要回来改这张清单，
 * 而「名单空了」由哨兵拦住（清单空 ⇒ 下面所有断言恒真）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jsxCall, readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname

/** 一袋 = 一个只有一个消费方的弹窗。`drop` 是那些**派生**道具（不住在袋里）。 */
const SLICES = [
  { key: 'calendar', type: 'ChatsCalendarDialogProps', file: 'chats-calendar-dialog.tsx', call: 'ChatsCalendarDialog', drop: [] as string[] },
  { key: 'edited', type: 'ChatsEditedDialogProps', file: 'chats-edited-dialog.tsx', call: 'ChatsEditedDialog', drop: [] },
  { key: 'exportDialog', type: 'ChatsExportDialogProps', file: 'chats-export-dialog.tsx', call: 'ChatsExportDialog', drop: [] },
  { key: 'groupInfo', type: 'Omit<ChatsGroupInfoViewProps, \'isGroup\' | \'open\'>', file: 'chats-group-info-view.tsx', call: 'ChatsGroupInfoView', drop: ['isGroup', 'open'] },
] as const

/** 从弹窗自己的 props 接口里取成员名单（与那一刀用的取法一致：两空格缩进的 `name:`）。 */
function membersOf(src: string, drop: readonly string[]): string[] {
  const at = src.indexOf('Props {')
  expect(at, '这份模块里找不到 Props 接口').toBeGreaterThan(-1)
  const block = src.slice(at, src.indexOf('\n}', at))
  return (block.match(/^ {2}([A-Za-z_$][\w$]*)[?]?:/gm) ?? [])
    .map((s) => s.slice(2).replace(/:$/, '').replace(/\?$/, ''))
    .filter((n) => !drop.includes(n))
}

/** 袋的类型块：`state: {` 到那一格的收尾 `}`。 */
function bagBlock(view: string): string {
  const start = view.indexOf('state: {')
  expect(start, 'chats-view.tsx 里找不到 state 袋').toBeGreaterThan(-1)
  const end = view.indexOf('\n  }', start)
  expect(end, 'state 袋没有收尾').toBeGreaterThan(start)
  return view.slice(start, end)
}

/** 袋里某一格里平铺着的字段名（分组那几行的键不算：它们指向一组，不是道具本身）。 */
function flatOf(block: string): string[] {
  const keys: Set<string> = new Set(SLICES.map((s) => s.key))
  return (block.match(/^ {6}([A-Za-z_$][\w$]*)\??:/gm) ?? [])
    .map((s) => s.slice(6).replace(/:$/, '').replace(/\?$/, ''))
    .filter((n) => !keys.has(n))
}

describe('state 袋按消费方分组', () => {
  const view = readStripped(join(HERE, 'chats-view.tsx'))
  const panel = readStripped(join(HERE, 'Chats.tsx'))
  const bag = bagBlock(view)
  const groups = SLICES.map((s) => ({ ...s, members: membersOf(readStripped(join(HERE, s.file)), s.drop) }))
  const grouped = new Set(groups.flatMap((g) => g.members))

  it('哨兵：四组都真取到了成员、三份文件都真读到了（空清单 ⇒ 下面的断言全是恒真）', () => {
    for (const g of groups) expect(g.members.length, `${g.key} 只量出 ${g.members.length} 件`).toBeGreaterThanOrEqual(5)
    expect(grouped.size, '四组成员合计').toBeGreaterThanOrEqual(60)
    expect(bag.length, 'state 袋太短，没读到内容').toBeGreaterThan(2000)
    expect(panel.length).toBeGreaterThan(5000)
  })

  it('袋里每组的类型**就是**弹窗自己的 props（抄第二份清单就是这次要修掉的东西）', () => {
    for (const g of groups) {
      expect(bag, `袋里少了 ${g.key}: ${g.type}`).toContain(`${g.key}: ${g.type}`)
    }
  })

  it('渲染树整袋展开：组件写了没人挂 = 界面少一屏，且 typecheck 不报错', () => {
    for (const g of groups) {
      const call = jsxCall(view, g.call, g.call)
      expect(call, `${g.call} 的调用点没有整袋展开`).toContain(`{...${g.key}}`)
      // 纯 bag 的那三袋必须**只有**展开这一件事：多出来一件逐件道具就是第二份清单
      if (g.drop.length === 0) expect(call, `${g.call} 调用点除了整袋展开还多传了东西`).toBe(`<${g.call} {...${g.key}} />`)
    }
  })

  it('面板那头真的供上每一袋（供了但渲染树没接、或接了但面板没供，都在这条露出来）', () => {
    for (const g of groups) {
      expect(panel, `Chats.tsx 的 viewState 里没有 ${g.key} 这一袋`).toContain(`${g.key}: {`)
      for (const m of g.members) {
        const lit = panel.slice(panel.indexOf(`${g.key}: {`))
        expect(lit.slice(0, 900), `${g.key} 袋里没供 ${m}`).toContain(m)
      }
    }
  })

  it('群信息抽屉那两个派生道具仍在调用点算（它们不住在袋里）', () => {
    const call = jsxCall(view, 'ChatsGroupInfoView', '群信息调用点')
    expect(call).toContain("isGroup={curSession?.type === 'group'}")
    expect(call).toContain('open={groupInfoOpen}')
    // `isGroup` / `open` 不许混进袋里：它们是这一屏现场算出来的，面板那头没有同名状态
    expect(bag, '袋里不该有 isGroup').not.toContain('\n      isGroup:')
    expect(bag, '袋里不该有 open').not.toContain('\n      open:')
  })

  /**
   * 反退化 + 棘轮：分过组的成员不许再以平铺字段的形式回到袋里；
   * 平铺那一截只许变短（现在是 96 件），并且不许短到"整袋被搬空"那种误删。
   */
  it('平铺字段不许重新长回来（只许变小），且成员不许有两份出处', () => {
    const flat = flatOf(bag)
    expect(flat.length, '读到的平铺字段数').toBeLessThanOrEqual(96)
    expect(flat.length, '平铺字段少得太离谱 —— 多半是整块被误删').toBeGreaterThanOrEqual(60)
    const twice = flat.filter((n) => grouped.has(n))
    expect(twice, `这些成员既在袋里平铺、又在某一组里（两份出处）：${twice.join(' ')}`).toEqual([])
  })

  it('反例自证：把一件成员摊平回袋里，必须被上面那条抓住', () => {
    const fake = bag + '\n      calOpen: boolean\n'
    expect(flatOf(fake).filter((n) => grouped.has(n)).length, '合成违例一个都没命中 ⇒ 这份判据是空的').toBeGreaterThan(0)
    expect(flatOf(bag).filter((n) => grouped.has(n)).length, '真文件本来就命中 ⇒ 上面那条是假绿').toBe(0)
  })
})

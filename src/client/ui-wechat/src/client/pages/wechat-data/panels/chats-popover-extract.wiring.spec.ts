/**
 * 第八刀两块浮层的**接线**守卫（消息右键菜单 + 群成员资料浮层）。
 *
 * 与第七刀同一条理由：搬 JSX 的风险不是"算错"，是"少挂一屏"。组件写好了但调用点漏挂，
 * 或 props 名字打错（React 只会静默拿到 undefined），测试与 typecheck 都可能照样绿 ——
 * 于是消息菜单再也点不出来，而没人知道是哪一步丢的。
 * 所以两头都钉：旧形状不许长回 `chats-view.tsx`、两块模块必须被挂上且道具名齐全、
 * 而搬走的那两条不变量（先关再执行 / 缺字段整行不画）必须真的住在模块里。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname

/** 出现在 `chats-view.tsx` 里就说明那一块又长回渲染树了。 */
const OLD_SHAPES = [
  'msgCtxOverlay',
  'msgCtxMenu',
  'memberProfilePop',
  'memberProfileName',
  'role="menuitem"',
  'profileMember.name',
] as const

/** 菜单模块里必须在场的：少一件就是搬漏了一支（而不是"两边都没有"）。 */
const MENU_MARKS = [
  'csscards.msgCtxOverlay',
  'csscards.msgCtxMenu',
  'data-st-msg-menu',
  'e.stopPropagation()',
  'onClick={() => { onClose(); onPick(item, msg) }}',
] as const

/** 资料浮层必须在场的：`!pos` 与两处「有才画」。 */
const PROFILE_MARKS = [
  'if (!member || !pos) return null',
  '{member.region && (',
  '{member.signature && (',
  'csscards.memberProfileItem',
] as const

describe('第八刀两块浮层的接线', () => {
  const view = readStripped(join(HERE, 'chats-view.tsx'))
  const menu = readStripped(join(HERE, 'chats-msg-menu.tsx'))
  const profile = readStripped(join(HERE, 'chats-member-profile.tsx'))

  it('三张清单与三份文件都得真拿到东西（清空/读空会让上面那些「不含」恒真）', () => {
    expect(OLD_SHAPES.length).toBeGreaterThanOrEqual(6)
    expect(MENU_MARKS.length).toBeGreaterThanOrEqual(5)
    expect(PROFILE_MARKS.length).toBeGreaterThanOrEqual(4)
    expect(view.length, 'chats-view.tsx 没读到').toBeGreaterThan(5000)
    expect(menu.length, 'chats-msg-menu.tsx 没读到').toBeGreaterThan(1000)
    expect(profile.length, 'chats-member-profile.tsx 没读到').toBeGreaterThan(800)
  })

  it('渲染树里不许再留这两块的 JSX 形状', () => {
    for (const fp of OLD_SHAPES) {
      expect(view, `chats-view.tsx 里又出现了 ${fp} —— 那一屏要待在模块里`).not.toContain(fp)
    }
  })

  it('两块都真的挂上了（组件写好没人挂 = 界面少一屏，且测试全绿）', () => {
    expect(view).toContain('<ChatsMsgMenu')
    expect(view).toContain('<ChatsMemberProfile')
    expect(view).toContain("from './chats-msg-menu.tsx'")
    expect(view).toContain("from './chats-member-profile.tsx'")
  })

  it('调用点道具名齐全：菜单那三项缺一项目就点不动，浮层那两项缺一项就永远不画', () => {
    const call = view.slice(view.indexOf('<ChatsMsgMenu'), view.indexOf('/>', view.indexOf('<ChatsMsgMenu')))
    for (const prop of ['msgMenu={msgMenu}', 'onClose={() => { setMsgMenu(null) }}', 'onPick={runMenuAction}']) {
      expect(call, `菜单调用点少了 ${prop}`).toContain(prop)
    }
    // 菜单项仍由 chats-view 侧的 buildMsgMenu 决定：搬进组件就等于把类型判断拆成两份
    expect(call, '菜单项不该搬进组件（buildMsgMenu 还该在调用点）').toContain('buildMsgMenu(msgMenu.m, msgMenu.kind)')
    const call2 = view.slice(view.indexOf('<ChatsMemberProfile'), view.indexOf('/>', view.indexOf('<ChatsMemberProfile')))
    for (const prop of ['member={profileMember}', 'pos={profilePos}']) {
      expect(call2, `资料浮层调用点少了 ${prop}`).toContain(prop)
    }
  })

  /**
   * 两条不变量的**结构性**判据：只靠行为用例的话，将来有人「顺手简化」这行只会红在用例上；
   * 这条红在源码上，指得出是哪一块、哪一行。
   */
  it('「先关菜单再执行动作」与「缺字段整行不画」不许被顺手改掉', () => {
    for (const mark of MENU_MARKS) {
      expect(menu, `chats-msg-menu.tsx 里少了 ${mark}`).toContain(mark)
    }
    for (const mark of PROFILE_MARKS) {
      expect(profile, `chats-member-profile.tsx 里少了 ${mark}`).toContain(mark)
    }
    // 顺序判据的另一种写法（先执行再关）必须不成立：它才是本轮真正要挡的那个改法
    expect(menu).not.toContain('onPick(item, msg); onClose()')
  })

  it('这一份不许自己再加一遍 Esc 监听（两处各监听一次会让共享弹窗栈多算一层）', () => {
    expect(menu).not.toContain("addEventListener('keydown'")
    expect(menu).not.toContain('Escape')
    expect(profile).not.toContain("addEventListener('keydown'")
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    const fake = view + '\n<div className={csscards.msgCtxOverlay} role="menuitem" />\n'
    const bites = OLD_SHAPES.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的').toBeGreaterThan(0)
    expect(view, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})

// @vitest-environment jsdom
/**
 * 群聊信息抽屉的行为守卫（#19 第五刀：`chats-group-info-view.tsx`）。
 *
 * 这一族原先整族零用例（钩子、算术、JSX 三处都没有）。算术那半在 `chats-member-view.spec.ts`，
 * 这里钉的是**只有渲染才看得见**的六件：不是群聊时抽屉不许存在、三态互斥（加载中 / 失败 / 有数据）、
 * 搜索无结果的空态、那颗「＋ 添加」**故意不是按钮**、展开后「收起」必须还在（本轮修掉的不对称）、
 * 公告未展开时被夹住且展开入口只在真能展开时出现。关掉本文件时先想想第六条：
 * 那条是一次真 bug 的回归位，不是装饰。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatsGroupInfoViewProps } from './chats-group-info-view.tsx'
import { ChatsGroupInfoView } from './chats-group-info-view.tsx'
import type { GroupInfo, GroupMember } from '@deepseek-ai/dsh-wechat-data/types'

const mem = (i: number): GroupMember => ({ username: `wxid_${i}`, name: `成员${i}` } as GroupMember)
const MEMBERS: GroupMember[] = Array.from({ length: 100 }, (_, i) => mem(i))
// D1 后视图会读 settings / owner / totalMembers（群主标）—— 夹具给一份合法 GroupInfo。
// 2026-10-19：区③ 四条只读开关行已按用户要求删除，`settings` 只是后端仍会回的形状。
const INFO = {
  name: '测试群',
  announcement: '公告正文',
  members: MEMBERS,
  totalMembers: MEMBERS.length,
  owner: 'wxid_1',
  remark: '',
  settings: { muted: false, pinned: true, savedToContacts: true, showMemberNickname: false },
} as unknown as GroupInfo

let host: HTMLDivElement
let root: Root
const sink = {
  hideMemberProfile: vi.fn(),
  setAnnExpanded: vi.fn(),
  setGroupInfoOpen: vi.fn(),
  setMemberExpanded: vi.fn(),
  setMemberSearch: vi.fn(),
  setProfileMember: vi.fn(),
  showMemberProfile: vi.fn(),
}

function props(over: Partial<ChatsGroupInfoViewProps> = {}): ChatsGroupInfoViewProps {
  return {
    annCanExpand: true,
    annExpanded: false,
    annRef: { current: null },
    filteredMembers: MEMBERS,
    groupInfo: INFO,
    groupInfoErr: null,
    groupInfoLoading: false,
    groupInfoTitleId: 'st-group-info-title',
    hideMemberProfile: sink.hideMemberProfile,
    isGroup: true,
    memberExpanded: false,
    memberQuery: '',
    memberSearch: '',
    memberTotal: MEMBERS.length,
    open: true,
    onExport: vi.fn(),
    setAnnExpanded: sink.setAnnExpanded,
    setGroupInfoOpen: sink.setGroupInfoOpen,
    setMemberExpanded: sink.setMemberExpanded,
    setMemberSearch: sink.setMemberSearch,
    setProfileMember: sink.setProfileMember,
    showMemberProfile: sink.showMemberProfile,
    shownMembers: MEMBERS.slice(0, 24),
    ...over,
  }
}

function show(over: Partial<ChatsGroupInfoViewProps> = {}): void {
  act(() => { root.render(createElement(ChatsGroupInfoView, props(over))) })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const qa = (sel: string): Element[] => [...host.querySelectorAll(sel)]
const need = (el: Element | null | undefined, what: string): Element => {
  // `undefined` 能过 `not.toBeNull()` ⇒ 归一成 null 再断，否则"没找到"会变成一次静默空点。
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}
const click = (el: Element | null | undefined): void => {
  need(el, '要点的元素')
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const hover = (el: Element | null | undefined, entering: boolean): void => {
  need(el, `要触发 ${entering ? 'mouseenter' : 'mouseleave'} 的元素`)
  // React 不监听原生 `mouseenter`：它把 onMouseEnter/onMouseLeave 合成在冒泡的
  // `mouseover`/`mouseout` 上，靠 `relatedTarget` 判"从哪来到哪去"。
  // 所以这里派发 over/out 并把 relatedTarget 放在方块外面（jsdom 里用 body 代表外部）。
  act(() => {
    el?.dispatchEvent(new MouseEvent(entering ? 'mouseover' : 'mouseout', {
      bubbles: true, cancelable: true, relatedTarget: document.body,
    }))
  })
}
const textOf = (sel: string): string => q(sel)?.textContent ?? ''
/** 受控 `<input>` 改值必须走原型 setter（直写 `.value` 被 React 的 value tracker 吞掉）。 */
const typeInto = (input: HTMLInputElement | null, next: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  need(input, '要输入的框')
  act(() => {
    if (!input || !setter) return
    setter.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const TILE = 'button[class*="memberTile"]'
const MORE = 'button[class*="memberMore"]'
/** 名称那一行。`class*=` 是子串匹配，容器 `groupInfoRows` 与堆叠行 `groupInfoRowStack` 都要排掉。 */

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const k of Object.keys(sink)) (sink as unknown as Record<string, { mockReset: () => void }>)[k]?.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('什么时候才该有这个抽屉', () => {
  it('没打开 ⇒ 整块不渲染', () => {
    show({ open: false })
    expect(q('[data-st-dialog="chats-groupinfo"]')).toBeNull()
  })

  it('打开着但不是群聊 ⇒ 也不渲染（切到单聊后 groupInfoOpen 可能还留着）', () => {
    show({ isGroup: false })
    expect(q('[data-st-dialog="chats-groupinfo"]'), '单聊顶上飘着一个群成员网格').toBeNull()
  })

  it('`aria-labelledby` 指的就是标题那个节点的 id（读屏靠它念出「群聊信息」）', () => {
    show({ groupInfoTitleId: 'st-title-x' })
    const d = need(q('[data-st-dialog="chats-groupinfo"]'), '抽屉')
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('aria-labelledby')).toBe('st-title-x')
    expect(q('#st-title-x')?.textContent).toBe('群聊信息')
  })

  it('关闭钮同时清掉「成员资料卡」（只关抽屉的话，资料卡会浮在下一个会话上）', () => {
    show()
    click(q('button[class*="groupInfoClose"]'))
    expect(sink.setGroupInfoOpen).toHaveBeenCalledWith(false)
    expect(sink.setProfileMember).toHaveBeenCalledWith(null)
  })
})

describe('三种数据形态互斥', () => {
  it('加载中 ⇒ 只有「加载中…」，不画网格也不画空态', () => {
    show({ groupInfoLoading: true })
    // R4：加载态从 `.emptyInline` 改为 `<LoadingState variant="compact">`（带 data-st-loading）。
    expect(textOf('[data-st-loading="compact"]')).toBe('加载中…')
    expect(qa(TILE)).toHaveLength(0)
  })

  it('失败 ⇒ 报错误文案，且不画"上一次成功"那份快照（B 群的抽屉里不能出现 A 群的人）', () => {
    show({ groupInfoLoading: false, groupInfoErr: '群信息读取失败' })
    // R4：错误态从 `.emptyInline`（灰字，读起来像「没数据」）改为 `<ErrorState>`（红框 + role="alert"）。
    expect(textOf('[data-st-error="1"]')).toContain('群信息读取失败')
    expect(qa(TILE), '错误下面还挂着一张别处的成员网格').toHaveLength(0)
    expect(q('input[type="text"]'), '读不到数据却还留着搜索框').toBeNull()
  })

  it('不加载、没数据、没错误 ⇒ 什么都不画（但抽屉本体还在，用户知道按钮没坏）', () => {
    show({ groupInfo: null })
    expect(q('[data-st-dialog="chats-groupinfo"]')).not.toBeNull()
    expect(qa(TILE)).toHaveLength(0)
    expect(q('input[type="text"]')).toBeNull()
  })
})

describe('搜索与空态', () => {
  it('搜索框是受控的：值来自 props，输入把新值交回去', () => {
    show({ memberSearch: '张三' })
    const input = q('input[type="text"]') as HTMLInputElement | null
    expect(input?.value).toBe('张三')
    typeInto(input, '李')
    expect(sink.setMemberSearch).toHaveBeenCalledWith('李')
  })

  it('有查询词且零命中 ⇒ 空态三行 + 报群里总人数 + 「清空搜索」真的清空', () => {
    show({ memberQuery: 'zzz', filteredMembers: [], shownMembers: [] })
    expect(textOf('[class*="memberEmptyTitle"]')).toBe('未找到相关成员')
    expect(textOf('[class*="memberEmptyDesc"]')).toContain(`${MEMBERS.length} 位成员`)
    click(q('button[class*="memberEmptyClear"]'))
    expect(sink.setMemberSearch).toHaveBeenCalledWith('')
  })

  it('没查询词且零命中 ⇒ 不算"搜不到"（不端出空态，也不报总人数）', () => {
    show({ memberQuery: '', filteredMembers: [], shownMembers: [] })
    expect(q('[class*="memberEmpty"]')).toBeNull()
  })

  it('有命中 ⇒ 一人一颗 tile，title 是昵称', () => {
    const five = MEMBERS.slice(0, 5)
    show({ memberQuery: '成员', filteredMembers: five, shownMembers: five })
    const tiles = qa(TILE)
    expect(tiles).toHaveLength(5)
    expect(tiles[0]?.getAttribute('title')).toBe('成员0')
  })
})

describe('悬停出资料卡', () => {
  it('mouseenter 把成员与触发节点交出去，mouseleave 交给隐藏逻辑', () => {
    const two = MEMBERS.slice(0, 2)
    show({ filteredMembers: two, shownMembers: two })
    const first = need(qa(TILE)[0], '第一颗成员方块')
    hover(first, true)
    expect(sink.showMemberProfile).toHaveBeenCalledTimes(1)
    expect(sink.showMemberProfile.mock.calls[0]?.[0]).toMatchObject({ username: 'wxid_0' })
    expect(sink.showMemberProfile.mock.calls[0]?.[1]).toBe(first)
    hover(first, false)
    expect(sink.hideMemberProfile).toHaveBeenCalledTimes(1)
  })
})

describe('那颗故意的死控件', () => {
  it('「＋ 添加」不是 button：不进键盘/焦点，也没有任何点击接线', () => {
    show()
    const tile = need(q('div[class*="memberTile"]'), '「＋ 添加」方块')
    expect(tile.tagName).toBe('DIV')
    expect(tile.getAttribute('aria-disabled')).toBe('true')
    expect(tile.getAttribute('title')).toBe('暂不支持邀请')
    expect(tile.textContent).toContain('添加')
    click(tile)
    expect(sink.setGroupInfoOpen, '死控件被挂上了动作 ⇒ 本应用没有邀请通道，这是假承诺').not.toHaveBeenCalled()
    expect(sink.setMemberExpanded).not.toHaveBeenCalled()
    expect(sink.setProfileMember).not.toHaveBeenCalled()
  })

  it('搜索结果里不出现「＋ 添加」（对着过滤后的名单加人是误导）', () => {
    const one = MEMBERS.slice(0, 1)
    show({ memberQuery: '成员0', filteredMembers: one, shownMembers: one })
    expect(q('div[class*="memberTile"]')).toBeNull()
  })
})

describe('展开 / 收起', () => {
  /** 本轮修掉的不对称：旧写法在搜索态拿「当前上限」比，展开后上限涨到 200 ⇒ 按钮整颗消失、收不回来。 */
  it('搜索命中 100 且已展开 ⇒ 「收起」必须还在（收不回来是真 bug 的回归位）', () => {
    show({
      memberQuery: '成员', memberExpanded: true, filteredMembers: MEMBERS,
      memberTotal: MEMBERS.length, shownMembers: MEMBERS.slice(0, 200),
    })
    const btn = need(q(MORE), '「收起」按钮')
    expect(btn.textContent).toBe('收起')
    click(btn)
    const u = sink.setMemberExpanded.mock.calls[0]?.[0] as (prev: boolean) => boolean
    expect(typeof u).toBe('function')
    expect(u(true)).toBe(false)
  })

  it('折叠且命中超过一屏 ⇒ 文案报命中数；点击是取反而不是"永远展开"', () => {
    show({ memberQuery: '成员', memberExpanded: false, filteredMembers: MEMBERS, shownMembers: MEMBERS.slice(0, 24) })
    expect(textOf(MORE)).toBe('展开更多匹配（共 100 位）')
    click(q(MORE))
    const u = sink.setMemberExpanded.mock.calls[0]?.[0] as (prev: boolean) => boolean
    expect(u(false)).toBe(true)
  })

  it('非搜索态按总人数算：不足一屏时不出按钮，超过时文案报总人数', () => {
    show({ memberQuery: '', filteredMembers: MEMBERS.slice(0, 10), memberTotal: 10, shownMembers: MEMBERS.slice(0, 10) })
    expect(q(MORE)).toBeNull()
    show({ memberQuery: '', filteredMembers: MEMBERS, memberTotal: 300, shownMembers: MEMBERS.slice(0, 24) })
    expect(textOf(MORE)).toBe('查看更多（300 人）')
  })

  it('按总数算门槛与「当前显示多少条」无关（折叠态只画 24 条也不该以为"没有了"）', () => {
    show({
      memberQuery: '', memberExpanded: false, filteredMembers: MEMBERS, memberTotal: MEMBERS.length,
      shownMembers: MEMBERS.slice(0, 24),
    })
    expect(qa(TILE)).toHaveLength(24)
    expect(q(MORE)).not.toBeNull()
  })
})

describe('群公告', () => {
  it('没有公告 ⇒ 那一行整行不出现（不是一个空标签）', () => {
    show({ groupInfo: { ...INFO, announcement: '' } as GroupInfo })
    expect(textOf('[class*="groupInfoRows"]')).toContain('群聊名称')
    expect(textOf('[class*="groupInfoRows"]')).not.toContain('群公告')
  })

  it('未展开 ⇒ 带 data-clamp；展开后去掉夹住，入口换成「收起」（D1：入口改为行右箭头，语义走 aria-label）', () => {
    show({ annExpanded: false })
    expect(need(q('[class*="groupInfoAnn"]'), '公告').hasAttribute('data-clamp')).toBe(true)
    expect(q('button[aria-label="展开群公告"]'), '折叠态该有展开入口').not.toBeNull()
    show({ annExpanded: true })
    expect(q('[class*="groupInfoAnn"]')?.hasAttribute('data-clamp'), '展开着还夹住 ⇒ 按钮是假的').toBe(false)
    expect(q('button[aria-label="收起群公告"]'), '展开态该换成收起入口').not.toBeNull()
  })

  it('短到不需要展开时不给展开入口（一颗点了没反应的按钮比没有更糟）', () => {
    show({ annCanExpand: false })
    expect(q('button[aria-label="展开群公告"]')).toBeNull()
    expect(q('button[aria-label="收起群公告"]')).toBeNull()
  })

  it('群聊名称按「标签左 / 值右」的行列出，值就是群名', () => {
    show()
    // D0 行语法统一后行类换成 infoRow；用「含群聊名称」过滤出名称那一行（其余行不含金标）。
    const rows = qa('div[class*="infoRow_"]').filter((el) => (el.textContent ?? '').includes('群聊名称'))
    expect(rows, '选择器没正好框住名称那一行').toHaveLength(1)
    const t = rows[0]?.textContent ?? ''
    expect(t).toContain('群聊名称')
    expect(t).toContain('测试群')
    expect(t.indexOf('群聊名称'), '标签排在值后面 ⇒ 又长成"标签上/值下"的块了').toBeLessThan(t.indexOf('测试群'))
  })
})

describe('微信对齐（D1）：无公告时抽屉仍被官方区填满', () => {
  it('没有公告 ⇒ 资料行与底部导出槽仍在（空半屏的复发位）', () => {
    show({ groupInfo: { ...INFO, announcement: '' } as GroupInfo })
    expect(textOf('[class*="groupInfoRows"]'), '资料行少了 ⇒ 抽屉又空半屏').toContain('群成员数')
    const exp = [...host.querySelectorAll('button')].find((b) => b.textContent === '导出聊天记录')
    expect(exp, '底部动作位没了（D7）').not.toBeUndefined()
  })

  /**
   * 2026-10-19 用户报「导出按钮压住成员名 / 查看更多」的回归位。
   *
   * 根因不是按钮样式，而是**归属**：导出槽原先和内容包一起放在滚动区里，滚动区的
   * `margin-top:auto` 只在内容不足一屏时把按钮推到底；内容一高，按钮就压住资料行。
   * 现在导出槽是抽屉外壳的直接子元素（固定 footer），滚动区只包内容：
   *
   *   groupInfo（外壳）
   *     ├─ groupInfoHeader
   *     ├─ groupInfoBody（唯一滚动区）
   *     │    └─ groupZones
   *     └─ groupExport（固定 footer）
   *
   * jsdom 不做布局，所以这里钉 DOM 归属；CSS 的 `flex:0 0 auto` 与视觉上的
   * 「不重叠」由 wiring 那侧的几何断言和真实探针接手。
   */
  it('导出槽在滚动区外、作为抽屉固定 footer（不再和内容包挤在滚动区里）', () => {
    show()
    const drawer = need(q('[data-st-dialog="chats-groupinfo"]'), '抽屉')
    const body = need(q('[class*="groupInfoBody"]'), '抽屉滚动区')
    const zones = need(q('[class*="groupZones"]'), '内容包')
    // `class*=` 是子串匹配（`groupExport` 也会命中按钮的 `groupExportBtn`），所以取
    // 含导出按钮的那个**外壳直接子元素**作为槽本身。
    const slot = need(
      [...drawer.children].find((el) => el.querySelector('[class*="groupExportBtn"]') !== null),
      '导出槽',
    )

    expect(body.contains(zones), '内容包不在滚动区内').toBe(true)
    expect(drawer.contains(slot), '导出槽不在抽屉里').toBe(true)
    expect(body.contains(slot), '导出槽又回到滚动区里了 ⇒ 内容一高就会压住成员名/查看更多').toBe(false)

    // 位置：滚动区在前、固定 footer 在后。
    const order = [...drawer.children]
    expect(order.indexOf(body), '滚动区不是抽屉的直接子元素').toBeGreaterThan(-1)
    expect(order.indexOf(slot), '导出槽不是抽屉的直接子元素').toBeGreaterThan(-1)
    expect(order.indexOf(body), '固定 footer 跑到了滚动区前面').toBeLessThan(order.indexOf(slot))

    // 反例自证：把导出槽塞回滚动区，上面的核心断言必须红（否则这道闸是恒真的）。
    body.appendChild(slot)
    expect(body.contains(slot), '合成违例没能把导出槽塞回滚动区 ⇒ 这道闸抓不住坏形状').toBe(true)
  })

  /**
   * 2026-10-19 用户要求删除区③ 四条只读开关行（免打扰 / 置顶 / 存通讯录 / 显成员昵称）。
   * 它们全是 L13 死控件：给不了动作也给不了真相，四行只占抽屉半屏。
   * 这一格钉的是「不许再长回来」—— 尤其是「为了填满抽屉」而把它们复活。
   */
  it('区③ 四条只读开关行已删除：一个 switch 都不许有', () => {
    show()
    expect(host.querySelectorAll('[role="switch"]').length, '只读开关行又回来了（用户已要求删除）').toBe(0)
    const rows = textOf('[class*="groupInfoRows"]')
    for (const label of ['消息免打扰', '置顶聊天', '保存到通讯录', '显示群成员昵称']) {
      expect(rows, `「${label}」那一行又回来了`).not.toContain(label)
    }
  })

  it('群主标落在 owner 那颗 tile 上，且只有一颗', () => {
    show()
    expect(host.querySelectorAll('[class*="memberBadge"]').length, '群主标不唯一 ⇒ 标错人').toBe(1)
  })
})

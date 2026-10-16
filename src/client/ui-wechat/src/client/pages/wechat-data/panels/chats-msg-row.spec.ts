// @vitest-environment jsdom
/**
 * 消息行的**行为**守卫（#19 第二刀：`chats-msg-row.tsx`）。
 *
 * 这一段规则全写在注释里，却从来没有用例：头像的身份键在三条分支里各不相同，
 * 而**键错的后果只是"两个人显示同一张头像"** —— 不报错、不告警、看不出来。
 * 注释里那条「以前 fallback 到 `curSession.username`，于是自己和对方显示同一个头像」
 * 就是真出过的事故，现在由用例钉住，而不是靠注释提醒下一个改代码的人。
 *
 * 三个子组件（`Avatar`/`MessageBody`/`MessageImageGroup`）在此**装假**：本文件要断的是
 * 「传给了它们什么」，不是它们自己画成什么样（那三族各有判据）。
 * `renderKindOf` 用真的 —— 「哪一类消息走居中行」正是本行组件依赖的分类口径，
 * 自己 mock 一份就等于把这条契约从测试里删掉了。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MsgRowDeps } from './chats-msg-row.tsx'
import type { MessageRenderItem } from '../utils/message-items.ts'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

const stubs = vi.hoisted(() => ({
  avatars: [] as Array<Record<string, unknown>>,
  bodies: [] as Array<Record<string, unknown>>,
  groups: [] as Array<Record<string, unknown>>,
}))
vi.mock('./chats-support.tsx', () => ({
  Avatar: (p: Record<string, unknown>): React.JSX.Element => {
    stubs.avatars.push(p)
    return createElement('span', { 'data-av': '1', 'data-name': String(p.name ?? ''), 'data-username': String(p.username ?? '') })
  },
}))
vi.mock('./chats-cards.tsx', () => ({
  MessageBody: (p: Record<string, unknown>): React.JSX.Element => {
    stubs.bodies.push(p)
    return createElement('div', {
      'data-body': String((p.m as { localId?: number })?.localId ?? ''),
      'data-chatlog': p.onOpenChatlog ? '1' : '0',
      'data-selfname': String(p.selfName ?? ''),
    })
  },
}))
vi.mock('./chats-media.tsx', () => ({
  MessageImageGroup: (p: Record<string, unknown>): React.JSX.Element => {
    stubs.groups.push(p)
    return createElement('div', { 'data-imgroup': String((p.items as unknown[])?.length ?? 0) })
  },
}))

const { makeMsgRow } = await import('./chats-msg-row.tsx')

const PRIVATE = { username: 'wxid_talker', displayName: '张三', type: 'private' } as WechatSession
const GROUP = { username: '123@chatroom', displayName: '项目群', type: 'group' } as WechatSession
const SELF = 'wxid_me'

let host: HTMLDivElement
let root: Root
const menu = vi.fn()
const viewer = vi.fn()
const chatlog = vi.fn()

const msg = (over: Partial<WechatMessage>): WechatMessage =>
  ({ localId: 7, createTime: 1700000000, type: 1, isSender: 0, ...over } as WechatMessage)

const av = (): Element | null => host.querySelector('[data-av]')
const attrOf = (sel: string, name: string): string | null => host.querySelector(sel)?.getAttribute(name) ?? null

/** 渲染一行，返回行根节点（`null` = 这一行压根不该出现）。 */
function renderRow(item: MessageRenderItem, deps: Partial<MsgRowDeps> = {}): Element | null {
  const render = makeMsgRow({
    curSession: PRIVATE,
    editedIds: new Set<number>(),
    openChatlog: chatlog,
    openMsgMenu: menu,
    openViewer: viewer,
    selfWxid: SELF,
    ...deps,
  })
  act(() => { root.render(createElement('div', { id: 'wrap' }, render(item))) })
  return host.querySelector('#wrap')?.firstElementChild ?? null
}

const asMsg = (m: WechatMessage): MessageRenderItem => ({ kind: 'msg', m })

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  stubs.avatars.length = 0
  stubs.bodies.length = 0
  stubs.groups.length = 0
  menu.mockReset()
  viewer.mockReset()
  chatlog.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('行结构（深链与守卫都认这些锚点）', () => {
  it('日期分隔：只有标签，没有 id、没有头像', () => {
    const el = renderRow({ kind: 'day', label: '9 月 26 日', key: 'd-1' })
    expect(el, '分隔行没画出来').not.toBeNull()
    expect(el?.id, '日期分隔**不该**有 msg-* 的 id（深链只认消息）').toBe('')
    expect(el?.className).toContain('msgDayDivider')
    expect(el?.textContent).toContain('9 月 26 日')
    expect(av()).toBeNull()
  })

  it('普通消息带 `msg-<localId>` 的 id（locateMessage 与深链靠它找节点）', () => {
    const el = renderRow(asMsg(msg({ localId: 42 })))
    expect(el?.id).toBe('msg-42')
  })

  it('系统提示 / 撤回 / 拍一拍 / 无内容 ⇒ 居中行、没有头像与气泡列', () => {
    for (const [label, m] of [
      ['系统提示(10000)', msg({ type: 10000 })],
      ['撤回(10002)', msg({ type: 10002 })],
      ['拍一拍', msg({ renderType: 'pat' as WechatMessage['renderType'] })],
      ['无内容(11000)', msg({ type: 11000 })],
    ] as Array<[string, WechatMessage]>) {
      renderRow(asMsg(m))
      const rowEl = host.querySelector('.msgRowSystem') ?? host.querySelector('[class*="msgRowSystem"]')
      expect(rowEl, `${label} 该走居中行`).not.toBeNull()
      expect(rowEl?.id, `${label} 仍要有 id（撤回行也要能被深链定位）`).toBe('msg-7')
      expect(av(), `${label} 不该出现头像`).toBeNull()
      expect(host.querySelector('[data-body]'), `${label} 只画一次正文`).not.toBeNull()
      act(() => { root.render(createElement('div', { id: 'wrap' })) })
    }
  })

  it('居中行的正文不带「打开聊天记录」入口（那是卡片才有的）', () => {
    renderRow(asMsg(msg({ type: 10000 })))
    expect(attrOf('[data-body]', 'data-chatlog'), '系统行也接了 chatlog 入口 ⇒ 点击区域跑到了灰字上').toBe('0')
    expect(attrOf('[data-body]', 'data-selfname')).toBe(PRIVATE.username)
  })

  it('普通消息的正文带「打开聊天记录」入口（合并转发卡片要靠它）', () => {
    renderRow(asMsg(msg({ type: 1 })))
    expect(attrOf('[data-body]', 'data-chatlog')).toBe('1')
    expect(stubs.bodies[0]?.onOpenChatlog).toBe(chatlog)
    expect(stubs.bodies[0]?.onOpenImage, '开原图的回调要透传').toBe(viewer)
  })
})

describe('头像的身份键（错了只会"两个人同一张头像"，没人报错）', () => {
  it('私聊对方 ⇒ 用会话 username 与显示名', () => {
    renderRow(asMsg(msg({ isSender: 0 })))
    expect(attrOf('[data-av]', 'data-username')).toBe('wxid_talker')
    expect(attrOf('[data-av]', 'data-name')).toBe('张三')
  })

  it('自己 ⇒ 用登录账号的 wxid，绝不用会话 username', () => {
    renderRow(asMsg(msg({ isSender: 1 })))
    expect(attrOf('[data-av]', 'data-username')).toBe(SELF)
    expect(attrOf('[data-av]', 'data-name')).toBe('我')
  })

  it('账号 wxid 还不知道 ⇒ 留空（宁可占位，也不要键到对方头像上）', () => {
    renderRow(asMsg(msg({ isSender: 1 })), { selfWxid: '' })
    expect(attrOf('[data-av]', 'data-username'), '这就是当年"我和对方同一张头像"的那条 fallback').toBe('')
  })

  it('群成员 ⇒ 用消息里的 sender；解析不出来时留空，绝不拿昵称当键', () => {
    renderRow(asMsg(msg({ sender: 'wxid_a', senderName: '小李' })), { curSession: GROUP })
    expect(attrOf('[data-av]', 'data-username')).toBe('wxid_a')
    expect(attrOf('[data-av]', 'data-name'), '显示名用 senderName').toBe('小李')

    renderRow(asMsg(msg({ sender: undefined, senderName: '小李' })), { curSession: GROUP })
    const avEl = host.querySelector('[data-av]')
    expect(avEl?.getAttribute('data-username'), '同名成员会互相顶掉头像').toBe('')
    expect(avEl?.getAttribute('data-name')).toBe('小李')
  })

  it('群成员没有 senderName ⇒ 显示名退到 sender 本身（至少有名字，不是空白）', () => {
    renderRow(asMsg(msg({ sender: 'wxid_b' })), { curSession: GROUP })
    expect(attrOf('[data-av]', 'data-name')).toBe('wxid_b')
  })
})

describe('群里那行发言人名字', () => {
  it('群消息 + 别人发的 + 有 sender ⇒ 画出发言人；自己发的不画', () => {
    renderRow(asMsg(msg({ sender: 'wxid_a', senderName: '小李' })), { curSession: GROUP })
    const who = host.querySelector('[class*="msgSender"]')
    expect(who, '群里要标出是谁发的').not.toBeNull()
    expect(who?.textContent).toBe('小李')

    renderRow(asMsg(msg({ isSender: 1 })), { curSession: GROUP })
    expect(host.querySelector('[class*="msgSender"]'), '自己发的不需要再标一遍').toBeNull()

    renderRow(asMsg(msg({ sender: 'wxid_a' })), { curSession: PRIVATE })
    expect(host.querySelector('[class*="msgSender"]'), '私聊不画发言人').toBeNull()
  })
})

describe('已编辑标记与图片组', () => {
  it('在 editedIds 里的消息 ⇒ 时间戳那枚气泡带上「已编辑」', () => {
    renderRow(asMsg(msg({ localId: 9 })), { editedIds: new Set([9]) })
    expect(host.textContent).toContain('已编辑')
    renderRow(asMsg(msg({ localId: 9 })), { editedIds: new Set([8]) })
    expect(host.textContent).not.toContain('已编辑')
  })

  it('图片组走 MessageImageGroup，且整组只画一行（不是每张一行）', () => {
    const items = [msg({ localId: 3, type: 3 }), msg({ localId: 4, type: 3 })]
    renderRow({ kind: 'group', items, gid: 'g-1' })
    expect(attrOf('[data-imgroup]', 'data-imgroup')).toBe('2')
    expect(stubs.bodies, '图片组不该再走单条正文').toHaveLength(0)
    expect(host.querySelector('[data-av]'), '图片组仍要有头像（它是别人的消息）').not.toBeNull()
    expect(host.querySelector('[class*="msgBubbleTight"]'), '连拍要贴紧的气泡').not.toBeNull()
    expect(stubs.groups[0]?.username, '取原图要带会话 username').toBe(PRIVATE.username)
    expect(stubs.groups[0]?.onOpenAt, '点开要走同一个开图入口').toBe(viewer)
  })

  it('图片组是空的（只剩个 gid）⇒ 这一行不画，别炸', () => {
    expect(renderRow({ kind: 'group', items: [], gid: 'g-2' })).toBeNull()
  })

  it('没有会话（列表还没选中人）⇒ 什么都不画', () => {
    expect(renderRow(asMsg(msg({})), { curSession: null })).toBeNull()
  })
})

describe('右键菜单', () => {
  it('右键一行 ⇒ 把这一条消息与它的渲染种类交给面板', () => {
    const m = msg({ localId: 5, type: 3 })
    const el = renderRow(asMsg(m))
    expect(el).not.toBeNull()
    act(() => { el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    expect(menu).toHaveBeenCalledTimes(1)
    const args = menu.mock.calls[0] as [unknown, WechatMessage, string]
    expect(args[1]).toBe(m)
    expect(args[2], '种类要按 renderKindOf 现算（这里 type 3 是图片）').toBe('image')
  })
})

/* ── 长按（触摸端的「右键」）────────────────────────────────────────────────
   为什么这一族必须有行为用例：触摸上既没有右键也没有 :hover，长按是**唯一**的入口；
   而它坏掉的样子是「按了没反应」或「滚动时菜单乱弹」—— 桌面端的回归测试一条都碰不到。
   jsdom 没有 PointerEvent 构造器，所以用普通 Event 再把坐标/pointerType 挂上去
   （React 只按事件名派发、不校验实例类型；`cancelable: true` 才测得到 preventDefault）。 */
describe('长按菜单（触摸端的右键）', () => {
  /** 造一个带坐标与 pointerType 的指针事件。 */
  const pev = (type: string, over: Record<string, unknown> = {}): Event => {
    const ev = new Event(type, { bubbles: true, cancelable: true })
    return Object.assign(ev, { clientX: 20, clientY: 30, pointerType: 'touch', button: 0, ...over })
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('按住 500ms ⇒ 用按压点的坐标打开菜单（与右键走同一个入口）', () => {
    const m = msg({ localId: 11, type: 3 })
    const el = renderRow(asMsg(m))
    act(() => { el?.dispatchEvent(pev('pointerdown', { clientX: 77, clientY: 88 })) })
    expect(menu, '还没到阈值就弹 ⇒ 会与滚动手势抢').not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(500) })
    expect(menu).toHaveBeenCalledTimes(1)
    const args = menu.mock.calls[0] as [{ clientX: number, clientY: number }, WechatMessage, string]
    expect(args[1]).toBe(m)
    expect(args[2]).toBe('image')
    expect([args[0].clientX, args[0].clientY], '坐标要落在手指按下的地方（平板/宽屏上菜单就出在那儿）')
      .toEqual([77, 88])
  })

  it('没到 500ms 就抬手 ⇒ 不弹（短按是点按，不是长按）', () => {
    const el = renderRow(asMsg(msg({ localId: 12 })))
    act(() => { el?.dispatchEvent(pev('pointerdown')) })
    act(() => { vi.advanceTimersByTime(300) })
    act(() => { el?.dispatchEvent(pev('pointerup')) })
    act(() => { vi.advanceTimersByTime(400) })
    expect(menu).not.toHaveBeenCalled()
  })

  it('按住后移动超过 10px ⇒ 取消（滚消息列表时不该乱弹菜单）', () => {
    const el = renderRow(asMsg(msg({ localId: 13 })))
    act(() => { el?.dispatchEvent(pev('pointerdown', { clientY: 300 })) })
    act(() => { el?.dispatchEvent(pev('pointermove', { clientY: 260 })) })
    act(() => { vi.advanceTimersByTime(800) })
    expect(menu, '滚动被当成长按 ⇒ 手指一滑就弹菜单').not.toHaveBeenCalled()
  })

  it('鼠标按下不启动长按（桌面端只走右键，不引入第二套手势口径）', () => {
    const el = renderRow(asMsg(msg({ localId: 14 })))
    act(() => { el?.dispatchEvent(pev('pointerdown', { pointerType: 'mouse' })) })
    act(() => { vi.advanceTimersByTime(900) })
    expect(menu).not.toHaveBeenCalled()
  })

  it('系统手势打断（pointercancel）⇒ 取消', () => {
    const el = renderRow(asMsg(msg({ localId: 15 })))
    act(() => { el?.dispatchEvent(pev('pointerdown')) })
    act(() => { el?.dispatchEvent(pev('pointercancel')) })
    act(() => { vi.advanceTimersByTime(900) })
    expect(menu).not.toHaveBeenCalled()
  })

  it('长按已触发后的抬手要 preventDefault —— 否则浏览器补发的 mousedown 打在遮罩上，菜单一闪就关', () => {
    const el = renderRow(asMsg(msg({ localId: 16 })))
    act(() => { el?.dispatchEvent(pev('pointerdown')) })
    act(() => { vi.advanceTimersByTime(500) })
    expect(menu).toHaveBeenCalledTimes(1)
    const up = pev('pointerup')
    act(() => { el?.dispatchEvent(up) })
    expect(up.defaultPrevented, '菜单会被自己那次抬手关掉（触摸上等于「长按没用」）').toBe(true)
  })

  it('普通点按的抬手**不**能 preventDefault（消息流里点对方那条 = 选中做分析，click 必须留着）', () => {
    const el = renderRow(asMsg(msg({ localId: 17 })))
    act(() => { el?.dispatchEvent(pev('pointerdown')) })
    const up = pev('pointerup')
    act(() => { el?.dispatchEvent(up) })
    expect(up.defaultPrevented, '把普通点按也压掉 ⇒ 触摸上选不中消息做分析').toBe(false)
  })
})

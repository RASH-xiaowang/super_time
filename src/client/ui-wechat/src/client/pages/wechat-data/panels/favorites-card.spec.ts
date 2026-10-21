// @vitest-environment jsdom
/**
 * 收藏卡片的行为判据（#22 虚拟化：`favorites-card.tsx`）。
 *
 * 挑这几条来测的理由：虚拟化之后每一行都会**反复挂载/卸载**，于是"行挂上就请求缩略图"这条
 * 新规则必须钉住两件事 —— 该请求时请求一次（重复渲染不许再敲后端）、不该请求时一次都不敲
 * （没有图片的条目）。另外卡片在「批量选择」模式下语义是复选框，这一条以前就存在，
 * 搬进组件之后如果丢掉，键盘用户与读屏会静默失去状态播报，所以一起钉。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import { FavCard } from './favorites-card.tsx'

const fav = (over: Partial<FavorItem> = {}): FavorItem => ({
  localId: 7, type: 2, typeLabel: '', title: '', desc: '', url: '', updateTime: 0, time: '',
  content: '<fav><title>图文</title><datalist><dataitem datatype="2" dataid="aaa"><thumbfullmd5>th</thumbfullmd5></dataitem></datalist></fav>',
  fromUsr: '', chatName: '', source: '', ...over,
})

const onActivate = vi.fn((_f: FavorItem): void => {})
const onMounted = vi.fn((_md5: string): void => {})

let host: HTMLDivElement
let root: Root

function show(over: Partial<React.ComponentProps<typeof FavCard>> = {}): void {
  act(() => {
    root.render(createElement(FavCard, {
      f: fav(), selectMode: false, checked: false, thumbs: {}, onActivate, onMounted, ...over,
    }))
  })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const need = (el: Element | null | undefined, what: string): Element => {
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  onActivate.mockReset()
  onMounted.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('FavCard', () => {
  it('挂载一条带图片的收藏 ⇒ 请求它的缩略图（取 thumbfullmd5 那一份，不是原图）', () => {
    show()
    expect(onMounted.mock.calls.map((c) => c[0])).toEqual(['th'])
  })

  it('没有图片的条目一次都不请求（否则每张文字收藏都要敲一次后端）', () => {
    show({ f: fav({ content: '<fav><datalist><dataitem datatype="1"><datadesc>纯文本</datadesc></dataitem></datalist></fav>' }) })
    expect(onMounted).not.toHaveBeenCalled()
  })

  it('同一行重复渲染只请求一次（虚拟化滚动时每一行都会因位置变化重渲染）', () => {
    show()
    show()
    show({ thumbs: { th: 'data:image/png;base64,th' } })
    expect(onMounted.mock.calls.map((c) => c[0])).toEqual(['th'])
  })

  it('换成另一条带不同 md5 的收藏 ⇒ 会再请求一次（不是"这一行请求过就永远不再请求"）', () => {
    show()
    show({ f: fav({ content: '<fav><datalist><dataitem datatype="2" dataid="other"></dataitem></datalist></fav>' }) })
    expect(onMounted.mock.calls.map((c) => c[0])).toEqual(['th', 'other'])
  })

  it('缩略图解码到了才渲染 <img>；没解码到时不留破图', () => {
    show()
    expect(q('img')).toBeNull()
    show({ thumbs: { th: 'data:image/png;base64,th' } })
    const img = need(q('img'), '缩略图')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,th')
    // 出网点纪律：图片一律后端代理，界面自己不向远程主机要图
    expect(img.getAttribute('referrerPolicy')).toBe('no-referrer')
  })

  it('非选择模式下是按钮，点击把这一条原样交回面板（面板决定是开详情还是勾选）', () => {
    show()
    const card = need(q('[data-fav-id="7"]'), '卡片')
    expect(card.getAttribute('role')).toBe('button')
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const calls = onActivate.mock.calls
    expect(calls).toHaveLength(1)
    expect((calls[0]?.[0] as FavorItem).localId).toBe(7)
  })

  it('批量选择模式下是复选框，勾上时有可见的勾与 aria-checked（读屏不能只靠颜色）', () => {
    show({ selectMode: true, checked: true })
    const card = need(q('[data-fav-id="7"]'), '卡片')
    expect(card.getAttribute('role')).toBe('checkbox')
    expect(card.getAttribute('aria-checked')).toBe('true')
    const box = need(q('[data-checked]'), '勾选框')
    expect(box.getAttribute('data-checked')).toBe('true')
    expect(box.textContent).toBe('✓')
    show({ selectMode: true, checked: false })
    expect(need(q('[data-fav-id="7"]'), '卡片').getAttribute('aria-checked')).toBe('false')
    expect(q('[data-checked]'), '未勾上时不该有 data-checked').toBeNull()
  })

  it('标题/摘要/落款都要有（卡片的主信息不能随重构丢掉）', () => {
    // 摘要这一格走的是「没有资源条目时回退 desc」那一支：带 dataitem 的收藏摘要取自 text 部分。
    show({ f: fav({ content: '<fav><title>x</title></fav>', title: '后端标题', desc: '后端描述', source: '某群', time: '2026-09-01 10:00' }) })
    const text = host.textContent ?? ''
    expect(text).toContain('后端标题')
    expect(text).toContain('后端描述')
    // 底栏按截图拆成「类型 · 来源」与日期两列，文本节点不再连续。
    expect(text).toContain('图片 · 某群')
    expect(text).toContain('2026-09-01 10:00')
  })

  it('每种收藏都有来源头像位；没有可解码头像时显示来源首字', () => {
    show({
      f: fav({
        type: 8,
        typeLabel: '文件',
        avatar: '',
        source: '设计群',
        content: '<fav><datalist><dataitem datatype="8"><datatitle>报价单.pdf</datatitle><datafmt>pdf</datafmt></dataitem></datalist></fav>',
      }),
    })
    const avatar = need(q('[class*="favCardAvatar"]'), '卡片来源头像')
    expect(avatar.textContent).toBe('设')
  })

  it('有资源条目时摘要取自文本条目（不是整段 desc），并且图片条目不会自己变成一行空摘要', () => {
    show({ f: fav({ content: '<fav><datalist><dataitem datatype="1"><datadesc>条目里的正文</datadesc></dataitem><dataitem datatype="2" dataid="m"></dataitem></datalist></fav>', desc: '整段描述' }) })
    const text = host.textContent ?? ''
    expect(text).toContain('条目里的正文')
    expect(text).not.toContain('整段描述')
  })

  it('聊天记录收藏的卡片预览只取前两条正文，并带上发送者前缀', () => {
    show({
      f: fav({
        type: 14,
        content: '<fav><title>群聊的聊天记录</title><datalist>'
          + '<dataitem datatype="1"><datadesc>第一条</datadesc><datasrcname>甲</datasrcname></dataitem>'
          + '<dataitem datatype="1"><datadesc>第二条</datadesc><datasrcname>乙</datasrcname></dataitem>'
          + '<dataitem datatype="1"><datadesc>第三条</datadesc><datasrcname>丙</datasrcname></dataitem>'
          + '</datalist></fav>',
      }),
    })
    const text = host.textContent ?? ''
    expect(text).toContain('甲：第一条')
    expect(text).toContain('乙：第二条')
    expect(text).not.toContain('丙：第三条')
  })
})

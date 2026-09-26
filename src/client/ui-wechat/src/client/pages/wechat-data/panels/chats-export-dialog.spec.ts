// @vitest-environment jsdom
/**
 * 导出消息弹窗的行为守卫（#19 第四刀：`chats-export-dialog.tsx`）。
 *
 * 这一屏是面板里唯一"填了半天、一个动作全丢"的地方：遮罩判断写错一次就是
 * 「点在对话框里也关掉」，而格式/类型/时间范围/目录全在当场，没有第二处能看见。
 * 其余几条也直接影响产出：一个类型都没选时是**全部**（不是 0 类）、`0` 那格代表「全部」、
 * `total<=0` 只能是不确定态（不然会画出一条停在 0% 的假进度）、导出中必须同时锁住主按钮
 * 并给出「中止」。这些改前**一条用例都没有**（只有一份 `chats-export-hook.spec.ts` 管钩子那一半）。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatsExportDialogProps } from './chats-export-dialog.tsx'
import { ChatsExportDialog } from './chats-export-dialog.tsx'

const FORMATS = [{ value: 'txt', label: 'TXT' }, { value: 'html', label: 'HTML' }, { value: 'md', label: 'Markdown' }]
const TYPES = [{ key: 'text', label: '文本', types: [1] }, { key: 'image', label: '图片', types: [3] }]

let host: HTMLDivElement
let root: Root
const sink = {
  cancelExport: vi.fn(),
  chooseExportDir: vi.fn(async (): Promise<void> => undefined),
  exportSession: vi.fn(async (): Promise<void> => undefined),
  setExpCount: vi.fn(),
  setExpFilename: vi.fn(),
  setExpFormat: vi.fn(),
  setExpFrom: vi.fn(),
  setExpTo: vi.fn(),
  setExpTypes: vi.fn(),
  setExpZip: vi.fn(),
  setExportOpen: vi.fn(),
}

function props(over: Partial<ChatsExportDialogProps> = {}): ChatsExportDialogProps {
  return {
    EXPO_FORMATS: FORMATS,
    EXPO_TYPES: TYPES,
    cancelExport: sink.cancelExport,
    chooseExportDir: sink.chooseExportDir,
    expCount: 0,
    expDir: '',
    expFilename: '',
    expFormat: 'txt',
    expFrom: '',
    expTo: '',
    expTypes: [],
    expZip: false,
    exportOpen: true,
    exportProgress: null,
    exportSession: sink.exportSession,
    exporting: false,
    pickingDir: false,
    setExpCount: sink.setExpCount,
    setExpFilename: sink.setExpFilename,
    setExpFormat: sink.setExpFormat,
    setExpFrom: sink.setExpFrom,
    setExpTo: sink.setExpTo,
    setExpTypes: sink.setExpTypes,
    setExpZip: sink.setExpZip,
    setExportOpen: sink.setExportOpen,
    ...over,
  }
}

function show(over: Partial<ChatsExportDialogProps> = {}): void {
  act(() => { root.render(createElement(ChatsExportDialog, props(over))) })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const qa = (sel: string): Element[] => [...host.querySelectorAll(sel)]
const click = (el: Element | null | undefined): void => {
  // `undefined` 能过 `not.toBeNull()` ⇒ 归一成 null 再断，否则"元素没找到"会变成一次静默空点。
  expect(el ?? null, '要点的元素没找到').not.toBeNull()
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
/** 按钮的 `disabled` 在 DOM 上是属性， jsdom 会同步反映。 */
const disabled = (el: Element | null | undefined): boolean => el?.hasAttribute('disabled') ?? false
const textOf = (sel: string): string => q(sel)?.textContent ?? ''
/**
 * 进度标签。`textCaptionTrunc` 在树上出现两次（目录那一格也用它），
 * 只按类名查会拿到前面那条 ⇒ 必须按"进度块里 exportField 的直接子节点"定位。
 */
const PROGRESS_LABEL = '[class*="exportField"] > [class*="textCaptionTrunc"]'
/**
 * 条数那四格。`class*=` 是子串匹配 ⇒ 光写 `exportChip` 会同时捞到容器 `exportChips`
 * 和类型那批 `exportChipCheck`，所以限定 `button` 并把 Check 变体排掉。
 */
const COUNT_CHIPS = 'button[class*="exportChip"]:not([class*="exportChipCheck"])'
/** 「选择目录」那枚按钮：`exportBtn` 是 `exportBtnGhost`/`exportBtnPrimary` 的前缀，必须排掉。 */
const DIR_BTN = 'button[class*="exportBtn"]:not([class*="exportBtnGhost"]):not([class*="exportBtnPrimary"])'
/**
 * 改受控 `<input>` 的值：React 在节点上挂了 value tracker，直接写 `el.value` 再派发
 * `input` 会被判定为"值没变"而吞掉事件 —— 必须走原型 setter 绕开 tracker 的取值。
 */
const typeInto = (input: HTMLInputElement | null, next: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  expect(input ?? null, '要输入的框没找到').not.toBeNull()
  expect(setter ?? null, 'jsdom 没给 <input> 的原型 value setter').not.toBeNull()
  act(() => {
    if (!input || !setter) return
    setter.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** 勾/取消 `<input type=checkbox>`：React 对复选框听的是 `click`，派发 `change` 不会触发 onChange。 */
const toggleBox = (box: HTMLInputElement | null): void => {
  expect(box ?? null, '复选框没找到').not.toBeNull()
  act(() => { box?.click() })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const k of Object.keys(sink)) (sink as unknown as Record<string, { mockReset: () => void }>)[k]?.mockReset()
  sink.chooseExportDir.mockResolvedValue(undefined)
  sink.exportSession.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('开关与关闭路径', () => {
  it('没打开 ⇒ 整块不渲染（弹窗不该藏在 DOM 里）', () => {
    show({ exportOpen: false })
    expect(q('[data-st-dialog="chats-export"]')).toBeNull()
    expect(q('[role="dialog"]')).toBeNull()
  })

  it('打开 ⇒ `role=dialog` + `aria-modal` + 那个 `data-st-dialog` 名字（焦点管理与若干守卫按名字找它）', () => {
    show()
    const d = q('[data-st-dialog="chats-export"]')
    expect(d).not.toBeNull()
    expect(d?.getAttribute('role')).toBe('dialog')
    expect(d?.getAttribute('aria-modal')).toBe('true')
  })

  it('点遮罩本身 ⇒ 关；点在对话框里面 ⇒ 不关（这条写错就是"填半天一碰全丢"）', () => {
    show()
    click(q('[class*="exportDialog"]'))
    expect(sink.setExportOpen, '点在对话框内部也会关闭 ⇒ 用户选的格式/目录随时会丢').not.toHaveBeenCalled()
    click(q('[data-st-dialog="chats-export"]'))
    expect(sink.setExportOpen).toHaveBeenCalledWith(false)
  })

  it('右上角关闭钮 ⇒ 关', () => {
    show()
    click(q('[class*="calClose"]'))
    expect(sink.setExportOpen).toHaveBeenCalledWith(false)
  })
})

describe('格式与内容', () => {
  it('一个类型都没选 ⇒ 徽章写「全部消息」（不是 "0 类消息"）', () => {
    show({ expTypes: [] })
    expect(textOf('[class*="exportCountBadge"]')).toBe('全部消息')
    show({ expTypes: ['text'] })
    expect(textOf('[class*="exportCountBadge"]')).toBe('1 类消息')
  })

  it('格式卡只有当前那一项是 active，点击把它的 value 交回去', () => {
    show({ expFormat: 'txt' })
    const cards = qa('[class*="exportFormatCard"]')
    expect(cards).toHaveLength(FORMATS.length)
    expect(cards.filter((c) => c.hasAttribute('data-active'))).toHaveLength(1)
    expect(cards[0]?.hasAttribute('data-active'), 'txt 才是当前项').toBe(true)
    click(cards[1])
    expect(sink.setExpFormat).toHaveBeenCalledWith('html')
  })

  it('条数那格：0 显示「全部」，点 50 交回 50，且只有匹配项 active', () => {
    show({ expCount: 0 })
    const chips = qa(COUNT_CHIPS)
    expect(chips, '选择器没正好框住那四格（子串匹配会连带 exportChipCheck）').toHaveLength(4)
    expect(chips.map((c) => c.textContent)).toEqual(['10 条', '50 条', '100 条', '全部'])
    expect(chips[3]?.hasAttribute('data-active'), 'expCount=0 时「全部」该高亮').toBe(true)
    click(chips[1])
    expect(sink.setExpCount).toHaveBeenCalledWith(50)
  })

  it('「全选」在空与非空间互为反向：空 ⇒ 交回全部 key，非空 ⇒ 交回空表', () => {
    show({ expTypes: [] })
    expect(textOf('[class*="exportLinkBtn"]')).toBe('全选')
    click(qa('[class*="exportLinkBtn"]')[0])
    const updater = sink.setExpTypes.mock.calls[0]?.[0] as (prev: readonly string[]) => readonly string[]
    expect(updater(TYPES.map((t) => t.key))).toEqual([])
    expect(updater([])).toEqual(['text', 'image'])

    sink.setExpTypes.mockClear()
    show({ expTypes: ['text'] })
    expect(textOf('[class*="exportLinkBtn"]')).toBe('取消全选')
    click(qa('[class*="exportLinkBtn"]')[0])
    const u2 = sink.setExpTypes.mock.calls[0]?.[0] as (prev: readonly string[]) => readonly string[]
    expect(u2(['text', 'image'])).toEqual([])
  })

  it('单个类型 chip：已含则移除、未含则追加（不产生重复项）', () => {
    show({ expTypes: ['text'] })
    const checks = qa('[class*="exportChipCheck"]')
    click(checks[0])
    let u = sink.setExpTypes.mock.calls[0]?.[0] as (prev: readonly string[]) => readonly string[]
    expect(u(['text'])).toEqual([])
    sink.setExpTypes.mockClear()
    click(checks[1])
    u = sink.setExpTypes.mock.calls[0]?.[0] as (prev: readonly string[]) => readonly string[]
    expect(u(['text'])).toEqual(['text', 'image'])
    expect(u(['text']).filter((k) => k === 'image')).toHaveLength(1)
  })
})

describe('时间范围、文件名与目录', () => {
  it('「全部时间」把两端都清空（只清一端会留下半截区间）', () => {
    show({ expFrom: '2026-09-01', expTo: '2026-09-20' })
    const btn = qa('[class*="exportLinkBtn"]').find((b) => b.textContent === '全部时间')
    click(btn ?? null)
    expect(sink.setExpFrom).toHaveBeenCalledWith('')
    expect(sink.setExpTo).toHaveBeenCalledWith('')
  })

  it('文件名与 ZIP 勾选都是受控写回', () => {
    show({ expFilename: 'a', expZip: false })
    const input = q('input[type="text"]') as HTMLInputElement | null
    expect(input?.value).toBe('a')
    typeInto(input, 'b')
    expect(sink.setExpFilename).toHaveBeenCalledWith('b')

    const box = q('input[type="checkbox"]') as HTMLInputElement | null
    expect(box?.checked, 'expZip=false 时不该预先勾上').toBe(false)
    toggleBox(box)
    expect(sink.setExpZip).toHaveBeenCalledWith(true)
  })

  it('目录：空白路径算"未选"（trim 之后再判），选了就把真路径显示出来', () => {
    show({ expDir: '   ' })
    expect(textOf('[class*="exportDirTitle"]')).toBe('尚未选择保存目录')
    expect(textOf('[class*="textCaptionTrunc"]')).toContain('~/.dsh/wechat-data/exports')
    expect(q('[class*="exportDirBox"]')?.hasAttribute('data-chosen'), '全是空白也算已选 ⇒ 用户以为选过了').toBe(false)

    show({ expDir: '  D:\\exports\\x  ' })
    expect(textOf('[class*="exportDirTitle"]')).toBe('已选择保存目录')
    expect(textOf('[class*="textCaptionTrunc"]')).toBe('D:\\exports\\x')
    expect(q('[class*="exportDirBox"]')?.hasAttribute('data-chosen')).toBe(true)
  })

  it('选择目录中 ⇒ 按钮禁用且文案换掉（重复点会开第二个系统对话框）', async () => {
    show({ pickingDir: false })
    const before = qa(DIR_BTN)
    expect(before, '选择器没正好框住「选择目录」那一枚').toHaveLength(1)
    click(before[0])
    expect(sink.chooseExportDir).toHaveBeenCalledTimes(1)
    show({ pickingDir: true })
    const btn = q(DIR_BTN)
    expect(disabled(btn)).toBe(true)
    expect(btn?.textContent).toContain('选择中')
  })
})

describe('进度与导出中', () => {
  it('没有进度 ⇒ 一条假进度杠都不画', () => {
    show({ exportProgress: null })
    expect(q('[role="progressbar"]')).toBeNull()
  })

  it('total>0 ⇒ 按百分比；done 超过 total 时封顶 100', () => {
    show({ exportProgress: { phase: 'writing', done: 3, total: 12 } })
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25')
    expect(textOf(PROGRESS_LABEL)).toBe('writing · 3 / 12')
    show({ exportProgress: { phase: 'writing', done: 99, total: 12 } })
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
  })

  it('total<=0 ⇒ 不确定态（没有总数时停在 0% 是在谎报"没动"）', () => {
    show({ exportProgress: { phase: 'packing', done: 7, total: 0 } })
    const bar = q('[role="progressbar"]')
    expect(bar?.hasAttribute('data-indeterminate'), 'total=0 却按 0% 画').toBe(true)
    expect(bar?.hasAttribute('aria-valuenow'), '不确定态不该报一个具体百分比').toBe(false)
    expect(textOf(PROGRESS_LABEL)).toBe('packing · 7')
  })

  it('phase 为空时退回「导出中」（不给用户看一个空标签）', () => {
    show({ exportProgress: { phase: '', done: 1, total: 2 } })
    expect(textOf(PROGRESS_LABEL)).toBe('导出中 · 1 / 2')
  })

  it('导出中：主按钮锁住换文案，并出现「中止导出」；没在导出时不给中止按钮', () => {
    show({ exporting: false })
    const primary = qa('[class*="exportBtnPrimary"]')[0]
    expect(primary?.textContent).toBe('导出')
    expect(disabled(primary)).toBe(false)
    expect(textOf('[class*="exportActions"]')).not.toContain('中止导出')
    click(primary ?? null)
    expect(sink.exportSession).toHaveBeenCalledTimes(1)

    show({ exporting: true })
    const p2 = qa('[class*="exportBtnPrimary"]')[0]
    expect(p2?.textContent).toBe('导出中…')
    expect(disabled(p2), '导出中还能再点一次 ⇒ 两个任务同时写同一个目录').toBe(true)
    const stop = qa('[class*="exportBtnGhost"]').find((b) => b.textContent === '中止导出')
    click(stop ?? null)
    expect(sink.cancelExport).toHaveBeenCalledTimes(1)
  })
})

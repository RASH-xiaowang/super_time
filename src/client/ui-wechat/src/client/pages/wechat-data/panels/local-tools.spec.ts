// @vitest-environment jsdom
/**
 * 「本地工具」页的行为守卫（2026-11-24）。
 *
 * 两件事值得钉住：
 *  ① **接线**：新页签要真的能从侧栏进来（nav-config 可见条目 → WechatDataPanel 分支 →
 *     panel-loaders 懒加载）。少一环就是「点了没反应」，而单看任意一个文件都像是好的。
 *  ② **卡片说的是真话**：`needs-config` 必须显示成「待配置」并写出缺什么；
 *     参数里必填项要带 `*`；搜索能按调用名命中（排查时拿到的往往就是 `weather`
 *     这种英文调用名，不是中文名）。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalToolsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'

const SNAPSHOT: LocalToolsSnapshot = {
  updatedAt: 1,
  groups: [
    { id: 'retrieval', label: '微信数据检索', note: '' },
    { id: 'reply', label: 'AI 回复', note: '' },
    { id: 'local', label: '本机能力', note: '' },
  ],
  items: [
    {
      id: 'retrieval:search_messages', group: 'retrieval', name: '消息关键词检索', callName: 'search_messages',
      summary: '消息类工具', description: '在消息里按关键词检索。',
      params: [{ name: 'query', required: true, type: 'string', note: '≤ 80 字' }],
      status: 'ready', builtin: true, enabled: true, source: 'src/backend/wechat-data/src/query/tools/message-tools.ts', online: false,
    },
    {
      id: 'reply:weather', group: 'reply', name: '天气查询', callName: 'weather',
      summary: '查目标消息里那座城市的天气。', description: '查目标消息中城市的当前天气。',
      params: [{ name: 'city', required: true, type: 'string' }],
      status: 'needs-config', statusNote: '未选择天气数据源（open-meteo）。',
      builtin: true, enabled: true, source: 'src/backend/wechat-data/src/query/reply-tools/registry.ts', online: true,
    },
    {
      id: 'local:backup', group: 'local', name: '备份与恢复', callName: 'createBackup',
      summary: '把解密库与媒体打包成可迁移备份。', description: '把解密库与媒体打包成可迁移备份。',
      params: [], status: 'ready', builtin: true, enabled: true, source: 'src/backend/wechat-data/src/query/backup.ts', online: false,
    },
    {
      id: 'custom:glossary', group: 'retrieval', name: '术语表', callName: 'glossary',
      summary: '固定回答（不查数据、不出网）', description: '本团队口径',
      params: [], status: 'ready', builtin: false, kind: 'answer', enabled: true,
      participation: ['ask'], source: '本机工具注册表（tool_custom）', online: false,
    },
    {
      id: 'custom:recent_transfers', group: 'retrieval', name: '最近三个月转账', callName: 'recent_transfers',
      summary: '封装 search_records（已固定 from）', description: '查最近三个月的转账明细。',
      params: [{ name: 'query', required: false, type: 'string' }],
      status: 'ready', builtin: false, kind: 'alias', enabled: false,
      participation: ['ask'], target: 'search_records', fixed: { from: '2026-08-01' },
      source: '本机工具注册表（tool_custom）', online: false,
    },
  ],
}

const apiGetLocalTools = vi.fn<() => Promise<LocalToolsSnapshot>>()
const apiSetLocalToolEnabled = vi.fn(async () => ({ ok: true }))
const apiDeleteLocalTool = vi.fn(async () => ({ ok: true }))
const apiSaveLocalTool = vi.fn(async (input: { name?: string }) => ({ ok: true, item: { ...SNAPSHOT.items[3]!, callName: input.name, name: '新工具' } }))
const apiGetLocalToolConfig = vi.fn(async () => ({
  weather: { provider: '', access: '', apiKeySaved: false },
  search: { provider: '', apiKeySaved: false },
  weatherProviders: [{ value: '', label: '（未选择）' }, { value: 'open-meteo', label: 'Open-Meteo' }],
  weatherAccessModes: [{ value: '', label: '（未选择）' }, { value: 'noncommercial', label: '非商用' }],
  searchProviders: [{ value: '', label: '（未选择）' }, { value: 'brave', label: 'Brave Search' }],
}))
vi.mock('../api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api.ts')>()
  return { ...mod, apiGetLocalTools, apiSetLocalToolEnabled, apiDeleteLocalTool, apiGetLocalToolConfig, apiSaveLocalTool }
})

/** 在 mock 生效之后再导入面板（模块顶层会读到被 mock 的 api）。 */
const { LocalToolsPanel } = await import('./LocalTools.tsx')

let host: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  apiGetLocalTools.mockReset()
  apiGetLocalTools.mockResolvedValue(SNAPSHOT)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-tool-id]')]

async function render(): Promise<void> {
  await act(async () => { root.render(createElement(LocalToolsPanel)) })
  await flush()
}

/** 在搜索框里输入（受控组件要派发 input 事件，react 才会收到 onChange）。 */
function typeSearch(value: string): void {
  const input = host.querySelector<HTMLInputElement>('input[type="search"], input[aria-label="搜索本地工具"]')
  if (input === null) throw new Error('找不到搜索框')
  setValue(input, value)
}

/** 给受控 input/textarea 赋值（必须走原型 setter，否则 react 收不到变更）。 */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 抽屉 portal 到 document.body：按可访问名找控件。 */
function inDrawer<T extends Element>(selector: string): T {
  const el = document.body.querySelector<T>(selector)
  if (el === null) throw new Error(`抽屉里找不到 ${selector}`)
  return el
}

/** 给受控 <select> 选值（React 监听的是 change）。 */
function setSelect(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** 点开抽屉里的「新建工具」。 */
async function openNewTool(): Promise<void> {
  const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes('新建工具'))
  expect(create, '找不到新建按钮').toBeTruthy()
  await act(async () => { create?.click() })
  await flush()
}

describe('本地工具：卡片与状态', () => {
  it('每个工具一张卡，计数如实', async () => {
    await render()
    expect(cards()).toHaveLength(5)
    expect(host.textContent ?? '').toContain('共 5 个工具')
    expect(host.textContent ?? '').toContain('显示 5 个')
  })

  it('默认工具没有「删除」，自定义工具有「编辑 / 删除」', async () => {
    await render()
    const builtin = host.querySelector<HTMLElement>('[data-tool-id="retrieval:search_messages"]')
    expect(builtin?.textContent ?? '', '默认工具出现了删除按钮').not.toContain('删除')
    const custom = host.querySelector<HTMLElement>('[data-tool-id="custom:glossary"]')
    expect(custom?.textContent ?? '').toContain('自定义')
    expect(custom?.textContent ?? '').toContain('编辑')
    expect(custom?.textContent ?? '').toContain('删除')
  })

  it('停用的工具显示「已停用」，且卡片能被认出来', async () => {
    await render()
    const off = host.querySelector<HTMLElement>('[data-tool-id="custom:recent_transfers"]')
    expect(off?.dataset['disabled']).toBe('true')
    expect(off?.textContent ?? '').toContain('已停用')
  })

  it('点击「停用」调后端并带上取反后的状态', async () => {
    await render()
    apiSetLocalToolEnabled.mockClear()
    const card = host.querySelector<HTMLElement>('[data-tool-id="retrieval:search_messages"]')
    const button = [...(card?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '') === '停用')
    expect(button, '找不到停用按钮').toBeTruthy()
    await act(async () => { (button as HTMLButtonElement).click() })
    await flush()
    expect(apiSetLocalToolEnabled).toHaveBeenCalledWith({ name: 'search_messages', enabled: false })
  })

  it('待配置的天气卡有「配置」入口，打开后能选数据源', async () => {
    await render()
    const card = host.querySelector<HTMLElement>('[data-tool-id="reply:weather"]')
    const button = [...(card?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '') === '配置')
    expect(button, '待配置的卡片没有配置入口').toBeTruthy()
    await act(async () => { (button as HTMLButtonElement).click() })
    await flush()
    expect(apiGetLocalToolConfig).toHaveBeenCalled()
    // 抽屉 portal 到 document.body
    const text = document.body.textContent ?? ''
    expect(text).toContain('天气查询')
    expect(text).toContain('数据源')
    expect(text).toContain('Open-Meteo')
  })

  it('新建按钮打开编辑抽屉，里面有「执行方式」两个模板', async () => {
    await render()
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes('新建工具'))
    expect(create, '找不到新建按钮').toBeTruthy()
    await act(async () => { create?.click() })
    await flush()
    // 抽屉走 Radix Portal，挂在 document.body 下（不在面板的 host 里）。
    const text = document.body.textContent ?? ''
    expect(text).toContain('执行方式')
    expect(text).toContain('预设封装')
    expect(text).toContain('固定回答')
  })

  it('预设封装：勾选参数后真的保持勾选，并出现固定值输入框', async () => {
    await render()
    await openNewTool()
    setSelect(inDrawer<HTMLSelectElement>('select[aria-label="被封装的工具"]'), 'search_messages')
    await flush()

    const box = inDrawer<HTMLInputElement>('input[aria-label="固定 query"]')
    expect(box.checked, '刚打开时不该是勾上的').toBe(false)
    await act(async () => { box.click() })
    await flush()

    // 这一格就是「勾选不了」的回归点：勾上之后值先为空串，不能因此把自己判回未勾选
    expect(inDrawer<HTMLInputElement>('input[aria-label="固定 query"]').checked).toBe(true)
    const valueInput = inDrawer<HTMLInputElement>('input[aria-label="query 的固定值"]')
    expect(valueInput.value).toBe('')
    expect(document.body.textContent ?? '').toContain('填上值才会生效')
  })

  it('预设封装：没填任何固定值时提交被前端拦住并说清原因', async () => {
    await render()
    await openNewTool()
    setValue(inDrawer<HTMLInputElement>('input[aria-label="工具显示名称"]'), '最近转账')
    setSelect(inDrawer<HTMLSelectElement>('select[aria-label="被封装的工具"]'), 'search_messages')
    await flush()
    setValue(inDrawer<HTMLTextAreaElement>('textarea[aria-label="工具说明"]'), '查最近的转账')

    apiSaveLocalTool.mockClear()
    const save = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '') === '创建工具')
    await act(async () => { save?.click() })
    await flush()
    expect(apiSaveLocalTool).not.toHaveBeenCalled()
    expect(document.body.textContent ?? '').toContain('固定值')
  })

  it('新建固定回答工具：填标题自动出调用名，提交时把 name 与 isNew 一起发出去', async () => {
    await render()
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes('新建工具'))
    await act(async () => { create?.click() })
    await flush()

    // 只填中文标题，调用名应当自动变成合法的 tool_xxxx
    setValue(inDrawer<HTMLInputElement>('input[aria-label="工具显示名称"]'), '术语表')
    const nameInput = inDrawer<HTMLInputElement>('input[aria-label="工具调用名"]')
    expect(nameInput.value).toMatch(/^tool_[0-9a-f]{4}$/)

    // 选「固定回答」并填正文与说明
    const answerKind = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '').includes('固定回答'))
    act(() => { answerKind?.click() })
    setValue(inDrawer<HTMLTextAreaElement>('textarea[aria-label="工具说明"]'), '本团队对「回款」的定义')
    setValue(inDrawer<HTMLTextAreaElement>('textarea[aria-label="固定回答"]'), '回款=客户已付款未到账')

    apiSaveLocalTool.mockClear()
    const save = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '') === '创建工具')
    expect(save, '找不到创建按钮').toBeTruthy()
    await act(async () => { save?.click() })
    await flush()

    expect(apiSaveLocalTool).toHaveBeenCalledTimes(1)
    const payload = apiSaveLocalTool.mock.calls[0]?.[0] as Record<string, unknown>
    // 这是此前必定失败的那一格：新建时 name 被整段丢掉了
    expect(payload['name'], '新建时没有把调用名发给后端').toMatch(/^tool_[0-9a-f]{4}$/)
    expect(payload['isNew']).toBe(true)
    expect(payload['kind']).toBe('answer')
    expect(payload['answer']).toBe('回款=客户已付款未到账')
    expect(payload['title']).toBe('术语表')
  })

  it('调用名被清空时拦住提交（不发请求，提示可自动生成）', async () => {
    await render()
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes('新建工具'))
    await act(async () => { create?.click() })
    await flush()
    setValue(inDrawer<HTMLInputElement>('input[aria-label="工具显示名称"]'), '术语表')
    setValue(inDrawer<HTMLInputElement>('input[aria-label="工具调用名"]'), '')

    apiSaveLocalTool.mockClear()
    const save = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '') === '创建工具')
    await act(async () => { save?.click() })
    await flush()
    expect(apiSaveLocalTool, '不合法的调用名不该发到后端').not.toHaveBeenCalled()
    expect(document.body.textContent ?? '').toContain('自动生成')
  })

  it('needs-config 显示「待配置」并写出缺什么；ready 显示「可用」', async () => {
    await render()
    const weather = host.querySelector<HTMLElement>('[data-tool-id="reply:weather"]')
    expect(weather?.dataset['status']).toBe('needs-config')
    expect(weather?.textContent ?? '').toContain('待配置')
    expect(weather?.textContent ?? '').toContain('未选择天气数据源')
    const backup = host.querySelector<HTMLElement>('[data-tool-id="local:backup"]')
    expect(backup?.textContent ?? '').toContain('可用')
  })

  it('卡片带调用名、参数与源文件（排查时的三条线索）', async () => {
    await render()
    const card = host.querySelector<HTMLElement>('[data-tool-id="retrieval:search_messages"]')
    expect(card?.querySelector('code')?.textContent).toBe('search_messages')
    expect(card?.textContent ?? '').toContain('query*')
    expect(card?.textContent ?? '').toContain('tools/message-tools.ts')
  })

  it('按调用名搜索也能命中（英文名是日志里看到的那个）', async () => {
    await render()
    typeSearch('weather')
    expect(cards().map((el) => el.dataset['toolId'])).toEqual(['reply:weather'])
  })

  it('按分组过滤', async () => {
    await render()
    const local = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => (button.textContent ?? '').includes('本机能力'))
    expect(local, '找不到「本机能力」筛选').toBeTruthy()
    act(() => { local?.click() })
    expect(cards().map((el) => el.dataset['toolId'])).toEqual(['local:backup'])
  })

  it('搜索无结果给空态，不留下空白网格', async () => {
    await render()
    typeSearch('不存在的工具名')
    expect(cards()).toHaveLength(0)
    expect(host.textContent ?? '').toContain('没有匹配的工具')
  })
})

// @vitest-environment jsdom
/**
 * 「提交 Bug 与建议」弹窗的行为判据。
 *
 * 守四件事：
 *   ① 引导内容齐全（标题 / 三条步骤 / 隐私提醒）—— 这些文案本身就是产品需求，
 *      被删掉不会让任何类型或构建报错；
 *   ② 「打开提交页面」真的把**官方 https 地址**交给系统浏览器；
 *   ③ 「复制诊断信息」写进剪贴板的是版本与平台（mock 主进程桥 + clipboard），
 *      而不是一句空话或用户数据；
 *   ④ 浏览器里没有 `window.electronAPI` 时仍能打开、复制，不能因为读版本而崩。
 *
 * Radix Dialog 的 Portal / 焦点副作用要跨多个宏任务才落 DOM，所以用 setTimeout(0)
 * 的 flush（同 `ui/confirm.a11y.spec.ts`）。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import {
  BUG_REPORT_URL,
  BugReportDialog,
  buildBugReportDiagnostics,
  openBugReportForm,
  openExternalUrl,
} from './BugReportDialog.tsx'
import { setCapabilities } from '../api.ts'

const VERSIONS = {
  app: '1.2.3',
  electron: '33.2.0',
  chrome: '130.0.0',
  node: '20.18.0',
  platform: 'win32',
  arch: 'x64',
} as const

let host: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn<() => void>>
let getVersions: ReturnType<typeof vi.fn<() => Promise<Record<string, string>>>>
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
let openSpy: MockInstance<typeof window.open>

/** Radix 的 Portal / 焦点与 effect 都跨宏任务；逐轮 setTimeout(0) 并包在 act 里。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    })
  }
}

/** 按可见文字找按钮（弹窗里没有同名按钮）。 */
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')]
    .find((el) => el.textContent?.trim() === text)
  expect(found, `找不到按钮：${text}`).toBeDefined()
  return found as HTMLButtonElement
}

async function renderDialog(): Promise<void> {
  act(() => {
    root.render(createElement(BugReportDialog, { open: true, onClose }))
  })
  await flush()
}

beforeEach(() => {
  onClose = vi.fn<() => void>()
  getVersions = vi.fn<() => Promise<Record<string, string>>>(async () => VERSIONS)
  writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined)
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { getVersions },
  })
  // 组件现在按统一能力表决定能否碰桥（capabilities.wiring 不允许面板自己判环境）。
  setCapabilities({
    isDesktop: true, isBrowser: false, desktopEquivalent: false,
    dirPicker: false, capturePanel: false, shellOpen: false,
    license: false, diag: false, update: false,
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  // Radix Portal 挂在 body 下；逐个摘掉，避免下一条用例查到上一次的 DOM。
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  Reflect.deleteProperty(window, 'electronAPI')
  setCapabilities({
    isDesktop: false, isBrowser: true, desktopEquivalent: false,
    dirPicker: false, capturePanel: false, shellOpen: false,
    license: false, diag: false, update: false,
  })
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(navigator, 'platform')
  Reflect.deleteProperty(navigator, 'userAgent')
  vi.restoreAllMocks()
})

describe('Bug 反馈弹窗：引导内容与外部入口', () => {
  it('标题、三条步骤与隐私提醒都渲染出来', async () => {
    await renderDialog()
    expect(onClose).not.toHaveBeenCalled()

    const text = document.body.textContent ?? ''
    expect(text).toContain('提交 Bug 与建议')
    expect(text, '缺少引导语').toContain('遇到问题或有好建议')
    expect(text).toContain('复现步骤')
    expect(text).toContain('现场证据')
    expect(text).toContain('使用环境')
    expect(text, '三条步骤没有编号').toMatch(/1.*复现步骤.*2.*现场证据.*3.*使用环境/s)
    expect(text, '缺少醒目的隐私提醒').toContain('请勿提交聊天记录原文、数据库密钥、License、API Key 等敏感信息。')
    expect(text, '没有说明外部链接行为').toContain('将在系统浏览器中打开')
  })

  it('点「打开提交页面」用官方 https 地址调用 window.open，且弹窗不自动关闭', async () => {
    await renderDialog()
    act(() => { button('打开提交页面').click() })
    await flush()

    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy).toHaveBeenCalledWith(BUG_REPORT_URL, '_blank', 'noopener,noreferrer')
    // 打开外部浏览器没有可靠的失败信号：弹窗留着，用户还能手动复制链接。
    expect(onClose, '打开提交页面后不应自动关闭弹窗').not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(BUG_REPORT_URL)
  })

  it('openExternalUrl 只放行 https，拒绝 http / javascript / file', () => {
    expect(new URL(BUG_REPORT_URL).protocol).toBe('https:')
    expect(openExternalUrl(BUG_REPORT_URL)).toBe(true)
    expect(openSpy).toHaveBeenLastCalledWith(BUG_REPORT_URL, '_blank', 'noopener,noreferrer')

    for (const bad of ['http://www.kdocs.cn/l/cmLRic6J3AR4', 'javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe']) {
      expect(openExternalUrl(bad), `不该放行 ${bad}`).toBe(false)
    }
    expect(openSpy).toHaveBeenCalledTimes(1)

    openBugReportForm()
    expect(openSpy).toHaveBeenCalledTimes(2)
  })

  it('「复制诊断信息」写入含版本与平台的可粘贴文本，并提示已复制', async () => {
    await renderDialog()
    expect(getVersions, '打开弹窗时没去取运行时版本').toHaveBeenCalledTimes(1)

    act(() => { button('复制诊断信息').click() })
    await flush(8)

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain(`应用版本：${VERSIONS.app}`)
    expect(copied).toContain(`系统平台：${VERSIONS.platform}`)
    expect(copied).toContain(`系统架构：${VERSIONS.arch}`)
    expect(copied).toContain(`Electron：${VERSIONS.electron}`)
    expect(copied).toContain(`Chromium：${VERSIONS.chrome}`)
    expect(document.body.textContent).toContain('已复制诊断信息')
  })
})

describe('Bug 反馈弹窗：浏览器兜底与纯函数', () => {
  /** jsdom 默认没有真实 UA / platform：给一个 Chrome-on-Linux 的稳定事实。 */
  function stubBrowserFacts(): void {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' })
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    })
  }

  it('没有 Electron 桥（手机浏览器）时用 UA 兜底出具体平台与 Chromium 版本', async () => {
    stubBrowserFacts()
    Reflect.deleteProperty(window, 'electronAPI')
    await renderDialog()
    expect(document.body.textContent).toContain('提交 Bug 与建议')

    act(() => { button('复制诊断信息').click() })
    await flush(8)

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0]?.[0] ?? ''
    expect(copied, '没有取到浏览器平台').toContain('系统平台：Linux x86_64')
    expect(copied, '没有把 UA 里的 Chromium 版本解析出来').toContain('Chromium：130.0.0.0')
    expect(copied).not.toContain('系统平台：未知')
  })

  it('交接态把整段 UA 塞进 chrome 时不污染诊断信息', async () => {
    stubBrowserFacts()
    getVersions.mockResolvedValue({
      app: '1.2.3',
      electron: 'browser',
      chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      node: '',
      platform: '',
      arch: '',
    })
    await renderDialog()

    act(() => { button('复制诊断信息').click() })
    await flush(8)

    const copied = writeText.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('应用版本：1.2.3')
    expect(copied, '整段 UA 不该被当成 Chromium 版本').toContain('Chromium：130.0.0.0')
    expect(copied, '“browser”不是可定位问题的版本号').not.toContain('Electron：browser')
    expect(copied).toContain('系统平台：Linux x86_64')
  })

  it('复制失败时展示可手动选中的诊断信息（不让用户去猜版本）', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    await renderDialog()

    act(() => { button('复制诊断信息').click() })
    await flush(8)

    expect(document.body.textContent).toContain('复制失败')
    const manual = document.querySelector('pre[aria-label="诊断信息（可手动复制）"]')
    expect(manual, '复制失败后没有给出可手动复制的诊断信息').not.toBeNull()
    expect(manual?.textContent).toContain('应用版本：1.2.3')
  })

  it('buildBugReportDiagnostics 对缺失字段容错，且只输出白名单字段', () => {
    const full = buildBugReportDiagnostics(VERSIONS)
    expect(full).toContain('1.2.3')
    expect(full).toContain('win32')
    expect(full).toContain('x64')
    expect(full).toContain('33.2.0')
    expect(full).toContain('130.0.0')

    const sparse = buildBugReportDiagnostics({ app: '1.2.3' })
    expect(sparse).toContain('应用版本：1.2.3')
    expect(sparse, '缺失字段应显示未知而不是 undefined').toContain('未知')
    expect(sparse).not.toContain('undefined')

    // 隐私承诺要能验证：每一行都必须来自固定的字段白名单。
    const allowed = /^(Super Time 微信数据 · Bug 诊断信息|应用版本：|系统平台：|系统架构：|Electron：|Chromium：|Node\.js：|隐私提醒：)/
    for (const line of full.split('\n').filter((l) => l !== '')) {
      expect(allowed.test(line), `诊断信息里出现了白名单之外的内容：${line}`).toBe(true)
    }
  })
})

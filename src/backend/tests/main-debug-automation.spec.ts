/**
 * 主进程调试自动化的行为与“不回流 main.js”的守卫。
 *
 * 这段逻辑以前直接写在 `main.js` 里，渲染层的 DOM selector 因此泄露进 Electron
 * 主进程；抽出来后，这里锁住两件事：纯行为仍然正确，以及 main.js 只挂载、不再持有实现。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  clickLabels,
  installScreenshotAutomation,
  runScreenshotAutomation,
  scrollTarget,
} from '../main-debug-automation.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('主进程截图自动化', () => {
  it('SUPERTIME_CLICK 按竖线拆分、去空白并丢弃空段', () => {
    expect(clickLabels({ SUPERTIME_CLICK: '  A | B | | C  ' })).toEqual(['A', 'B', 'C'])
    expect(clickLabels({})).toEqual([])
  })

  it('SUPERTIME_SCROLL 保持原语义：缺失为 NaN，明确字符串转数字', () => {
    expect(Number.isNaN(scrollTarget({}))).toBe(true)
    expect(scrollTarget({ SUPERTIME_SCROLL: '520' })).toBe(520)
  })

  it('完整跑一遍时按顺序执行主题/页签/点击/地图/滚动并写截图', async () => {
    const executed: string[] = []
    const webContents = {
      async executeJavaScript(code: string) {
        executed.push(code)
        return code.includes('SUPERTIME_CLICK') ? true : {}
      },
      async capturePage() {
        return { toPNG: () => Buffer.from('png') }
      },
    }
    const written: Array<[string, Buffer]> = []
    const env = {
      SUPERTIME_SCREENSHOT: 'C:\\shots\\panel.png',
      SUPERTIME_THEME: 'light',
      SUPERTIME_TAB: '世界板块',
      SUPERTIME_CLICK: '展开 | 详情',
      SUPERTIME_MAP_DEBUG: '1',
      SUPERTIME_SCROLL: '520',
    }

    const result = await runScreenshotAutomation({
      window: { webContents: webContents as never },
      env,
      writeFileSync: (path: string, data: Buffer) => written.push([path, data]),
      sleep: async () => {},
    })

    expect(result).toEqual({ started: true })
    expect(executed.length).toBe(7)
    expect(executed[0]).toContain('theme-light')
    expect(executed[1]).toContain('世界板块')
    expect(executed.filter((code) => code.includes('textContent')).length).toBeGreaterThanOrEqual(4)
    expect(executed.at(-1)).toContain('scrollTop')
    expect(written).toEqual([['C:\\shots\\panel.png', Buffer.from('png')]])
  })

  it('未启用时只返回 null，不占用定时器', () => {
    const setTimeoutFn = vi.fn()
    expect(installScreenshotAutomation({
      getWindow: () => null,
      app: { quit: () => {} },
      env: {},
      setTimeoutFn,
    })).toBeNull()
    expect(setTimeoutFn).not.toHaveBeenCalled()
  })

  it('main.js 只挂载自动化模块，不再持有渲染层调试实现', () => {
    const main = readFileSync(join(ROOT, 'main.js'), 'utf8')
    expect(main).toContain("require('./src/backend/main-debug-automation')")
    expect(main).toContain('installScreenshotAutomation({ getWindow: () => mainWindow, app })')
    expect(main).not.toContain('SUPERTIME_SCREENSHOT')
    expect(main).not.toContain('SUPERTIME_MAP_DEBUG')
    expect(main).not.toContain('SUPERTIME_SCROLL')
    expect(main).not.toContain("document.querySelector('[data-theme-toggle]')")
  })
})

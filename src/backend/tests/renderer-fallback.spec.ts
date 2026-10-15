/**
 * ui-dist 缺失时的演示页兜底不再把 IPC 返回的动态值当 HTML 解析。
 *
 * 这个 fallback 只在 `src/backend/main-window.js` 找不到前端产物时加载，但
 * 版本号、Remote 方法名都来自运行时 IPC 数据。`innerHTML` 会让这些字符串
 * 具备标记语义；这里用 `createElement` + `textContent` 后，即使名字里带
 * `<img onerror=...>` 也只会成为可见文本。
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const rendererSource = readFileSync(join(ROOT, 'src', 'renderer.js'), 'utf8')

function runFallback(electronAPI: unknown) {
  const original = document.querySelector('#renderer-fallback')
  original?.remove()
  const host = document.createElement('div')
  host.id = 'renderer-fallback'
  host.innerHTML = `
    <ul id="versions"></ul>
    <p id="wechat-info"></p>
    <select id="wechat-method" disabled></select>
    <button id="wechat-call" disabled></button>
    <pre id="wechat-result"></pre>
    <button id="open-file"></button>
    <button id="reveal" disabled></button>
    <button id="ping"></button>
  `
  document.body.append(host)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: electronAPI,
  })
  // renderer.js 是普通浏览器脚本，不是模块；eval 能完整跑出两个异步初始化入口。
  window.eval(rendererSource)
  return host
}

async function settle() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('demo renderer fallback', () => {
  it('版本与 Remote 方法名按文本写入 DOM，不产生子元素或属性注入', async () => {
    const api = {
      getVersions: async () => ({
        electron: '<img src=x onerror=globalThis.__versionInjected=1>',
        chrome: 'chrome',
        node: 'node',
        platform: 'win32',
        arch: 'x64',
      }),
      wechat: {
        info: async () => ({
          ok: true,
          value: {
            root: 'root',
            decrypted: 'decrypted',
            selfUsername: 'user',
            methods: ['getSessions', '<option>x</option><img src=x onerror=globalThis.__methodInjected=1>'],
            llmConfigured: false,
          },
        }),
        call: async () => ({ ok: true, value: null }),
        onEvent: () => {},
      },
      openFile: async () => ({ canceled: true, files: [] }),
      showInFolder: async () => {},
      ping: async () => 'pong',
    }

    runFallback(api)
    await settle()

    const versionItems = [...document.querySelectorAll<HTMLElement>('#versions li')]
    expect(versionItems).toHaveLength(4)
    expect(versionItems[0]?.querySelector('strong')?.textContent)
      .toBe('<img src=x onerror=globalThis.__versionInjected=1>')
    expect(versionItems[0]?.querySelector('img')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__versionInjected).toBeUndefined()

    const select = document.querySelector<HTMLSelectElement>('#wechat-method')!
    expect(select.options).toHaveLength(2)
    expect(select.options[1]?.value)
      .toBe('<option>x</option><img src=x onerror=globalThis.__methodInjected=1>')
    expect(select.options[1]?.textContent)
      .toBe('<option>x</option><img src=x onerror=globalThis.__methodInjected=1>')
    expect(select.querySelector('option img')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__methodInjected).toBeUndefined()
    expect(select.disabled).toBe(false)
  })

  it('源码不再把运行时数据拼进 innerHTML', () => {
    const assignments = rendererSource
      .split(/\r?\n/)
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => /innerHTML\s*=/.test(line))
    expect(assignments).toEqual([])
  })
})

/**
 * 「打开网页」的接线守卫（2026-10-19）。
 *
 * 这条链路横跨四处（标题栏按钮 / preload / 主进程控制面 / 卡片 preload），
 * 任何一处掉线在真机上都很像「按钮点了没反应」。这里用源码形状一次性钉住：
 *   ① 标题栏按钮真的调 `webHandoff.open`；
 *   ② preload 暴露同一组方法（类型面见 `electron-api.wiring.spec.ts`）；
 *   ③ main.js 创建控制面、并在退出时 dispose；
 *   ④ 卡片窗口有拖动区，但只有「返回桌面」一个可点动作，且不暴露 `electronAPI`。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('标题栏「打开网页」接线', () => {
  it('标题栏状态区有按钮，并调用 webHandoff.open', () => {
    const src = read('src/client/ui-app/titlebar-status.tsx')
    expect(src).toContain('打开网页')
    expect(src).toContain('window.electronAPI?.webHandoff')
    expect(src).toContain('bridge.open()')
    expect(src).toContain('aria-label="在默认浏览器中打开"')
  })

  it('preload 暴露 open / restore / state 三个方法', () => {
    const src = read('preload.js')
    expect(src).toContain('webHandoff: {')
    for (const method of ['open', 'restore', 'state']) {
      expect(src).toContain(`${method}: () => ipcRenderer.invoke('browser-handoff:${method}')`)
    }
  })

  it('主进程创建控制面，退出时 dispose', () => {
    const src = read('main.js')
    expect(src).toContain("require('./src/backend/browser-handoff')")
    expect(src).toContain('createBrowserHandoff({')
    expect(src).toContain('browserHandoff.dispose()')
    expect(src).toContain('getMainWindow: () => mainWindow')
  })
})

describe('交接态：浏览器与桌面端同权限', () => {
  it('handoff-boot 在 capabilities 之前执行，并安装原生代理桥', () => {
    const entry = read('src/client/ui-app/ui-entry.tsx')
    const bootAt = entry.indexOf("import './handoff-boot.ts'")
    const capsAt = entry.indexOf("import { bypassLocalGates, capabilities } from './capabilities.ts'")
    expect(bootAt, 'ui-entry 没有引入交接态引导').toBeGreaterThanOrEqual(0)
    expect(capsAt).toBeGreaterThan(bootAt)
    const boot = read('src/client/ui-app/handoff-boot.ts')
    expect(boot).toContain("mode=desktop") // 实际是 searchParams.get('mode') === 'desktop'
    expect(boot).toContain("'/api/native/'")
    for (const m of ['pickDirectory', 'capturePanel', 'saveFileDialog', 'showInFolder', 'openFile']) {
      expect(boot, `交接态桥缺 ${m}`).toContain(`${m}:`)
    }
    expect(boot).toContain('license:')
    expect(boot).toContain('diag:')
    expect(boot).toContain('update:')
    expect(boot).toContain('remoteAccess:')
    expect(boot).toContain('wechat:')
  })

  it('能力表把交接态计入原生能力；降级卡与动作判据都放行', () => {
    const caps = read('src/client/ui-app/capabilities.ts')
    expect(caps).toContain('desktopEquivalent')
    expect(caps).toContain('(isDesktop || desktopEquivalent)')
    const gate = read('src/client/ui-wechat/src/client/pages/wechat-data/ui/desktop-only.tsx')
    expect(gate).toContain('caps.desktopEquivalent === true')
    expect(gate).toContain('caps.desktopEquivalent !== true')
  })

  it('服务端只有 fullAccess 会话能调原生端点，且交接码带 fullAccess', () => {
    const server = read('src/backend/http-server.js')
    expect(server).toContain('handleNative')
    expect(server).toContain('FULL_ACCESS_REQUIRED')
    expect(server).toContain('ctx.sessions.isFull')
    expect(server).toContain('fullAccess')
    const handoff = read('src/backend/browser-handoff.js')
    expect(handoff).toContain('control.rotate({ fullAccess: true })')
    expect(handoff).toContain('issuePairingCode({ fullAccess: true })')
    expect(handoff).toContain('mode=desktop')
  })

  it('主进程原生代理覆盖桌面端用到的能力', () => {
    const native = read('src/backend/handoff-native.js')
    for (const action of ['pick-directory', 'open-file', 'save-file', 'show-in-folder', 'capture-panel',
      'license-status', 'diag-log-info', 'update-state', 'remote-access-state', 'llm-get', 'llm-profiles']) {
      expect(native, `原生代理缺 ${action}`).toContain(`'${action}'`)
    }
  })
})

describe('卡片只有返回一个动作', () => {
  /** 剥注释：注释里解释「不暴露 electronAPI」不应该被试条当成违规。 */
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('卡片页面：拖动区 + 返回按钮；不出现 electronAPI', () => {
    const src = code(read('src/backend/browser-handoff.js'))
    expect(src).toContain('-webkit-app-region:drag')
    expect(src).toContain('-webkit-app-region:no-drag')
    expect(src).toContain('点击返回桌面应用')
    expect(src).toContain('window.handoff.restore()')
    expect(src).not.toContain('electronAPI')
  })

  it('卡片 preload 只暴露 restore，不加载主 preload', () => {
    const preload = code(read('src/backend/handoff-preload.js'))
    expect(preload).toContain("exposeInMainWorld('handoff'")
    expect(preload).toContain('browser-handoff:restore')
    expect(preload).not.toContain('electronAPI')
    const handoff = code(read('src/backend/browser-handoff.js'))
    expect(handoff).toContain("'handoff-preload.js'")
    expect(handoff).not.toContain("preload: path.join(deps.rootDir, 'preload.js')")
  })
})

/**
 * `src/backend/ipc-misc.js` 的注册守卫（M21 第二十刀）。
 *
 * 为什么需要：这些频道原先**长在 `main.js` 的 `app.whenReady()` 回调里**，搬出去之后
 * 「有没有漏传 ctx 字段」「频道名有没有打错」都只能在真 Electron 里暴露 —— 而 CI 的
 * Electron 冒烟要跑几十秒且只在 windows runner 上跑。这里用**假 ipcMain** 把注册过程
 * 跑一遍：不需要 Electron，秒级，而且能逐条点名缺了哪个频道。
 *
 * 接线守卫（解构字段 ↔ main.js 实参、裸用 ctx 名字）已抽到 （覆盖所有 ipc-*.js）。
 * 这里只管**频道**：注册时机与频道清单。
 * 顺带钉住「注册时机」这件事：`registerMiscIpc` 是被 `app.whenReady()` 回调调用的，
 * 所以它必须是**同步注册**（返回后再注册就晚了 —— 渲染层首次 invoke 会拿到
 * `No handler registered`）。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { registerMiscIpc } = require(join(HERE, '..', 'ipc-misc.js'))


/** 该模块负责的频道（与拆分前 main.js 里的注册一一对应）。 */
const HANDLE = [
  'diag:log-info', 'diag:export-log', 'diag:reveal-log',
  'app:versions', 'app:ping', 'app:test-mode', 'app:run-mode', 'app:debug-gates',
  'license:status', 'license:export-request', 'license:import', 'license:import-text', 'license:remove',
  'dialog:open-file', 'dialog:open-directory', 'dialog:save-file',
  'shell:show-item',
  'window:is-fullscreen', 'window:capture-panel',
]
const ON = ['window:minimize', 'window:close', 'window:fullscreen-toggle']

/**
 * 造一份最小 ctx。
 * @param handled - 已注册 handle 频道名收集器。
 * @param onned - 已注册 on 频道名收集器。
 * @param overrides - 覆盖任意字段（行为用例用它注入假窗口/假屏幕）。
 * @param handlers - 频道 → 回调 的捕获表（注册守卫之外的用例要真的调用回调）。
 */
function ctx(
  handled: string[],
  onned: string[],
  overrides: Record<string, unknown> = {},
  handlers = new Map<string, (...a: unknown[]) => unknown>(),
) {
  return {
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handled.push(ch); handlers.set(ch, fn) },
      on: (ch: string, fn: (...a: unknown[]) => unknown) => { onned.push(ch); handlers.set(ch, fn) },
    },
    ipcTrust: {
      wrap: (_ch: string, fn: (...a: unknown[]) => unknown) => fn,
      wrapOn: (_ch: string, fn: (...a: unknown[]) => unknown) => fn,
    },
    app: { getVersion: () => '0.0.0', isPackaged: false, getPath: () => '/tmp', getName: () => 'Super Time', on: () => {} },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder: () => {}, openExternal: async () => {} },
    path: { basename: (p: string) => p, dirname: () => '/tmp', join: (...a: string[]) => a.join('/') },
    fs: { statSync: () => ({ size: 0 }), existsSync: () => false },
    diagLog: { files: () => [], path: '/tmp/x.log' },
    STATE_DIR: '/tmp',
    APP_VERSION: '0.0.0',
    debugGates: () => ({ packaged: false, skipGates: true }),
    licenseService: { status: () => ({ state: 'ok' }), verify: async () => ({ ok: true }), METHOD_FEATURE: {} },
    getMainWindow: () => null,
    // 默认屏幕：工作区与整屏一致（只有覆盖它的行为用例才关心差值）。
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 0, height: 0 } }) },
    buildDiagnosticReport: () => 'report',
    installWebContentsGuards: () => {},
    ...overrides,
  }
}

describe('ipc-misc：13 + 3 个频道都要注册上（漏一个就是「No handler registered」）', () => {
  it('同步注册全部 handle / on 频道，且不重复', () => {
    const handled: string[] = []
    const onned: string[] = []
    registerMiscIpc(ctx(handled, onned))
    // 防空转：注册表不能是空的（否则下面的逐条断言会因为「两边都空」而假通过）
    expect(handled.length + onned.length, '一个频道都没注册上').toBeGreaterThan(15)
    for (const ch of HANDLE) {
      expect(handled, `缺频道 ${ch}`).toContain(ch)
    }
    for (const ch of ON) {
      expect(onned, `缺频道 ${ch}`).toContain(ch)
    }
    expect(new Set(handled).size, '有频道被注册了两次（ipcMain.handle 会抛）').toBe(handled.length)
  })
})

/**
 * 「全屏」按钮的行为判据（2026-10-18 修复「全屏挡住任务栏」）。
 *
 * 真实 Electron 实测（2560×1440、工作区 2560×1400）：
 *   · `setFullScreen(true)` → bounds `0,0,2560,1440` ⇒ **盖住 40px 任务栏**（用户报的原始 bug）；
 *   · `frame:false` 窗口 `maximize()` → bounds `-8,-8,2576,1416` ⇒ Windows 把不可见缩放边框
 *     算在外面，右/下越界 8px，**仍压住任务栏上沿**；且这两种状态之后再 setBounds 都被忽略。
 * 所以按钮的契约是：`setBounds(当前显示器 workArea)`，绝不调用 setFullScreen。
 * 这里用假窗口把「几何等于工作区」「退出还原」「状态事件」三条钉住。
 */
describe('window:fullscreen-toggle：铺满工作区（保留任务栏），不是 OS 全屏', () => {
  const NORMAL = { x: 560, y: 250, width: 1440, height: 900 }
  const WORK = { x: 0, y: 0, width: 2560, height: 1400 }

  /** 假主窗口：记录 setBounds / setFullScreen / 发往渲染层的事件。 */
  function windowFixture(initial = NORMAL) {
    const sent: Array<[string, unknown]> = []
    const calls: string[] = []
    let bounds = { ...initial }
    const win = {
      isDestroyed: () => false,
      getBounds: () => ({ ...bounds }),
      setBounds: (b: typeof NORMAL) => { calls.push('setBounds'); bounds = { ...b } },
      setFullScreen: () => { calls.push('setFullScreen') },
      isFullScreen: () => false,
      webContents: { send: (ch: string, v: unknown) => { sent.push([ch, v]) } },
    }
    return { win, sent, calls, bounds: () => ({ ...bounds }) }
  }

  function invoke(overrides: Record<string, unknown>) {
    const handled: string[] = []
    const onned: string[] = []
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    registerMiscIpc(ctx(handled, onned, overrides, handlers))
    return {
      toggle: handlers.get('window:fullscreen-toggle'),
      isFull: handlers.get('window:is-fullscreen'),
    }
  }

  it('第一次点钉到工作区（不是整屏）、第二次点还原，并回传状态事件', () => {
    const fixture = windowFixture()
    const { toggle, isFull } = invoke({
      getMainWindow: () => fixture.win,
      screen: { getDisplayMatching: () => ({ workArea: { ...WORK } }) },
    })
    expect(toggle, 'window:fullscreen-toggle 没注册').toBeTypeOf('function')
    expect(isFull, 'window:is-fullscreen 没注册').toBeTypeOf('function')

    expect(isFull!()).toBe(false)
    toggle!()
    // 关键几何：等于工作区 ⇒ 任务栏不会被盖住
    expect(fixture.bounds()).toEqual(WORK)
    expect(fixture.calls, '不许用 setFullScreen —— Windows 上它会盖住任务栏').not.toContain('setFullScreen')
    expect(fixture.sent[fixture.sent.length - 1]).toEqual(['window:fullscreen-changed', true])
    expect(isFull!()).toBe(true)

    toggle!()
    expect(fixture.bounds()).toEqual(NORMAL)
    expect(fixture.sent[fixture.sent.length - 1]).toEqual(['window:fullscreen-changed', false])
    expect(isFull!()).toBe(false)
  })

  it('进入前已接近铺满（旧版本残留/系统最大化）⇒ 退出时缩到 1440×900 并居中', () => {
    // 真实反例：窗口被 Win32/系统最大化后 bounds 为 -8,-8,2576,1416，原样还原等于没退出全屏。
    const fixture = windowFixture({ x: -8, y: -8, width: 2576, height: 1416 })
    const { toggle } = invoke({
      getMainWindow: () => fixture.win,
      screen: { getDisplayMatching: () => ({ workArea: { ...WORK } }) },
    })
    toggle!()
    expect(fixture.bounds()).toEqual(WORK)
    toggle!()
    expect(fixture.bounds()).toEqual({ x: 560, y: 250, width: 1440, height: 900 })
  })

  it('多屏：按窗口**当前所在**显示器取工作区，不是主屏', () => {
    const fixture = windowFixture({ x: 2600, y: 120, width: 1200, height: 800 })
    const SECOND = { x: 2560, y: 0, width: 1920, height: 1040 }
    let asked: unknown = null
    const { toggle } = invoke({
      getMainWindow: () => fixture.win,
      screen: {
        getDisplayMatching: (bounds: unknown) => {
          asked = bounds
          return { workArea: { ...SECOND } }
        },
      },
    })
    toggle!()
    expect(asked, '取工作区时没把窗口当前 bounds 交给 getDisplayMatching').toEqual({ x: 2600, y: 120, width: 1200, height: 800 })
    expect(fixture.bounds()).toEqual(SECOND)
  })

  it('窗口不存在/已销毁时静默不抛（IPC 可能在关窗竞态里到达）', () => {
    const { toggle, isFull } = invoke({ getMainWindow: () => null })
    expect(() => { toggle!() }).not.toThrow()
    expect(isFull!()).toBe(false)
  })
})

/**
 * `src/backend/ipc-misc.js` 的注册守卫（M21 第二十刀）。
 *
 * 为什么需要：这些频道原先**长在 `main.js` 的 `app.whenReady()` 回调里**，搬出去之后
 * 「有没有漏传 ctx 字段」「频道名有没有打错」都只能在真 Electron 里暴露 —— 而 CI 的
 * Electron 冒烟要跑几十秒且只在 windows runner 上跑。这里用**假 ipcMain** 把注册过程
 * 跑一遍：不需要 Electron，秒级，而且能逐条点名缺了哪个频道。
 *
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

const ROOT = join(HERE, '..', '..', '..')
const miscSrc = readFileSync(join(HERE, '..', 'ipc-misc.js'), 'utf8')
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8')

/** `const { a, b } = ctx;` 里的字段名（模块可以有多处解构）。 */
function ctxFields(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*ctx\s*;/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim()
      if (name) out.push(name)
    }
  }
  return out
}

/** `fn({ … })` 实参对象字面量在顶层出现的键（含缩写键 `app`）。 */
function callKeys(src: string, fn: string): string[] {
  const at = src.indexOf(fn + '({')
  if (at < 0) throw new Error(`main.js 里找不到 ${fn}({…}) 调用点`)
  const start = src.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let i = start; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{' || c === '(' || c === '[') depth += 1
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) throw new Error(`${fn} 的实参对象字面量没有闭合`)
  // 行注释先摘掉，免得注释里的逗号被当成字段分隔（当前字面量里没有注释，防的是以后加）
  const keys: string[] = []
  let seg = ''
  let d = 0
  for (const c of src.slice(start + 1, end).replace(/\/\/[^\n]*/g, '')) {
    if (c === '{' || c === '(' || c === '[') d += 1
    else if (c === '}' || c === ')' || c === ']') d -= 1
    if (c === ',' && d === 0) { keys.push(seg); seg = '' } else seg += c
  }
  keys.push(seg)
  return keys.map((s) => s.split(':')[0].trim()).filter(Boolean)
}

/** 该模块负责的频道（与拆分前 main.js 里的注册一一对应）。 */
const HANDLE = [
  'diag:log-info', 'diag:export-log', 'diag:reveal-log',
  'app:versions', 'app:ping', 'app:test-mode', 'app:debug-gates',
  'license:status', 'license:export-request', 'license:import', 'license:import-text', 'license:remove',
  'dialog:open-file', 'dialog:open-directory', 'dialog:save-file',
  'shell:show-item',
  'window:is-fullscreen', 'window:capture-panel',
]
const ON = ['window:minimize', 'window:close', 'window:fullscreen-toggle']

function ctx(handled: string[], onned: string[]) {
  return {
    ipcMain: {
      handle: (ch: string) => { handled.push(ch) },
      on: (ch: string) => { onned.push(ch) },
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
    buildDiagnosticReport: () => 'report',
    installWebContentsGuards: () => {},
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

describe('ipc-misc：main.js 的 ctx 字面量必须逐字段对齐', () => {
  // 为什么单独有这一条：`installWebContentsGuards` 曾经**没被传进来**，而模块里那句
  // `app.on('web-contents-created', …)` 是惰性回调 —— 注册期一声不响，等真开窗口才抛
  // undefined，表现成「安全守卫静默失效」（渲染层的 window.open 真把窗口开出来了）。
  // 单测和 typecheck 都抓不到：JS 没有类型，假 ipcMain 也不触发那个回调。
  it('模块解构的每个字段，main.js 的实参里都有', () => {
    const need = ctxFields(miscSrc)
    expect(need.length, '没解析到任何解构字段（正则或代码形态变了？）').toBeGreaterThan(10)
    const passed = callKeys(mainSrc, 'registerMiscIpc')
    for (const f of need) {
      expect(passed, `main.js 没给 registerMiscIpc 传 \`${f}\` —— 模块里会拿到 undefined，直到那行代码真被执行才炸`)
        .toContain(f)
    }
  })

  it('反向：传了但模块不解构的字段要清掉（两份清单别各走各的）', () => {
    const need = ctxFields(miscSrc)
    for (const f of callKeys(mainSrc, 'registerMiscIpc')) {
      expect(need, `main.js 传了 \`${f}\`，但 ipc-misc.js 并不解构它（要么删掉实参，要么补上解构）`)
        .toContain(f)
    }
  })
})

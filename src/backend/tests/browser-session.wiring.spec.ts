/**
 * 浏览器态（手机端）接线的判据：环境判定只有一处，两条传输路共用同一套语义。
 *
 * ## 这里守的三件事
 *
 *   ① **环境判定收在 `capabilities.ts` 一处**。渲染层里散落的 `if (window.electronAPI)`
 *      必然漏 —— 漏掉的地方在手机上表现为「点了没反应」，比报错更难排查。
 *      注意口径：这里禁的是**自己推导环境**，不是禁「访问原生能力」。
 *      `api-media.ts` 的日志导出、`api-kb.ts` 的选文件、`api-core.ts` 的面板截图这些
 *      本来就写成 `window.electronAPI?.x?.()` 的可选链（浏览器里自然 no-op），
 *      它们不需要、也不应该改成读能力表 —— 那是 M9 的降级卡片要处理的事。
 *   ② **事件映射只有一份**。IPC 与 SSE 两条路都必须把事件交给 `dispatchWechatEvent`，
 *      谁要是自己再写一串 `if (ev.name === …)`，「桌面会实时刷新、手机不会」就回来了。
 *   ③ **令牌门真的挡在应用外面**。未授权时连 `WechatApp` 都不该挂载 —— 它一挂载就会
 *      发一串请求，全部 401，用户看到的是「一屏加载失败」而不是「请输入令牌」。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const APP = join(ROOT, 'src', 'client', 'ui-app')
const entryPath = join(APP, 'ui-entry.tsx')
const entrySrc = readFileSync(entryPath, 'utf8')
const capsSrc = readFileSync(join(APP, 'capabilities.ts'), 'utf8')
const gateSrc = readFileSync(join(APP, 'browser-gate.tsx'), 'utf8')

/** 剥掉注释：注释里写一句「这里要调 dispatchWechatEvent」不该算接线。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 收集真实的调用表达式名（`a.b(…)` → `a.b`，`f(…)` → `f`）。 */
function callNames(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const t = node.expression
      if (ts.isIdentifier(t)) out.push(t.text)
      else if (ts.isPropertyAccessExpression(t)) out.push(t.getText(sf))
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('① 环境判定只有 capabilities.ts 一处', () => {
  it('capabilities.ts 真的导出了环境判定与能力表', () => {
    expect(capsSrc).toMatch(/export const isDesktop/)
    expect(capsSrc).toMatch(/export const isBrowser/)
    expect(capsSrc).toMatch(/export const capabilities = Object\.freeze/)
    expect(capsSrc).toMatch(/export const bypassLocalGates/)
    // 判定必须基于「桥确实齐全」，而不是「window 存在」—— 失败方向要是「当成浏览器」
    expect(capsSrc, '判定没有检查 wechat.call 是不是函数（形状不对时会把浏览器当桌面端）')
      .toMatch(/typeof b\?\.wechat\?\.call === 'function'/)
  })

  it('ui-entry 从 capabilities 取判定，而不是自己推导环境', () => {
    expect(entrySrc, 'ui-entry 没有引入能力表').toMatch(/from '\.\/capabilities\.ts'/)
    expect(entrySrc).toContain('capabilities.isDesktop')
    expect(entrySrc).toContain('capabilities.isBrowser')
    const code = codeOnly(entrySrc)
    // 自己推导环境的两种典型写法都不该出现在「决定走哪条传输路」这件事上。
    // 注意：`(window as any).electronAPI.wechat.call(...)` 这类**使用**桥的写法是允许的
    // （那正是桌面分支要做的事），禁的是拿它当环境判据。
    expect(code, 'ui-entry 里又出现了自己推导环境的 typeof 判定').not.toMatch(/typeof window\b/)
    const judgments = [...code.matchAll(/if\s*\(\s*!?\(window as [^)]*\)\.electronAPI\s*\)/g)]
    expect(judgments, 'ui-entry 里出现了裸的 `if (window.electronAPI)` 环境判定').toEqual([])
  })

  it('能力表覆盖全部原生能力（少一项就会有控件在手机上点了没反应）', () => {
    for (const key of ['titlebar', 'windowControls', 'dirPicker', 'capturePanel', 'shellOpen', 'license', 'diag', 'update']) {
      expect(capsSrc, `能力表里缺 ${key}`).toMatch(new RegExp(`${key}:`))
    }
  })
})

describe('② 事件映射只有一份：两条传输路都交给 dispatchWechatEvent', () => {
  it('ui-entry 引入了映射表，并把它交给 IPC 的 onEvent', () => {
    expect(entrySrc).toMatch(/from '\.\/wechat-events\.ts'/)
    const code = codeOnly(entrySrc)
    expect(code, 'IPC 那条路没有用共用的映射表').toContain('onEvent(dispatchWechatEvent)')
    // 反面：那串手写 if-else 不许再回来（回来就意味着两条路各有一份映射）
    expect(code, 'ui-entry 里又出现了手写的事件名分支（映射必须只有一份）')
      .not.toContain("'dsh-wechat-data-updated'")
    expect(code).not.toContain("'dsh-wechat-ask-delta'")
    expect(code).not.toContain("'dsh-clawbot-message'")
  })

  it('SSE 那条路也走同一张表（http-remote 的缺省派发器就是 dispatchWechatEvent）', () => {
    const remoteSrc = readFileSync(join(APP, 'http-remote.ts'), 'utf8')
    expect(remoteSrc).toMatch(/from '\.\/wechat-events\.ts'/)
    expect(codeOnly(remoteSrc), 'SSE 的缺省派发器不是共用的映射表')
      .toMatch(/opts\.dispatch \?\? \(\(ev: BackendEvent\) => dispatchWechatEvent\(ev\)\)/)
  })
})

describe('③ 令牌门挡在应用外面，且两条传输路各就各位', () => {
  it('ui-entry 按环境二选一装 Remote（桌面 IPC / 浏览器 HTTP）', () => {
    const calls = callNames(entryPath, entrySrc)
    expect(calls, '没有安装 HTTP Remote').toContain('createHttpRemote')
    expect(calls, '没有安装 Remote（setWechatRemote）').toContain('setWechatRemote')
    // 桌面分支仍然直接用桥（这是它该做的事），浏览器分支用 HTTP Remote
    const code = codeOnly(entrySrc)
    expect(code).toContain('electronAPI.wechat.call(name, args)')
    expect(code.indexOf('capabilities.isDesktop'), '分流判据必须排在装 Remote 之前')
      .toBeLessThan(code.indexOf('createHttpRemote()'))
  })

  it('根组件在浏览器态用 BrowserSession 包住 WechatApp（未授权不挂载应用）', () => {
    expect(entrySrc, 'ui-entry 没有引入令牌门').toMatch(/from '\.\/browser-gate\.tsx'/)
    expect(entrySrc).toMatch(/<BrowserSession><WechatApp\s*\/><\/BrowserSession>/)
    // 桌面态直接渲染 WechatApp，不该被套进令牌门（否则桌面启动要先过一道 HTTP 鉴权）
    const code = codeOnly(entrySrc)
    const rootAt = code.indexOf('function Root()')
    expect(rootAt, '找不到根组件').toBeGreaterThan(-1)
    const rootBody = code.slice(rootAt, rootAt + 500)
    expect(rootBody).toContain('capabilities.isBrowser')
    expect(rootBody, '桌面态也被套进了令牌门').toMatch(/return <WechatApp\s*\/>/)
    expect(code, '根组件没有被真正渲染').toContain('render(<Root />)')
  })

  it('令牌门：探测已有会话、支持一次性 ?t=、并在会话失效时重新出现', () => {
    const code = codeOnly(gateSrc)
    expect(code, '没有探测已有会话（每次刷新都要重新输令牌）').toContain('hasSession()')
    expect(code, '没有读地址栏里的一次性令牌（扫码进来会停在输入框）').toContain('tokenFromUrl()')
    expect(code, '换到会话后没有抹掉地址栏里的令牌').toContain('stripTokenFromUrl()')
    expect(code, '没有订阅会话失效事件（TTL 到期后用户只会看到一屏加载失败）')
      .toContain('SESSION_LOST_EVENT')
    // 放行之后才接事件流：未授权时它只会不停收到 401
    expect(code, 'SSE 事件流不是「放行之后」才起的').toMatch(/if \(phase !== 'ready'\) return undefined/)
    expect(code).toContain('startHttpEventRelay()')
  })

  it('浏览器态跳过本地三道闸门（那三道在手机上做不成），但调试横幅不受影响', () => {
    expect(entrySrc, '闸门豁免没有用 capabilities 的口径').toMatch(/skipGates \|\| bypassLocalGates/)
    // 三道闸门都要由 gatesBypassed 守着；细节判据在 debug-gates.spec.ts，这里只钉「接线还在」
    const code = codeOnly(entrySrc)
    expect(code).toContain('!gatesBypassed && (!onboardingDone')
    expect(code).toContain('!gatesBypassed && !consented')
    expect(code).toMatch(/if \(gatesBypassed\) \{\s*return <WechatDataPanel \/>/)
    // 浏览器态不该挂调试横幅（文案里的 SUPERTIME_SKIP_ONBOARDING 在手机上根本没设过）
    expect(code, '调试横幅的守卫被换成了 gatesBypassed（手机上会出现「调试模式」横幅）')
      .toContain('if (!skipGates) return')
  })

  it('浏览器态摘掉自绘标题栏（body 是 flex column，摘掉后 #root 自动占满）', () => {
    const code = codeOnly(entrySrc)
    expect(code, '浏览器里还留着一条 38px 的死标题栏（拖不动窗口、按钮点了没反应）')
      .toMatch(/if \(!capabilities\.titlebar\) document\.getElementById\('titlebar'\)\?\.remove\(\)/)
  })
})

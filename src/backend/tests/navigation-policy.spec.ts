/**
 * H10：窗口打开 / 页面导航的放行策略。
 *
 * 渲染的是聊天与朋友圈内容 —— 不可信输入。这些判定原先只写在主进程里、只能靠手工
 * 点链接观察，抽到 src/backend/navigation-policy.js 后可以穷举。核心不变量是
 * **默认拒绝**：只放行已知安全的形态，新协议不会被意外放行。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { decideNavigation, decideWindowOpen, isInsidePath, isSafeExternalUrl } from '../navigation-policy.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const APP_ROOT = 'D:\\super-time-wechat'

describe('shell.openExternal 白名单：只放行 http(s)', () => {
  it('http / https 交给系统浏览器', () => {
    expect(decideWindowOpen('http://example.com/a')).toBe('external')
    expect(decideWindowOpen('https://example.com/a?b=1#c')).toBe('external')
    // 协议大小写由 URL 归一化
    expect(decideWindowOpen('HTTPS://Example.COM')).toBe('external')
    expect(decideWindowOpen('  https://example.com  ')).toBe('external')
  })

  it('file: 被拒 —— 否则聊天里一条链接就能拉起本地可执行文件', () => {
    expect(decideWindowOpen('file:///C:/Windows/System32/calc.exe')).toBe('deny')
    expect(decideWindowOpen('file://C:/Windows/notepad.exe')).toBe('deny')
    expect(isSafeExternalUrl('file:///tmp/x')).toBe(false)
  })

  it('smb:/UNC 与自定义协议被拒（凭据泄漏、外连）', () => {
    expect(decideWindowOpen('smb://attacker/share')).toBe('deny')
    expect(decideWindowOpen('\\\\attacker\\share')).toBe('deny')
    expect(decideWindowOpen('ms-msdt:/id')).toBe('deny')
    expect(decideWindowOpen('vscode://x')).toBe('deny')
    expect(decideWindowOpen('javascript:alert(1)')).toBe('deny')
    expect(decideWindowOpen('data:text/html,<script>1</script>')).toBe('deny')
  })

  it('带凭据的 URL 被拒（浏览器里会显示成欺骗性的主机名）', () => {
    // `https://wechat.com:pass@evil.com/` 在地址栏里看起来像 wechat.com，真实主机是
    // evil.com —— 交给系统打开没有正当用途。
    expect(decideWindowOpen('https://user:pass@evil.com/x')).toBe('deny')
    expect(decideWindowOpen('https://wechat.com:pass@evil.com/')).toBe('deny')
    expect(decideWindowOpen('http://user@evil.com/')).toBe('deny')
    expect(decideWindowOpen('https://example.com/path?q=1')).toBe('external')
  })

  it('空值/垃圾输入一律拒绝，且不抛异常', () => {
    for (const bad of ['', '   ', '#', 'not a url', undefined, null, 42, {}, 'https://']) {
      expect(decideWindowOpen(bad)).toBe('deny')
    }
  })
})

describe('导航守卫：只允许应用自己的页面', () => {
  const appDoc = APP_ROOT + '\\src\\client\\ui-dist\\index.html'

  it('应用目录内的 file: 页面放行（含带查询串的自身）', () => {
    expect(decideNavigation('file:///D:/super-time-wechat/src/client/ui-dist/index.html', APP_ROOT)).toBe('allow')
    expect(decideNavigation('file:///D:/super-time-wechat/src/client/ui-dist/index.html?skeleton=1', APP_ROOT)).toBe('allow')
    expect(decideNavigation('file:///D:/super-time-wechat/src/index.html', APP_ROOT)).toBe('allow')
  })

  it('外部地址被阻止（window.location = 外部站点）', () => {
    expect(decideNavigation('https://example.com', APP_ROOT)).toBe('deny')
    expect(decideNavigation('http://127.0.0.1:8080/', APP_ROOT)).toBe('deny')
  })

  it('应用目录之外的本地文件被阻止', () => {
    expect(decideNavigation('file:///C:/Windows/System32/calc.exe', APP_ROOT)).toBe('deny')
    expect(decideNavigation('file:///D:/super-time-wechat-evil/index.html', APP_ROOT)).toBe('deny')
    expect(decideNavigation('file:///D:/super-time-wechat/../../secrets.txt', APP_ROOT)).toBe('deny')
  })

  it('空 root 必须默认拒绝（fail-open 边界）', () => {
    // 评审实测：`path.relative('', x)` 得到相对路径、不以 '..' 开头，会把任意文件判成
    // 「在应用目录内」；root=undefined 更会抛 TypeError。这里把不变量钉住。
    expect(decideNavigation('file:///D:/super-time-wechat/src/index.html', '')).toBe('deny')
    expect(decideNavigation('file:///C:/Windows/win.ini', '')).toBe('deny')
    // 第二个参数是可选的（`reason?: string`）：没给理由也必须拒绝，而不是抛
    expect(decideNavigation('file:///C:/Windows/win.ini', undefined)).toBe('deny')
    expect(isInsidePath('', 'C:\\anything')).toBe(false)
    expect(isInsidePath('   ', 'C:\\anything')).toBe(false)
  })

  it('非 file: 协议与非法输入一律阻止', () => {
    for (const bad of ['about:blank', 'data:text/html,x', 'javascript:void 0', '', undefined, '://x']) {
      expect(decideNavigation(bad, APP_ROOT)).toBe('deny')
    }
    expect(appDoc.length).toBeGreaterThan(0)
  })
})

describe('路径包含判定', () => {
  it('同目录与子路径算在内，前缀相似的兄弟目录不算', () => {
    expect(isInsidePath(APP_ROOT, APP_ROOT)).toBe(true)
    expect(isInsidePath(APP_ROOT, APP_ROOT + '\\src\\a.ts')).toBe(true)
    // 关键边界：`super-time-wechat-evil` 不能因为「前缀相同」被放行
    expect(isInsidePath(APP_ROOT, 'D:\\super-time-wechat-evil\\x')).toBe(false)
    expect(isInsidePath(APP_ROOT, 'D:\\other\\x')).toBe(false)
  })
})

describe('主进程接线：每个导航入口都真的挂了守卫', () => {
  /**
   * 上面这些用例只证明**判定函数**是对的。判定函数写得再好，
   * 主进程少挂一个事件就等于该路径完全没守卫 —— 而这类缺失不会有任何报错。
   * `will-frame-navigate` 就是这么漏掉的（它管子框架导航，`will-navigate` 不覆盖它）。
   * 所以这里钉三件事：五个入口都在 `installWebContentsGuards` 里挂上、
   * 每个都走同一个 `decideNavigation`/`preventDefault`、以及**新出现的导航类事件必须进清单**。
   */
  const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8')
  const guards = mainSrc.slice(mainSrc.indexOf('function installWebContentsGuards'))
  const ATTACHED = ['setWindowOpenHandler', 'will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']

  for (const ev of ATTACHED) {
    it(`守卫里挂了 ${ev}`, () => {
      // 按**完整调用形态**找，不能只找子串：改名成 `will-navigate-legacy` 也算「挂着」，
      // 而那是完全失效的监听（第 8 刀变异自证时就是这么漏的）。
      const shape = ev === 'setWindowOpenHandler' ? `contents.${ev}(` : `contents.on('${ev}'`
      expect(guards.includes(shape), `${ev} 没在 installWebContentsGuards 里以 ${shape} 出现`).toBe(true)
    })
  }

  it('三条导航事件都走同一个判定函数（不许就地写一套新判定）', () => {
    const nav = ['will-navigate', 'will-redirect', 'will-frame-navigate']
    for (const ev of nav) {
      const at = guards.indexOf(`'${ev}'`)
      expect(at, ev).toBeGreaterThan(-1)
      expect(guards.slice(at, at + 700), `${ev} 没调用 decideNavigation`).toContain('decideNavigation')
    }
  })

  it('防空转：main.js 里出现的导航类事件都在清单内（加了新事件就得同步本用例）', () => {
    const seen = [...mainSrc.matchAll(/contents\.on\('(will-[a-z-]+)'/g)].map((m) => m[1])
    const unexpected = seen.filter((e) => !ATTACHED.includes(e))
    expect(unexpected, `未挂守卫的导航事件：${unexpected.join(', ')}`).toEqual([])
    for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      expect(seen, `main.js 不再监听 ${ev} —— 守卫被删了？`).toContain(ev)
    }
  })
})

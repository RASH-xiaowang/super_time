/**
 * Electron 安全基线守卫（P0-4 顺手补上的一道空档）。
 *
 * 2026-09-26 的深度代码审查把「`contextIsolation:true` / `nodeIntegration:false` /
 * `sandbox:true`、全仓无 `webSecurity:false`…」记成 **✅ 未发现问题** —— 事实对，
 * 但那一刻这些值只被**人眼看过一次**，没有任何用例守着。同一个审查里另一条教训是
 * 「只在真机脚本里被证明过的行为，随时可以在 CI 全绿的情况下被改回去」⇒ 这类
 * 「一行就能翻转、翻转就是远程代码执行原语」的配置恰恰最该有守卫。
 *
 * 顺带把 P0-4 的搬迁钉住：窗口本体现在住在 `src/backend/main-window.js`，
 * 「全仓只有一处 `new BrowserWindow(`」这条一旦破了，说明有人另开了一个
 * 不受这套 webPreferences 约束的窗口。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WINDOW_MODULE = 'src/backend/main-window.js'
/** 排除：vendored 依赖、构建产物、测试夹具。 */
const EXCLUDED_PREFIXES = ['src/backend/deps/', 'src/backend/wechat-data/lib/', 'src/client/ui-dist/', 'node_modules/']

function hostSources(dir = 'src'): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`
      if (EXCLUDED_PREFIXES.some((p) => (rel + '/').startsWith(p))) continue
      const abs = join(ROOT, d, e.name)
      if (e.isDirectory()) { walk(rel); continue }
      if (!/\.(js|ts|tsx|html)$/.test(e.name) || /\.spec\./.test(e.name)) continue
      if (statSync(abs).isFile()) out.push(rel)
    }
  }
  walk(dir)
  return out
}

const files = ['main.js', 'preload.js', ...hostSources()]
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const windowSrc = read(WINDOW_MODULE)

describe('Electron 窗口安全基线', () => {
  it('扫描范围非空（防空转：读不到文件时下面几条全是恒真）', () => {
    expect(files.length, '一个宿主文件都没扫到').toBeGreaterThan(20)
    expect(files).toContain(WINDOW_MODULE)
    expect(windowSrc, '窗口模块里没有 webPreferences ⇒ 判据的对象不存在').toContain('webPreferences')
  })

  it('三项必须是安全值，且就写在唯一那份 webPreferences 里', () => {
    const prefs = /webPreferences: \{([\s\S]*?)\n    \}/.exec(windowSrc)
    expect(prefs, '取不到 webPreferences 这一段').not.toBeNull()
    const body = prefs?.[1] ?? ''
    expect(body).toContain('contextIsolation: true')
    expect(body).toContain('nodeIntegration: false')
    expect(body).toContain('sandbox: true')
    expect(body.match(/contextIsolation/g)?.length, 'contextIsolation 出现多于一处').toBe(1)
  })

  it('全仓不许出现关掉基线的写法（含「新加的第二份 webPreferences」）', () => {
    const BAD = [
      /nodeIntegration *: *true/,
      /contextIsolation *: *false/,
      /sandbox *: *false/,
      /webSecurity *: *false/,
      /allowRunningInsecureContent/,
      /webviewTag *: *true/,
    ]
    const hits: string[] = []
    for (const rel of files) {
      const src = read(rel)
      for (const re of BAD) {
        if (re.test(src)) hits.push(`${rel} 命中 ${re}`)
      }
    }
    expect(hits, '渲染进程安全基线被翻转：\n  ' + hits.join('\n  ')).toEqual([])
  })

  it('全仓只有一处 new BrowserWindow(（另开窗口就得复用这套守卫）', () => {
    const sites: string[] = []
    for (const rel of files) {
      const n = (read(rel).match(/new BrowserWindow\(/g) ?? []).length
      if (n > 0) sites.push(...Array<string>(n).fill(rel))
    }
    expect(sites, `建窗口的地方不止一处：${sites.join(', ')}`).toEqual([WINDOW_MODULE])
  })

  it('导航/开窗判定仍走 navigation-policy（守卫不许在别处重写一份）', () => {
    expect(existsSync(join(ROOT, 'src/backend/navigation-policy.js'))).toBe(true)
    expect(windowSrc).toContain('decideNavigation')
    expect(windowSrc).toContain('decideWindowOpen')
    // 开窗一律 deny：`action:'deny'` 是本文件要守的那个**唯一**分支，external 只交给系统浏览器
    expect(windowSrc).toContain("{ action: 'deny' }")
    expect(windowSrc).toContain('will-attach-webview')
    expect(relative(ROOT, join(ROOT, WINDOW_MODULE)).split(sep).join('/')).toBe(WINDOW_MODULE)
  })
})

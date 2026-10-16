/**
 * 环境判据的唯一口径（M9）。
 *
 * ## 守的是什么
 *
 * `ui-app/capabilities.ts` 的文件头写着「渲染层只读它，`capabilities.wiring.spec.ts` 用
 * AST 断言渲染层没有别处自己判环境」—— 这份 spec 就是那句话**欠下的那条闸门**。
 * 在它存在之前，一个文件里的 `window.electronAPI` 出现 15 处，其中三处（NoticeBanner /
 * kb-files-panel / ExportHistoryDialog）判的是「桥在不在」而不是「本环境有没有这个能力」。
 *
 * ## 为什么「判环境」和「用桥」要分开
 *
 * 用桥是**传输**：`api-*.ts` / `llm-config.ts` / `ui-entry.tsx` 那几个文件就是把 IPC 桥包成
 * 函数给界面用，它们必须碰 `window.electronAPI`。判环境是**决策**：一个控件该不该出现、
 * 该不该禁用。决策散落在几十个面板里，就必然出现「桌面端会、手机端不会」那种只在一端复现的
 * 偏差，而且没人能一眼看全。所以这里允许前者（白名单点名），要求后者一律走能力表。
 *
 * ## 三条判据各自的失败症状
 *
 *   ① 面板自己判桥 ⇒ 手机上出现一个点了没反应的按钮（比报错更难排查，见 capabilities.ts 头注）。
 *   ② 能力项没有消费者 ⇒ 表上多一条「谎报的能力」：桌面端以为界面会藏起那个控件，其实没人藏。
 *   ③ `DESKTOP_ONLY` 的键没被任何降级卡覆盖 ⇒ 手机上那一节照常渲染，然后每个接口都吃
 *      `METHOD_NOT_ALLOWED_REMOTE`（用户看到的是转圈 + 一串红字）。
 *
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TREES = ['ui-wechat/src', 'ui-app'].map((p) => join(CLIENT_ROOT, p))

/** 相对 `src/client` 的路径（统一成正斜杠，清单里好写也好比对）。 */
const relOf = (abs: string): string => relative(CLIENT_ROOT, abs).replace(/\\/g, '/')

/**
 * **允许**直接读桥的文件：传输层 + 判据自己 + 挂载入口。
 * 按文件名点名，不按目录通配 —— 「api 目录」这种规则会放进来一个刚写的新面板。
 */
const TRANSPORT_FILES: ReadonlySet<string> = new Set([
  'ui-app/capabilities.ts',
  'ui-app/ui-entry.tsx',
  'ui-app/http-remote.ts',
  'ui-wechat/src/client/electron-api.ts',
  'ui-wechat/src/client/pages/wechat-data/api-core.ts',
  'ui-wechat/src/client/pages/wechat-data/api-config.ts',
  'ui-wechat/src/client/pages/wechat-data/api-kb.ts',
  'ui-wechat/src/client/pages/wechat-data/api-media.ts',
  'ui-wechat/src/client/pages/wechat-data/llm-config.ts',
])

/**
 * **宿主闸门已经把它们挡在浏览器之外**的那几个文件：它们只在桌面端渲染，
 * 所以不必自己判环境。理由由 `ui-entry` 的 `bypassLocalGates` 分支撑着，
 * 那条分支在判据 ④ 里单独钉住 —— 分支一旦被删，这里三条立刻变红。
 */
const DESKTOP_ONLY_BY_HOST: ReadonlySet<string> = new Set([
  'ui-app/license/LicenseGate.tsx',
  'ui-app/license/LicenseAuthPanel.tsx',
  'ui-app/onboarding/OnboardingShell.tsx',
])

/** 面板引用这些名字 = 走的是统一口径，不算「自己判环境」。 */
const SANCTIONED_VERDICT = /runtimeCapabilities\(\)|desktopOnlyGate\(|desktopAction\(\)|from '[^']*\/capabilities\.ts'/

/** 扫一棵树里的生产源码（跳过 spec 与产物）。 */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name) || e.name.includes('.spec.') || e.name.endsWith('.d.ts')) continue
      if (!statSync(p).isFile()) continue
      out.push(p)
    }
  }
  for (const t of TREES) walk(t)
  return out
}

/**
 * 数一段源码里**代码**对 `electronAPI` 的引用（AST ⇒ 注释与文档字符串里的提到不算数）。
 * @param code - 文件内容。
 * @param tsx - 是否按 TSX 解析。
 * @returns 引用次数。
 */
function electronApiTouches(code: string, tsx = true): number {
  const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  let n = 0
  const visit = (node: ts.Node): void => {
    const nameNode = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
      ? (node as ts.PropertyAccessExpression).name
      : (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) ? node.name : undefined
    if (nameNode && nameNode.getText().replace(/['"]/g, '') === 'electronAPI') n += 1
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

/** 一个碰了桥的文件是否用了统一口径。 */
function usesSanctionedVerdict(code: string): boolean {
  return SANCTIONED_VERDICT.test(code)
}

/** 判据 ① 的实现：返回「自己判环境」的文件清单。 */
function strayEnvVerdicts(files: string[]): string[] {
  const bad: string[] = []
  for (const p of files) {
    const rel = relOf(p)
    if (TRANSPORT_FILES.has(rel) || DESKTOP_ONLY_BY_HOST.has(rel)) continue
    const code = readFileSync(p, 'utf8')
    if (electronApiTouches(code) > 0 && !usesSanctionedVerdict(code)) bad.push(rel)
  }
  return bad
}

/** 取正则的第一个捕获组；没命中就抛 —— 判据失去对象时必须响，而不是悄悄量到空。 */
function group1(m: RegExpMatchArray | null, label: string): string {
  const v = m?.[1]
  if (v === undefined) throw new Error(label + '：正则没命中（判据失去对象）')
  return v
}

/** 从 `capabilities.ts` 的 `Object.freeze({…})` 里取出能力项名。 */
function capabilityKeys(): string[] {
  const code = readFileSync(join(CLIENT_ROOT, 'ui-app/capabilities.ts'), 'utf8')
  const start = code.indexOf('export const capabilities = Object.freeze({')
  if (start < 0) throw new Error('capabilities.ts 里找不到 Object.freeze 的能力表（判据失去对象）')
  const end = code.indexOf('\n})', start)
  const body = code.slice(start, end)
  // 两种写法都算：`titlebar: isDesktop,` 与简写的 `isDesktop,`（值与变量同名时 TS 允许省略）。
  return [...body.matchAll(/^  ([a-zA-Z]+)[ :,]/gm)].map((m) => m[1] ?? '').filter(Boolean)
}

/** 从 `desktop-only.tsx` 的 `DESKTOP_ONLY` 表里取出节名。 */
function desktopOnlyKeys(): string[] {
  const code = readFileSync(join(CLIENT_ROOT, 'ui-wechat/src/client/pages/wechat-data/ui/desktop-only.tsx'), 'utf8')
  const start = code.indexOf('const DESKTOP_ONLY')
  if (start < 0) throw new Error('desktop-only.tsx 里找不到 DESKTOP_ONLY 表')
  const end = code.indexOf('\n})', start)
  return [...code.slice(start, end).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1] ?? '').filter(Boolean)
}

/**
 * 能力项里**没有直接消费者**的那几条，以及覆盖它们的整节降级。
 *
 * 为什么允许「没有消费者」：这几条对应的控件整块被 `desktopOnlyGate` / 宿主闸门摘掉了，
 * 再在按钮上判一次是重复判据。但这件事必须写在这里，否则下一条新增的能力项会顺手加进
 * 这张表（表越长越等于没有表），所以每条都要给一个**能在源码里搜到的**覆盖点。
 */
const COVERED_BY_SECTION: Readonly<Record<string, { coveredBy: string, file: string }>> = {
  windowControls: { coveredBy: 'capabilities.titlebar', file: 'ui-app/ui-entry.tsx' },
  dirPicker: { coveredBy: "exporting || desktopAction()", file: 'ui-wechat/src/client/pages/wechat-data/panels/chats-head-actions.tsx' },
  diag: { coveredBy: "desktopOnlyListCard(DESKTOP_ONLY_KEYS)", file: 'ui-wechat/src/client/pages/wechat-data/panels/settings-browser.tsx' },
}

describe('环境判据只有一处（capabilities.wiring）', (): void => {
  const files = sourceFiles()

  it('确实扫到了源码与桥引用（否则下面的判据全是恒真）', (): void => {
    expect(files.length).toBeGreaterThan(200)
    const touching = files.filter((p) => electronApiTouches(readFileSync(p, 'utf8')) > 0)
    expect(touching.length).toBeGreaterThanOrEqual(10)
  })

  it('① 渲染层没有别处自己判环境', (): void => {
    expect(strayEnvVerdicts(files)).toEqual([])
  })

  it('② 每个能力项都有消费者，或有一条写明了的整节降级', (): void => {
    const all = files.map((p) => ({ rel: relOf(p), code: readFileSync(p, 'utf8') }))
    const missing: string[] = []
    for (const key of capabilityKeys()) {
      const read = all.some(({ code }) => new RegExp(`(capabilities|runtimeCapabilities\\(\\))\\.${key}\\b`).test(code))
      if (read) continue
      const cov = COVERED_BY_SECTION[key]
      // 「有覆盖」必须真的能在源码里搜到那一句 —— 搜不到就等于这一格没人管。
      if (cov && all.some(({ rel, code }) => rel === cov.file && code.includes(cov.coveredBy))) continue
      missing.push(cov ? `${key}（登记的覆盖点 ${cov.file} 里搜不到「${cov.coveredBy}」）` : key)
    }
    expect(missing).toEqual([])
  })

  it('②b 能力表的键与注入进渲染层那份副本的键一一对应', (): void => {
    const core = readFileSync(join(CLIENT_ROOT, 'ui-wechat/src/client/pages/wechat-data/api-core.ts'), 'utf8')
    const decl = /interface RuntimeCapabilities \{([\s\S]*?)\n\}/.exec(core)
    expect(decl, 'api-core.ts 里找不到 RuntimeCapabilities').not.toBeNull()
    const declared = [...group1(decl, 'RuntimeCapabilities').matchAll(/^\s+([a-zA-Z]+): boolean/gm)].map((m) => m[1] ?? '').filter(Boolean).sort()
    // 注入副本只需覆盖「面板要读的那几项」：titlebar / windowControls 是外壳自己的事，不过包界。
    const shell = ['titlebar', 'windowControls']
    const table = capabilityKeys().filter((k) => !shell.includes(k)).sort()
    expect(declared).toEqual(table)
    const fallback = /_caps \?\? \{([^}]*)\}/.exec(core)
    expect(fallback, '缺省能力表（未注入时按浏览器处理）').not.toBeNull()
    for (const k of ['isBrowser', 'isDesktop', ...table]) {
      expect(group1(fallback, '缺省能力表')).toContain(`${k}: `)
    }
    // 失败方向必须是「当成浏览器」：没注入时 `isDesktop:false / isBrowser:true`。
    // 反过来（默认按桌面端）会让界面去调一个不存在的桥 —— 那是直接抛，不是降级。
    const fb = group1(fallback, '缺省能力表')
    expect(fb).toMatch(/isDesktop: false/)
    expect(fb).toMatch(/isBrowser: true/)
  })

  /**
   * ③b 「设置里每一节都被想到」。
   *
   * 手机端那一屏只渲染 `boundary` 一节，其余每一节都必须落到 `DESKTOP_ONLY` 表里某一条；
   * 新增一节而忘了登记 ⇒ 手机上它会照常渲染，然后每个接口都吃 `METHOD_NOT_ALLOWED_REMOTE`。
   * 配置向导那五节共用表里一条 `setup`，这条映射写死在下面（新增步骤也要在这里加一行）。
   */
  it('③b 设置面板的每一节要么手机上能用，要么登记为「仅桌面端」', (): void => {
    // 节的锚点散在三个文件里（步骤卡在 settings-steps、远程访问卡在自己文件里），所以一起收。
    const owners = ['panels/Settings.tsx', 'panels/settings-steps.tsx', 'panels/settings-remote-access.tsx']
    const text = owners.map((f) => readFileSync(join(CLIENT_ROOT, 'ui-wechat/src/client/pages/wechat-data', f), 'utf8')).join('\n')
    const anchors = [...new Set([...text.matchAll(/data-settings-section="([a-z]+)"/g)].map((m) => m[1] ?? '').filter(Boolean))]
    expect(anchors.length).toBeGreaterThanOrEqual(12)
    const WIZARD = ['detect', 'dbkey', 'imgkey', 'img', 'voice']
    const keys = desktopOnlyKeys()
    const unrolled = new Set(keys)
    for (const w of WIZARD) if (keys.includes('setup')) unrolled.add(w)
    // settings-browser 那一版**主动渲染**的节（不靠降级卡）。
    const browser = readFileSync(join(CLIENT_ROOT, 'ui-wechat/src/client/pages/wechat-data/panels/settings-browser.tsx'), 'utf8')
    const shown = new Set([...browser.matchAll(/data-settings-section="([a-z]+)"/g)].map((m) => m[1] ?? '').filter(Boolean))
    expect(anchors.filter((a) => !unrolled.has(a) && !shown.has(a))).toEqual([])
    // 反向：表里不许有设置面板已经不存在的节（那是一条说瞎话的降级卡）。
    expect(keys.filter((k) => k !== 'setup' && !anchors.includes(k))).toEqual([])
  })

  /**
   * ⑥ 禁用属性组的**位置**：`{...desktopActionProps()}` 必须在元素的 `disabled={…}` 之后。
   *
   * 为什么单独立一条：JSX 的 spread 是后写覆盖先写，写反了不会报错、也不会红，
   * 只是手机上那个按钮又变回可点 —— 一个「加了降级但降级不生效」的静默失效。
   */
  it('⑥ desktopActionProps() 的 spread 都在同元素 disabled 之后', (): void => {
    const offenders: string[] = []
    for (const p of files) {
      const code = readFileSync(p, 'utf8')
      if (!code.includes('desktopActionProps()')) continue
      // 抓每个元素开标签（<button / <Button / <input 到它自己的 > 之间）
      for (const m of code.matchAll(/<(?:button|Button|input|select)\b[\s\S]*?>/g)) {
        const tag = m[0]
        const at = tag.indexOf('desktopActionProps()')
        if (at < 0) continue
        const after = tag.slice(at)
        if (/\bdisabled=/.test(after)) offenders.push(`${relOf(p)} :: ${tag.slice(0, 90).replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
    // 恒真自检：这条至少要看一眼真的扫到了若干 spread，否则清单空转。
    const spreads = files.reduce((n, p) => n + (readFileSync(p, 'utf8').match(/desktopActionProps\(\)/g) ?? []).length, 0)
    expect(spreads).toBeGreaterThan(10)
  })

  it('③ 每一节「仅桌面端」都被某张降级卡覆盖', (): void => {
    const keys = desktopOnlyKeys()
    expect(keys.length).toBeGreaterThanOrEqual(8)
    const texts = files.map((p) => readFileSync(p, 'utf8'))
    const gated = new Set<string>()
    for (const t of texts) for (const m of t.matchAll(/desktopOnlyGate\('([a-z]+)'\)/g)) gated.add(m[1] ?? '')
    // 清单卡把剩下的全部列出（手机端「设置」那一屏）。
    const listed = texts.some((t) => /desktopOnlyListCard\((DESKTOP_ONLY_KEYS|Object\.keys)/.test(t))
    const uncovered = keys.filter((k) => !gated.has(k) && !listed)
    expect(uncovered).toEqual([])
    // 反方向：卡里不许写一个表上没有的键（写了只会得到一张「这一节做的事都发生在这台电脑上」的通用卡）。
    const typo = [...gated].filter((k) => !keys.includes(k))
    expect(typo).toEqual([])
  })

  it('④ 手机端的「设置」不挂载桌面端那份状态钩子（被屏蔽方法的调用次数必须是零）', (): void => {
    const settings = readFileSync(join(CLIENT_ROOT, 'ui-wechat/src/client/pages/wechat-data/panels/Settings.tsx'), 'utf8')
    expect(/if \(runtimeCapabilities\(\)\.isBrowser\) return <SettingsBrowserPanel/.test(settings)).toBe(true)
    expect(settings).toContain('function SettingsDesktopPanel')
    const browser = readFileSync(join(CLIENT_ROOT, 'ui-wechat/src/client/pages/wechat-data/panels/settings-browser.tsx'), 'utf8')
    expect(browser).not.toContain('useSettingsState(')
    expect(browser).toContain('PrivacyTrustPanel')
    // 配置向导那张「指路卡」自己也要摘掉：它指的那五节在手机上不存在，
    // 留一张指向空处的浮卡比没有更让人困惑（而它挂载时打的那四个接口全会被拒）。
    const guide = readFileSync(join(CLIENT_ROOT, 'ui-wechat/src/client/pages/wechat-data/panels/SetupGuide.tsx'), 'utf8')
    expect(guide).toMatch(/^\s*if \(runtimeCapabilities\(\)\.isBrowser\) return null/m)
  })

  it('⑤ 三道本地闸门只在浏览器态绕行，桌面端恒不绕行', (): void => {
    const caps = readFileSync(join(CLIENT_ROOT, 'ui-app/capabilities.ts'), 'utf8')
    expect(caps).toMatch(/export const bypassLocalGates: boolean = isBrowser/)
    const entry = readFileSync(join(CLIENT_ROOT, 'ui-app/ui-entry.tsx'), 'utf8')
    expect(entry).toContain('bypassLocalGates')
    // 判据 ① 的白名单靠这一条撑着：宿主不再绕行，那三个 license/onboarding 文件就必须自己判环境。
    expect(entry).toMatch(/gatesBypassed[^\n]*bypassLocalGates/)
  })

  it('反例自证：判环境的三种写法，两种要红一种不该红', (): void => {
    const bare = "import { useState } from 'react'\nexport function P(): void { const api = (window as any).electronAPI?.update; void api }\n"
    expect(electronApiTouches(bare)).toBe(1)
    expect(usesSanctionedVerdict(bare)).toBe(false)
    const guarded = "import { runtimeCapabilities } from '../api.ts'\nconst api = (window as any).electronAPI?.update; void api; void runtimeCapabilities()\n"
    expect(usesSanctionedVerdict(guarded)).toBe(true)
    // 注释里提到桥，不该被算成一次判环境（AST 天然不管注释）。
    const commentOnly = "/** 这里原本读 window.electronAPI，现在走能力表。 */\nexport const x = 1\n"
    expect(electronApiTouches(commentOnly)).toBe(0)
    // 类型字面量里的字段名（`{ electronAPI?: … }`）是**真的**读了桥，必须算。
    expect(electronApiTouches("const a = (window as unknown as { electronAPI?: {} }).electronAPI")).toBe(2)
  })
})

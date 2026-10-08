/**
 * 手写覆盖层的**无障碍接线**守卫（R7，2026-09-28）。
 *
 * ── 为什么要有这一条 ───────────────────────────────────────────────────────────
 * kit 的 `Drawer` / `Dialog` 走 Radix，Esc 与焦点陷阱是白送的。但面板里还有一批
 * **手写**的 `role="dialog"` 覆盖层，它们只做了「点遮罩关闭」。WAI-ARIA 的 dialog
 * 模式要求 Esc 可关闭、且 Tab 不许跑出弹窗 —— 键盘用户会在这些弹窗里被困住。
 *
 * 项目为此备了一套钩子（`ui/kit-overlay.tsx` 的 `useEscapeToClose` / `useDialogFocus`），
 * 但**接线靠人肉**，漏了不会有任何编译错误：属性名写错、hook 忘调、名字打错，
 * 全都静默失败（`useDialogFocus` 是按选择器字符串找宿主的）。
 * `chats-thread.tsx` 的注释记录过一次实测事故：「Esc 关不掉、Tab 会跑到抽屉背后的
 * 会话列表里（审计 P1-7）」。本 spec 就是把这类漏接**钉死在构建期**。
 *
 * ── 口径（三条，都踩过坑）────────────────────────────────────────────────────
 *
 * ① **跨文件接线是合法的**，不能按「同文件搜 hook」判缺口。
 *    第一版审计脚本就是这么判的，得出「9 个文件缺 hook」的结论 —— 全错。
 *    实际架构是：持有 dialog 的组件只管渲染，状态与 hook 在**父级**。
 *    例：`data-st-dialog="chats-chatlog"` 写在 `chats-chatlog-dialog.tsx`，
 *    而 `useDialogFocus(chatlogStack.length > 0, '[data-st-dialog="chats-chatlog"]')`
 *    在 `chats-msg-search.tsx`。所以判据是**全仓按名字配对**，不是按文件配对。
 *
 * ② **必须 `stripComments`**。本仓注释里大量出现 `data-st-dialog="…"` 与 hook 名
 *    （这一份文件自己就是例子），不剥注释会把注释当实现，守卫变恒真。
 *
 * ③ **排除 `querySelector` 那种字符串用法**。`kit-shell.tsx` 里有
 *    `!document.querySelector('[role="dialog"]')`（Esc 清空搜索前的保险），
 *    它看着像 `role="dialog"` 的宿主，其实只是一个查询。按「前面 30 字符有没有
 *    querySelector / 结尾是不是 `[`」排除。
 *
 * ④ **"有 Esc 就行"不算过关，必须走 `escStack`**。`chats-media.tsx` 的查看器
 *    原来自带一段 `keydown` 监听（`if (e.key === 'Escape') onClose()`）——
 *    能关，首版守卫却判它缺 Esc。这里**没有把判据放宽**：自带监听虽然能关，
 *    但**不进 `escStack`**，查看器之上再叠一层弹窗时一次 Esc 会关掉两层
 *    （`escStack` 的全部意义就是「只让最上层响应」，见 `kit-overlay.tsx` 注释）。
 *    所以 R7 把它**收编**到 `useEscapeToClose`，判据保持严格 —— 是代码向判据靠拢，
 *    不是判据迁就代码。
 *
 * ── 哨兵：抽样点名，不是数字下限（R6 的血泪）──────────────────────────────────
 * R6 的 `button-disabled-tone` 用 `total >= 80` 当哨兵，变异把它改成 `>= 1` 照样绿
 * （实际值 139，下限永远越不过）；而真正会发生的塌陷（某文件按钮被整体改写）也越不过。
 * 教训：**塌陷一定发生在某个具体位置上，点名比计数敏感得多。**
 * 所以这里有 `NAMED_OVERLAYS` —— 逐个点名「文件 + dialog 名 + 接线在哪」。
 * 任何一个漏接、改名，立刻红。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readText, stripComments } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
/** 本 spec 在 `panels/` 下；`wechat-data/` 是它的上一层。 */
const WECHAT_DATA = join(HERE, '..')
const PANELS = HERE

/** 参与扫描的源文件（`.ts` / `.tsx`），结果已剥注释。 */
function collectSources(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(p)
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        out.set(entry.name, stripComments(readText(p)))
      }
    }
  }
  walk(WECHAT_DATA)
  return out
}

const SOURCES = collectSources()
const ALL = [...SOURCES.values()].join('\n')

/**
 * 点名表：每个手写覆盖层一行。
 *
 * `attrIn` = 写 `data-st-dialog="<name>"` 的文件；
 * `focusIn` = 调 `useDialogFocus(…, '[data-st-dialog="<name>"]')` 的文件；
 * `escIn`   = 调 `useEscapeToClose(…, …)` 的文件（Esc 与焦点可以不在同一处，
 *             但只要该覆盖层打开逻辑所在的那份文件里有调用即可 —— 见 ① 的口径）。
 *
 * 注：`escIn` 只是「该文件确实用了 esc 栈」的存在性检查；真正的语义绑定
 * （打开条件对不对）由各自的业务 spec 钉（如 `chats-chatlog-dialog.wiring.spec.ts`）。
 */
const NAMED_OVERLAYS = [
  // ── 同文件接线（组件自包含）──────────────────────────────────────────
  { name: 'daily-form', attrIn: 'DailySummary.tsx', focusIn: 'DailySummary.tsx', escIn: 'DailySummary.tsx' },
  { name: 'files-lightbox', attrIn: 'Files.tsx', focusIn: 'Files.tsx', escIn: 'Files.tsx' },
  { name: 'chats-viewer', attrIn: 'chats-media.tsx', focusIn: 'chats-media.tsx', escIn: 'chats-media.tsx' },
  { name: 'chats-contactinfo', attrIn: 'chats-contact-info-view.tsx', focusIn: 'chats-contact-info-view.tsx', escIn: 'chats-contact-info-view.tsx' },
  // ── 跨文件接线（状态在父级）──────────────────────────────────────────
  { name: 'chats-cal', attrIn: 'chats-calendar-dialog.tsx', focusIn: 'chats-msg-search.tsx', escIn: 'chats-msg-search.tsx' },
  { name: 'chats-chatlog', attrIn: 'chats-chatlog-dialog.tsx', focusIn: 'chats-msg-search.tsx', escIn: 'chats-msg-search.tsx' },
  { name: 'chats-edited', attrIn: 'chats-edited-dialog.tsx', focusIn: 'chats-msg-search.tsx', escIn: 'chats-msg-search.tsx' },
  { name: 'chats-export', attrIn: 'chats-export-dialog.tsx', focusIn: 'chats-msg-search.tsx', escIn: 'chats-msg-search.tsx' },
  { name: 'chats-groupinfo', attrIn: 'chats-group-info-view.tsx', focusIn: 'chats-thread.tsx', escIn: 'chats-thread.tsx' },
  { name: 'moments-export', attrIn: 'moments-portals.tsx', focusIn: 'moments-panel.tsx', escIn: 'moments-panel.tsx' },
  { name: 'moments-viewer', attrIn: 'moments-portals.tsx', focusIn: 'moments-panel.tsx', escIn: 'moments-panel.tsx' },
  { name: 'moments-detail', attrIn: 'moments-portals.tsx', focusIn: 'moments-panel.tsx', escIn: 'moments-panel.tsx' },
] as const

/** 收集所有 `data-st-dialog="X"` 属性用法（排除 `querySelector('[data-st-dialog=…]')`）。 */
function attrHosts(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(/data-st-dialog=["']([^"']+)["']/g)) {
      const name = m[1]!
      const before = src.slice(Math.max(0, m.index - 30), m.index)
      // 选择器用法：`[` 紧跟其后（`querySelector('[data-st-dialog="x"]')`）
      if (before.trimEnd().endsWith('[')) continue
      if (!out.has(name)) out.set(name, new Set())
      out.get(name)!.add(file)
    }
  }
  return out
}

/** 收集所有 `useDialogFocus(x, '[data-st-dialog="Y"]')` 的目标名 → 调用文件。 */
function focusHosts(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [file, src] of SOURCES) {
    const re = /useDialogFocus\s*\([^,]+,\s*['"]\[data-st-dialog=["']([^"']+)["']\]['"]/g
    for (const m of src.matchAll(re)) {
      const name = m[1]!
      if (!out.has(name)) out.set(name, new Set())
      out.get(name)!.add(file)
    }
  }
  return out
}

/**
 * 该文件里是否**真的调用了** `useEscapeToClose(…)`（而不是只在 import 里出现）。
 *
 * 为什么不能直接 `src.includes('useEscapeToClose')`：那一行 `import { … } from '../ui/kit.tsx'`
 * 同样含这个字符串 ⇒ 把调用点整个删掉，守卫**照样绿**。R7 变异 M1 / M4 就是这么骗过首版的。
 * 判据必须落在**调用点**上：前面不能是标识符字符或 `.`，后面紧跟 `(`。
 * （同族教训见 `MEMORY.md`：`toContain('fnName')` 钉不住「必须调用某函数」。）
 */
function callsEscapeToClose(src: string): boolean {
  return /[^A-Za-z0-9_$.]useEscapeToClose\s*\(/.test(src)
}

describe('手写覆盖层的无障碍接线', () => {
  const attrs = attrHosts()
  const focuses = focusHosts()

  it('确实扫到了源码（哨兵：读空 ⇒ 下面所有判据全是恒真）', () => {
    expect(SOURCES.size, '一个源文件都没读到').toBeGreaterThanOrEqual(40)
    expect(ALL.length, '联合语料太短，扫描面塌陷了').toBeGreaterThan(100_000)
    expect(attrs.size, '一个 data-st-dialog 都没扫到').toBeGreaterThanOrEqual(10)
    /* 点名表本身也要有下限，否则「删掉一行」就等于「这条覆盖层不用查了」——
     * R7 变异 M3 就是删掉 chats-viewer 那行，首版守卫照样绿。 */
    expect(NAMED_OVERLAYS.length, '点名表被削短了 ⇒ 少登记一项就少查一项').toBeGreaterThanOrEqual(12)
  })

  it('哨兵：逐一确认下面点名的名字真的存在（名字改了要立刻红）', () => {
    const missingAttr = NAMED_OVERLAYS.filter(o => !attrs.get(o.name)?.has(o.attrIn))
      .map(o => `${o.name} 的属性不在 ${o.attrIn}`)
    const missingFocus = NAMED_OVERLAYS.filter(o => !focuses.get(o.name)?.has(o.focusIn))
      .map(o => `${o.name} 的 useDialogFocus 不在 ${o.focusIn}`)
    expect(missingAttr, `这些覆盖层的 data-st-dialog 属性找不到了：\n  ${missingAttr.join('\n  ')}`).toEqual([])
    expect(missingFocus, `这些覆盖层没人给它做焦点管理：\n  ${missingFocus.join('\n  ')}`).toEqual([])
  })

  it('每个被点名的覆盖层，Esc 与焦点两套 hook 都真的被调用（不是只写了属性）', () => {
    const bad: string[] = []
    for (const o of NAMED_OVERLAYS) {
      const escSrc = SOURCES.get(o.escIn)
      expect(escSrc, `${o.escIn} 没读到（点了名却在扫描面之外）`).toBeDefined()
      if (!callsEscapeToClose(escSrc!)) bad.push(`${o.name}: ${o.escIn} 里没有 useEscapeToClose 调用`)
    }
    expect(bad, `以下覆盖层缺 Esc 接线：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('反例自证：只留 import 行、删掉调用点，必须被咬住', () => {
    // 这正是变异 M1/M4 的形态：`import { useEscapeToClose } from …` 还在，调用没了。
    const src = SOURCES.get('chats-contact-info-view.tsx')!
    expect(callsEscapeToClose(src), '前提不成立：真文件里没有调用点').toBe(true)
    const importOnly = src.replace(/^([^\n]*useEscapeToClose[^\n]*)\(open, onClose\)/m, '$1')
    expect(importOnly, 'import 行被一起改掉了，反例不成立').toContain('useEscapeToClose')
    expect(callsEscapeToClose(importOnly), '只留 import 也判「有调用」⇒ 判据是恒真的').toBe(false)
  })

  it('`querySelector(\'[role="dialog"]\')` 那种字符串用法不许被误判成覆盖层', () => {
    // kit-shell.tsx 里的查询式用法：排除逻辑生效的正面证据
    const shell = SOURCES.get('kit-shell.tsx')
    expect(shell, 'kit-shell.tsx 没读到').toBeDefined()
    expect(shell!, 'Esc 清空搜索的保险没了').toContain(`querySelector('[role="dialog"]')`)
    // 它不该把自己的名字塞进属性表（它压根没有 data-st-dialog 属性）
    for (const [name, files] of attrs) {
      expect(files.has('kit-shell.tsx'), `kit-shell.tsx 被误判成 ${name} 的宿主`).toBe(false)
    }
  })
})

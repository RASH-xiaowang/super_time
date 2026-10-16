/**
 * P3 族 C（文字链）收敛守卫（2026-09-28）。
 *
 * ── 这份守卫钉什么 ────────────────────────────────────────────────
 * 族 C = 「长得像链接的 `<button>`」：无内边距、无边框、无背景、字色 `--nm-cyan`、
 * hover 下划线。实测全仓 **6 个类 / 8 处调用点**：
 *
 *   chats-cards.module.css   .exportLinkBtn   → chats-export-dialog.tsx ×2
 *   contacts.module.css      .linkBtn         → Contacts.tsx ×1
 *   knowledge-base.module.css .linkBtn        → KnowledgeBase.tsx ×1
 *   records.module.css       .link           → Ledger.tsx ×1, Records.tsx ×1
 *   storage.module.css       .linkBtn         → Storage.tsx ×1
 *   tasks.module.css         .linkBtn         → Tasks.tsx ×1
 *
 * ── 为什么必须是独立组件，不能是 `Button variant="ghost"` ─────────
 * `Button`（外部包 `@deepseek-ai/dsh-client-ui-primitives`）只有 6 variant，
 * 每种都带内边距与固定高（`ghost` = 36px / `sm` = 28px）⇒ 换成它**凭空多 28px 高**，
 * 表格单元格与说明行会被撑开。族 C 的 `padding: 0` 是**语义**（不占位、随文字流），
 * 不是"忘了设 padding"。所以 `LinkButton` 与 `Button` **平行**，不复用其 variant。
 *
 * ── 收敛后是什么样 ───────────────────────────────────────────────
 * 唯一定义点 = `ui/kit.module.css` 的 `.link`，由 `ui/kit-fields.tsx` 的
 * `LinkButton` 组件包住（内置 `type="button"`，透传 `ButtonHTMLAttributes`）。
 * 六份模块 CSS 里的族 C 类**全部删除**。
 *
 * ── 顺带做的视觉统一（用户 2026-09-28 裁决「统一为纯下划线」）────
 * 现状 hover 有三套花活：`contacts.linkBtn` 变紫 + 青色 text-shadow、
 * `records.link` 加 text-shadow、其余只下划线。收敛后一律**纯下划线**。
 * 这符合 `PRECISION MATRIX` 方向（去掉装饰性发光，视觉预算投给层级）。
 * 另：`font-size` 现状 11/12px 混用 ⇒ 统一 `var(--nm-fs-sm)`（12px）。
 *
 * ── 为什么这值得钉死 ─────────────────────────────────────────────
 * 收敛的**唯一价值**是"以后只有一个定义点"。若哪天有人在某个面板里手写回
 * `<button className={css.linkBtn}>`，视觉上几乎看不出差别（都是青色小字），
 * 但族 C 就重新分叉了。这条纪律**没有视觉回归能守**，只能靠守卫。
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PANELS = import.meta.dirname
const UI = join(PANELS, '..', 'ui')

/** 剥注释：本仓注释里大量出现 `.类名` / `button` / `text-shadow`，不剥会假阳性。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const readPanels = (f: string): string => stripComments(readFileSync(join(PANELS, f), 'utf8'))
const readUi = (f: string): string => stripComments(readFileSync(join(UI, f), 'utf8'))

/** 取某个类的「主规则块」体（不含花括号本身）：`^\s*\.cls\s*\{` + `m` flag，再配平花括号。 */
function ruleBody(css: string, cls: string): string | null {
  const m = new RegExp(`^\\s*\\.${cls}\\s*\\{`, 'm').exec(css)
  if (m === null) return null
  return balanced(css, m.index + m[0].length)
}

/** 从 `start`（已在 `{` 之后）配平花括号，返回括号内的内容。 */
function balanced(src: string, start: number): string {
  let depth = 1
  let i = start
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') depth -= 1
    i += 1
  }
  return src.slice(start, i - 1)
}

/**
 * 取一个具名函数的**函数体**。
 *
 * 不能简单找「第一个顶格 `}`」——签名形如
 * `export function LinkButton({ a, b, ...rest }: { a?: T } & React.ButtonHTMLAttributes<…>) {`，
 * **参数类型的闭合 `}` 也是顶格**，会把签名当函数体（本仓 `fnBody()` 踩过同一个坑）。
 * 正解：从函数名后**配平圆括号**跳过参数表，再找函数体的 `{` 并配平。
 */
function functionBody(src: string, name: string): string | null {
  const head = new RegExp(`export function ${name}\\s*\\(`).exec(src)
  if (head === null) return null
  // 配平圆括号找参数表结束
  let i = head.index + head[0].length
  let paren = 1
  let braceSeen = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '{') braceSeen += 1
    else if (c === '}') braceSeen -= 1
    else if (c === '(') paren += 1
    else if (c === ')') {
      paren -= 1
      if (paren === 0 && braceSeen === 0) break
    }
    i += 1
  }
  // 参数表结束后，跳过返回类型注解，找到函数体的 '{'
  const bodyOpen = src.indexOf('{', i)
  if (bodyOpen < 0) return null
  return balanced(src, bodyOpen + 1)
}

/** 族 C 被收编的六个类（文件 → 类名）。收敛后这些类必须**从模块 CSS 里消失**。 */
const RETIRED = [
  { file: 'chats-cards.module.css', cls: 'exportLinkBtn' },
  { file: 'contacts.module.css', cls: 'linkBtn' },
  { file: 'knowledge-base.module.css', cls: 'linkBtn' },
  { file: 'records.module.css', cls: 'link' },
  { file: 'storage.module.css', cls: 'linkBtn' },
  { file: 'tasks.module.css', cls: 'linkBtn' },
] as const

/**
 * 八处调用点（文件 → 必须出现 `<LinkButton` 的次数）。
 * 用**次数**而不是"出现过"：`chats-export-dialog` 有两处、`Ledger`/`Records`
 * 各一处却共享同一个 `.link` 类——只断言"至少一次"会给漏改留口子。
 *
 * 勘测更正（2026-09-28）：初版按 6 个类数成 9 处，哨兵实测得 **8**。
 * 逐处复核：chats-export-dialog ×2 + Contacts ×1 + KnowledgeBase ×1 + Storage ×1
 * + Tasks ×1 + Ledger ×1 + Records ×1 = 8。（哨兵存在的意义就在这——它拦住了我把
 * 一个凭印象写的数字当成事实。）
 */
const CALL_SITES = [
  { file: 'chats-export-dialog.tsx', times: 2 },
  { file: 'Contacts.tsx', times: 1 },
  { file: 'KnowledgeBase.tsx', times: 1 },
  { file: 'Ledger.tsx', times: 1 },
  { file: 'Records.tsx', times: 1 },
  { file: 'Storage.tsx', times: 1 },
  { file: 'Tasks.tsx', times: 1 },
] as const

/** 族 C 退役后**不许再出现**的 className 属性访问（`css./csscards./cssshell.` 前缀）。 */
const STALE_CLASSREF = /\b(?:css|csscards|cssshell)\s*\.\s*(?:exportLinkBtn|linkBtn)\b/g


/** 数调用点：钉**组件调用**（`<LinkButton`），不是 import 行、不是注释里的名字。 */
function countCallSites(src: string): number {
  return (src.match(/<LinkButton\b/g) ?? []).length
}

describe('哨兵：族 C 的唯一定义点真实存在', () => {
  it('kit-fields.tsx 导出 LinkButton，且真的渲染 <button>', () => {
    const src = readUi('kit-fields.tsx')
    expect(src, 'LinkButton 没导出 ⇒ 8 处调用点无从收敛').toMatch(
      /export function LinkButton\b/,
    )
    // 钉组件体：必须渲染 <button> 且挂 css.link。
    // ❗ 不能用 `/export function LinkButton\b[\s\S]*?\n\}/` —— 非贪婪会在**函数签名里的
    //    类型对象**的顶格 `}` 处提前截断（签名形如 `({ a }: {\n a: T\n} & BHA<…>)`），
    //    切到的只有参数表。要配平花括号取真函数体（同 `fnBody()` 的坑）。
    const body = functionBody(src, 'LinkButton')
    expect(body, '抓不到 LinkButton 函数体').not.toBeNull()
    expect(body!, 'LinkButton 必须渲染原生 <button>（语义与键盘可达性靠它）').toMatch(
      /<button\b/,
    )
    expect(body!, 'LinkButton 必须挂 css.link（否则样式不生效）').toMatch(/\bcss\.link\b/)
    expect(body!, '组件必须内置 type="button"（否则在 form 内会变成提交按钮）').toMatch(
      /type="button"/,
    )
  })

  it('kit.module.css 的 .link 就是族 C 的唯一定义（六项几何 + 纯下划线 hover）', () => {
    const body = ruleBody(readUi('kit.module.css'), 'link')
    expect(body, '.link 规则块不存在').not.toBeNull()
    const b = body!
    // 五项「无」——这是族 C 的语义，缺一项就不再是链接形态
    expect(b, 'padding 必须为 0（占位会撑开表格单元格）').toMatch(/(?:^|;)\s*padding\s*:\s*0(px)?\s*(?:;|$)/)
    expect(b, 'border 必须 none').toMatch(/(?:^|;)\s*border\s*:\s*none/)
    expect(b, 'background 必须 none 或 transparent').toMatch(
      /(?:^|;)\s*background(?:-color)?\s*:\s*(?:none|transparent)/,
    )
    expect(b, 'cursor 必须 pointer').toMatch(/(?:^|;)\s*cursor\s*:\s*pointer/)
    expect(b, 'color 必须是 --nm-cyan（族 C 的身份色）').toMatch(
      /(?:^|;)\s*color\s*:\s*var\(--nm-cyan\)/,
    )
    // 字号统一令牌（收敛点：现状 11/12px 混用）
    expect(b, 'font-size 必须是令牌，不得是裸值').toMatch(
      /(?:^|;)\s*font-size\s*:\s*var\(--nm-[a-z0-9-]+\)\s*(?:;|$)/,
    )

    const hover = ruleBody(readUi('kit.module.css'), 'link:hover')
    expect(hover, '.link:hover 规则块不存在 ⇒ hover 反馈丢了').not.toBeNull()
    expect(hover!, 'hover 必须是 text-decoration: underline').toMatch(
      /(?:^|;)\s*text-decoration\s*:\s*underline/,
    )
    expect(
      hover!,
      'hover 不得含 decoration 性发光（用户 2026-09-28 裁决「统一为纯下划线」，PRECISION MATRIX 去发光）',
    ).not.toMatch(/text-shadow/)
  })
})

describe('六份模块 CSS 里的族 C 类必须已退役', () => {
  it.each(RETIRED.map(r => [r.file, r.cls] as const))(
    '%s 的 .%s 已删除（否则族 C 是两个定义点，等于没收敛）',
    (file, cls) => {
      const css = readPanels(file)
      const body = ruleBody(css, cls)
      expect(
        body,
        `${file} 里仍有 .${cls} —— 收敛的唯一价值是"只有一个定义点"，两份定义必然分叉`,
      ).toBeNull()
    },
  )
})

describe('八处调用点必须全部走 LinkButton', () => {
  it.each(CALL_SITES.map(c => [c.file, c.times] as const))(
    '%s 恰好有 %i 处 <LinkButton（手写 <button className={css.link…}> 已消除）',
    (file, times) => {
      const src = readPanels(file)
      expect(countCallSites(src), `${file} 的 <LinkButton 调用点数量不对`).toBe(times)
    },
  )

  it('反例自证：全仓不得再有指向已退役类名的 className 属性访问', () => {
    // 只查 `.exportLinkBtn` / `.linkBtn` 两个**高特征**类名——`.link` 太通用
    // （别的模块也可能有同名类），靠上面的「.link 已删除」那条来守。
    const stale: string[] = []
    for (const f of readdirSync(PANELS)) {
      if (!f.endsWith('.tsx')) continue
      const src = readPanels(f)
      STALE_CLASSREF.lastIndex = 0
      const hit = src.match(STALE_CLASSREF)
      if (hit !== null) stale.push(`${f}: ${[...new Set(hit)].join(', ')}`)
    }
    expect(
      stale,
      `这些文件还指着已退役的类名 ⇒ 收敛后 \`css.xxx\` 是 undefined，样式静默失效：\n  ${stale.join('\n  ')}`,
    ).toEqual([])
  })

  it('哨兵下限：调用点总数必须 ≥ 8（点名表被削短也要红）', () => {
    const total = CALL_SITES.reduce((n, c) => n + c.times, 0)
    expect(total, '点名表自己太短 ⇒ 收敛范围被悄悄缩小').toBeGreaterThanOrEqual(8)
    expect(CALL_SITES.length, '点名表本身也得有下限（R7 教训：删一行照样绿）').toBeGreaterThanOrEqual(7)
  })
})

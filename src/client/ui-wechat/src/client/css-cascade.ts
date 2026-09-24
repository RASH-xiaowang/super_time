/**
 * 「一份 CSS Module 到底能不能拆」的尺子 —— 纯函数，不碰文件系统。
 *
 * ## 为什么单独一个模块
 *
 * M21 只剩两个超限的 CSS Module（`chats.module.css` 2904 行、`onboarding.module.css` 1618 行）。
 * 2026-09-22 那次勘测量出「最大不可分簇 = 1140 / 1113 行 ⇒ 拆不到 1000」，但那段算料只活在一次性脚本
 * 与文档文字里：此后每改一次层叠写法都要重新量一遍，而没有机检的数一定会腐烂（本仓库同类的教训见
 * `docs/RELEASE-PLAN.md` 的 N36 与 N38）。所以判据搬到这里，配上枚举期望值的单测。
 *
 * 更要紧的一点：判据**必须与 `scripts/css-bundle-diff.mjs` 的危险判据同一套**，否则「簇算出来能拆」
 * 与「搬完产物报危险」两套口径会各说各话。那边收的是**构建产物**（类名形如 `_msgRow_HASH_行号`，
 * 归一后是 `._msgRow`），这边收的是**源文件**（`.msgRow`，且带 `:global(...)`）——
 * 两种形态的类名抽取**不能合成一个正则**：`._card` 既是「`card` 归一后的样子」也是 kit 里一个
 * **真存在**的类名（第十五刀的撞键事故）。所以 {@link builtClasses} 与 {@link sourceClasses} 分开。
 *
 * ## 三条硬约束（决定「必须同份」）
 *
 * ① **同一条规则里的局部类名**必须同份：CSS Modules 按文件给类名打 hash，跨份引用**静默失效**
 *    （不报错、不红，只是样式没了）。`:global(.x)` 里的名字**不打 hash**，因此不构成约束 ——
 *    这一条是本模块与 2026-09-22 那次一次性脚本的**唯一口径差**，也是那次没量到的地方。
 * ② 被 `animation*:` 引用的 `@keyframes` 名字必须与引用它的规则同份（同理：按文件 hash 名字）。
 * ③ 「同一元素共现的两个类 + 两条规则特异性相同 + 声明的属性名有交集」⇒ 谁生效取决于产物里的
 *    先后，而分家之后先后由 import 图决定 ⇒ 这种类对必须同份。带后代/组合选择器的规则一律保守
 *    算危险（祖先信息在源文件里判不出来）。这条与 `css-bundle-diff` 的 `dangerousFlips` 同判据。
 */

/** 一条叶子规则（`@media` 之类只作为 `at` 前缀记录，不单独成条）。 */
export type Leaf = {
  /** 外层 at-rule 链（`@media (…) >> @container (…)`），顶层规则是空串。 */
  at: string
  /** 归一后的选择器（空白与逗号周围空格压掉）。 */
  sel: string
  /** 归一后的声明串（`;` 分隔）。 */
  decls: string
  /** 起始行（0 基，含）。 */
  a: number
  /** 结束行（0 基，不含）—— 与 {@link a} 一起给出这一条规则占的物理行。 */
  b: number
  /** 选择器里出现的**局部**类名（不含 `:global(...)` 里的）。 */
  classes: string[]
  /** 选择器里 `:global(...)` 内的类名 —— 只用于报告，不参与「必须同份」的闭包。 */
  globals: string[]
}

/** 一个 `@keyframes` 定义。 */
export type Keyframes = { name: string, a: number, b: number }

/** 解析结果：叶子规则 + 关键帧定义 + 文件物理行数。 */
export type SourceCss = { leaves: Leaf[], frames: Keyframes[], lines: number }

/** 归一选择器：压空白、去掉组合符周围的空格（与 `css-bundle-diff` 同口径）。 */
export function normSel (s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').trim()
}

/** 归一声明串：逐条压空白、去空项。 */
export function normDecl (d: string): string {
  return d.split(';')
    .map((x) => x.trim().replace(/\s*:\s*/, ':').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(';')
}

/** 取与 `open` 处 `{` 配对的 `}` 下标；找不到返回文本长度（不抛 —— 让「括号不配」在别处响）。 */
export function matching (text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return text.length
}

/**
 * 把注释**换成等长的空格**再返回 —— 行号要按原始文本算，直接删注释会让后面每条规则的行号整体前移。
 * @param css - 源文本。
 * @returns 没有注释、但偏移与行数完全不变的文本。
 */
export function blankComments (css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 一个偏移量 → 0 基行号。 */
export function lineOf (text: string, offset: number): number {
  let n = 0
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') n += 1
  return n
}

/**
 * 抽**局部**类名：`.foo` 算，`:global(.foo)` 与 `:global .foo` 里的 `foo` 不算。
 *
 * 做法是先把 `:global( … )` 整段摘出来单独收，剩下的按 `.name` 收 —— 因为 CSS Modules 里
 * `:global(.x)` 输出的就是 `x` 本身（不哈希），拆文件对它没有约束；反过来漏掉这条会把
 * `theme-light` 这种全局枢纽当成「必须同份」的类，把整份文件锁死成一团。
 * @param sel - 归一后的选择器。
 * @returns `{ locals, globals }` 两组类名。
 */
export function sourceClasses (sel: string): { locals: string[], globals: string[] } {
  const globals: string[] = []
  const rest = sel.replace(/:global\s*\(([^)]*)\)/g, (_all, inner: string) => {
    for (const m of inner.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) globals.push(m[1] ?? '')
    return ' '
  })
  const locals: string[] = []
  for (const m of rest.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    const name = m[1] ?? ''
    if (name !== '') locals.push(name)
  }
  return { locals, globals }
}

/** 构建产物形态的类名抽取（`_msgRow_HASH_12` 已被 {@link normSel} 之外的那步归一成 `._msgRow`）。 */
export function builtClasses (sel: string): string[] {
  return [...sel.matchAll(/\._([A-Za-z_][\w-]*)/g)].map((m) => m[1] ?? '')
}

/** 声明里用到的属性名集合。 */
export function propsOf (decls: string): Set<string> {
  return new Set(decls.split(';').map((x) => x.split(':')[0] ?? '').filter(Boolean))
}

/** 特异性压成一个数（id×100 + 类/属性/伪类×10 + 类型/伪元素）—— 与 `css-bundle-diff` 同式。 */
export function specificity (sel: string): number {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
  const els = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length
  return ids * 100 + cls * 10 + els
}

/** 带后代/组合选择器（属性选择器里的空格不算）。 */
export function hasCombinator (sel: string): boolean {
  return /[ >+~]/.test(sel.replace(/\[[^\]]*\]/g, ''))
}

/**
 * 标出「整行都是注释」的行（逐行扫，支持跨行注释）。
 *
 * 为什么要标：拆文件时紧贴在规则头上的注释是跟着那条规则搬走的。簇的行数若不算这几行，
 * 每份的**物理行数**就被低估 —— 低估的后果是单向的：把拆不动判成拆得动（上线才发现某份仍超限）。
 * @param css - 原始文本。
 * @returns 与行号对齐的布尔表。
 */
export function commentLines (css: string): boolean[] {
  const lines = css.split('\n')
  const out: boolean[] = []
  let inComment = false
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? ''
    let seenCode = false
    let j = 0
    for (; j < l.length;) {
      if (inComment) {
        const end = l.indexOf('*/', j)
        if (end < 0) { j = l.length } else { inComment = false; j = end + 2 }
        continue
      }
      const start = l.indexOf('/*', j)
      const cut = start < 0 ? l.length : start
      if (l.slice(j, cut).trim() !== '') seenCode = true
      if (start < 0) { j = l.length; continue }
      inComment = true
      j = start + 2
    }
    out.push(!seenCode && l.trim() !== '')
  }
  return out
}

/**
 * 解析源文件（未构建那份）：叶子规则带行号，`@keyframes` 单独收。
 *
 * 显式递归而不是正则：这两份文件里有 `@media { .x { … } }` 与多行选择器列表；一条 `[^}]*}`
 * 会把内层花括号切断（第十五刀 `.root`、第十六刀 `.regionEmpty` 两次事故同一个根因）。
 * @param css - 源文件文本。
 * @returns 叶子规则、关键帧与物理行数。
 */
export function parseSource (css: string): SourceCss {
  const text = blankComments(css)
  const comments = commentLines(css)
  const leaves: Leaf[] = []
  const frames: Keyframes[] = []
  const lines = text.split('\n').length

  /** 一段区间的「规则起始行」：选择器所在行，再往上把紧贴的整行注释一起算进来。 */
  const startLine = (from: number, to: number): number => {
    let off = from
    while (off < to && /\s/.test(text[off] ?? ' ')) off += 1
    let a = lineOf(text, off)
    while (a > 0 && comments[a - 1] === true) a -= 1
    return a
  }

  /**
   * @param from - 这一段文本在 `text` 里的起始偏移（用来算行号）。
   * @param at - 外层 at-rule 链。
   */
  const walk = (from: number, to: number, at: string): void => {
    let i = from
    for (;;) {
      const brace = text.indexOf('{', i)
      if (brace < 0 || brace >= to) break
      const head = text.slice(i, brace).trim()
      const close = matching(text, brace)
      const bodyStart = brace + 1
      const bodyEnd = Math.min(close, to)
      const a = startLine(i, brace)
      const b = lineOf(text, bodyEnd) + 1
      if (head.startsWith('@keyframes') || head.startsWith('@-webkit-keyframes')) {
        const name = head.replace(/@(-webkit-)?keyframes/, '').trim()
        if (name !== '') frames.push({ name, a, b })
      } else if (head.startsWith('@')) {
        const nextAt = at === '' ? normSel(head) : at + ' >> ' + normSel(head)
        walk(bodyStart, bodyEnd, nextAt)
      } else if (head !== '') {
        const { locals, globals } = sourceClasses(head)
        leaves.push({ at, sel: normSel(head), decls: normDecl(text.slice(bodyStart, bodyEnd)), a, b, classes: locals, globals })
      }
      i = bodyEnd + 1
    }
  }
  walk(0, text.length, '')
  return { leaves, frames, lines }
}

/** 并查集：返回 `find`（自带路径压缩）。 */
export function makeFind (): { union: (a: string, b: string) => void, find: (x: string) => string } {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) ?? r
    if (!parent.has(r)) parent.set(r, r)
    let cur = x
    while (parent.get(cur) !== r) {
      const nxt = parent.get(cur) ?? r
      parent.set(cur, r)
      cur = nxt
    }
    return r
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  return { union, find }
}

/** 一条规则里被 `animation*:` 引用的关键帧名（源文件里写的就是局部名）。 */
export function animatedNames (leaf: Leaf, frames: readonly Keyframes[]): string[] {
  const out: string[] = []
  for (const d of leaf.decls.split(';')) {
    if (!/^animation(-name)?:/.test(d)) continue
    const val = d.slice(d.indexOf(':') + 1)
    for (const f of frames) if (new RegExp(`(^|[\\s,])${f.name.replace(/[^\w-]/g, '\\$&')}(?![\\w-])`).test(val)) out.push(f.name)
  }
  return out
}

/** 一个「必须同份」的簇。 */
export type Cluster = { root: string, symbols: Set<string>, rules: number, lines: number }

/**
 * 按给定的连接算簇。
 *
 * 一条规则可以同时属于好几个符号（`.a .b` 里 a、b 都指向它），而它们既然被连进同一簇，
 * 这一行就只能算**一次** —— 第一版按「符号 → 规则」直接累加，把 `.a .b` 数了两遍，
 * 最大簇因此虚高。虚高的害处是单向的：它会把本来能拆的文件判成拆不动。
 * @param links - 一对对「必须同份」的符号（带命名空间：`c:类名` / `k:关键帧名`）。
 * @param owner - 符号 → 它出现的规则。
 * @param frames - `@keyframes` 定义（按名字连进簇）。
 * @param leaves - 全部叶子规则（没有局部类名的规则各自成簇：它们确实能随便搬）。
 * @returns 按行数降序的簇。
 */
export function clustersOf (
  links: readonly (readonly [string, string])[],
  owner: Map<string, Leaf[]>,
  frames: readonly Keyframes[],
  leaves: readonly Leaf[],
): Cluster[] {
  const { union, find } = makeFind()
  for (const [x, y] of links) union(x, y)
  // 没有任何连接的符号也要成簇（否则「孤立规则能随便搬」这件事看不见）
  for (const key of owner.keys()) find(key)
  const byRoot = new Map<string, Cluster>()
  const bucket = (r: string): Cluster => {
    const cur = byRoot.get(r)
    if (cur !== undefined) return cur
    const fresh: Cluster = { root: r, symbols: new Set<string>(), rules: 0, lines: 0 }
    byRoot.set(r, fresh)
    return fresh
  }
  const counted = new Set<Leaf>()
  for (const [sym, owned] of owner) {
    const b = bucket(find(sym))
    b.symbols.add(sym)
    for (const leaf of owned) {
      if (counted.has(leaf)) continue
      counted.add(leaf)
      b.rules += 1
      b.lines += leaf.b - leaf.a
    }
  }
  // 一条局部类名都没有的规则（`div > span`、`:root` 之类）不受任何约束 ⇒ 每条各自一簇。
  for (const leaf of leaves) {
    if (counted.has(leaf)) continue
    counted.add(leaf)
    const b = bucket('u:' + String(leaf.a) + ':' + leaf.sel)
    b.rules += 1
    b.lines += leaf.b - leaf.a
  }
  for (const f of frames) {
    const b = bucket(find('k:' + f.name))
    b.symbols.add('k:' + f.name)
    // 关键帧块本身占的行要算进它所在的那一簇（没人引用时它自己就是一簇）。
    b.lines += f.b - f.a
  }
  return [...byRoot.values()].sort((x, y) => (y.lines - x.lines) || (x.root < y.root ? -1 : 1))
}

/**
 * 约束 ① + ②：同一规则里的局部类名互连；规则与它 `animation:` 引用的关键帧相连。
 * @param parsed - {@link parseSource} 的结果。
 * @returns 连接对与「符号 → 规则」的归属表（喂给 {@link clustersOf}）。
 */
export function weakLinks (parsed: SourceCss): { links: Array<[string, string]>, owner: Map<string, Leaf[]> } {
  const links: Array<[string, string]> = []
  const owner = new Map<string, Leaf[]>()
  const put = (sym: string, leaf: Leaf): void => {
    const list = owner.get(sym)
    if (list === undefined) owner.set(sym, [leaf])
    else if (!list.includes(leaf)) list.push(leaf)
  }
  /**
   * 一条规则的「锚点符号」：有局部类名就用第一个类，没有就用这条规则自己。
   *
   * 不能给「没有局部类名」的规则统一挂一个 `c:__无类名__` —— 那会把全文件所有元素级规则
   * （`div > span`、`p`…）连成一团，凭空造出一个大簇。
   */
  const anchorOf = (leaf: Leaf): string => leaf.classes[0] === undefined
    ? 'u:' + String(leaf.a) + ':' + leaf.sel
    : 'c:' + leaf.classes[0]
  for (const leaf of parsed.leaves) {
    for (const c of leaf.classes) put('c:' + c, leaf)
    // 引用了关键帧 ⇒ 把这条规则挂到锚点符号上（锚点没有局部类名时它本来不在 owner 里）。
    // 注意这里**不需要**额外的 put：`clustersOf` 里没被任何符号认领的规则会自己成一簇，
    // 而 `links` 已经把那个簇根与 `k:名字` 并到一起 —— 写了变异才知道这行 put 是多余的。
    const frames = animatedNames(leaf, parsed.frames)
    for (const k of frames) links.push([anchorOf(leaf), 'k:' + k])
    for (let i = 1; i < leaf.classes.length; i += 1) links.push(['c:' + (leaf.classes[0] ?? ''), 'c:' + (leaf.classes[i] ?? '')])
  }
  return { links, owner }
}

/** 一处「分了家就会因产物次序而变样式」的危险类对。 */
export type Danger = { pair: string, sel1: string, sel2: string, why: string }

/**
 * 约束 ③：共现类对里「同特异性 + 属性有交集」的那些（带组合选择器一律保守算危险）。
 *
 * 与 `css-bundle-diff` 的 `dangerousFlips` 同一判据，区别只在：那边比的是「改动前后**同一条规则**的
 * 相对次序是否翻转」，这边还没有「改动后」—— 它回答的是「这两个类**能不能分到两份文件里**」，
 * 判据换成「只要这对类可能抢同一条属性，就必须同份」。这是**必要条件**而不是充分条件
 * （分家之后它们仍可能同属一个元素），所以宁可多连。
 * @param parsed - 源文件解析结果。
 * @param cooc - 消费者里同一元素共现的类名对（`a + b`，两侧同文件内的局部名）。
 * @returns 危险类对清单。
 */
export function dangerPairs (parsed: SourceCss, cooc: ReadonlySet<string>): Danger[] {
  const rulesOf = (cls: string): Leaf[] => parsed.leaves.filter((l) => l.classes.includes(cls))
  const out: Danger[] = []
  for (const pair of cooc) {
    const [c1, c2] = pair.split(' + ')
    if (c1 === undefined || c2 === undefined) continue
    const r1 = rulesOf(c1)
    const r2 = rulesOf(c2)
    if (r1.length === 0 || r2.length === 0) continue
    for (const x of r1) {
      for (const y of r2) {
        if (x === y) continue
        const comb = hasCombinator(x.sel) || hasCombinator(y.sel)
        const p = propsOf(y.decls)
        const overlap = [...propsOf(x.decls)].some((k) => p.has(k))
        const sameSpec = specificity(x.sel) === specificity(y.sel)
        if (!comb && !(sameSpec && overlap)) continue
        out.push({
          pair,
          sel1: (x.at === '' ? '' : x.at + ' » ') + x.sel,
          sel2: (y.at === '' ? '' : y.at + ' » ') + y.sel,
          why: comb ? '含后代/组合选择器（保守判危险）' : `同特异性 ${String(specificity(x.sel))} 且抢 ${[...propsOf(x.decls)].filter((k) => p.has(k)).join(',')}`,
        })
      }
    }
  }
  return out
}

/**
 * 保序连续切点：在不 regroup 的前提下，有多少个行边界可以把文件切成「每段 ≤ limit 行且没有类名跨段」。
 * @param parsed - 源文件解析结果。
 * @param limit - 每份的行数上限。
 * @returns 合法切点（0 就是一次都切不动）。
 */
export function contiguousCuts (parsed: SourceCss, limit: number): number[] {
  const spans = new Map<string, [number, number]>()
  const note = (c: string, a: number, b: number): void => {
    const cur = spans.get(c)
    if (cur === undefined) spans.set(c, [a, b])
    else {
      if (a < cur[0]) cur[0] = a
      if (b > cur[1]) cur[1] = b
    }
  }
  for (const l of parsed.leaves) for (const c of l.classes) note(c, l.a, l.b)
  for (const f of parsed.frames) note('k:' + f.name, f.a, f.b)
  // 切点 L 表示「在第 L 行之前断开」。某个类名的跨度 [a,b) 跨过它 ⇔ a < L < b —— 跨了就等于把这个
  // 类名分进两份文件，而 CSS Modules 会给它两个哈希，静默失效（比报错更坏）。
  const ranges = [...spans.values()]
  const cuts: number[] = []
  for (let l = 1; l < parsed.lines; l += 1) {
    if (!ranges.some(([a, b]) => a < l && b > l)) cuts.push(l)
  }
  return cuts
}

/**
 * 「只按保序连续切点切」需要几份，每份多少行；切不出来返回 `null`。
 *
 * 贪心取「能取的最远合法切点」在这里是最优的：所有段都要 ≤ limit，段越少越容易让每段都够长，
 * 所以先长后短不可能比贪心更差 —— 贪心失败（下一段找不到任何合法切点）就等于「不存在可行分法」。
 * @param cuts - {@link contiguousCuts} 的结果（升序）。
 * @param lines - 文件物理行数。
 * @param limit - 每份上限。
 * @returns 各份的行数，或 `null`。
 */
export function orderSplits (cuts: readonly number[], lines: number, limit: number): number[] | null {
  const ok = new Set<number>(cuts)
  const parts: number[] = []
  let start = 0
  while (start < lines) {
    const cap = Math.min(lines, start + limit)
    if (cap === lines) { parts.push(lines - start); return parts }
    let cut = -1
    for (let l = cap; l > start; l -= 1) {
      if (ok.has(l)) { cut = l; break }
    }
    if (cut <= start) return null
    parts.push(cut - start)
    start = cut
  }
  return parts
}

/** 一份拆出来的 CSS（名字 + 原文）。 */
export type SplitPart = { name: string, css: string }

/** 一个消费者：它的原文 + 「别名 → 哪一份」的对应表（对应表来自它的 import 行，由调用方给）。 */
export type SplitConsumer = { file: string, text: string, aliases: Array<{ alias: string, part: string }> }

/**
 * 拆完一套 CSS Module 之后的三条不变量（第 49/50 刀共用这一份实现）。
 *
 * 为什么放进尺子里而不是各写一份 spec：chats 与 onboarding 是**同一套判据**，
 * 两个 spec 各抄一遍的话，将来只有一份会修 —— 那正是本模块开头写的那件事（一把尺子两套实现）。
 *
 * ① **各份的局部类名两两不相交**：CSS Modules 按文件打 hash，同名类出现在两份里就是两个 token，
 *    React 只写一次 `css.x` 的那一份**静默失效**（不报错、构建照过、测试也不红）；
 * ② **每个 `别名.类名` 都能在它 import 的那份里找到**：引用搬家而别名没改 ⇒ 拿到 `undefined` ⇒
 *    那个元素没有样式（`className={undefined}` 时 React 连属性都不写，所以症状是「样式凭空少了」）；
 * ③ **每份自己不超过上限**：拆出来不是躲过棘轮的办法。
 * @param parts - 拆出来的各份（含原来那份）。
 * @param consumers - 引用它们的文件。
 * @param limit - 每份的行数上限。
 * @returns 缺陷清单；空数组 = 三条都成立。
 */
export function splitInvariants (parts: readonly SplitPart[], consumers: readonly SplitConsumer[], limit: number): string[] {
  const out: string[] = []
  const infos = parts.map((p) => ({
    name: p.name,
    classes: new Set(parseSource(p.css).leaves.flatMap((l) => l.classes)),
    lines: p.css.split(/\r?\n/).length - (p.css.endsWith('\n') ? 1 : 0),
  }))
  for (let a = 0; a < infos.length; a += 1) {
    for (let b = a + 1; b < infos.length; b += 1) {
      const ia = infos[a]
      const ib = infos[b]
      if (ia === undefined || ib === undefined) continue
      for (const c of ia.classes) if (ib.classes.has(c)) out.push(`① 同名类 ${c} 出现在 ${ia.name} 与 ${ib.name} 两份里`)
    }
  }
  for (const c of consumers) {
    for (const { alias, part } of c.aliases) {
      const info = infos.find((i) => i.name === part)
      if (info === undefined) { out.push(`② ${c.file}：别名 ${alias} 指向 ${part}，但这份不在表里`); continue }
      const re = new RegExp(`\\b${alias.replace(/[^\w$]/g, '\\$&')}\\.([A-Za-z_][\\w-]*)`, 'g')
      for (const m of c.text.matchAll(re)) {
        const cls = m[1] ?? ''
        if (!info.classes.has(cls)) out.push(`② ${c.file}：${alias}.${cls} 不在 ${info.name} 里（引用悬空 ⇒ 运行时是 undefined）`)
      }
    }
  }
  for (const i of infos) {
    if (i.lines > limit) out.push(`③ ${i.name} 有 ${String(i.lines)} 行 > 上限 ${String(limit)}`)
  }
  return out
}

/** 一张表的可读摘要（脚本与单测共用，免得两处各写一遍格式化）。 */
export function summarize (
  name: string,
  parsed: SourceCss,
  weak: readonly Cluster[],
  clusters: readonly Cluster[],
  limit: number,
  coocCount: number,
  dangerCount: number,
  cuts: readonly number[],
): string[] {
  const max = clusters[0]
  const bins = pack(clusters.map((c) => c.lines), limit)
  const over = clusters.filter((c) => c.lines > limit)
  const inOrder = orderSplits(cuts, parsed.lines, limit)
  const classes = new Set(parsed.leaves.flatMap((l) => l.classes)).size
  return [
    `== ${name}：${String(parsed.lines)} 物理行、${String(parsed.leaves.length)} 条叶子规则、` +
      `${String(parsed.frames.length)} 个 @keyframes、${String(classes)} 个局部类名`,
    `   弱闭包（同名类必须同份 + 关键帧跟着引用者走）最大簇 ${String(weak[0]?.lines ?? 0)} 行；` +
      `消费者里同一元素共现的类对 ${String(coocCount)} 对 ⇒ 其中 ${String(dangerCount)} 处「分了家就会因产物次序而变样式」；` +
      `强闭包最大簇 ${String(max?.lines ?? 0)} 行 / ${String(max?.symbols.size ?? 0)} 个符号` +
      (coocCount === 0 ? '  ⚠ 一对共现都没匹配上 ⇒ 强闭包这一列**不算数**（它只是没数据，不是没有危险对）' : ''),
    `   ① 保序连续切点 ${String(cuts.length)} 个 ⇒ ` + (inOrder === null
      ? '切不出「每份都 ≤ 上限」的分法（类名跨度盖住了每一个行边界）'
      : `可切成 ${String(inOrder.length)} 份（${inOrder.map((x) => String(x)).join(' / ')} 行）`),
    `   ② 按簇 regroup（上限 ${String(limit)} 行/份）：` + (over.length > 0
      ? `有 ${String(over.length)} 个簇本身就超 ⇒ **不改层叠语义拆不动**（最大的那几簇的根：${over.slice(0, 3).map((c) => c.root.replace(/^c:/, '.')).join('、')}）`
      : `${String(bins.length)} 份装得下（各份 ${bins.map((x) => String(x)).join(' / ')}）⇒ 按簇分家可行，代价是规则次序会变，拆完必须过 css:bundle-diff`),
  ]
}

/** 贪心装箱（降序 first-fit）：返回每份装了多少行。 */
export function pack (sizes: readonly number[], limit: number): number[] {
  const bins: number[] = []
  for (const n of [...sizes].sort((a, b) => b - a)) {
    if (n > limit) { bins.push(n); continue }
    const k = bins.findIndex((used) => used + n <= limit)
    if (k < 0) bins.push(n)
    else bins[k] = (bins[k] ?? 0) + n
  }
  return bins
}

/**
 * 从 TSX 源码文本里抽「同一元素共现的类名对」。
 *
 * 取法与 `css-bundle-diff` 的 `coOccurrences` 同源，但**花括号按深度配对**而不是「遇到第一个 `}` 就停」：
 * 模板串写法 `` className={`${css.a} ${css.b}`} `` 里那个 `}` 是插值的收尾，非贪婪正则在那里就断了 ⇒
 * 只读出 `css.a` 一个名字 ⇒ 这一类共现**整批看不见**，而共现看不见就等于「没有危险对」——
 * 这是最坏的一种漏（把拆不动判成拆得动）。2026-09-24 实测：同一份代码库里两种取法的对数不同。
 * @param texts - 一份份 TSX/TS 源码文本。
 * @returns `a + b`（字典序）的集合。
 */
export function coOccurrencesFromSources (texts: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const t of texts) {
    let from = 0
    for (;;) {
      const at = t.indexOf('className={', from)
      if (at < 0) break
      const start = at + 'className={'.length
      let i = start
      let depth = 1
      while (i < t.length && depth > 0) {
        const ch = t[i]
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
        i += 1
      }
      const body = t.slice(start, Math.min(i, start + 800))
      const names: string[] = []
      for (const x of body.matchAll(/[A-Za-z_$][\w$]*\.([A-Za-z_][\w-]*)/g)) names.push(x[1] ?? '')
      for (let a = 0; a < names.length; a += 1) {
        for (let b = a + 1; b < names.length; b += 1) {
          if (names[a] !== names[b]) out.add([names[a] ?? '', names[b] ?? ''].sort().join(' + '))
        }
      }
      from = start
    }
  }
  return out
}

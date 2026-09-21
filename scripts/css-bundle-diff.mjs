/**
 * 产物 CSS 的**规则序列**对比 —— 用来证明「CSS Modules 的拆分/搬移没有改变样式语义」。
 *
 * 为什么需要它：`ui:smoke` 只做 SSR 标记，看不到样式；而跨文件搬 CSS 规则会改变产物里
 * 规则的**顺序**（Vite 按 import 图发 CSS），等特异性的两条规则一旦换序，命中同一个元素时
 * 胜负就翻盘了 —— 这种回归在单测与冒烟里全是绿的。
 *
 * 判据（比「截图肉眼比」更强，因为它是穷尽的）：
 *   ① 规则集合逐条对齐 —— 少一条（LOST）/ 多一条（ADDED）/ 同选择器但声明变了（CHANGED）都报；
 *   ② 规则**相对次序**不变 —— 前后都在的规则里，谁在谁前面变了就报 ORDER。
 * 只要 ①② 干净，产物 CSS 的语义就与改前一致（CSS 只有「顺序」这一个语义通道）。
 *
 * 用法（拆 CSS 前先存基线，拆完重建再比）：
 *   npm run build:ui
 *   node scripts/css-bundle-diff.mjs --save /tmp/css-before.json
 *   …改 CSS Modules / 改 TSX 里的类名前缀…
 *   npm run build:ui
 *   node scripts/css-bundle-diff.mjs --check /tmp/css-before.json
 *
 * 归一化：Vite 的类名形如 `._card_1wkk6_1299`（local + 哈希 + 源文件行号）。搬移会让哈希与
 * 行号都变，所以比对前把它们抹掉、只留 local —— 否则「搬一行」会被误报成「整条规则变了」。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'src', 'client', 'ui-dist', 'assets')

/** 产物里体积最大的那份 CSS（主样式表；WorldMap 之类是异步分块）。与 check-wx-tokens 同口径。 */
function mainCss() {
  const files = readdirSync(ASSETS)
    .filter((f) => f.endsWith('.css'))
    .map((f) => ({ f, p: join(ASSETS, f), size: statSync(join(ASSETS, f)).size }))
    .sort((a, b) => b.size - a.size)
  if (files.length === 0) {
    console.error('ui-dist/assets 下没有 CSS，请先运行 npm run build:ui')
    process.exit(2)
  }
  return files[0]
}

/**
 * 类名归一：`_card_1wkk6_1299` → `_card`（哈希与行号都会因搬移而变）。
 *
 * **声明里也要抹**：`@keyframes` 的名字同样经 CSS Modules 处理，会出现在
 * `animation:_noticeIn_bcqhk_1` 这种声明内部；而哈希是按**文件内容**算的 ——
 * 改一行 CSS，整个文件的类名与关键帧名一起换哈希。只抹选择器会把每条带 animation
 * 的规则都误报成「声明变了」（第一版就这么被骗过一次）。
 */
const HASHED = /_([A-Za-z_][\w-]*)_[a-z0-9]{4,}_\d+/g
const normSel = (s) => s.replace(HASHED, '_$1').replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').trim()
const normDecl = (d) =>
  d.split(';')
    .map((x) => x.trim().replace(HASHED, '_$1').replace(/\s*:\s*/, ':').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(';')

/** 取与 open 处 `{` 配对的 `}` 的下标。 */
function matching(text, open) {
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
 * 把 CSS 拆成叶子规则（保持文档顺序）。
 *
 * 显式递归而不是正则：实例里有 `@container … { .x { … } }` 这种嵌套，一条 `[^}]*}` 会把内层
 * 花括号切断、把外层选择器与内层声明拼成一条**不存在**的规则 —— 那会让「顺序变了」看不出来。
 * 实测产物形状：叶子规则 + `@media`(43) / `@container`(8) / `@keyframes`(40)，没有 `&` 嵌套。
 */
function parseRules(css, atPrefix = '', out = []) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let i = 0
  for (;;) {
    const brace = text.indexOf('{', i)
    if (brace < 0) break
    const head = text.slice(i, brace).trim()
    const close = matching(text, brace)
    const body = text.slice(brace + 1, close)
    if (head.startsWith('@')) {
      // 至少带一层块（media/container/keyframes…）→ 递归；@layer 之类同理
      parseRules(body, atPrefix ? atPrefix + ' >> ' + normSel(head) : normSel(head), out)
    } else {
      out.push({ at: atPrefix, sel: normSel(head), decls: normDecl(body) })
    }
    i = close + 1
  }
  return out
}

const key = (r) => r.at + ' | ' + r.sel
/** 一条规则的完整指纹（含声明）——比对的**主判据**就是它组成的序列。 */
const line = (r) => `${key(r)} { ${r.decls} }`

/**
 * 冲突分析用的三个小工具。
 *
 * 产物里 3014 条叶规则中只有 24 条带后代/组合选择器（其余是单类 + 伪类/属性），所以
 * 「两个类会不会落在同一个元素上」可以用**源码里的 className 共现**来判：一个元素只会受
 * 它自己带的类影响（后代选择器那 24 条按保守处理，见下）。
 */
const classesOf = (sel) => [...sel.matchAll(/\._([A-Za-z_][\w-]*)/g)].map((m) => m[1])
const propsOf = (decls) => new Set(decls.split(';').map((x) => x.split(':')[0]).filter(Boolean))
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
  const els = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length
  return ids * 100 + cls * 10 + els
}
const hasCombinator = (sel) => /[ >+~]/.test(sel.replace(/\[[^\]]*\]/g, ''))

/** 源码里的 className 共现：同一个 className 表达式里同时出现的两个 CSS Modules 局部类名。 */
function coOccurrences(root) {
  const out = new Set()
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'ui-dist') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.tsx')) files.push(p)
    }
  }
  walk(join(root, 'src', 'client'))
  for (const f of files) {
    const t = readFileSync(f, 'utf8')
    for (const m of t.matchAll(/className=\{([\s\S]{0,600}?)\}/g)) {
      const names = [...m[1].matchAll(/[A-Za-z_$][\w$]*\.([A-Za-z_][\w-]*)/g)].map((x) => x[1])
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          if (names[i] !== names[j]) out.add([names[i], names[j]].sort().join(' + '))
        }
      }
    }
  }
  return out
}

/** 多重集差：`a` 里有而 `b` 里没有的条目（含重复计数）。 */
function multisetDiff(a, b) {
  const c = new Map()
  for (const x of b) c.set(x, (c.get(x) ?? 0) - 1)
  const out = []
  for (const x of a) {
    const n = c.get(x) ?? 0
    if (n < 0) c.set(x, n + 1)
    else out.push(x)
  }
  return out
}

/**
 * 翻转的规则对里，哪些**可能真的改变元素样式**。
 *
 * 判据：两个类在同一元素上共现（否则一个元素不会同时匹配两条规则）＋ 特异性相同
 * （不同则谁赢与顺序无关）＋ 声明的属性名有交集（不重叠就各写各的）。
 * 三条同时满足才算危险；带后代/组合选择器的规则一律保守算危险（它们的匹配还取决于祖先）。
 */
function dangerousFlips(before, after, cooc) {
  /** 指纹 → 出现过的下标（按出现次序），用来把「同一条规则」在两次构建里对上号。 */
  const lineage = (rules) => {
    const m = new Map()
    rules.forEach((r, i) => {
      const h = line(r)
      if (!m.has(h)) m.set(h, [])
      m.get(h).push(i)
    })
    return m
  }
  const bLin = lineage(before)
  const aLin = lineage(after)
  const rulesOf = (rules, cls) => rules.map((r, i) => ({ r, i })).filter((x) => classesOf(x.r.sel).includes(cls))
  const dangerous = []
  let checked = 0
  // 同名类要单独补一遍：`.root` 与 `.root[data-in-dialog]` 这类「基态 + 变体」天然作用于
  // 同一个元素，而 className 共现里看不到它们（元素上只写了一次 `css.root`）。
  const sameName = new Set()
  for (const r of before) for (const c of classesOf(r.sel)) sameName.add(c)
  for (const c of sameName) cooc.add(c + ' + ' + c)
  for (const pair of cooc) {
    const [c1, c2] = pair.split(' + ')
    const b1 = rulesOf(before, c1); const b2 = rulesOf(before, c2)
    const a1 = rulesOf(after, c1); const a2 = rulesOf(after, c2)
    if (!b1.length || !b2.length || !a1.length || !a2.length) continue
    checked += 1
    for (const x1 of b1) {
      for (const x2 of b2) {
        // 规则内容若在两次构建里都出现过，就能给每条规则找到「它自己」在另一半里的位置；
        // 只对「同一条规则 × 同一条规则」判次序，别拿 A 模块的 .btnFx 去和 B 模块的 .btnFixed 比。
        const h1 = line(x1.r); const h2 = line(x2.r)
        const n1b = bLin.get(h1).indexOf(x1.i)
        const n2b = bLin.get(h2).indexOf(x2.i)
        const after1 = aLin.get(h1)?.[n1b]; const after2 = aLin.get(h2)?.[n2b]
        if (after1 === undefined || after2 === undefined) continue
        const beforeRel = x1.i < x2.i
        const afterRel = after1 < after2
        if (beforeRel === afterRel) continue
        const comb = hasCombinator(x1.r.sel) || hasCombinator(x2.r.sel)
        const sameSpec = specificity(x1.r.sel) === specificity(x2.r.sel)
        const p2 = propsOf(x2.r.decls)
        const overlap = [...propsOf(x1.r.decls)].some((p) => p2.has(p))
        if (process.env.CSS_DIFF_TRACE && pair.includes(process.env.CSS_DIFF_TRACE)) {
          console.error(`[trace] ${pair} 翻转：${x1.r.sel}(${x1.i}→${after1}) / ${x2.r.sel}(${x2.i}→${after2})`
            + ` spec ${specificity(x1.r.sel)}/${specificity(x2.r.sel)} 属性重叠=${overlap} 组合=${comb}`)
        }
        if (comb || (sameSpec && overlap)) {
          dangerous.push(`${pair}：${x1.r.sel} 与 ${x2.r.sel} 的相对次序翻转`
            + `${comb ? '（含后代/组合选择器，保守判危险）' : ''}`)
        }
      }
    }
  }
  return { dangerous, checked }
}

function main() {
  const mode = process.argv[2]
  const path = process.argv[3]
  const { f, p, size } = mainCss()
  const rules = parseRules(readFileSync(p, 'utf8'))
  console.log(`读取 ${f}（${(size / 1024).toFixed(0)} KB）→ ${rules.length} 条规则`)
  if (mode === '--save') {
    writeFileSync(path, JSON.stringify(rules))
    console.log(`基线已写入 ${path}`)
    return
  }
  if (mode !== '--check' || !path) {
    console.error('用法：node scripts/css-bundle-diff.mjs --save <file> | --check <file>')
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(path, 'utf8'))
  const seqBefore = before.map(line)
  const seqAfter = rules.map(line)
  const identical = seqBefore.length === seqAfter.length && seqBefore.every((x, i) => x === seqAfter[i])

  // 不等价时给出分类统计。注意**必须按多重集比**：类名归一后，不同模块的同名类
  // （`._card` 在 kit 与 settings 里各有一份）会撞键 —— 用 Map 去重会把同一条规则
  // 与另一条比，自比都能报出 403 条「声明变了」（第一版就这么错的）。
  const lostPairs = multisetDiff(seqBefore, seqAfter)
  const addedPairs = multisetDiff(seqAfter, seqBefore)
  const lostKeys = multisetDiff(before.map(key), rules.map(key))
  const addedKeys = multisetDiff(rules.map(key), before.map(key))

  // 次序变了不等于样式变了：跨文件搬规则时，产物里模块的先后会跟着变（Vite 按 import 图发 CSS），
  // 但只要「可能落在同一个元素上的那两类」相对次序没变，就没有元素能看到不同的结果。
  const cooc = coOccurrences(ROOT)
  const { dangerous, checked } = dangerousFlips(before, rules, cooc)

  if (!identical) {
    let at = 0
    while (at < Math.max(seqBefore.length, seqAfter.length) && seqBefore[at] === seqAfter[at]) at += 1
    console.error(`\n! 规则序列不等价，首个差异在第 ${at} 条：`)
    console.error(`    前 = ${seqBefore[at] ?? '(缺)'}`)
    console.error(`    后 = ${seqAfter[at] ?? '(缺)'}`)
    if (lostPairs.length) {
      console.error(`\n! 内容层少了 ${lostPairs.length} 条：`)
      for (const x of lostPairs.slice(0, 6)) console.error(`    - ${x}`)
    }
    if (addedPairs.length) {
      console.error(`\n! 内容层多了 ${addedPairs.length} 条：`)
      for (const x of addedPairs.slice(0, 6)) console.error(`    + ${x}`)
    }
    if (lostPairs.length === 0 && addedPairs.length === 0) {
      console.error('\n（内容逐条相同、只是相对次序变了 —— CSS 拆分最常见的形态，需按下面的冲突分析判）')
    }
    if (lostKeys.length || addedKeys.length) {
      console.error(`\n选择器层：少了 ${lostKeys.length} 个 / 多了 ${addedKeys.length} 个`)
      for (const x of lostKeys.slice(0, 4)) console.error(`    - ${x}`)
      for (const x of addedKeys.slice(0, 4)) console.error(`    + ${x}`)
    }
  }
  console.log(`\n冲突分析：源码里共现的类对 ${cooc.size} 个，其中相对次序变化并可能影响同一元素的 ${dangerous.length} 个（已核 ${checked} 个共现类对）`)
  for (const d of dangerous.slice(0, 8)) console.error(`    ✗ ${d}`)
  const ok = lostPairs.length === 0 && addedPairs.length === 0 && lostKeys.length === 0 && addedKeys.length === 0 && dangerous.length === 0
  console.log(ok
    ? (identical
      ? `\n✅ 产物 CSS 语义等价：${rules.length} 条规则，逐条（选择器 + 声明 + 次序）与基线一致`
      : `\n✅ 产物 CSS 语义等价：${rules.length} 条规则集合逐条一致；次序有变化，但**没有任何一对可能共现的类**因此改变胜负`)
    : `\n❌ 产物 CSS 与基线不等价（少了 ${lostPairs.length} / 多了 ${addedPairs.length} 条；危险次序变化 ${dangerous.length} 处）`)
  process.exit(ok ? 0 : 1)
}

main()

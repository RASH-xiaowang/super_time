/**
 * 账本自检：把文档里所有**可机器核对**的断言过一遍。
 *
 * 为什么需要：这 20+ 轮我反复往同一份文档里追加，已出现过
 *   ① 幻影引用（引用不存在的文件）
 *   ② 引用的行号超出文件范围
 *   ③ 命令名与 `package.json` 对不上
 *   ④ 数字与源码不符（如"8 个用例"实际 10 个）
 *   ⑤ 中间结论已被推翻、但标题读起来仍像结论
 *   ⑥ 结构损坏（重复标题）—— 已修过两次
 * 每次都是发现一个修一个，这里一次性机械核对。
 *
 * 口径：文档里大量引用**只有 basename**（如 `sync.ts:33`），正文已给出模块名，
 * 所以按 basename 建索引解析，而不是要求写全路径。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const ROOT = 'D:/super-time-wechat'
const LEDGER = join(ROOT, 'docs', 'PERF-THEME-LEDGER-2026-09-29.md')
const text = readFileSync(LEDGER, 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let problems = 0
const bad = (m) => { problems++; console.log('  x ' + m) }
const ok = (m) => console.log('  ok ' + m)

/** basename → 绝对路径数组。 */
const INDEX = new Map()
function walk (dir) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (['node_modules', '.git', 'lib', 'deps', 'ui-dist'].includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!/\.(ts|tsx|js|mjs|css|json)$/.test(e.name)) continue
    if (!INDEX.has(e.name)) INDEX.set(e.name, [])
    INDEX.get(e.name).push(p)
  }
}
// `working/` 也建索引：它是 **gitignored 的本地草稿目录**，账本里会引用它
// （探针脚本、诊断产物、BEFORE/AFTER 快照）。不建索引的话，这些引用会被
// 误报成"文件不存在" —— 而它们在本机确实存在，只是**不进仓库**。
// 注意：这同时也意味着"引用 working/ 的行**在别的机器上解析不了**"，
// 所以账本里凡引用它都明确标注了 `working/`（本地、未入库）。
for (const d of ['src', 'docs', 'scripts', 'working']) walk(join(ROOT, d))

/**
 * 解析文档引用为绝对路径。
 * @param p - 文档里写的路径。
 * @returns 绝对路径、'SKIP'（省略写法）或 null。
 */
function resolveRef (p) {
  if (p.includes('...')) return 'SKIP'
  if (existsSync(join(ROOT, p))) return join(ROOT, p)
  const hits = INDEX.get(basename(p)) ?? []
  if (hits.length === 0) return null
  return hits.find((h) => h.replace(/\\/g, '/').endsWith(p)) ?? hits[0]
}

console.log('=== (1) 文件引用是否存在 ===')
{
  const paths = new Set()
  for (const m of text.matchAll(/`([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs|css|json|md))`/g)) {
    const p = m[1]
    if (/^(?:src|docs|scripts|tools|tests)\//.test(p) || p === 'main.js') paths.add(p)
  }
  let n = 0
  for (const p of paths) {
    const r = resolveRef(p)
    if (r === 'SKIP') continue
    n++
    if (r === null) bad(`引用不存在的文件: ${p}`)
  }
  ok(`检查了 ${n} 个文件引用`)
}

console.log('\n=== (2) 路径:行号 是否在范围内 ===')
{
  const seen = new Set()
  let n = 0
  for (const m of text.matchAll(/`?([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs|css)):(\d+)(?:-(\d+))?`?/g)) {
    const p = m[1]; const a = m[2]; const b = m[3]
    const key = p + ':' + a + ':' + String(b)
    if (seen.has(key)) continue
    seen.add(key)
    const full = resolveRef(p)
    if (full === 'SKIP') continue
    if (full === null) { bad(`行号引用指向不存在的文件: ${p}:${a}`); continue }
    const lines = readFileSync(full, 'utf8').split('\n').length
    n++
    const hi = Number(b ?? a)
    if (Number(a) < 1 || hi > lines) bad(`${p}:${a}${b ? '-' + b : ''} 超出文件行数（实际 ${lines} 行）`)
  }
  ok(`检查了 ${n} 个行号引用`)
}

console.log('\n=== (3) npm 命令是否存在 ===')
{
  const cmds = new Set()
  for (const m of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) cmds.add(m[1])
  for (const c of cmds) if (pkg.scripts[c] === undefined) bad(`npm run ${c} 不存在于 package.json`)
  ok(`检查了 ${cmds.size} 个: ${[...cmds].join(', ')}`)
}

console.log('\n=== (4) 声明的数字是否与源码一致 ===')
{
  const spec = readFileSync(join(ROOT, 'src/backend/wechat-data/tests/query-yield-discipline.spec.ts'), 'utf8')
  const list = /P1_2_MODULES[^=]*=\s*\[([\s\S]*?)\]/.exec(spec)
  const nMods = [...(list?.[1] ?? '').matchAll(/'([^']+)'/g)].length
  const claimed = [...text.matchAll(/P1-2[^\n]*?\*\*(\d+)\s*个模块\*\*/g)].map((m) => Number(m[1]))
  if (claimed.length === 0) console.log('  (未声明 P1-2 模块数)')
  else if (claimed.every((c) => c === nMods)) ok(`P1-2 模块数一致（${nMods}）`)
  else bad(`P1-2 模块数不一致：文档 ${claimed.join('/')}，源码 ${nMods}`)

  const ts = readFileSync(join(ROOT, 'src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts'), 'utf8')
  const nCases = [...ts.matchAll(/^\s*it\(/gm)].length
  const m2 = /主题对比度[^\n]*?(\d+)\s*个用例/.exec(text)
  if (m2 === null) console.log('  (未声明主题对比度用例数)')
  else if (Number(m2[1]) === nCases) ok(`主题对比度用例数一致（${nCases}）`)
  else bad(`主题对比度用例数不一致：文档 ${m2[1]}，源码 ${nCases}`)
}

console.log('\n=== (5) 像"结论"的小节标题是否带时效标注 ===')
{
  const CONCLUSIVE = /根因确定|真正的原因|找到了更上游|根因已确定/
  const MARKED = /否掉|推翻|尚未证实|削弱|未定位|已排除/
  const stale = []
  for (const m of text.matchAll(/^#{3,4} (.+)$/gm)) {
    const h = m[1]
    if (CONCLUSIVE.test(h) && !MARKED.test(h)) stale.push(h)
  }
  if (stale.length === 0) ok('所有结论式小节标题都带了时效标注')
  else for (const s of stale) bad(`标题像结论但未标注已被否掉: ${s}`)
}

console.log('\n=== (6) 结构：标题无重复 ===')
{
  const seen = new Set()
  let dup = 0
  const hs = [...text.matchAll(/^(#{2,4}) (.+)$/gm)]
  for (const m of hs) {
    const k = m[1].length + ':' + m[2].trim()
    if (seen.has(k)) { bad(`重复标题: ${m[2].trim()}`); dup++ }
    seen.add(k)
  }
  if (dup === 0) ok(`标题 ${hs.length} 个，无重复`)
}

console.log('\n=== (7) 账本声明的棘轮值 == 棘轮文件里的值 ===')
{
  // 账本里用 `ratchet: <文件>  <函数>  <值>` 声明（见第二节 2a-1）。
  const declared = [...text.matchAll(/^ratchet:\s+(\S+)\s+(\S+)\s+(\d+)\s*$/gm)]
    .map((m) => ({ file: m[1], fn: m[2], val: Number(m[3]) }))
  if (declared.length === 0) {
    bad('账本里没有任何 `ratchet:` 声明 ⇒ 这条判据空转（若确实没有要声明的，请删掉本段）')
  } else {
    const specText = readFileSync(join(ROOT, 'src/backend/tests/function-size-ratchet.spec.ts'), 'utf8')
    // 棘轮文件里的条目形如： 'src/....tsx  FnName  313',
    const entries = new Map()
    for (const m of specText.matchAll(/'([^']+?\.(?:ts|tsx))\s{2,}(\w+)\s{2,}(\d+)'/g)) {
      entries.set(`${m[1]}::${m[2]}`, Number(m[3]))
    }
    for (const d of declared) {
      const cur = entries.get(`${d.file}::${d.fn}`)
      if (cur === undefined) bad(`账本声明的棘轮条目在棘轮文件里找不到: ${d.file}  ${d.fn}`)
      else if (cur !== d.val) bad(`棘轮值不一致: ${d.fn} 账本 ${d.val} vs 棘轮文件 ${cur}`)
    }
    ok(`比对 ${declared.length} 条棘轮声明（棘轮文件共 ${entries.size} 条）`)
  }
}

console.log('\n=== (8) 守卫表引用的文件是否存在 ===')
{
  // 从"守卫（防回归）"那一节里抽出引用的文件（到"## 三、"为止）
  const from = text.indexOf('## 二、守卫')
  const to = text.indexOf('## 三、')
  const sec = from === -1 ? '' : text.slice(from, to === -1 ? text.length : to)
  const refs = new Set()
  for (const m of sec.matchAll(/`([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs))`/g)) {
    const p = m[1]
    if (/^(?:src|scripts|tools)\//.test(p)) refs.add(p)
  }
  let n = 0
  for (const p of refs) {
    const r = resolveRef(p)
    if (r === 'SKIP') continue
    n++
    if (r === null) bad(`守卫表引用了不存在的文件: ${p}`)
  }
  ok(`检查了守卫表里 ${n} 个文件引用`)
}

console.log('\n=== (9) 小节标题下面必须有正文（防"标题被吞"）===')
{
  // 背景：**同一个编辑错误我犯了 3 次** —— 用标题行当替换锚点时，替换内容若没把
  // 标题重新包含进去，标题就"被吃掉"，正文直接接到上一节末尾。此时文档**结构仍合法**
  // （标题不重复、不空文件），(1)-(8) 全都发现不了；只能靠人读出来。
  // 这里机械检出两种形状：
  //   ① 标题下面**没有正文**（下一个非空行又是标题 / 或到文末）；
  //   ② 某个小节的正文里**出现了更高级或同级标题**之前只有空行（即 ① 的变体）。
  const lines = text.split('\n')
  const isEmptyBody = []
  const headingIdx = []
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,4} /.test(lines[i])) headingIdx.push(i)
  }
  /**
   * 取标题的层级（`#` 的个数）。
   * @param {string} l - 标题行。
   * @returns {number} 层级。
   */
  const lvlOf = (l) => (/^(#{1,6})/.exec(l)?.[1] ?? '').length
  for (let k = 0; k < headingIdx.length; k++) {
    const start = headingIdx[k]
    const myLvl = lvlOf(lines[start])
    // ⚠️ "本节的结束位置"必须是**下一个同级或更高级**标题 —— 不能取"下一个标题"，
    // 否则 `## 二、守卫` 会被 `### 2a.` 立刻截断，误报成"到文末都没有正文"（第二版就是这么错的）。
    let end = lines.length
    for (let j = k + 1; j < headingIdx.length; j++) {
      if (lvlOf(lines[headingIdx[j]]) <= myLvl) { end = headingIdx[j]; break }
    }
    let firstBodyLine = null
    for (let i = start + 1; i < end; i++) {
      if (lines[i].trim() !== '') { firstBodyLine = lines[i]; break }
    }
    // 同级的 `##` 后面**只跟子节**是合法结构（如「## 二、守卫」下直接是「### 2a…」）。
    if (firstBodyLine === null) { isEmptyBody.push(`${lines[start].trim()}（本节没有正文）`); continue }
    if (/^#{2,4} /.test(firstBodyLine) && lvlOf(firstBodyLine) <= myLvl) {
      isEmptyBody.push(`${lines[start].trim()} ← 紧跟着同级/更高级标题「${firstBodyLine.trim().slice(0, 30)}」`)
    }
  }
  if (isEmptyBody.length === 0) ok(`检查了 ${headingIdx.length} 个标题，每个下面都有正文`)
  else for (const h of isEmptyBody) bad(`标题下面是空的（疑似被吞后正文接到了上一节）: ${h}`)

  // 变体：相邻两个标题之间**只有空行**，等价于上面的 ①，已覆盖。
  // 再补一条：标题行**既不是** "#"~"####" 开头、却在正文中间以 "### " 形式出现（缩进/被吞的痕迹）
  const odd = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s+###\s/.test(l))
    .map(({ l, i }) => `:${String(i + 1)} ${l.trim().slice(0, 40)}`)
  if (odd.length > 0) for (const o of odd) bad(`疑似被吞/缩进的标题: ${o}`)
}

console.log('\n=== (10) 交叉引用的小节必须真的存在 ===')
{
  // 为什么是这一条：**"标题被吞"这个具体事故（我犯过 3 次）其实骗过了 (9)** ——
  // 把 `### 2b. …` 那一行删掉时，它下面的正文会**并进上一节**，于是没有"空正文"可查。
  // 实测反例：删掉 2b 标题后 (9) 依然全过。
  // 真正能被机械检出的是**断掉的交叉引用**：文档里有若干"见第二节 2a""已由 2d 的三方核对确认"
  // 这类指向具体小节编号的引用；小节没了，这些引用就悬空。
  const headings = [...text.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].trim())
  const refs = new Set()
  // 覆盖我实际用过的所有引用动词（第一版只认 `第二节|见|已由|与`，
  // 于是"且已通过 2c 的三方核对确认"这种用了 `通过` 的漏掉了 —— 而它恰恰是错的引用）。
  for (const m of text.matchAll(/(?:第二节|见|已由|与|通过|据|按|参照)\s*(2[a-z])\b/g)) refs.add(m[1])
  if (refs.size === 0) {
    bad('文档里没有任何指向小节编号的交叉引用 ⇒ 这条判据空转（若确实没有，请删掉本段）')
  } else {
    const missing = [...refs].filter((r) => !headings.some((h) => h.startsWith(r + '.') || h.startsWith(r + ' ')))
    for (const r of missing) bad(`交叉引用的小节不存在（可能标题被吞）: ${r}`)
    ok(`检查了 ${refs.size} 个交叉引用小节: ${[...refs].join(', ')}`)
  }
}

console.log('\n=== (11) 验收清单 / 覆盖说明也要过同样的引用/命令检查 ===')
{
  // 为什么单独加这条：`audit:ledger` 原本只读**账本**。而 2026-09-29 新增的
  // `docs/VERIFY-CHECKLIST.md` 里同样有文件引用、行号引用、npm 命令 ——
  // 它自己会漂移（改了命令名/挪了文件就变成错的指南），而没人看着。
  // 2026-09-29 又把本轮新增的 `docs/PERF-THEME-COVERAGE-2026-09-29.md` 纳入同一口径：
  // 它是给人看的"范围/目标/验证"说明，同样会腐烂。
  const DOCS = [
    { rel: 'docs/VERIFY-CHECKLIST.md', name: '验收清单' },
    { rel: 'docs/PERF-THEME-COVERAGE-2026-09-29.md', name: '覆盖说明' },
  ]
  for (const doc of DOCS) {
    const CLI = join(ROOT, ...doc.rel.split('/'))
    let cl
    try { cl = readFileSync(CLI, 'utf8') } catch { bad(`找不到${doc.name}: ${CLI}`); continue }
    // 11a 文件引用
    const paths = new Set()
    for (const m of cl.matchAll(/`([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs|css|json|md))`/g)) {
      const p = m[1]
      if (/^(?:src|docs|scripts|tools|tests)\//.test(p)) paths.add(p)
    }
    let n1 = 0
    for (const p of paths) {
      const r = resolveRef(p)
      if (r === 'SKIP') continue
      n1++
      if (r === null) bad(`${doc.name}引用了不存在的文件: ${p}`)
    }
    // 11b 行号引用
    let n2 = 0
    for (const m of cl.matchAll(/`?([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs|css)):(\d+)(?:-(\d+))?`?/g)) {
      const full = resolveRef(m[1])
      if (full === 'SKIP') continue
      if (full === null) { bad(`${doc.name}的行号引用指向不存在的文件: ${m[1]}:${m[2]}`); continue }
      n2++
      const lines = readFileSync(full, 'utf8').split('\n').length
      if (Number(m[2]) < 1 || Number(m[3] ?? m[2]) > lines) {
        bad(`${doc.name}: ${m[1]}:${m[2]} 超出文件行数（实际 ${lines} 行）`)
      }
    }
    // 11c npm 命令
    const cmds = new Set()
    for (const m of cl.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) cmds.add(m[1])
    for (const c of cmds) if (pkg.scripts[c] === undefined) bad(`${doc.name}里的 npm run ${c} 不存在`)
    ok(`${doc.name}: ${n1} 个文件引用 / ${n2} 个行号引用 / ${cmds.size} 个命令`)
  }
}

console.log('\n=== (12) 账本/清单里引用的关键实测值 == 最新探针产物 ===')
{
  // 为什么加这条：**我自己因为"凭印象写数字"错了两次** ——
  //   ① 写"主题对比度 8 个用例"（实际 10）；
  //   ② 写">20ms 的均 ≤46ms"（实际最大 142ms，46ms 是去掉三个大头后的最大值）。
  // 两次都是事后人工核对才发现的。这条把核对变成机器做。
  //
  // ⚠️ 探针产物在 `working/`（**gitignored**）。所以：
  //   · 有产物 ⇒ 严格比对；
  //   · 没有产物（如 CI）⇒ **明确跳过并说明**，不算失败（否则 CI 会恒红）。
  const probeFiles = (() => {
    try {
      return readdirSync(join(ROOT, 'working'))
        .filter((f) => /^probe-remote-\d{4}-\d{6}\.txt$/.test(f))
        .sort()
    } catch { return [] }
  })()
  if (probeFiles.length === 0) {
    ok('跳过：working/ 下没有 probe-remote-*.txt 产物（CI 上正常）⇒ 本类不参与判定')
  } else {
    const newest = join(ROOT, 'working', probeFiles[probeFiles.length - 1])
    const probe = readFileSync(newest, 'utf8')
    /** 从探针产物里取第一个捕获组。 */
    const grab = (re) => re.exec(probe)?.[1] ?? null

    const claims = [
      {
        name: '完全调通数',
        fromProbe: grab(/完全调通（无错误）:\s*(\d+)\s*\/\s*174/),
        // ⚠️ 这里**必须容忍区间**：这个数逐轮浮动（实测 168–170）。
        // 第一版只认死 168，于是我自己刚跑一次探针（得 170）就把审计搞红了 ——
        // **是判据太紧，不是文档错了**。测量值浮动而判据写死 = 必然误报。
        // 区间要**覆盖两个超时口径**：默认 4s 下 168–170；放到 180s 再跑是 171。
        // （第 70 轮查明：5 个长任务在 4s 超时下被记成 TIMEOUT。）
        range: [168, 171],
      },
      {
        name: '含超时成功数',
        // 探针输出用**全角冒号** `：`（第一版写半角 `:` ⇒ 判据自己报"产物里找不到字段"）。
        // 改成不依赖冒号形状：从"成功或仅超时"往后直接找 `N / 174`。
        fromProbe: grab(/成功或仅超时[\s\S]*?(\d+)\s*\/\s*174/),
        range: [171, 173],
      },
    ]
    let compared = 0
    for (const c of claims) {
      if (c.fromProbe === null) { bad(`探针产物里找不到「${c.name}」（判据需要更新）`); continue }
      const n = Number(c.fromProbe)
      const [lo, hi] = c.range
      // ① 产物读数必须落在文档声明的区间内
      if (n < lo || n > hi) {
        bad(`「${c.name}」产物读数 ${String(n)} 超出文档声明的区间 ${String(lo)}–${String(hi)}（源 ${probeFiles[probeFiles.length - 1]}）`)
        continue
      }
      // ② 两份文档都必须写出这个区间
      const cli = readFileSync(join(ROOT, 'docs', 'VERIFY-CHECKLIST.md'), 'utf8')
      const pat = new RegExp(`${String(lo)}[–-]${String(hi)}`)
      if (!pat.test(text) || !pat.test(cli)) {
        bad(`「${c.name}」区间 ${String(lo)}–${String(hi)} 没在账本/清单里同时写明（账本=${String(pat.test(text))} 清单=${String(pat.test(cli))}）`)
        continue
      }
      compared++
    }
    ok(`比对了 ${compared} 个关键实测值（区间口径；源: ${probeFiles[probeFiles.length - 1]}）`)
  }
}

console.log(`\n=== 汇总：${problems === 0 ? '全部通过' : String(problems) + ' 处需要修'} ===`)

/**
 * 文档索引与文档引用的完整性守卫（报告 §七 第三批 #25 / P3-20 的收口件）。
 *
 * 为什么要有它：`docs/` 里新写了四份给人看的文档（架构总览 / CONTRIBUTING / 部署与发布 / 错误码表），
 * 而**没有判据的文档一定会烂**。本仓的文档量已经大到"改了代码没人回头改文档"成为默认行为 ——
 * 审计报告里那条「文档与实现脱节」不是文笔问题，是下一个人照着做就做错的问题。
 *
 * 扫的四类**可机检的事实**（都是"引用了仓库里一个具体的东西"，因此能被解析）：
 *  ① 相对 markdown 链接 `[x](../src/foo.ts)` —— 路径由文档位置决定，没有歧义；
 *  ② 反引号里**按仓库根写**的路径 `` `src/query/media-image.ts` `` —— 只认顶层目录开头的，
 *     含 `*` / `<>` / `|` 的一律放过（那是模式说明与占位，不是引用）；
 *  ③ `npm run X` —— X 必须是 `package.json` 里真实存在的脚本；
 *  ④ 错误码表登记的机器码与中文代表串 —— 必须能在**生产源码**里找到（排除 `*.spec.*`、
 *     `src/backend/tests/`、生成物 `lib/**`、vendored `deps/**`）。
 *
 * 口径是量过的，不是猜的：写这份判据之前用 `working/probe-doc-refs*.mjs` 跑过一遍 ——
 * 64 条链接里 1 条坏（就是本文件，当时还不存在），27 条反引号路径 0 坏，27 个 npm 脚本 0 坏，
 * 17 个码 + 28 条中文串全部命中。信噪比够硬闸门（对比 `phantom-reference.spec.ts` 头注释里
 * 那次"100+ 条里 2 条真幻影"的教训：那种比例的门禁活不过第二天）。
 *
 * 与 `phantom-reference.spec.ts` 的分工：那份扫**源码注释**里的承诺，这份扫**文档**里的引用；
 * 两者都不猜路径，都带反例自证。
 * @vitest-environment node
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 本轮（#25）新增的四份文档：缺任何一份，这一项就不算交付。 */
const NEW_DOCS = ['docs/ARCHITECTURE.md', 'docs/CONTRIBUTING.md', 'docs/DEPLOYMENT.md', 'docs/ERROR-CODES.md']
/** 引用扫描的语料：四份新文档 + README（文档索引的宿主，也是别人进来的第一扇门）。 */
const CORPUS = [...NEW_DOCS, 'README.md']

/** 只有以这些顶层目录开头的反引号片段才当"仓库内引用"（`utils/format.ts` 那种简写有歧义，不猜）。 */
const ROOTED = /^(?:src|docs|scripts|tools|tests|wechat|\.github)\//
/** 含通配 / 尖括号 / 管道的一律是模式说明或命令片段，不是引用。 */
const PATTERNY = /[*<>{}|]/
const HAS_EXT = /\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|css)$/
/** 链接里的外部协议（`https:`、`mailto:`），以及纯锚点。 */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|[#])/

/** 递归列仓库内文件（相对路径、正斜杠），跳过依赖与产物目录。 */
function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'ui-dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, acc)
    else acc.push(relative(ROOT, p).replace(/\\/g, '/'))
  }
  return acc
}

/** 目录也单独列一份：文档里存在指向目录的链接（`[panels/](../src/.../panels/)`）。 */
function walkDirs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    acc.push(relative(ROOT, p).replace(/\\/g, '/'))
    walkDirs(p, acc)
  }
  return acc
}

const TREES = ['src', 'scripts', 'docs', 'tools', 'wechat', '.github']
const FILES = new Set<string>(TREES.flatMap((t) => walkFiles(join(ROOT, t))))
const DIRS = new Set<string>([...TREES.map((t) => t), ...walkDirs(join(ROOT, 'src')), ...walkDirs(join(ROOT, 'docs'))])

/**
 * 引用能不能落到仓库里的东西。
 * 三级：文档自身相对 → 仓库根相对 → **尾巴匹配**（文档里 `src/query/x.ts` 这类按子包写的路径，
 * 尾巴能在 `src/backend/wechat-data/src/query/x.ts` 命中）。尾巴匹配是 `phantom-reference.spec.ts`
 * 已有的口径，这里不另发明一套；它比"直接猜目录"保守：必须整条尾巴一致。
 */
function refExists(ref: string, fromDoc: string): boolean {
  const clean = (ref.split('#')[0] ?? '').replace(/^\.\//, '')
  if (!clean) return true
  if (existsSync(join(ROOT, dirname(fromDoc), clean)) || existsSync(join(ROOT, clean))) return true
  const tail = clean.replace(/^.*?(?:src|tests|scripts|docs|panels|query|client)\//, '').replace(/\/$/, '')
  if (!tail || tail === clean) return false
  const suffix = '/' + tail
  for (const f of FILES) if (f === tail || f.endsWith(suffix)) return true
  for (const d of DIRS) if (d === tail || d.endsWith(suffix)) return true
  return false
}

/** 相对 markdown 链接的目标（去掉锚点与外链）。 */
function relativeLinks(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const ref = m[1] ?? ''
    if (!ref || EXTERNAL.test(ref)) continue
    out.push(ref)
  }
  return out
}

/** 反引号里按仓库根写的路径。 */
function rootedSpans(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = (m[1] ?? '').trim()
    if (!ROOTED.test(tok) || PATTERNY.test(tok)) continue
    if (!HAS_EXT.test(tok) && !tok.endsWith('/')) continue
    out.push(tok)
  }
  return out
}

/**
 * `npm run X` 里的 X（`npm ci` / `npm start` / `npm test` 不是脚本名，跳过）。
 * 长度 ≤ 2 的一律当**占位**（文档里 `npm run X` 这种"任意脚本"的写法）；本仓真实脚本名最短是 `dev`。
 */
function npmScripts(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    const s = m[1] ?? ''
    if (s.length <= 2 || /xxx|absent/i.test(s)) continue
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** 错误码表第一列里的机器码（一行可以写 `A` / `B` / `C` 三个）。 */
function docCodes(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\|\s*((?:`[A-Z][A-Z_]{2,}`\s*\/?\s*)+)\|/.exec(line)
    if (!m) continue
    for (const c of (m[1] ?? '').matchAll(/`([A-Z][A-Z_]{2,})`/g)) {
      const code = c[1] ?? ''
      if (code && !out.includes(code)) out.push(code)
    }
  }
  return out.sort()
}

/** 第 5 节表格里「代表串（逐字）」那一列的每一条。 */
function familyStrings(text: string): string[] {
  const start = text.indexOf('## 5.')
  const end = text.indexOf('## 6.', start + 1)
  const body = start < 0 || end < 0 ? '' : text.slice(start, end)
  const out: string[] = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue
    for (const s of (line.split('|')[2] ?? '').matchAll(/`([^`]+)`/g)) {
      const v = s[1] ?? ''
      if (v.length > 1 && !out.includes(v)) out.push(v)
    }
  }
  return out
}

/**
 * 生产源码合并成一份文本：码与中文串要落在这里，落在测试里不算（测试自己写一个假码
 * 就能把判据喂饱），落在 `lib/index.js` 里也不算（那是生成物，改 src 时它跟着变，不能反过来当出处）。
 */
function productionText(): string {
  const rels = walkFiles(join(ROOT, 'src')).filter((f) => {
    if (!/^(?:src\/backend|src\/license)\//.test(f)) return false
    if (f.startsWith('src/backend/deps/')) return false
    if (f.includes('/lib/')) return false
    if (f.includes('/tests/')) return false
    if (/\.spec\.tsx?$/.test(f) || f.endsWith('.d.ts')) return false
    return /\.(?:js|cjs|mjs|ts|tsx)$/.test(f)
  })
  const bodies = ['main.js', 'preload.js'].map((f) => readFileSync(join(ROOT, f), 'utf8'))
  for (const rel of rels) bodies.push(readFileSync(join(ROOT, rel), 'utf8'))
  return bodies.join('\n')
}

const PROD = productionText()
const SCRIPTS = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}))

describe('文档索引与文档里的引用', () => {
  it('四份新文档都在，且不是空壳', () => {
    for (const doc of NEW_DOCS) {
      const text = readFileSync(join(ROOT, doc), 'utf8')
      const lines = text.split('\n').length
      const sections = (text.match(/^## /gm) ?? []).length
      // 「有内容」的可机检下限：篇幅、小节数、至少一处仓库内引用（否则是一份自说自话的说明）。
      expect(lines, `${doc} 只有 ${lines} 行`).toBeGreaterThanOrEqual(60)
      expect(sections, `${doc} 只有 ${sections} 个二级小节`).toBeGreaterThanOrEqual(4)
      expect(relativeLinks(text).length + rootedSpans(text).length, `${doc} 一条仓库内引用都没有`).toBeGreaterThan(2)
      expect(/TODO|待补|待填|示例内容/.test(text), `${doc} 里还有占位词`).toBe(false)
    }
  })

  it('README 的文档索引收录了这四份，且索引每一行的链接都解析得到', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const at = readme.indexOf('## 文档索引')
    expect(at, 'README 里没有「文档索引」这一节').toBeGreaterThan(-1)
    const next = readme.indexOf('\n## ', at + 5)
    const block = readme.slice(at, next < 0 ? readme.length : next)
    const rows = block.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'))
    expect(rows.length, '索引表行数太少（连表头都不够）').toBeGreaterThanOrEqual(10)
    const targets = rows.flatMap((r) => relativeLinks(r))
    for (const doc of NEW_DOCS) {
      expect(targets, `README 文档索引里没有 ${doc}`).toContain(doc)
    }
    for (const t of targets) {
      expect(refExists(t, 'README.md'), `索引里的链接指向不存在的东西：${t}`).toBe(true)
    }
    // 每一行都得写"这份讲什么"，只放一个链接的索引等于没有索引。
    for (const r of rows.slice(1)) {
      expect((r.split('|')[2] ?? '').trim().length, `索引行缺少内容说明：${r.slice(0, 60)}`).toBeGreaterThanOrEqual(8)
    }
  })

  /**
   * P3-19 的两半：**会烂在文档里的数字与清单**。
   *
   * 报告原话是"16 个未索引文档 + README 视图数过时（写约 40 个，实测 94）"；实测是
   * 顶层 21 份文档里索引了 8 份（差 13 份），视图数写的是 90（实测 102）。补完之后由这两条守住：
   * 只补不守 = 下次照样烂 —— 而这正是本仓对其他"数字"的一贯口径（见 CONTRIBUTING 的棘轮一节）。
   */
  it('README 的文档索引覆盖 docs/ 顶层每一份文档（新增一份就得同时补索引）', () => {
    const top = readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(md|html)$/.test(e.name))
      .map((e) => `docs/${e.name}`)
    // 下限从 20 降到 7（2026-10-08 文档精简：docs/ 顶层只保留七份当前有效的文档）。
    // 这个数的作用是「扫描目标没读到」的反哨兵 —— 它必须 ≤ 真值、且离真值不太远：
    // 定得比真值高会误报，定得太低（比如 1）又会让「全覆盖」退化成近乎恒真。
    // 7 = 当前七份文档的条数，是这条哨兵能取的最紧下限（棘轮语义：只许随文档增减调整）。
    expect(top.length, '顶层文档数少得太离谱 ⇒ 扫描目标没读到，下面那条"全覆盖"是恒真').toBeGreaterThanOrEqual(7)
    // 反例自证：哨兵本身不是恒真 —— 低于下限就红
    expect(6).toBeLessThan(7)
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const at = readme.indexOf('## 文档索引')
    const next = readme.indexOf('\n## ', at + 5)
    const rows = readme.slice(at, next < 0 ? readme.length : next).split('\n').filter((l) => l.startsWith('|') && !l.includes('---'))
    const targets = rows.flatMap((r) => relativeLinks(r))
    const missing = top.filter((d) => !targets.includes(d))
    expect(missing, `这些文档在 docs/ 顶层躺着、README 索引里没有：${missing.join(', ')}`).toEqual([])
    // 反例自证：凭空多出一份文档，必须被同一条判据点出来
    expect([...top, 'docs/BRAND-NEW-NOT-INDEXED.md'].filter((d) => !targets.includes(d)),
      '合成违例没被抓住 ⇒ 这份覆盖判据是空的').toContain('docs/BRAND-NEW-NOT-INDEXED.md')
  })

  it('README 里那句「panels/ 下 N 个 .tsx 视图」的 N 与实测一致', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const m = /panels\/ 下 (\d+) 个 \.tsx 视图/.exec(readme)
    expect(m, '找不到 README 里那句视图数 ⇒ 改了写法要连这条判据一起改').not.toBeNull()
    const panels = readdirSync(join(ROOT, 'src/client/ui-wechat/src/client/pages/wechat-data/panels'))
      .filter((f) => f.endsWith('.tsx')).length
    expect(Number(m![1]), `README 写 ${m![1]} 个，实测 ${panels} 个 —— 数字要么改对，要么别写`).toBe(panels)
  })

  it('文档里的每条相对链接都指向仓库里真实存在的文件或目录', () => {
    const bad: string[] = []
    for (const doc of CORPUS) {
      const text = readFileSync(join(ROOT, doc), 'utf8')
      for (const ref of relativeLinks(text)) {
        if (!refExists(ref, doc)) bad.push(`${doc} -> ${ref}`)
      }
    }
    expect(bad, `这些文档链接指向不存在的东西（要么补文件，要么改链接）：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('反引号里按仓库根写的路径也必须存在', () => {
    const bad: string[] = []
    for (const doc of CORPUS) {
      const text = readFileSync(join(ROOT, doc), 'utf8')
      for (const tok of rootedSpans(text)) {
        if (!refExists(tok, doc)) bad.push(`${doc} -> ${tok}`)
      }
    }
    expect(bad, `这些反引号路径找不到：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('文档里写出来的 `npm run X` 必须是 package.json 里真实的脚本', () => {
    const bad: string[] = []
    let n = 0
    for (const doc of CORPUS) {
      for (const s of npmScripts(readFileSync(join(ROOT, doc), 'utf8'))) {
        n += 1
        if (!SCRIPTS.has(s)) bad.push(`${doc} -> npm run ${s}`)
      }
    }
    expect(n, '一条 npm run 都没扫到 ⇒ 正则坏了').toBeGreaterThanOrEqual(15)
    expect(bad, `这些命令在 package.json 里不存在：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('错误码表登记的每个机器码都在生产源码里', () => {
    const codes = docCodes(readFileSync(join(ROOT, 'docs/ERROR-CODES.md'), 'utf8'))
    expect(codes.length, '码表一条都没解析出来 ⇒ 表格口径变了，判据要跟着改').toBeGreaterThanOrEqual(12)
    const missing = codes.filter((c) => !PROD.includes(`'${c}'`) && !PROD.includes(`"${c}"`))
    expect(missing, `这些码只在文档里出现，代码里没有（改了名或删了）：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('错误码表第 5 节的中文代表串逐字命中生产源码', () => {
    const strs = familyStrings(readFileSync(join(ROOT, 'docs/ERROR-CODES.md'), 'utf8'))
    expect(strs.length, '第 5 节一条代表串都没解析出来 ⇒ 表格口径变了').toBeGreaterThanOrEqual(20)
    const missing = strs.filter((s) => !PROD.includes(s))
    expect(missing, `这些中文串在源码里已经找不到了（改文案时把文档一起改）：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('哨兵：语料与扫描面非空（否则上面几条都是恒真）', () => {
    let links = 0
    let spans = 0
    for (const doc of CORPUS) {
      const text = readFileSync(join(ROOT, doc), 'utf8')
      links += relativeLinks(text).length
      spans += rootedSpans(text).length
    }
    expect(links, '整个语料只扫出这么点链接 ⇒ 提取器或语料坏了').toBeGreaterThanOrEqual(40)
    expect(spans, '整个语料只扫出这么点反引号路径 ⇒ 提取器坏了').toBeGreaterThanOrEqual(15)
    expect(PROD.length, '生产源码文本为空').toBeGreaterThan(200_000)
    expect(PROD.includes('BACKEND_NOT_READY'), '生产源码文本里没有已知机器码 ⇒ 目录过滤错了').toBe(true)
    expect(FILES.size).toBeGreaterThan(500)
    expect(DIRS.size).toBeGreaterThan(20)
  })

  it('反例自证：坏引用必须被抓，而外链、锚点、模式说明不许被抓', () => {
    // ① 坏链接与坏反引号路径
    expect(relativeLinks('见 [判据](../src/backend/tests/truly-absent-xyz.spec.ts) 说明')).toEqual([
      '../src/backend/tests/truly-absent-xyz.spec.ts'
    ])
    expect(refExists('../src/backend/tests/truly-absent-xyz.spec.ts', 'docs/ERROR-CODES.md')).toBe(false)
    expect(rootedSpans('`src/query/truly-absent-xyz.ts` 与 `docs/TRULY-ABSENT-XYZ.md`')).toHaveLength(2)
    expect(refExists('src/query/truly-absent-xyz.ts', 'docs/ERROR-CODES.md')).toBe(false)
    // ② 真引用必须放过（否则"零坏引用"只是巧合）
    expect(refExists('../src/backend/tests/docs-index.spec.ts', 'docs/ERROR-CODES.md')).toBe(true)
    expect(refExists('src/query/media-image.ts', 'docs/ERROR-CODES.md'), '尾巴匹配没生效').toBe(true)
    expect(refExists('../src/client/ui-wechat/src/client/pages/wechat-data/panels/', 'docs/ARCHITECTURE.md'), '目录引用该被认').toBe(true)
    // ③ 外链、纯锚点、模式说明一律不进扫描面
    expect(relativeLinks('[releases](https://github.com/x/y/releases) 与 [第 4 节](#4-许可证)')).toEqual([])
    expect(rootedSpans('`src/query/*.ts`、`<userData>/wechat/`、`grep -r src/backend src/license`')).toEqual([])
    // ④ 码表与家族串：不存在的码 / 改过的中文串必须被报
    expect(docCodes("| `NOT_A_REAL_CODE_HERE` / `ALSO_ABSENT` | 出处 | 说明 |\n|---|---|---|\n")).toEqual(['ALSO_ABSENT', 'NOT_A_REAL_CODE_HERE'])
    expect(docCodes('这不是表格 `NOT_A_REAL_CODE_HERE`\n')).toEqual([])
    expect(PROD.includes('NOT_A_REAL_CODE_HERE'), '反例用的码恰好真的存在，这条自证就无效了').toBe(false)
    expect(familyStrings('## 5. x\n| 家族 | `一句源码里绝没有的话 XYZ` | 出处 |\n|---|---|---|\n## 6. y').length).toBe(1)
    // ⑤ npm 脚本：拼错的脚本名要进扫描面（再由 SCRIPTS 判红），而"任意脚本"的占位写法不许被抓
    expect(npmScripts('跑 `npm run docs:api:cheek` 与 `npm run docs:api:check`')).toEqual(['docs:api:cheek', 'docs:api:check'])
    expect(SCRIPTS.has('docs:api:cheek'), '反例脚本名恰好真实存在，这条自证就无效了').toBe(false)
    expect(npmScripts('改动这类东西时执行 `npm run X` 即可'), '占位写法被当成了真脚本')
      .toEqual([])
  })
})

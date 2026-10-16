/**
 * 幻影引用守卫：注释里写「这条由 X 把关」而 X 不存在 ⇒ 比没有把关者更坏。
 *
 * 这一族在本仓已复发四次（`scripts/check-ui-consistency.js`、`audit-a11y-clickable`、
 * `scripts/check-members-search.js`，以及本轮扫出来又一条）。共同点不是"写错文件名"，而是
 * **注释替代码许了一个代码没兑现的诺**：下一个读代码的人以为已经防住，就不再补判据 ——
 * 第三次那次，被这样"把关"的 FTS 可检索列缺陷是**真的**，而且因为默认路径与降级路径
 * 给出不同答案，表现成"用户偶尔搜得到、偶尔搜不到，日志一切正常"。
 *
 * 扫描口径（故意窄，宁缺毋滥 —— 宽了就是一堆假红，最后被人整个关掉）：
 *  ① `scripts/**.mjs|cjs|js|ts` —— 本仓四次复发的正是"某个脚本把关"这一类；
 *  ② 任何以 `.spec.ts(x)` 结尾的路径 —— 声称"有用例守着"；
 *  ③ 以 `src/` 开头的路径 —— 明确按仓库根写的引用，没有歧义；
 *  ④ 上面这些若带 `#符号`，符号必须真在被指文件里。
 * **不查简写路径**（`utils/format.ts` 这类）：同一个简写在不同子包里指向不同文件，
 * 第一版按"仓库根 → 同目录 → 包根"依次试，扫出 100+ 条，其中真幻影只有 2 条 ——
 * 那种信噪比的闸门活不过第二天（也拦不住人把它改成 `expect(...).not.toBe(null)` 那种装饰）。
 * 只扫**手写源码的注释**：`src/backend/deps/**` 是 vendored 三方包，`lib/**` 与 `.d.ts` 是生成物。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TREES = ['src/backend', 'src/client']

/**
 * 只有出现在**承诺语境**里的路径才算"注释替代码许的诺"，才要求它解析得到。
 *
 * 为什么不扫全部注释里的路径：第一版那么做过，扫出 100+ 条，真幻影只有 3 条 —— 其余全是
 * 样例文件名、被删文件的回顾、`**` + `/x.spec.ts` 这种 glob 模式说明。那种信噪比的闸门活不过第二天，
 * 而一个被关闭的守卫比没有守卫更糟（它给出"已经管过"的错觉）。
 *
 * 两个词表都要窄：
 *  · 承诺词（出现在路径**前后各 40 字的窗口内**即算 —— 只在前或在后都算许愿）：
 *    `由 X 把关 / 见 X / 判据：X / X 守着 / X 锁定`；
 *  · 豁免词（**优先级更高**）：同一窗口里出现"不存在/已删/从未/接任"等，说明这句是
 *    在**记录一个历史幻影**而不是在许愿 —— 这类记录必须留在仓库里，不能为了过闸而删掉。
 */
const CLAIM = /由|见|判据|守卫|把关|守|锁定|钉/
/** 历史豁免：这一句是在**记录**一个不存在的/已删掉的东西，不是在许愿。 */
const HISTORY = /不存在|并不存在|不在仓库|没有提交|从未|已删|已移除|原名|曾用名|接任|取代|曾经|幻影/
/**
 * 另外两类一律放过，理由不同：
 *  · **外部包路径**（首段不是本仓的顶层目录，如 `graphology-layout-forceatlas2/iterate.js`、
 *    任何 `node_modules/...`）—— 那是第三方内部文件，本仓的清单里本来就没有它；
 *  · **占位名**（`xxx` / `abc` / `does-not-exist` / `never-` / `不存在`）—— 判据自己的
 *    合成样例与"形如 …"的模式说明。
 */
const REPO_ROOTS = /^(?:src|scripts|docs|tests|working|output|lib|bin|dist)\//
const PLACEHOLDER = /xxx|aba?c\b|does[-\s]?not[-\s]?exist|never-|SAMPLE|模板|形如/i

/** 一条注释里的路径样 token（连同可选的 `#符号`）。 */
const PATHS = /((?:[\w.$-]+\/)+[\w.$-]+\.(?:tsx|ts|mjs|cjs|json|js|css|md|ya?ml)(?![\w]))(#[\w$]+)?/g

/** 这份文件有没有义务兑现注释里的承诺（vendored 与生成物没有）。 */
function isHandWritten(f: string): boolean {
  if (!/\.(?:tsx|ts)$/.test(f) || f.endsWith('.d.ts')) return false
  if (f.startsWith('src/backend/deps/')) return false
  if (f.includes('/lib/')) return false
  if (f.includes('/node_modules/')) return false
  return true
}

function listFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'ui-dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) listFiles(p, acc)
    else acc.push(relative(ROOT, p).replace(/\\/g, '/'))
  }
  return acc
}

/** 全仓文件清单（解析用）：整仓扫，只跳过依赖与构建产物目录。 */
const ALL_FILES = new Set<string>([
  ...listFiles(join(ROOT, 'src')),
  ...listFiles(join(ROOT, 'scripts')),
  ...listFiles(join(ROOT, 'docs')),
])

/** 注释块：块注释 + 行注释。 */
function commentsOf(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0] ?? '')
  for (const line of src.split('\n')) {
    const i = line.indexOf('//')
    if (i < 0) continue
    // 行内 `//` 落在字符串里（`'https://x'`、样例文件名数组…）不是注释：
    // 判据是"前面有没有引号成对"—— 单引号/双引号/反引号任一出现奇数次就在串里。
    const before = line.slice(0, i)
    const odd = (q: string): boolean => (before.split(q).length - 1) % 2 === 1
    if (odd("'") || odd('"') || odd('`')) continue
    out.push(line.slice(i))
  }
  return out
}

/** 把一个注释里的路径解析到仓库内的真实文件；解析不到返回 null。 */
function findTarget(ref: string, fromFile: string): string | null {
  const clean = ref.replace(/^\.\//, '').replace(/^\.\.\//, '')
  const norm = (p: string): string => relative(ROOT, resolve(ROOT, p)).replace(/\\/g, '/')
  const direct = [clean, join(dirname(fromFile), clean)].map(norm)
  for (const c of direct) if (ALL_FILES.has(c)) return c
  // 简写尾巴匹配：`tests/foo.spec.ts` 之类允许按结尾命中（同一条形状，不引入"猜目录"的规则）
  const tail = clean.replace(/^.*?(?:src|tests|scripts|docs|panels)\//, '')
  for (const f of ALL_FILES) if (f === clean || f.endsWith('/' + tail)) return f
  return null
}

/** 一段文本里的幻影引用（`fromFile` 只用于算相对路径与报错定位）。 */
function phantomRefs(text: string, fromFile: string): string[] {
  const bad: string[] = []
  for (const comment of commentsOf(text)) {
    for (const m of comment.matchAll(PATHS)) {
      const whole = m[0] ?? ''
      const ref = m[1] ?? ''
      const symbol = m[2] ?? ''
      // 承诺窗口：路径前后各 40 字（去掉注释星的与反引号）
      const at = m.index ?? 0
      const window = comment.slice(Math.max(0, at - 40), at + whole.length + 40).replace(/[`*\s]+/g, '')
      if (HISTORY.test(window)) continue // 在记录历史幻影，不是在许愿
      if (PLACEHOLDER.test(window)) continue // 合成样例与"形如 …"的模式说明
      if (!REPO_ROOTS.test(ref.replace(/^\.\//, ''))) continue // 外部包内部路径，本仓清单里没有它
      if (!CLAIM.test(window)) continue // 不是承诺语境（样例名、模式说明、回顾）
      const hit = findTarget(ref, fromFile)
      if (!hit) { bad.push(`${fromFile}: 找不到 ${ref}`); continue }
      if (symbol && !new RegExp(`\\b${symbol.slice(1).replace(/\$/g, '\\$')}\\b`).test(readFileSync(join(ROOT, hit), 'utf8'))) {
        bad.push(`${fromFile}: ${ref} 里没有符号 ${symbol.slice(1)}`)
      }
    }
  }
  return bad
}

describe('注释里的路径引用必须真的存在', () => {
  /**
   * 本文件排除在外，两个理由都得是真的：
   * ① 它**必须**写出那几条已知的幻影名字（否则"这类问题存在"这件事在仓库里没有记录）；
   * ② 反例自证的样例是**字符串字面量**，而注释提取是文本级的（要 AST 就得给每个 `.ts` 建语法树，
   *    本仓 1200 个文件扫一遍会慢到没人愿意跑）—— 排除自己比把样例写成"看不出是样例"诚实。
   */
  const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/')
  const sources = TREES.flatMap((t) => listFiles(join(ROOT, t))).filter((f) => isHandWritten(f) && f !== SELF)

  it('哨兵：扫描面非空且包含两棵树与 vendored 的排除（否则「零幻影」是恒真）', () => {
    expect(sources.length, '一个手写源码文件都没扫到').toBeGreaterThan(300)
    expect(sources.some((f) => f.startsWith('src/backend/wechat-data/src/'))).toBe(true)
    expect(sources.some((f) => f.startsWith('src/client/ui-wechat/src/'))).toBe(true)
    expect(sources.some((f) => f.startsWith('src/backend/deps/')), 'vendored 包被扫进来了（该排除）').toBe(false)
    expect(sources.some((f) => f.endsWith('.d.ts')), '生成物 .d.ts 被扫进来了（该排除）').toBe(false)
    expect(sources.includes(SELF), '本文件本该排除（见上面的两条理由）').toBe(false)
  })

  it('哨兵：确实扫到若干条"承诺语境"里的引用（一条都没有 ⇒ 判据空转）', () => {
    // 计数口径 = 「有承诺词 + 历史豁免都没命中」的引用数；只看路径出现次数是不够的，
    // 那样随便一句注释就能把哨兵喂饱。
    let claims = 0
    for (const f of sources) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      for (const comment of commentsOf(text)) {
        for (const m of comment.matchAll(PATHS)) {
          const at = m.index ?? 0
          const window = comment.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/[`*\s]+/g, '')
          if (HISTORY.test(window) || !CLAIM.test(window)) continue
          claims += 1
        }
      }
      if (claims > 30) break
    }
    expect(claims, '一条承诺语境里的引用都没找到 ⇒ CLAIM/PATHS 或注释提取坏了').toBeGreaterThan(30)
  })

  it('全仓手写源码的注释里零幻影（§六 那一条复发现象的闸门）', () => {
    const bad: string[] = []
    for (const f of sources) bad.push(...phantomRefs(readFileSync(join(ROOT, f), 'utf8'), f))
    expect(bad, `这些注释指向不存在的东西（要么把东西补上，要么改注释）：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('反例自证：承诺语境里的坏引用必须被抓住，而样例与历史记录不许被报', () => {
    const HERE = 'src/backend/tests/x.spec.ts'
    // ① 不存在的脚本，且写明"由它把关"
    expect(phantomRefs('/* 这条由 scripts/check-totally-absent-here.js 把关 */\nconst a = 1\n', HERE))
      .toEqual(['src/backend/tests/x.spec.ts: 找不到 scripts/check-totally-absent-here.js'])
    // ② 不存在的用例，且写明"判据："
    expect(phantomRefs('/* 判据：tests/this-case-truly-missing.spec.ts */\n', HERE).length).toBe(1)
    // ③ 文件在、符号不在
    expect(phantomRefs('/* 见 src/backend/wechat-data/src/gateway-core.ts#symbolAbsentHere */\n', HERE))
      .toEqual(['src/backend/tests/x.spec.ts: src/backend/wechat-data/src/gateway-core.ts 里没有符号 symbolAbsentHere'])
    // ④ 真引用必须放过（否则"零幻影"只是巧合）
    expect(phantomRefs('/* 见 src/backend/wechat-data/src/gateway-core.ts#GatewayCore，由 scripts/mutation-check.mjs 把关 */\n', HERE)).toEqual([])
    // ⑤ 没有承诺词的提及不算许愿；带承诺词但是**占位名**的也不该报（这条专门喂给
    //    PLACEHOLDER 那一格：路径看着完全在仓库里，只有"这是模式说明"能救它）
    expect(phantomRefs('/* 形如 x/y/z.spec.tsx 的文件都被 glob 收进来 */\n', HERE)).toEqual([])
    expect(phantomRefs('/* 判据文件形如 src/client/tests/xxx.spec.ts */\n', HERE)).toEqual([])
    // ⑥ 历史记录（"那个脚本从来不存在"）必须能留在仓库里 —— 为了让判据过关而删掉它，
    //    等于把复发线索抹掉，比没有守卫更糟。
    expect(phantomRefs('/* 原先写着由 scripts/check-ui-consistency.js 把关，而那个脚本在仓库里并不存在 */\n', HERE)).toEqual([])
    // ⑦ 但豁免词不能顺手把"当下就在许愿"的那句也放过：同一句里没有历史词时必须报
    expect(phantomRefs('/* 这条由 scripts/still-absent-here-check.js 把关 */\n', HERE).length).toBe(1)
  })
})

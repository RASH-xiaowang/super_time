/**
 * N22：`files` 的 `src/**\/*` 是通配 —— 打包内容必须用**白名单 + 体积预算**兜住。
 *
 * 为什么不能只靠现有的黑名单断言：M19 补的三条排除（`!src/backend/deps/**`、`!src/**\/*.ts`、
 * `!src/client/ui-app/**`）验证的是「已知的冗余不在」。做 N21 的 A/B 时把 `src/client/ui-dist`
 * 改名成同级的 `src/client/ui-dist.bak`，它被**照常打进 asar**（约 +12MB），而三条断言全部照绿 ——
 * 黑名单天生验证不了「不该在的不在」。同类触发面：编辑器/同步工具留下的 `*.orig`/`*.bak`、
 * 临时导出目录、被 gitignore 的构建中间产物。
 *
 * 用例直接对着规则模块（`scripts/package-content-rules.js`）跑，并且**同时**校验两条数据源：
 *   · 真实工作树（打包之前那一半，能立刻发现不该在的东西）；
 *   · 真实 asar 条目（若本机有 dist/win-unpacked，则顺带把「打包结果」也验一遍）。
 * 规则没被接线到 packaged-smoke 的话这些断言也救不了包，所以最后另有一条接线断言。
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { at } from './helpers/strict-index.ts'

const requireCjs = createRequire(import.meta.url)
const rules = requireCjs('../../../scripts/package-content-rules.js') as {
  MAX_ASAR_BYTES: number
  MIN_ASAR_BYTES: number
  ALLOWED_SRC_DIR_PREFIXES: string[]
  ALLOWED_SRC_FILES: string[]
  normalizeEntry: (p: string) => string
  srcEntryViolations: (e: string[]) => Array<{ entry: string; rule: string; hint: string }>
  asarSizeViolations: (bytes: unknown) => Array<{ rule: string; detail: string }>
  collectDiskEntries: (dir: string, prefix: string) => string[]
  FORBIDDEN_IN_DEPS: Array<{ name: string; why: string }>
  REQUIRED_IN_DEPS: Array<{ name: string; why: string }>
  productionDepClosure: (rootDir: string, rootPkg: unknown) => { names: Set<string>; missing: string[] }
  depClosureViolations: (names: Set<string>) => Array<{ rule: string; name: string; hint: string }>
}

const repoRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..')
const asarPath = join(repoRoot, 'dist', 'win-unpacked', 'resources', 'app.asar')
const scratch = mkdtempSync(join(tmpdir(), 'st-pack-rules-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('打包内容规则（N22）', () => {
  it('当前工作树 src/ 全在白名单内，且清单不是空的（防空转）', () => {
    const entries = rules.collectDiskEntries(join(repoRoot, 'src'), 'src')
    // 防空转：前缀写错（如漏了 'src'）会让所有条目被 `startsWith('src/')` 跳过 ⇒ 静默全绿。
    expect(entries.length).toBeGreaterThan(100)
    // 标记必须选**仓库里一定有**的文件。原先用的是 `src/client/ui-dist/index.html`，
    // 可它是构建产物（gitignore，不进库）——CI 的「单元测试」步跑在「前端构建」**之前**，
    // 于是那条断言在 CI 上必红：`expected [...] to include 'src/client/ui-dist/index.html'`
    // （2026-09-20 实测）。单测不该依赖「先构建过」。
    expect(entries).toContain('src/index.html')
    expect(entries).toContain('src/backend/backend-rpc.js')
    // 构建过之后再额外钉一次：产物必须被白名单放行（本机/打包流程会走到这里，CI 单测步跳过）。
    if (entries.includes('src/client/ui-dist/index.html')) {
      expect(rules.srcEntryViolations(['src/client/ui-dist/index.html', 'src/client/ui-dist/assets/app.js'])).toEqual([])
    }
    expect(rules.srcEntryViolations(entries)).toEqual([])
  })

  it('src/ 下多一个 .bak 目录会被判违规（N22 的验收场景，可逆）', () => {
    const probe = 'src/client/ui-dist.bak'
    const entries = ['src/client/ui-dist.bak', `${probe}/index.html`, `${probe}/assets/app.js`]
    // 先确认这条路径**本来**是合法的白名单路径（对照组：同一位置的正名不被判违规）。
    expect(rules.srcEntryViolations(['src/client/ui-dist/index.html'])).toEqual([])
    const bad = rules.srcEntryViolations(entries)
    expect(bad.map((v) => v.entry)).toEqual(entries)
    // 目录本身必须被点名（否则「整棵多余的子树」会被漏掉）。
    expect(at(bad, 0, 'stray 命中').rule).toBe('stray')

    // 真在磁盘上放一个 1MB 的残留，再走一次**真实的**工作树清单（临时目录里的等价布局）。
    const fake = join(scratch, 'src', 'client', 'ui-dist.bak')
    mkdirSync(fake, { recursive: true })
    writeFileSync(join(fake, 'index.html.orig'), Buffer.alloc(1024 * 1024, 7))
    const built = rules.collectDiskEntries(join(scratch, 'src'), 'src')
    const hits = rules.srcEntryViolations(built)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((v) => v.entry.includes('ui-dist.bak'))).toBe(true)
    expect(hits.some((v) => v.rule === 'stray'), '1MB 的 .orig 也要被拦').toBe(true)
  })

  it('白名单子树**内部**的备份/临时残留同样被拦（结构规则之外的那一层）', () => {
    const cases = [
      'src/client/ui-dist/index.html.orig',
      'src/backend/wechat-data/lib/index.js.bak',
      'src/backend/tmp-export/file.js',
    ]
    for (const entry of cases) {
      expect(rules.srcEntryViolations([entry]).map((v) => v.entry), entry).toEqual([entry])
    }
    // 反面：正常的构建产物与源码不受影响。
    expect(rules.srcEntryViolations([
      'src/client/ui-dist/index.html',
      'src/client/ui-dist/assets/app-abc123.js',
      'src/backend/wechat-data/lib/index.js',
      'src/backend/wechat-data/src/query/sync.ts',
      'src/index.html',
    ])).toEqual([])
  })

  it('白名单清单本身自洽：都在 src/ 下、前缀带斜杠、非空', () => {
    expect(rules.ALLOWED_SRC_DIR_PREFIXES.length).toBeGreaterThan(3)
    expect(rules.ALLOWED_SRC_FILES.length).toBeGreaterThan(0)
    for (const p of rules.ALLOWED_SRC_DIR_PREFIXES) {
      expect(p.startsWith('src/'), p).toBe(true)
      expect(p.endsWith('/'), p).toBe(true)
    }
    for (const f of rules.ALLOWED_SRC_FILES) expect(f.startsWith('src/'), f).toBe(true)
  })

  it('体积预算：基线通过，超过上界 / 读数无效都要红', () => {
    // 阶段 D 实测的 app.asar 字节数（接入 PDF/Word/Excel 三个解析器之后；
    // 构成见 `working/d-asar-probe2.txt`）。N21 时是 24,033,395 B。
    const baseline = 56_478_217
    expect(rules.asarSizeViolations(baseline)).toEqual([])
    expect(rules.asarSizeViolations(rules.MAX_ASAR_BYTES)).toEqual([])
    // ★ 上界必须**紧到还能抓住 N22 那个场景**：一个 12MB 的残留（`ui-dist.bak` 之类）
    // 顶破上界。若哪天为了让基线过而把上界抬到 baseline×1.3 以上，这条会红 ——
    // 那是**期望行为**：说明「体积预算」已经宽到抓不住它本来要抓的东西了。
    expect(rules.asarSizeViolations(baseline + 12 * 1024 * 1024).map((v) => v.rule))
      .toEqual(['size-ceiling'])
    const big = rules.asarSizeViolations(rules.MAX_ASAR_BYTES + 1)
    expect(big.map((v) => v.rule)).toEqual(['size-ceiling'])
    // 防空转核心：读不到大小（0/NaN/undefined）必须红 —— 只写上界的话这时恒真。
    expect(rules.asarSizeViolations(0).length).toBe(1)
    expect(rules.asarSizeViolations(Number.NaN).length).toBe(1)
    expect(rules.asarSizeViolations(undefined).length).toBe(1)
    expect(rules.asarSizeViolations(rules.MIN_ASAR_BYTES - 1).length, '下界之下也要红').toBe(1)
  })

  it('本机打包产物（若存在）也满足同两条规则', () => {
    if (!existsSync(asarPath)) return // 没有产物时跳过：真正的把关在 packaged-smoke 里
    const { listPackage } = requireCjs('@electron/asar')
    const entries = (listPackage(asarPath) as string[])
    const violations = rules.srcEntryViolations(entries)
    expect(violations, JSON.stringify(violations.slice(0, 5))).toEqual([])
    const bytes = readFileSync(asarPath).length
    expect(rules.asarSizeViolations(bytes)).toEqual([])
  })

  it('规则确实被 packaged-smoke 调用（接线断言：规则再对，没接线也白搭）', () => {
    const src = readFileSync(join(repoRoot, 'scripts', 'packaged-smoke.js'), 'utf8')
    // 注释不算：要求是**调用**形式（名字后紧跟左括号），注释掉调用点会让这两条转红。
    for (const fn of ['srcEntryViolations(', 'asarSizeViolations(', 'collectDiskEntries(']) {
      expect(src.includes(fn), `packaged-smoke.js 里没有调用 ${fn}`).toBe(true)
    }
  })
})


describe('生产依赖闭包（审计 §P2-6 ⑰ 的 TODO ②：不需要先打包的闸门）', () => {
  // 背景：electron-builder 会把**生产依赖树**自动带进包 —— `files` 白名单管得住 `src/**`，
  // 管不住「某个依赖顺路带进来一个 135 MB 的兄弟包」。实测 asar 曾涨到 196.65 MB，其中
  // `onnxruntime-web/dist` 135.15 MB 与 `@img/sharp-win32-x64` 18.50 MB 都是
  // `@huggingface/transformers` 的传递依赖，而**没有一条正向规则列出过它们**。
  // 原来的体积断言只在本地存在 `dist/win-unpacked/.../app.asar` 时才跑 ⇒ 长年不执行。
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as unknown

  it('仓库现状：禁用包一个都没有，必需包一个都不缺', () => {
    const { names } = rules.productionDepClosure(repoRoot, rootPkg)
    // 防空转：前缀/解析写错会让闭包只剩几个包，那样下面两条断言都恒真。
    expect(names.size, '闭包太小 ⇒ 扫描没生效').toBeGreaterThan(30)
    expect(rules.depClosureViolations(names)).toEqual([])
  })

  it('反例自证①：闭包里出现 onnxruntime-web 必须报 dep-forbidden', () => {
    const { names } = rules.productionDepClosure(repoRoot, rootPkg)
    const bad = new Set(names)
    bad.add('onnxruntime-web')
    const v = rules.depClosureViolations(bad)
    expect(v.map((x) => x.name)).toContain('onnxruntime-web')
    expect(v.find((x) => x.name === 'onnxruntime-web')?.rule).toBe('dep-forbidden')
  })

  it('反例自证②：必需包（onnxruntime-common）缺了必须报 dep-required', () => {
    const { names } = rules.productionDepClosure(repoRoot, rootPkg)
    const bad = new Set(names)
    bad.delete('onnxruntime-common')
    const v = rules.depClosureViolations(bad)
    expect(v.map((x) => x.name)).toContain('onnxruntime-common')
    expect(v.some((x) => x.rule === 'dep-required')).toBe(true)
  })

  it('闭包跟着**传递依赖**走，且能吃下嵌套 node_modules（这正是抓 135MB 的机制）', () => {
    const root = join(scratch, 'closure')
    const mk = (rel: string, pkg: unknown) => {
      mkdirSync(join(root, rel), { recursive: true })
      writeFileSync(join(root, rel, 'package.json'), JSON.stringify(pkg), 'utf8')
    }
    mk('', { name: 'root' })
    mk('node_modules/a', { name: 'a', dependencies: { b: '1' } })
    // b 只存在于 a 自己的 node_modules 下（嵌套而非提升）—— 解析必须能下沉找到
    mk('node_modules/a/node_modules/b', { name: 'b' })
    const got = rules.productionDepClosure(root, { dependencies: { a: '1' } })
    expect([...got.names].sort()).toEqual(['a', 'b'])
  })

  it('禁用/必需两张名单都不是空的，且每条都写明了理由（否则就是无声的名单）', () => {
    expect(rules.FORBIDDEN_IN_DEPS.length).toBeGreaterThanOrEqual(3)
    expect(rules.REQUIRED_IN_DEPS.length).toBeGreaterThanOrEqual(8)
    for (const e of [...rules.FORBIDDEN_IN_DEPS, ...rules.REQUIRED_IN_DEPS]) {
      expect(e.why.length, `${e.name} 的理由太短（形同没写）`).toBeGreaterThanOrEqual(5)
    }
  })
})

/**
 * M18：平台声明必须与「实际构建得出、且跑得起来」的目标一致。
 *
 * 背景：`package.json` 的 build 里曾同时声明 `win/nsis`、`mac/dmg`、`linux/AppImage`，
 * 而本仓库只把 `@koromix/koffi-win32-x64` 作为 `file:` 依赖内联。M18 选择删掉后两个
 * 声明，理由**是数据源**（Weixin.exe / 注册表 / xwechat_files 都只存在于 Windows），
 * 构建侧只是结果 —— 实测两个平台的形态还不一样：
 *   · `--mac` 直接失败（`Build for macOS is supported only on macOS`，exit 1）；
 *   · `--linux --dir` 出得来（exit 0），但包里唯一的原生模块是 win32 的 `koffi.node`
 *     （缺 `@koromix/koffi-linux-x64`），即「出得来、跑不了」。
 *
 * 这条用例守的是**声明别漂回去**，以及「声明与打包白名单」别脱节。
 * 它**守不住**文档里解释性文字的真伪 —— README 的第一版把 mac 的情形写成「会缺原生
 * 二进制」，那是错的（mac 根本打不出），只有人工复审能发现。
 *
 * 分工：这条用例覆盖「配置层」；`scripts/packaged-smoke.js` 覆盖「产物层」（它会断言
 * asar 里确实带了该带的、没带不该带的）。真正的可构建性最终由 `npm run pack` / `dist` 证明。
 *
 * 刻意**不**守的：
 *   · `main.js:1211` 与 `tools/license-studio/main.js:277` 的 `process.platform !== 'darwin'`
 *     —— Electron 模板残留，win32 进程里不可达，删不删都不改变对外声明；
 *   · README 的因果解释文字（见上）。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { grp } from './helpers/strict-index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const build = pkg.build

/** electron-builder 里 `win` 允许的 target 名（非 win 平台的一律不在内）。 */
const WIN_TARGETS = new Set([
  'nsis', 'nsis-web', 'portable', 'msi', 'appx', 'squirrel', 'zip', '7z',
  'tar.xz', 'tar.gz', 'tar', 'dir',
])
const NON_WIN_TARGETS = ['dmg', 'pkg', 'appimage', 'deb', 'rpm', 'flatpak', 'snap', 'mas']

/**
 * 收集某个 key 下**所有字符串叶子**。
 *
 * 例：`{ target: 'nsis' }`、`{ target: ['dmg'] }`、`{ target: [{ target: 'nsis', arch: ['x64'] }] }`
 * 三种形态都要能取到 —— 只认「值是字符串」会把后两种整类漏掉（本用例第一版就漏了
 * `arch: ['x64']`，导致 `ALL_ARCHES` 恒为空、断言空转）。
 *
 * 刻意**不**用「把整个配置 JSON 化再找子串」的写法：`onlyloadappfromasar` 里含 `mas`、
 * `directories` 里含 `dir`，子串扫描只会误报（第一版就是这么误报的）。
 */
function collectValues(node: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectValues(item, key, out)
    return out
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key) flattenValuesFor(key, v, out)
      else collectValues(v, key, out)
    }
  }
  return out
}

/**
 * 取出一个已命名字段的值。三种形态：`'nsis'`、`['x64']`、`[{ target: 'nsis', arch: ['x64'] }]`。
 *
 * 关键在最后一层：对象只沿**同名字段**下钻。早先写成「摊平该值下所有字符串叶子」，
 * 结果 `win.target` 那个对象里的 `arch: ['x64']` 被当成 target 收进集合，`x64` 立刻
 * 违反「target 必须在 win 允许集内」—— 断言本意是查平台，却因收集过宽而误报。
 */
function flattenValuesFor(key: string, value: unknown, out: string[]): void {
  if (typeof value === 'string') { out.push(value); return }
  if (Array.isArray(value)) {
    for (const item of value) flattenValuesFor(key, item, out)
    return
  }
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (inner !== undefined) flattenValuesFor(key, inner, out)
  }
}

const ALL_TARGETS = build ? collectValues(build, 'target') : []
const ALL_ARCHES = build ? collectValues(build, 'arch') : []

/** 把 electron-builder 的 glob 粗化为正则，够用来判断某个相对路径是否被白名单覆盖。 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp('^' + escaped + '$')
}

/** `files` 里以 `!` 开头的排除规则不参与「是否被覆盖」的判定。 */
function coveredBy(patterns: string[] | undefined, relPath: string): boolean {
  if (!patterns || patterns.length === 0) return true // 未声明 = electron-builder 默认全收
  return patterns.filter((p) => !p.startsWith('!')).some((p) => globToRegExp(p).test(relPath))
}

const workflowDir = join(ROOT, '.github', 'workflows')
const workflowFiles = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((f) => /\.ya?ml$/i.test(f))
  : []

describe('M18：平台声明与可构建目标一致', () => {
  it('声明面在 package.json 的 build 字段里', () => {
    // electron-builder 只在 package.json 没有 build 字段时才去读 electron-builder.yml，
    // 实测日志为 `loaded configuration file=package.json ("build" field)`。
    // 若将来真的把配置迁走，这条会红 —— 那是**期望行为**：迁移必须连带改本用例，
    // 而不是让下面的断言对着 undefined 空转。
    expect(build, 'package.json 缺少 build 字段：若已迁移到 electron-builder.yml，请同步本用例')
      .toBeTypeOf('object')
  })

  it('build 里没有 mac / linux 平台键与目标', () => {
    expect(Object.keys(build).map((k) => k.toLowerCase())).not.toContain('mac')
    expect(Object.keys(build).map((k) => k.toLowerCase())).not.toContain('linux')
    // 防空转：配置里必须真能收集到 target，否则下面的断言全都毫无意义
    expect(ALL_TARGETS.length).toBeGreaterThan(0)
    expect(ALL_TARGETS.filter((t) => NON_WIN_TARGETS.includes(t.toLowerCase()))).toEqual([])
  })

  it('保留 win/nsis，且所有 target 都在 Windows 允许集内', () => {
    expect(build.win).toBeTruthy()
    expect(collectValues(build.win, 'target')).toContain('nsis')
    expect(ALL_TARGETS.every((t) => WIN_TARGETS.has(t))).toBe(true)
  })

  it('显式声明的架构只有 x64', () => {
    // 只约束「声明过的」架构：`"target": "nsis"`（裸字符串）是合法写法，此时
    // electron-builder 用宿主架构 —— 本机即 x64。早先要求 ALL_ARCHES 非空，
    // 会把这种合法写法误判成违约（变异矩阵里的 E2 抓到的就是这个误报）。
    expect(ALL_ARCHES.filter((a) => a !== 'x64')).toEqual([])
  })

  it('npm scripts 里没有触发 mac/linux 构建的入口', () => {
    // `dist` 用 `--win nsis` 是正当的；这里只禁「换个平台构建」这条路，
    // 否则删掉 build.mac 之后仍能靠脚本把声明绕回来。
    const offenders = Object.entries(pkg.scripts ?? {})
      .filter(([, cmd]) => /--(mac|macos|darwin|linux)\b/i.test(String(cmd)))
      .map(([name, cmd]) => `${name}: ${cmd}`)
    expect(offenders).toEqual([])
  })

  it('原生依赖只内联 win32，且被 files / asarUnpack 覆盖', () => {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }
    const natives = Object.entries(deps).filter(([name]) => /^@koromix\/koffi-/.test(name))
    expect(natives.length).toBeGreaterThan(0)

    for (const [name, spec] of natives) {
      // 内联的每一份原型包都必须是 win32；出现 darwin/linux 说明声明应当重新评估
      expect(name).toMatch(/^@koromix\/koffi-win32-/)
      expect(String(spec).startsWith('file:')).toBe(true)
      const dir = join(ROOT, String(spec).slice('file:'.length))
      expect(existsSync(join(dir, 'package.json'))).toBe(true)

      // file: 依赖会被 npm 装到同名位置，打包白名单必须覆盖它，且原生 .node 必须解包
      const installedAs = `node_modules/${name}/win32_x64/koffi.node`
      expect(coveredBy(build.files, installedAs), `files 白名单没覆盖 ${installedAs}`).toBe(true)
      expect(coveredBy(build.asarUnpack, installedAs), `asarUnpack 没覆盖 ${installedAs}`).toBe(true)
    }
    expect(Object.keys(deps).filter((n) => /^@koromix\/koffi-(darwin|linux|freebsd|openbsd)-/.test(n)))
      .toEqual([])
  })

  it('所有会构建/测试的 CI workflow 都只在 Windows 上跑', () => {
    // 扫整个目录而不是只读 ci.yml：新加一个 ubuntu runner 的 workflow 同样是
    // 「在别的平台上构建」的声明，旧版只读 ci.yml 会把它漏过去。
    expect(workflowFiles.length).toBeGreaterThan(0)

    /**
     * 「会用项目工具链」的判据。
     *
     * 这条规则的本意是「构建/测试必须跑在 win32 原生依赖装得起来的地方」
     * （koffi-win32-x64、wx_silk.exe、whisper bin 都只有 win32 一份），
     * 而不是「任何 workflow 都必须用 windows runner」。
     *
     * 反例（真实存在）：Pages 部署只是把 `website/` 这个静态目录原样上传 ——
     * 没有 setup-node、不装依赖、不构建，碰不到任何一个原生二进制。
     * 让它跑 windows runner 纯属浪费（ubuntu runner 更快、额度更宽），
     * 而把规则写成「所有 workflow 一律 windows」只会把这类无关任务也钉死。
     *
     * `setup-node` 是关键信号：装了 Node 就意味着接下来要动这个项目。
     * 三个信号（setup-node / npm 命令 / electron-builder）覆盖了当前全部构建路径。
     */
    const usesToolchain = (text: string): boolean =>
      /actions\/setup-node@|\bnpm\s+(ci|install|run|test)\b|\bnpx\s+\S|electron-builder/.test(text)

    for (const file of workflowFiles) {
      const text = readFileSync(join(workflowDir, file), 'utf8')
      const runners = [...text.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((m) => grp(m, 1, 'runs-on').trim().replace(/^['"]|['"]$/g, ''))
      expect(runners.length, `${file} 里没有 runs-on`).toBeGreaterThan(0)
      if (!usesToolchain(text)) continue
      for (const runner of runners) {
        expect(runner, `${file} 会构建/测试，但 runner 不是 windows`).toMatch(/^windows/i)
      }
    }

    // 防空转：必须**至少有一个** workflow 真的被这条规则管住。否则某个改动把
    // 判据写坏（比如正则再也匹配不上）时，上面的循环会全部 continue，用例静默变绿。
    const enforced = workflowFiles.filter((f) => usesToolchain(readFileSync(join(workflowDir, f), 'utf8')))
    expect(enforced.length, '没有任何 workflow 命中「会用项目工具链」—— 判据已失效，请复核本用例').toBeGreaterThan(0)
  })

  it('manifest 与后端 README 都写明支持平台', () => {
    // 大小写不敏感：改个大小写不是「声明变了」，旧版 toContain('Windows') 会误报
    expect(String(pkg.description)).toMatch(/windows/i)
    // 全篇搜索而不是取前 N 个字符：README 前面加一段说明就误报是过拟合
    const readme = readFileSync(join(ROOT, 'src', 'backend', 'README.md'), 'utf8')
    expect(readme).toContain('仅 Windows')
    // x64 这个口径也必须在声明面出现：配置里可以不写 arch（见上一条），
    // 但「对外说的是 x64」这件事要有据可查
    expect(readme).toMatch(/x64/i)
  })
})

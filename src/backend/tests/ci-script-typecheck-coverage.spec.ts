/**
 * N32（前半）：CI 会跑的**门禁脚本**必须真的在类型检查范围内。
 *
 * 为什么这条值得单独守：这些脚本本身就是门禁（`rag:check`、`privacy-gate:smoke`、
 * `check:sns-video`、`check:whisper-paths`、`ui:smoke`），而 vitest/esbuild 只**剥类型不查类型**。
 * 于是「门禁自己写错」是没人看的：本条落地时一次就抓到三处 ——
 *   · `rag-retrieval-check.ts` 的 weights 夹具少一个 `kb` 通道（打分循环遍历的是夹具自己的键，
 *     少写一个就等于那条用例里知识库通道不参与打分 —— 与线上跑的不是同一件事）；
 *   · 两处 `xxx[0].doc` 在 `noUncheckedIndexedAccess` 下是可能为 undefined 的（结果为空时
 *     本来该报「结果为空」，实际会抛一个 TypeError 被记成「脚本崩了」）；
 *   · `privacy-consent-ssr.tsx` 里 `at[i - 1]` 同形。
 *
 * 判据问**编译器本人**（`tsc --listFilesOnly`），不看 tsconfig 的注释写了什么 ——
 * 与 N31 那条同一手法：program 里有没有那个文件才算数。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..', '..', '..')
const CHECKS_CFG = join(ROOT, 'tsconfig.checks.json')
const CLIENT_CFG = join(ROOT, 'src', 'client', 'ui-wechat', 'tsconfig.json')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

function readJson (p: string): Record<string, any> {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/** 问编译器：这个项目的 program 里到底有哪些文件（返回仓库内相对路径，正斜杠）。 */
function programFiles (tsconfigPath: string): Set<string> {
  const out = execFileSync(process.execPath, [TSC, '-p', tsconfigPath, '--noEmit', '--listFilesOnly'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const rootUrl = ROOT.replace(/\\/g, '/') + '/'
  return new Set(out.split(/\r?\n/).map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.startsWith(rootUrl) && /\.tsx?$/.test(f))
    .map((f) => f.slice(rootUrl.length)))
}

/** 磁盘上 scripts/ 里所有 .ts/.tsx（递归，跳过产物与临时文件）。 */
function scriptsOnDisk (): string[] {
  const dir = join(ROOT, 'scripts')
  const walk = (d: string): string[] => readdirSync(d).flatMap((name) => {
    const p = join(d, name)
    if (statSync(p).isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(name) && !name.startsWith('.tmp-') ? [relative(ROOT, p).replace(/\\/g, '/')] : []
  })
  return walk(dir)
}

const pkg = readJson(join(ROOT, 'package.json')) as { scripts: Record<string, string> }
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

describe('N32：门禁脚本要在类型检查范围内', () => {
  it('tsconfig.checks.json 存在，且档位与客户端那份逐项对齐', () => {
    expect(existsSync(CHECKS_CFG), '缺少 tsconfig.checks.json').toBe(true)
    const checks = readJson(CHECKS_CFG).compilerOptions as Record<string, unknown>
    const client = readJson(CLIENT_CFG).compilerOptions as Record<string, unknown>
    for (const flag of ['noImplicitAny', 'noImplicitThis', 'strictFunctionTypes', 'noUncheckedIndexedAccess']) {
      expect(checks[flag], `tsconfig.checks.json 缺 ${flag}`).toBe(client[flag])
    }
    // 必须 extends **客户端**基座：这些脚本 import 的是面板与 React 代码，
    // 拿后端基座去查会得到一堆与真实构建无关的假错（jsx、css modules 声明都不在一边）。
    expect(readJson(CHECKS_CFG).extends, 'tsconfig.checks.json 应当 extends 客户端基座').toBe('./tsconfig.base.client.json')
  })

  it('scripts/ 目录里的每一个 .ts/.tsx 都在 program 里（不留「以后再说」的口子）', () => {
    const files = programFiles(CHECKS_CFG)
    // 防空转：这份 program 会拉进整棵客户端依赖树，不可能只有几个文件。
    expect(files.size, '--listFilesOnly 只返回了这么点文件，八成是解析失败').toBeGreaterThan(60)
    const onDisk = scriptsOnDisk()
    expect(onDisk.length, 'scripts/ 下一个 .ts/.tsx 都没扫到？前提不成立').toBeGreaterThan(3)
    const missing = onDisk.filter((f) => !files.has(f))
    expect(missing, '这些门禁脚本没被类型检查看过：' + missing.join('、')).toEqual([])
  })

  it('vitest.config.ts 也在同一份 program 里', () => {
    expect(programFiles(CHECKS_CFG).has('vitest.config.ts'), 'vitest.config.ts 不在类型检查范围内').toBe(true)
  })

  it('npm run typecheck 与 CI 都真的会跑这一份', () => {
    expect(pkg.scripts['typecheck:checks'], '缺少 typecheck:checks 脚本').toContain('tsconfig.checks.json')
    expect(pkg.scripts.typecheck, 'typecheck 没有把 checks 那一档串进来').toContain('typecheck:checks')
    expect(ci, 'CI 里没有 `npm run typecheck` 这一步（那这档就只在本地跑）').toMatch(/npm run typecheck/)
  })
})

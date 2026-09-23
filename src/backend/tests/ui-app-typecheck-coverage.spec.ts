/**
 * N31：`src/client/ui-app/**` 必须**真的在**类型检查覆盖范围内。
 *
 * 为什么需要一条守卫来守「类型检查本身」：客户端原先只有一份
 * `src/client/ui-wechat/tsconfig.json`，它的 `include: ["src"]` 相对的是**那份文件自己所在的目录**
 * —— 于是 `npm run typecheck` 报「0 错误」时，看的是 230 个面板文件，而**打包入口**
 * （`ui-app/ui-entry.tsx`）、启动页三站（引导 / 隐私同意 / 授权）、同意屏与授权面板
 * 一行都没被 tsc 看过。H11 那五档严格度对它们全部无效，`ui:smoke` 又走 tsx 转译不做类型检查
 * ⇒ CI 会绿着收下这一层的类型错误。一句「typecheck 过了」于是变成了永远为真的话。
 *
 * 判据刻意问**编译器本人**（`tsc --listFilesOnly`），不读注释也不做字符串 includes：
 * tsconfig 的注释说什么不算数，program 里有没有那个文件才算数 —— 这正是 N31 当初会漏掉的原因。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..', '..', '..')
const UI_APP_CFG = join(ROOT, 'src', 'client', 'ui-app', 'tsconfig.json')
const CLIENT_CFG = join(ROOT, 'src', 'client', 'ui-wechat', 'tsconfig.json')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** 问编译器：这个项目的 program 里到底有哪些文件（返回正斜杠路径）。 */
function programFiles(tsconfigPath: string): string[] {
  const out = execFileSync(
    process.execPath,
    [TSC, '-p', tsconfigPath, '--noEmit', '--listFilesOnly'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return out.split(/\r?\n/).map((f) => f.replace(/\\/g, '/')).filter(Boolean)
}

function readJson(p: string): Record<string, any> {
  return JSON.parse(readFileSync(p, 'utf8'))
}

const pkg = readJson(join(ROOT, 'package.json')) as { scripts: Record<string, string> }
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

describe('N31：打包入口那一层要在类型检查范围内', () => {
  it('ui-app 有自己的 tsconfig，且档位与 ui-wechat 逐项对齐（壳不是严格度的缺口）', () => {
    expect(existsSync(UI_APP_CFG), '缺少 src/client/ui-app/tsconfig.json').toBe(true)
    const shell = readJson(UI_APP_CFG).compilerOptions as Record<string, unknown>
    const client = readJson(CLIENT_CFG).compilerOptions as Record<string, unknown>
    // 这几档是 H11 逐项量过 0 处才开的；壳若少一档，就等于给严格度留了个洞
    for (const flag of ['noImplicitAny', 'noImplicitThis', 'strictFunctionTypes', 'noUncheckedIndexedAccess']) {
      expect(shell[flag], `ui-app 项目缺 ${flag}`).toBe(client[flag])
    }
    expect(client.noUncheckedIndexedAccess, 'ui-wechat 那份的 noUncheckedIndexedAccess 被关掉了？').toBe(true)
    // 必须 extends **客户端**基座：后端那份 `tsconfig.base.json` 与它无关（H11 踩过这个错觉）
    expect(readJson(UI_APP_CFG).extends).toBe('../../../tsconfig.base.client.json')
  })

  it('编译器本人的文件清单里有打包入口、三站闸门与同意屏', () => {
    const files = programFiles(UI_APP_CFG)
    // 防空转：这份 program 不可能只有几个文件（它会把整棵面板依赖树拉进来）
    expect(files.length, '--listFilesOnly 只返回了这么点文件，八成是解析失败').toBeGreaterThan(60)
    for (const want of [
      'src/client/ui-app/ui-entry.tsx',
      'src/client/ui-app/onboarding/OnboardingShell.tsx',
      'src/client/ui-app/onboarding/onboarding-content.tsx',
      'src/client/ui-app/privacy/PrivacyConsentGate.tsx',
      'src/client/ui-app/privacy/consent.ts',
      'src/client/ui-app/license/LicenseGate.tsx',
      'src/client/ui-app/license/LicenseAuthPanel.tsx',
    ]) {
      expect(files.some((f) => f.endsWith(want)), `program 里没有 ${want}`).toBe(true)
    }
    // 反面确认判据有鉴别力：本包对宿主插槽的注册点故意不在任何项目里
    // （它 import 的 @deepseek-ai/dsh-client-ui-* 本仓库没有 vendored，见 ui-wechat 那份的 exclude 注释）
    expect(files.some((f) => f.endsWith('src/client/index.tsx')),
      '连 src/client/index.tsx 都被拉进来了 —— include 收得太宽').toBe(false)
  })

  it('两个项目不互相覆盖（否则同一批文件被检查两遍，而 N31 的说法也不再成立）', () => {
    const client = programFiles(CLIENT_CFG)
    expect(client.some((f) => f.includes('/client/ui-app/')),
      'ui-wechat 项目已经含 ui-app 文件了：那 ui-app 那份就该删掉，别双跑').toBe(false)
  })

  it('npm run typecheck 串起了它，而 CI 跑的就是 npm run typecheck', () => {
    expect(pkg.scripts['typecheck:ui-app']).toMatch(/tsc -p src\/client\/ui-app\/tsconfig\.json --noEmit/)
    expect(pkg.scripts.typecheck).toContain('typecheck:ui-app')
    // 门禁若只跑 `tsc -p <某一份>`，上面这条覆盖得再好也没进 CI
    expect(ci).toMatch(/run:\s*npm run typecheck\b/)
  })
})

/**
 * 构建与打包命令必须覆盖全部入库产物。
 *
 * 运行时只加载 `lib/index.js`，前端类型只从 `lib/types` 取，而
 * `pack` / `dist` 曾只前置 `build:ui` —— 改完后端源码直接打包会悄悄发旧逻辑。
 * 这里把「启动/打包链路必须重建 bundle 与类型」钉成命令级不变量。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const releaseWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
const buildTypesSource = readFileSync(join(ROOT, 'scripts', 'build-types.js'), 'utf8')

describe('构建与打包命令覆盖全部入库产物', () => {
  it('build:all 按 backend → types → ui 的顺序一次构建全部产物', () => {
    expect(pkg.scripts['build:all'])
      .toBe('npm run build:backend && npm run build:types && npm run build:ui')
  })

  it('build:types 先清空生成目录再重建，删除/改名源文件不会留下旧声明', () => {
    expect(pkg.scripts['build:types']).toBe('node scripts/build-types.js')
    expect(buildTypesSource).toContain('fs.rmSync(outDir, { recursive: true, force: true })')
    expect(buildTypesSource).toContain("require.resolve('typescript/lib/tsc.js')")
  })

  it('启动与打包链路都走 build:all，不再只构建前端', () => {
    for (const name of ['prestart', 'dev', 'pack', 'dist']) {
      expect(pkg.scripts[name], `${name} 没走 build:all`).toContain('npm run build:all')
    }
  })

  it('入库产物一致性检查先到临时目录构建，再逐字节比对当前工作树，不依赖 git diff', () => {
    expect(pkg.scripts['check:backend'])
      .toBe('node scripts/check-generated-artifacts.js --backend')
    expect(pkg.scripts['check:types'])
      .toBe('node scripts/check-generated-artifacts.js --types')
  })

  it('tag 发布不经过 ci.yml，所以 release.yml 自己核对两份产物', () => {
    expect(releaseWorkflow).toContain('npm run check:backend')
    expect(releaseWorkflow).toContain('npm run check:types')
  })
})

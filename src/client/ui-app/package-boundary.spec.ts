/**
 * ui-app 只能通过 @deepseek-ai/dsh-client-ui-wechat 的公开子路径消费
 * ui-wechat。禁止再出现 `../ui-wechat/src/...` 这类把库内部文件当宿主的相对导入：
 * 那会让包入口、类型产物和懒加载边界都变成摆设。
 *
 * 本文件是纯源码判据，不 import 被测前端实现。
 * @vitest-environment node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const UI_WECHAT_SRC = join(ROOT, 'src', 'client', 'ui-wechat', 'src')
const PACKAGE = '@deepseek-ai/dsh-client-ui-wechat'
const ALLOWED_SUBPATHS = new Set(['contracts', 'host', 'notice', 'theme'])

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collect(p, out)
    else if (/\.(ts|tsx|d\.ts)$/.test(entry.name) && !entry.name.includes('.spec.')) out.push(p)
  }
  return out
}

function moduleSources(sf: ts.SourceFile): string[] {
  const out: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text)
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

function rel(p: string): string {
  return relative(ROOT, p).split(sep).join('/')
}

function packageSubpath(spec: string): string | null {
  const prefix = `${PACKAGE}/`
  return spec.startsWith(prefix) ? spec.slice(prefix.length) : null
}

describe('ui-app 对 ui-wechat 的包边界', () => {
  const files = collect(HERE)

  it('扫描覆盖到入口与启动三站（扫空会让零命中变成恒真）', () => {
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((f) => rel(f).endsWith('ui-entry.tsx'))).toBe(true)
    expect(files.some((f) => rel(f).endsWith('PrivacyConsentGate.tsx'))).toBe(true)
    expect(files.some((f) => rel(f).endsWith('OnboardingShell.tsx'))).toBe(true)
  })

  it('判据能认出指向 ui-wechat/src 的相对导入', () => {
    const fake = ts.createSourceFile(join(HERE, 'fake.ts'),
      "import { x } from '../ui-wechat/src/client/contracts.ts'\n"
      + "import { y } from '../../client/ui-wechat/src/client/foo.ts'\n",
      ts.ScriptTarget.Latest, true)
    const violations: string[] = []
    for (const spec of moduleSources(fake)) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(join(HERE, 'fake.ts')), spec)
      if (rel(target).startsWith(rel(UI_WECHAT_SRC))) violations.push(spec)
    }
    expect(violations).toHaveLength(2)
  })

  it('产品代码不再相对导入 ui-wechat/src，且包导入只走公开子路径', () => {
    const bad: string[] = []
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      for (const spec of moduleSources(sf)) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          if (rel(target).startsWith(rel(UI_WECHAT_SRC))) bad.push(`${rel(file)} -> ${spec}`)
          continue
        }
        const subpath = packageSubpath(spec)
        if (subpath !== null && !ALLOWED_SUBPATHS.has(subpath)) bad.push(`${rel(file)} -> ${spec}`)
      }
    }
    expect(bad, `ui-app 越过了 ui-wechat 的公开入口：\n${bad.join('\n')}`).toEqual([])
  })

  it('每个公开子路径在 tsconfig、Vite 和包 exports 里都有同一份解析', () => {
    const tsconfig = JSON.parse(readFileSync(join(HERE, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]> }
    }
    const paths = tsconfig.compilerOptions?.paths ?? {}
    for (const subpath of ALLOWED_SUBPATHS) {
      const key = `${PACKAGE}/${subpath}`
      expect(paths[key]?.length ?? 0, `ui-app tsconfig 缺少 ${key}`).toBeGreaterThan(0)
    }

    const vite = readFileSync(join(ROOT, 'vite.config.js'), 'utf8')
    const escapedPackage = PACKAGE.replaceAll('/', '\\/')
    for (const subpath of ALLOWED_SUBPATHS) {
      expect(vite, `vite.config.js 缺少 ${PACKAGE}/${subpath}`).toContain(`${escapedPackage}\\/${subpath}`)
    }

    const pkg = JSON.parse(readFileSync(join(UI_WECHAT_SRC, '..', 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
    }
    for (const subpath of ALLOWED_SUBPATHS) {
      expect(pkg.exports?.[`./${subpath}`], `ui-wechat package exports 缺少 ./${subpath}`).toBeTruthy()
    }
  })
})

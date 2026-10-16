/**
 * 生成物一致性检查的纯比较逻辑。
 *
 * 这些用例故意只测函数，不真跑 tsc/esbuild：脚本自身的正确性还要靠 CI
 * 在干净检出上执行 `npm run check:backend` / `check:types` 验证。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const script = requireCjs('../../../scripts/check-generated-artifacts.js') as {
  BACKEND_PATHS: string[]
  compareNamedFiles: (paths: string[], actual: string, generated: string, label: string) => {
    label: string
    missing: string[]
    extra: string[]
    changed: string[]
  }
  compareTrees: (actual: string, generated: string, label: string) => {
    label: string
    missing: string[]
    extra: string[]
    changed: string[]
  }
  listFiles: (root: string) => string[]
  parseMode: (argv: string[]) => string
}

const scratch = mkdtempSync(join(tmpdir(), 'st-generated-check-spec-'))
beforeEach(() => { rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true }) })
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function write(rel: string, content = 'x') {
  const file = join(scratch, ...rel.split('/'))
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

describe('check-generated-artifacts', () => {
  it('模式参数只认三个合法值，缺省为 all', () => {
    expect(script.parseMode(['node', 'script.js'])).toBe('all')
    expect(script.parseMode(['node', 'script.js', '--backend'])).toBe('backend')
    expect(script.parseMode(['node', 'script.js', '--types'])).toBe('types')
    expect(script.parseMode(['node', 'script.js', '--all'])).toBe('all')
    expect(() => script.parseMode(['node', 'script.js', '--unknown'])).toThrow(/未知模式/)
  })

  it('listFiles 递归返回 posix 相对路径，不把目录算成文件', () => {
    write('a/index.js', 'a')
    write('a/net/fetch-retry.js', 'b')
    write('a/empty/readme.txt', 'd')
    expect(script.listFiles(join(scratch, 'a'))).toEqual([
      'empty/readme.txt',
      'index.js',
      'net/fetch-retry.js',
    ])
  })

  it('指名文件比较会区分构建没产出与工作树缺失，并按字节识别漂移', () => {
    write('actual/index.js', 'actual-bytes')
    write('actual/net/fetch-retry.js', 'same')
    write('generated/index.js', 'generated-bytes')
    write('generated/net/fetch-retry.js', 'same')
    const diff = script.compareNamedFiles(
      ['index.js', 'net/fetch-retry.js', 'missing.js'],
      join(scratch, 'actual'),
      join(scratch, 'generated'),
      '后端 bundle',
    )
    expect(diff.changed).toEqual(['index.js'])
    expect(diff.missing).toEqual(['missing.js（构建没有产出）'])
    expect(diff.extra).toEqual([])
  })

  it('整树比较会把多出、缺失和内容漂移三类不一致都找出来', () => {
    write('actual/a.d.ts', 'a')
    write('actual/stale.d.ts', 'stale')
    write('generated/a.d.ts', 'changed')
    write('generated/b.d.ts', 'b')
    const diff = script.compareTrees(
      join(scratch, 'actual'),
      join(scratch, 'generated'),
      '后端类型声明',
    )
    expect(diff.changed).toEqual(['a.d.ts'])
    expect(diff.missing).toEqual(['b.d.ts'])
    expect(diff.extra).toEqual(['stale.d.ts'])
  })
})

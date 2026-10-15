/**
 * 守护 SQLite 页缓存策略：从「宿主在 bundle 加载前全局替换 node:sqlite」改成
 * 「后端包内显式配置、宿主在 bundle 加载后调用」。后者不再依赖脆弱的 CJS/ESM
 * 加载顺序，也让策略成为可单测的后端公开边界。
 *
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  configureSqliteCachePolicy,
  DatabaseSync,
} from '../wechat-data/src/query/db-open.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(HERE, '..', 'wechat-host.js'), 'utf8')
const packageRoot = join(HERE, '..', 'wechat-data')
const sourceRoot = join(packageRoot, 'src')
const indexSrc = readFileSync(join(sourceRoot, 'index.ts'), 'utf8')
const dbOpenSrc = readFileSync(join(sourceRoot, 'query', 'db-open.ts'), 'utf8')
const bundleSrc = readFileSync(join(packageRoot, 'lib', 'index.js'), 'utf8')
const sqlite = require('node:sqlite')
const originalDatabaseSync = sqlite.DatabaseSync

function cacheSize(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA cache_size').get() as { cache_size: number }
  return Number(row.cache_size)
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'deps' || entry.name === 'node_modules' || entry.name === 'lib') continue
    const file = join(dir, entry.name)
    if (entry.isDirectory()) listTsFiles(file, out)
    else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) out.push(file)
  }
  return out
}

afterAll(() => {
  configureSqliteCachePolicy({ readOnlyKb: 256, writableKb: 256 })
})

describe('SQLite 页缓存策略', () => {
  it('宿主不再全局替换 node:sqlite 的 DatabaseSync', () => {
    expect(hostSrc).not.toMatch(/sqlite\.DatabaseSync\s*=/)
    expect(hostSrc).toContain('mod.configureSqliteCachePolicy()')
    const importAt = hostSrc.indexOf("import('./wechat-data/lib/index.js')")
    const configAt = hostSrc.indexOf('mod.configureSqliteCachePolicy()')
    expect(importAt).toBeGreaterThan(-1)
    expect(configAt).toBeGreaterThan(importAt)
  })

  it('配置边界从后端入口导出', () => {
    expect(indexSrc).toContain("export { configureSqliteCachePolicy } from './query/db-open.ts'")
    expect(dbOpenSrc).toContain("export { configureSqliteCachePolicy, DatabaseSync } from '../sqlite-connection.ts'")
  })

  it('生产源码只能经 base 连接层拿 DatabaseSync，产物也只保留一条原生导入', () => {
    const bypasses = listTsFiles(sourceRoot).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      const hits = [...text.matchAll(/import(?:\s+type)?\s*\{[^}]*\bDatabaseSync\b[^}]*\}\s*from\s*['"]node:sqlite['"]/g)]
      return hits.map((hit) => `${file}:${hit.index ?? -1}`)
    }).filter((hit) => !hit.startsWith(join(sourceRoot, 'sqlite-connection.ts')))
    expect(bypasses.join('\n'), '新增绕过 sqlite-connection 的原生 DatabaseSync 导入').toBe('')
    const nativeImports = bundleSrc.match(/from\s+["']node:sqlite["']/g) ?? []
    expect(nativeImports.length, 'bundle 应只在 sqlite-connection 内部保留一条 node:sqlite 导入').toBe(1)
    expect(bundleSrc).toContain('configureSqliteCachePolicy')
  })

  it('默认把新连接的页缓存压到 -256KB', () => {
    configureSqliteCachePolicy()
    const db = new DatabaseSync(':memory:')
    try {
      expect(cacheSize(db)).toBe(-256)
    } finally {
      db.close()
    }
  })

  it('读/写连接可以分别收紧，且不改变 node:sqlite 的全局导出', () => {
    configureSqliteCachePolicy({ readOnlyKb: 128, writableKb: 768 })
    expect(sqlite.DatabaseSync).toBe(originalDatabaseSync)
    const read = new DatabaseSync(':memory:', { readOnly: true })
    const write = new DatabaseSync(':memory:')
    try {
      expect(cacheSize(read)).toBe(-128)
      expect(cacheSize(write)).toBe(-768)
    } finally {
      read.close()
      write.close()
    }
  })

  it('0 / 负数保留旧的「不干预」语义，非法值回退到默认值', () => {
    configureSqliteCachePolicy({ readOnlyKb: 0, writableKb: -5 })
    const read = new DatabaseSync(':memory:', { readOnly: true })
    const write = new DatabaseSync(':memory:')
    try {
      expect(cacheSize(read)).not.toBe(-256)
      expect(cacheSize(write)).not.toBe(-256)
    } finally {
      read.close()
      write.close()
    }

    configureSqliteCachePolicy({ readOnlyKb: Number.NaN, writableKb: Number.NaN })
    const readFallback = new DatabaseSync(':memory:', { readOnly: true })
    const writeFallback = new DatabaseSync(':memory:')
    try {
      expect(cacheSize(readFallback)).toBe(-256)
      expect(cacheSize(writeFallback)).toBe(-256)
    } finally {
      readFallback.close()
      writeFallback.close()
    }
  })
})

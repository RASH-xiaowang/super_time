/**
 * 「签名 + 结果」通用磁盘缓存（2026-10-21 性能专项）。
 *
 * 用途：首屏里纯函数式的聚合（`overviewExtras` 冷算 ~120ms）跨启动复用。
 * 判据：签名不符**必须**未命中（数据更新后绝不能返回旧结果）；损坏/缺失退化为 null；
 * 原子写；写失败只返回 false。外加接线守卫（compute 里真的读写缓存）。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSigCached, saveSigCached } from '../src/query/sig-disk-cache.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sig-cache-'))
  scratch.push(dir)
  return join(dir, 'cache', 'x.v1.json')
}

describe('sig-disk-cache', () => {
  it('sig 一致 ⇒ 命中并原样返回', () => {
    const path = tempFile()
    const value = { a: 1, list: [1, 2, 3] }
    expect(saveSigCached(path, 'sig-1', value)).toBe(true)
    expect(loadSigCached(path, 'sig-1')).toEqual(value)
  })

  it('sig 不一致 ⇒ 未命中（数据一变立即失效，不靠 TTL）', () => {
    const path = tempFile()
    saveSigCached(path, 'sig-1', { a: 1 })
    expect(loadSigCached(path, 'sig-2')).toBeNull()
  })

  it('文件缺失/损坏/字段不全 ⇒ null，不抛', () => {
    const missing = tempFile()
    expect(loadSigCached(missing, 's')).toBeNull()
    const bad = tempFile()
    mkdirSync(dirname(bad), { recursive: true })
    writeFileSync(bad, '{ not json', 'utf8')
    expect(() => loadSigCached(bad, 's')).not.toThrow()
    expect(loadSigCached(bad, 's')).toBeNull()
    const noValue = tempFile()
    mkdirSync(dirname(noValue), { recursive: true })
    writeFileSync(noValue, JSON.stringify({ sig: 's' }), 'utf8')
    expect(loadSigCached(noValue, 's')).toBeNull()
  })

  it('原子写：成功后不留 .tmp', () => {
    const path = tempFile()
    saveSigCached(path, 's', { ok: true })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(path + '.tmp')).toBe(false)
  })

  it('写失败只返回 false，不抛（缓存不能影响查询）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sig-cache-'))
    scratch.push(dir)
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const path = join(blocker, 'cache', 'x.v1.json')
    expect(() => saveSigCached(path, 's', {})).not.toThrow()
    expect(saveSigCached(path, 's', {})).toBe(false)
  })
})

describe('overview-extras 接线守卫', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const SRC = readFileSync(join(HERE, '..', 'src', 'query', 'overview-extras.ts'), 'utf8')

  it('compute 里真的按签名读缓存并落盘（否则磁盘缓存永远不会生效）', () => {
    expect(SRC, '缺 loadSigCached ⇒ 重启后永远重算').toContain('loadSigCached<OverviewExtras>')
    expect(SRC, '缺 saveSigCached ⇒ 算完从不落盘').toContain('saveSigCached(extrasCachePath(dec), sig, result)')
    expect(SRC, 'compute 必须拿到 sig 才能校验').toContain('computeOverviewExtras(dec, sig)')
  })
})

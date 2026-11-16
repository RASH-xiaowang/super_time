/**
 * P1-07：导出文件名的写边界。
 *
 * ## 守的是什么
 *
 * 年度报告 / 朋友圈 / 全量会话三条入口原先把调用方的 `filename` 直接 `join` 到导出目录，
 * 只去掉扩展名。渲染进程被控（或直接打 RPC）时，`..\\..\\evil.md` 就能把文件写到导出
 * 目录之外。修复后三条入口只经 `resolveExportTarget` 落盘：拒绝路径分隔符 / 绝对路径 /
 * 盘符 / `..`，并在 `resolve` 之后再做一次目录包含校验。
 *
 * ## 为什么分成两层用例
 *
 * `resolveExportTarget` 的单测钉住「所有坏形状都拒绝」，端到端用例钉住「三个入口真的
 * 只走这一个 helper」—— 只测 helper 的话，某个入口回头绕过它仍然全绿。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportAllSessions, exportAnnualReport, exportMoments, resolveExportTarget } from '../src/query/export-flows.ts'

let base = ''
let dec = ''
let out = ''

/** 最小数据根：空 SessionTable(annual 没关系，moments/sessions 都按空集处理)。 */
function makeDecrypted(dir: string): string {
  const decrypted = join(dir, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  const db = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  db.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  db.close()
  return decrypted
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wx-export-target-'))
  dec = makeDecrypted(base)
  out = join(base, 'out')
  mkdirSync(out, { recursive: true })
})

afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* 下一条用例自己会建 */ }
})

describe('resolveExportTarget：坏文件名一律拒绝', () => {
  it('拒绝 .. / 路径分隔符 / 绝对路径 / 盘符', () => {
    const bad = [
      '..\\..\\evil.md',
      '../evil.md',
      'a/b.zip',
      '/tmp/evil.md',
      '\\\\server\\share\\evil.md',
      'C:\\tmp\\evil.md',
      'C:/tmp/evil.md',
      '..',
    ]
    for (const name of bad) {
      expect(() => resolveExportTarget(out, name, 'md', 'fallback'), `${name} 被当成文件名放行了`).toThrow()
    }
    // 拒绝必须是「抛错」，不能是在目录里悄悄落一个清洗过的名字。
    expect(readdirSync(out)).toEqual([])
  })

  it('正常中文名按原样落地，默认名与扩展名规范化', () => {
    const r = resolveExportTarget(out, '微信年度报告', 'md', 'fallback')
    expect(r.filename).toBe('微信年度报告.md')
    expect(r.path).toBe(join(out, '微信年度报告.md'))

    expect(resolveExportTarget(out, undefined, 'zip', 'wechat_all_sessions_1').filename)
      .toBe('wechat_all_sessions_1.zip')
    expect(resolveExportTarget(out, '报告.MD', 'md', 'x').filename).toBe('报告.md')
  })

  it('重名不覆盖：依次退到 _2/_3', () => {
    writeFileSync(join(out, '报告.md'), '上一份')
    expect(resolveExportTarget(out, '报告', 'md', 'x').filename).toBe('报告_2.md')
    writeFileSync(join(out, '报告_2.md'), '再上一份')
    expect(resolveExportTarget(out, '报告', 'md', 'x').filename).toBe('报告_3.md')
    // 原文件内容没被碰。
    expect(existsSync(join(out, '报告.md'))).toBe(true)
  })

  it('仍然套用 writeDenialReason：可执行扩展名不许写', () => {
    expect(() => resolveExportTarget(out, 'evil', 'exe', 'x')).toThrow(/可执行/)
  })
})

describe('三个导出入口只经 resolveExportTarget 落盘', () => {
  it('年度报告：..\\..\\evil.md 被拒，且目录里一个文件都没有', async () => {
    await expect(
      exportAnnualReport(dec, 2024, 'md', out, '..\\..\\evil.md'),
    ).rejects.toThrow(/路径分隔符/)
    expect(readdirSync(out)).toEqual([])
  })

  it('朋友圈：a/b.txt 被拒；正常中文名成功', async () => {
    await expect(
      exportMoments(dec, { format: 'txt', dir: out, filename: 'a/b.txt' }),
    ).rejects.toThrow(/路径分隔符/)
    expect(readdirSync(out)).toEqual([])

    const ok = await exportMoments(dec, { format: 'txt', dir: out, filename: '微信朋友圈导出' })
    expect(ok.filename).toBe('微信朋友圈导出.txt')
    expect(existsSync(ok.path)).toBe(true)
  })

  it('全量会话：绝对路径被拒；正常文件名成功', async () => {
    await expect(
      exportAllSessions(dec, { dir: out, filename: '/tmp/evil.zip' }),
    ).rejects.toThrow(/路径分隔符/)
    expect(readdirSync(out)).toEqual([])

    const ok = await exportAllSessions(dec, { dir: out, filename: '全量会话' })
    expect(ok.filename).toBe('全量会话.zip')
    expect(existsSync(ok.path)).toBe(true)
  })
})

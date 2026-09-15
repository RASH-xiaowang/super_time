/**
 * M3：目录备份（createBackup）的「部分失败」必须上报，而不是吞掉后照常返回成功。
 *
 * 旧实现在子目录复制处用空 catch 吞掉异常：某个子目录复制失败后依然返回一个
 * 正常条目，列表页还会显示「备份成功」—— 用户以为数据保住了，实际缺库。
 *
 * 为什么要 mock 文件系统：要让「**只**某一个子目录复制失败」可复现，真实磁盘上没有一种
 * 跨平台、与权限无关的办法（改权限要管理员，符号链接要开发者模式）。mock 只替换 cpSync，
 * 其余 fs 能力原样透传。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    cpSync: (src: Parameters<typeof actual.cpSync>[0], dest: Parameters<typeof actual.cpSync>[1], opts?: Parameters<typeof actual.cpSync>[2]) => {
      if (String(src).includes('boom')) throw new Error('EIO 模拟复制失败')
      return actual.cpSync(src, dest, opts)
    },
  }
})

const { createBackup, listBackups } = await import('../src/query/backup.ts')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个 decrypted 根：session/message 两个可复制子目录 + 可选一个注定失败的 boom。 */
function makeRoot(withBoom: boolean): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-bkdir-'))
  scratch.push(base)
  const dec = join(base, 'decrypted')
  mkdirSync(join(dec, 'session'), { recursive: true })
  mkdirSync(join(dec, 'message'), { recursive: true })
  writeFileSync(join(dec, 'session', 'session.db'), 'session-db')
  writeFileSync(join(dec, 'message', 'message_0.db'), 'message-db')
  // 根目录下的散落文件与点目录按既有语义跳过（不该影响成败判定）。
  writeFileSync(join(dec, 'stray.txt'), 'x')
  mkdirSync(join(dec, '.cache'), { recursive: true })
  if (withBoom) {
    mkdirSync(join(dec, 'boom'), { recursive: true })
    writeFileSync(join(dec, 'boom', 'broken.db'), 'boom')
  }
  return dec
}

function backupsDir(dec: string): string {
  return join(dec, '..', 'backups')
}

describe('createBackup：部分失败必须上报并清理', () => {
  it('子目录复制失败 → 抛错（含失败目录名），且不留半成品备份', () => {
    const dec = makeRoot(true)
    let err: unknown = null
    try {
      createBackup(dec)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('备份不完整')
    expect((err as Error).message).toContain('boom')
    // 半成品目录不能留在 backups 里：列表页一旦看到它，就等于报了一个假的成功。
    const leftovers = existsSync(backupsDir(dec)) ? readdirSync(backupsDir(dec)) : []
    expect(leftovers).toEqual([])
    expect(listBackups(dec).items).toEqual([])
    // 目标备份名（最终名字）也不该存在。
    expect(readdirSync(backupsDir(dec)).some(n => n.startsWith('wechat_backup_'))).toBe(false)
  })

  it('全部成功时按最终名字落地，不留临时目录', () => {
    const dec = makeRoot(false)
    const entry = createBackup(dec)
    expect(entry.kind).toBe('dir')
    expect(existsSync(join(entry.path, 'session', 'session.db'))).toBe(true)
    expect(existsSync(join(entry.path, 'message', 'message_0.db'))).toBe(true)
    const names = readdirSync(backupsDir(dec))
    expect(names).toEqual([entry.name])
    expect(listBackups(dec).items.length).toBe(1)
    expect(listBackups(dec).items[0]?.ok).toBe(true)
  })
})

/**
 * W2-8.4：恢复（restore）前的磁盘空间预检。
 *
 * ## 这条在守什么
 *
 * 恢复是「读一个 `.wcb` → 解密 → 把明文整份写出来」，空间需求 = 备份头里
 * 那些分片的明文字节和。这件事原先一次都不查，于是空间不够时的失败形态是：
 * 解到第 N 个分片，`writeFileSync` 抛 ENOSPC —— 用户已经白等（scrypt +
 * 逐块解密都不便宜），磁盘上留着一个半截的 `.restored` 目录，报错还只有 errno。
 *
 * 预检要在**一个字节都不写**之前说清楚「差多少」。
 *
 * ## 三条不许退化的性质
 *
 * ① **密码校验先于预检**。否则用户密码打错了却看到「磁盘空间不足」，
 *    会被引到完全错误的方向上去查。
 * ② **预检自己失败时放行**。个别文件系统/权限组合下 `statfsSync` 会 `EPERM`；
 *    预检的目的是「少踩坑」，不是变成一个新的阻塞点 —— 因它失败就把恢复功能
 *    整个堵死，比不预检更糟。
 * ③ **余量大于明文本身**（64MB 与 10% 取大者）。恢复出来的目录不是终点：
 *    用户下一步通常要拿它当数据根用，系统本身也要空间。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, scryptSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** statfs 的替身状态：用 `vi.hoisted` 才能在 mock 工厂里读到（工厂被提到 import 之前）。 */
const fsMock = vi.hoisted(() => ({ mode: 'real' as 'real' | 'small' | 'throw', freeBytes: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statfsSync: (p: Parameters<typeof actual.statfsSync>[0], o?: Parameters<typeof actual.statfsSync>[1]) => {
      if (fsMock.mode === 'throw') {
        const e = new Error('EPERM 模拟：预检自己失败') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
      if (fsMock.mode === 'small') {
        // `bsize: 1` ⇒ `bavail` 就是字节数，不被块大小截断。
        // 用真实的 4096 会把可用量向下取整到 4KB 粒度，于是「差 1 字节」那条边界判据测不准。
        return { bsize: 1, bavail: fsMock.freeBytes } as unknown as ReturnType<typeof actual.statfsSync>
      }
      return actual.statfsSync(p, o)
    },
  }
})

const { createEncryptedBackup, restoreEncryptedBackup } = await import('../src/query/backup.ts')

let base = ''
let dec = ''
let entryName = ''

beforeEach(async () => {
  fsMock.mode = 'real'
  base = mkdtempSync(join(tmpdir(), 'wx-84-'))
  dec = join(base, 'decrypted')
  mkdirSync(join(dec, 'session'), { recursive: true })
  mkdirSync(join(dec, 'message'), { recursive: true })
  writeFileSync(join(dec, 'session', 'session.db'), 'hello backup')
  writeFileSync(join(dec, 'message', 'msg_0.db'), 'x'.repeat(4096))
  const e = await createEncryptedBackup(dec, 'pw123')
  entryName = e.name
})

afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* 下一条用例自己会报 */ }
})

describe('W2-8.4 恢复前的磁盘空间预检', () => {
  it('空间不够 ⇒ 明确报「差多少」，且一个字节都没落盘', () => {
    fsMock.mode = 'small'
    fsMock.freeBytes = 1024 // 1KB：连 64MB 的余量都过不去
    const r = restoreEncryptedBackup(dec, entryName, 'pw123')
    expect(r.ok, '空间不够却报告成功').toBe(false)
    expect(r.error).toContain('磁盘空间不足')
    // 报错里必须带上「需要多少 / 还剩多少」—— 只有一句 ENOSPC 用户没法判断要不要清盘。
    expect(r.error, '报错没说要多少、还剩多少').toMatch(/需要约 [\d.]+ GB/)
    expect(r.error).toMatch(/只剩 [\d.]+ GB/)
    const restored = join(base, 'backups', entryName.replace(/\.wcb$/, '') + '.restored')
    expect(existsSync(restored), '预检失败却已经建出了恢复目录（半成品留在盘上）').toBe(false)
  })

  it('预检自己失败（statfs EPERM）⇒ 放行，恢复照常成功', () => {
    fsMock.mode = 'throw'
    const r = restoreEncryptedBackup(dec, entryName, 'pw123')
    expect(r.ok, '预检失败被当成了阻塞点 —— 它只是「少踩坑」，不该把恢复功能堵死').toBe(true)
    expect(readFileSync(join(r.path as string, 'session', 'session.db'), 'utf8')).toBe('hello backup')
  })

  it('密码错误仍然报密码错误（预检不许抢在密码校验前面）', () => {
    fsMock.mode = 'small'
    fsMock.freeBytes = 1024
    const r = restoreEncryptedBackup(dec, entryName, 'wrong-pw')
    expect(r.ok).toBe(false)
    expect(r.error, '用户密码打错了，却被告知磁盘空间不足 —— 会把人引到完全错误的方向').toBe('密码错误或文件被篡改')
  })

  it('空间够 ⇒ 行为与预检之前完全一致', () => {
    const r = restoreEncryptedBackup(dec, entryName, 'pw123')
    expect(r.ok).toBe(true)
    expect(readFileSync(join(r.path as string, 'session', 'session.db'), 'utf8')).toBe('hello backup')
    expect(readFileSync(join(r.path as string, 'message', 'msg_0.db'), 'utf8').length).toBe(4096)
  })

  it('余量口径（明文很小 ⇒ 走 64MB 绝对下限）：差 1 字节就拦', () => {
    const plain = dirBytes(dec)
    const headroom = Math.max(64 * 1024 * 1024, Math.ceil(plain * 0.1))
    fsMock.mode = 'small'
    fsMock.freeBytes = plain + headroom - 1
    expect(restoreEncryptedBackup(dec, entryName, 'pw123').ok, '差 1 字节竟然放行了').toBe(false)
    fsMock.freeBytes = plain + headroom + 1
    expect(restoreEncryptedBackup(dec, entryName, 'pw123').ok, '刚过线却拦住了').toBe(true)
  })

  it('余量口径（明文够大 ⇒ 走 10% 比例），且预检发生在**读文件体之前**', () => {
    // 700MB 的明文：10% = 70MB > 64MB，所以比例分支生效。
    // 造一个**只有头、没有文件体**的 .wcb —— 于是：
    //   预检在正确位置 ⇒ 报「磁盘空间不足」；
    //   预检被挪到读文件体之后（或干脆没了）⇒ 报「备份文件读取被截断」。
    // 这条同时钉住了「预检不碰一个字节的数据」，也避免了为了凑 700MB 真去写 700MB 夹具。
    const fake = writeFakeWcb(base, 'fake700.wcb', 'pw123', [{ name: 'session/session.db', size: 700 * 1024 * 1024 }])
    fsMock.mode = 'small'
    fsMock.freeBytes = 700 * 1024 * 1024 + 64 * 1024 * 1024 // 少于 700 + 70MB
    const blocked = restoreEncryptedBackup(dec, fake, 'pw123')
    expect(blocked.ok).toBe(false)
    expect(blocked.error, '预检跑在读文件体之后了 ⇒ 白读一遍才开始报空间不够').toContain('磁盘空间不足')
    expect(blocked.error).not.toContain('截断')
    fsMock.freeBytes = 700 * 1024 * 1024 + 80 * 1024 * 1024 // 过了 10% 那道线
    const passed = restoreEncryptedBackup(dec, fake, 'pw123')
    expect(passed.error, '空间明明够，却仍被预检拦住').not.toContain('磁盘空间不足')
  })
})

/** 递归求一个目录里所有文件的字节和（与 `collectFiles` 的口径一致）。 */
function dirBytes(root: string): number {
  let total = 0
  for (const name of readdirSync(root)) {
    const abs = join(root, name)
    const st = statSync(abs)
    if (st.isDirectory()) total += dirBytes(abs)
    else total += st.size
  }
  return total
}

/**
 * 造一个「只有头、没有文件体」的 `.wcb`。
 *
 * 格式与 `createEncryptedBackup` 一致：MAGIC ‖ salt(16) ‖ headerLen(4BE) ‖ header ‖ HMAC-SHA256(key, header)。
 * 头里的分片大小是**声称值**，文件体一个字节都不写 —— 预检只看头，
 * 所以这足以覆盖 700MB 那条分支，而不用真造 700MB 的磁盘占用。
 * @param base - 临时根目录。
 * @param name - 备份文件名（落在 `<base>/backups` 下）。
 * @param password - 加密口令（MAC 要用同一个）。
 * @param files - 声称的文件清单（大小随便写，只有头会被读）。
 * @returns 备份文件名。
 */
function writeFakeWcb(base: string, name: string, password: string, files: Array<{ name: string; size: number }>): string {
  const dir = join(base, 'backups')
  mkdirSync(dir, { recursive: true })
  const salt = Buffer.alloc(16, 7)
  const headerBuf = Buffer.from(JSON.stringify({
    version: 1,
    files: files.map(f => ({ name: f.name, size: f.size, iv: Buffer.alloc(12, 3).toString('base64') })),
  }), 'utf8')
  const key = scryptSync(password, salt, 32)
  const mac = createHmac('sha256', key).update(headerBuf).digest()
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(headerBuf.length)
  writeFileSync(join(dir, name), Buffer.concat([Buffer.from('DSHWCB1\n', 'utf8'), salt, lenBuf, headerBuf, mac]))
  return name
}
/**
 * `snapshot-sidecars.ts#stageCopyRetry` 的行为守卫（2026-10-13，真机 EBUSY 实测）。
 *
 * 真机 75 秒观察抓到两次 staging 拷贝撞 EBUSY（解密快照正被在途查询的连接握着，
 * 毫秒级握手竞争），旧路径一撞就 `noteSyncFailure` 退避 10 秒 —— 一次毫秒级竞争
 * 赔上 10 秒新鲜度。重试语义必须钉住：
 *  · 一次成功 = 一次尝试、零等待；
 *  · 失败 N 次内重试、间隔 150ms（查询连接毫秒内就 close）；
 *  · 打满次数仍失败 ⇒ 把**最后一次**错误抛出去（退避口径不变，不吞错）。
 * 另含 sync.ts 的接线锚点：九处 staging 拷贝必须走这个助手（漏一处就是一处 10s 退避）。
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAGE_COPY_ATTEMPTS, stageCopyRetry, stageOpenRetry } from '../src/query/snapshot-sidecars.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('staging 拷贝的重试纪律（注入假 copy + 假时钟）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('一次成功 = 一次尝试、零等待', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)
    await stageCopyRetry('a', 'b', { copy, sleep })
    expect(copy).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('EBUSY 两次后成功 ⇒ 重试满 3 次、间隔 150ms，最终不抛', async () => {
    const copy = vi.fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValue(undefined)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const p = stageCopyRetry('a', 'b', { copy, sleep })
    await vi.advanceTimersByTimeAsync(STAGE_COPY_ATTEMPTS * 1000)
    await expect(p).resolves.toBeUndefined()
    expect(copy).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(150)
  })

  it('打满次数仍失败 ⇒ 抛出最后一次错误（不吞错，退避口径不变）', async () => {
    const last = new Error('EBUSY 第 3 次')
    const copy = vi.fn()
      .mockRejectedValueOnce(new Error('EBUSY 第 1 次'))
      .mockRejectedValueOnce(new Error('EBUSY 第 2 次'))
      .mockRejectedValueOnce(last)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const p = stageCopyRetry('a', 'b', { copy, sleep })
    const assertion = expect(p).rejects.toBe(last)
    await vi.advanceTimersByTimeAsync(STAGE_COPY_ATTEMPTS * 1000)
    await assertion
    expect(copy).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})

describe('staging 打开的重试纪律（stageOpenRetry，同一根因：刚写过的 staging 文件被瞬时独占）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('EBUSY 两次后成功 ⇒ 重试满 3 次，最终拿到句柄', async () => {
    const fh = { close: vi.fn() }
    const openFn = vi.fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValue(fh)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const p = stageOpenRetry('stage_wal', 'r+', { open: openFn, sleep })
    await vi.advanceTimersByTimeAsync(STAGE_COPY_ATTEMPTS * 1000)
    await expect(p).resolves.toBe(fh)
    expect(openFn).toHaveBeenCalledTimes(3)
    expect(openFn).toHaveBeenCalledWith('stage_wal', 'r+')
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('打满次数仍失败 ⇒ 抛出最后一次错误', async () => {
    const last = new Error('EBUSY 第 3 次')
    const openFn = vi.fn()
      .mockRejectedValueOnce(new Error('EBUSY 第 1 次'))
      .mockRejectedValueOnce(new Error('EBUSY 第 2 次'))
      .mockRejectedValueOnce(last)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const p = stageOpenRetry('stage_wal', 'r+', { open: openFn, sleep })
    const assertion = expect(p).rejects.toBe(last)
    await vi.advanceTimersByTimeAsync(STAGE_COPY_ATTEMPTS * 1000)
    await assertion
  })
})

describe('staging 拷贝的真文件冒烟', () => {
  it('真实文件一次拷成，内容一致', async () => {
    vi.useRealTimers()
    const dir = mkdtempSync(join(tmpdir(), 'wx-stage-'))
    scratch.push(dir)
    writeFileSync(join(dir, 'src.db'), 'payload-123')
    await stageCopyRetry(join(dir, 'src.db'), join(dir, 'dst.db'))
    expect(readFileSync(join(dir, 'dst.db'), 'utf8')).toBe('payload-123')
  })

  it('真实文件一次打开成功，句柄可读', async () => {
    vi.useRealTimers()
    const dir = mkdtempSync(join(tmpdir(), 'wx-stage-'))
    scratch.push(dir)
    writeFileSync(join(dir, 'src.db'), 'payload-456')
    const fh = await stageOpenRetry(join(dir, 'src.db'), 'r+')
    try {
      const buf = Buffer.alloc(11)
      await fh.read(buf, 0, 11, 0)
      expect(buf.toString('utf8')).toBe('payload-456')
    } finally {
      await fh.close()
    }
  })
})

describe('sync.ts 的接线（源码锚点）', () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/query/sync.ts'), 'utf8')

  it('哨兵：sync.ts 真的读到了（读空 ⇒ 下面的断言全恒真）', () => {
    expect(SRC.length).toBeGreaterThan(500)
  })

  it('十处 staging 拷贝全部走 stageCopyRetry（漏一处就是一处 10s 退避），copyFile 直用已移除', () => {
    const sites = (SRC.match(/await stageCopyRetry\(/g) ?? []).length
    expect(sites, 'staging 拷贝的接线点数量变了（应 10 处：1 rawWal + 5 target + 4 rawDb；tail 分支 2026-10-13 加了 1 处）').toBe(10)
    expect(SRC, '还有直接 copyFile 的 staging 拷贝').not.toContain('await copyFile(')
  })

  it('staging 打开全部走 stageOpenRetry（sync.ts 读源库/写产物 2 处 + sqlcipher-wal.ts WAL 补丁 1 处），open 直用已移除', () => {
    const sites = (SRC.match(/await stageOpenRetry\(/g) ?? []).length
    expect(sites, 'staging 打开的接线点数量变了（应 2 处：读源库 / 写产物；WAL 补丁句柄已随 2026-10-13 拆到 sqlcipher-wal.ts）').toBe(2)
    expect(SRC, '还有直接 open 的 staging 打开').not.toContain('await open(')
    const WAL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/query/sqlcipher-wal.ts'), 'utf8')
    expect(WAL.length, 'sqlcipher-wal.ts 没读到').toBeGreaterThan(500)
    expect((WAL.match(/await stageOpenRetry\(/g) ?? []).length, 'WAL 补丁句柄必须走 stageOpenRetry').toBe(1)
    expect(WAL, 'sqlcipher-wal.ts 还有直接 open').not.toContain('await open(')
  })
})

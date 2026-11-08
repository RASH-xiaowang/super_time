// @vitest-environment node
/**
 * 朋友圈视频 miss 负缓存的有效期。
 *
 * 微信会在已有月份/桶目录里继续写新文件，而这些目录的父级 mtime/size 可能不变。
 * 因此「本机没有」只能短时间成立；否则刚播放过的新视频会一直命中旧 miss，
 * 直到进程重启才恢复。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findLocalVideoPathAsync, snsVideoIndexForTest } from '../src/query/sns-video.ts'

const scratch: string[] = []

afterEach(() => {
  vi.useRealTimers()
  snsVideoIndexForTest().clear()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

beforeEach(() => {
  snsVideoIndexForTest().clear()
})

describe('朋友圈视频 miss 负缓存', () => {
  it('已有桶目录新增视频时，TTL 到期后无需重启即可命中', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))

    const base = mkdtempSync(join(tmpdir(), 'wx-sns-video-miss-'))
    scratch.push(base)
    const monthRoot = join(base, 'cache', '2026-11', 'Sns', 'Video')
    const bucket = join(monthRoot, 'ab')
    mkdirSync(bucket, { recursive: true })
    writeFileSync(join(bucket, 'unrelated.jpg'), Buffer.from('not-the-target'))

    const video = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypisom', 'latin1'),
      Buffer.alloc(256, 0x5a),
    ])
    const md5 = createHash('md5').update(video).digest('hex')
    const signatureBefore = statSync(monthRoot).mtimeMs

    const first = await findLocalVideoPathAsync(base, md5)
    expect(first.path).toBeUndefined()
    expect(first.error).toContain('本机缓存里没有这条视频')

    writeFileSync(join(bucket, md5 + '.mp4'), video)
    expect(statSync(monthRoot).mtimeMs, '用例前提：新增子目录文件不改变父目录签名').toBe(signatureBefore)

    vi.setSystemTime(new Date('2026-11-02T00:00:10Z'))
    const withinTtl = await findLocalVideoPathAsync(base, md5)
    expect(withinTtl.path, 'TTL 内应复用 miss，避免每次未命中都重扫整月').toBeUndefined()

    vi.setSystemTime(new Date('2026-11-02T00:00:31Z'))
    const afterTtl = await findLocalVideoPathAsync(base, md5)
    expect(afterTtl.path, 'TTL 到期后必须重新扫描并发现新增视频').toBeDefined()
  })
})

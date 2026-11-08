/**
 * @vitest-environment node
 *
 * MD5-only 视频回落：撤回记录没有 session_username/local_id 时，仍应能用
 * media.md5 在真实微信 `msg/video/<YYYY-MM>/` 下找到封面与实体。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveVideoInfo } from '../src/query/media-video.ts'

const MD5 = '0123456789abcdef0123456789abcdef'
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function makeRoot(tag: string): { decrypted: string; decoded: string; raw: string } {
  const root = mkdtempSync(join(tmpdir(), `wx-video-md5-${tag}-`))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  const decoded = join(root, 'decoded')
  const raw = join(root, 'raw')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
  mkdirSync(raw, { recursive: true })
  return { decrypted, decoded, raw }
}

function putVideoArtifacts(raw: string, month: string, cover: Buffer, body: Buffer): void {
  const dir = join(raw, 'msg', 'video', month)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${MD5}_thumb.jpg`), cover)
  writeFileSync(join(dir, `${MD5}.mp4`), body)
}

/** packed_info 的 st_control 逗号分隔字节文本形式。 */
function packedHex(hex: string): string {
  return Array.from(Buffer.from(hex, 'utf8')).join(',')
}

function putMessage(
  decrypted: string,
  shard: string,
  username: string,
  localId: number,
  md5: string,
): void {
  const dir = join(decrypted, 'message')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, shard))
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  try {
    db.exec(`CREATE TABLE "${table}" (local_id INTEGER, local_type INTEGER, packed_info_data TEXT)`)
    db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`).run(localId, 43, packedHex(md5))
  } finally {
    db.close()
  }
}

describe('resolveVideoInfo：MD5-only 回落', () => {
  it('没有 username/localId 时按 MD5 找到真实 msg/video 封面与实体', () => {
    const root = makeRoot('hit')
    putVideoArtifacts(root.raw, '2026-10', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('video-body'))

    const r = resolveVideoInfo(root.decrypted, root.decoded, '', 0, root.raw, MD5)
    expect(r.md5).toBe(MD5)
    expect(r.available).toBe(true)
    expect(r.coverUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(r.videoPath).toBe(join(root.raw, 'msg', 'video', '2026-10', `${MD5}.mp4`))
    expect(r.error).toBeUndefined()
  })

  it('MD5 大小写与空白被归一化', () => {
    const root = makeRoot('case')
    putVideoArtifacts(root.raw, '2026-10', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('video-body'))
    const r = resolveVideoInfo(root.decrypted, root.decoded, '', 0, root.raw, `  ${MD5.toUpperCase()}  `)
    expect(r.available).toBe(true)
    expect(r.md5).toBe(MD5)
  })

  it('没有任何定位键且 MD5 非法时给出可读错误，不崩溃', () => {
    const root = makeRoot('invalid')
    const r = resolveVideoInfo(root.decrypted, root.decoded, '', 0, root.raw, 'not-an-md5')
    expect(r.available).toBe(false)
    expect(r.error).toBe('缺少视频 MD5 或消息定位信息')
  })

  it('只有 MD5 但本机没有缓存时明确说明封面与实体缺失', () => {
    const root = makeRoot('miss')
    const r = resolveVideoInfo(root.decrypted, root.decoded, '', 0, root.raw, MD5)
    expect(r.available).toBe(false)
    expect(r.md5).toBe(MD5)
    expect(r.error).toContain('在微信里打开一次')
  })

  it('带 username/localId 时只从目录索引定位到的分片读取 MD5', () => {
    const root = makeRoot('locator')
    const username = 'wxid_video'
    putMessage(root.decrypted, 'message_0.db', 'unrelated', 1, 'ffffffffffffffffffffffffffffffff')
    putMessage(root.decrypted, 'message_8.db', username, 7, MD5)
    putVideoArtifacts(root.raw, '2026-10', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('video-body'))

    const r = resolveVideoInfo(root.decrypted, root.decoded, username, 7, root.raw)
    expect(r.md5).toBe(MD5)
    expect(r.available).toBe(true)
    expect(r.videoPath).toBe(join(root.raw, 'msg', 'video', '2026-10', `${MD5}.mp4`))
  })

  it('同一月份后来落盘的封面与实体能在下一次请求中看到', () => {
    const root = makeRoot('refresh')
    const month = join(root.raw, 'msg', 'video', '2026-10')
    mkdirSync(month, { recursive: true })
    writeFileSync(join(month, 'unrelated.txt'), 'x')

    const first = resolveVideoInfo(root.decrypted, root.decoded, '', 0, root.raw, MD5)
    expect(first.available).toBe(false)

    putVideoArtifacts(root.raw, '2026-10', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('video-body'))
    const second = resolveVideoInfo(root.decrypted, root.decoded, '', 0, root.raw, MD5)
    expect(second.available).toBe(true)
    expect(second.videoPath).toBe(join(month, `${MD5}.mp4`))
  })
})

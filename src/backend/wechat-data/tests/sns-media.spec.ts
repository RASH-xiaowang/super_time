/**
 * Offline SNS media resolution: V2-encrypted image blobs under
 * cache/<month>/Sns/Img and plain JPEG covers under Sns/Video / msg/video.
 * @vitest-environment node
 */
import { createCipheriv, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSnsImageDataUrl } from '../src/query/sns-image.ts'
import { resolveSnsVideoCoverDataUrl } from '../src/query/sns-video.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

const AES_KEY = '0123456789abcdef'
const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48])

/** Write one V2-encrypted blob (magic + aes size + xor size + AES padded block). */
function writeV2(path: string, plaintext: Buffer): void {
  const padded = Buffer.concat([plaintext, Buffer.alloc(16, 0x10)])
  const cipher = createCipheriv('aes-128-ecb', AES_KEY, null)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  const buf = Buffer.alloc(15 + encrypted.length)
  buf.set(Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]), 0)
  buf.writeUInt32LE(plaintext.length, 6)
  buf.writeUInt32LE(0, 10)
  encrypted.copy(buf, 15)
  writeFileSync(path, buf)
}

describe('resolveSnsImageDataUrl', () => {
  it('decodes a V2 SNS image blob located by the timeline+media cache key', () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-snsimg-'))
    scratch.push(base)
    const timelineId = '123456789'
    const mediaId = '987654321'
    const hash = createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex')
    const dir = join(base, 'cache', '2026-08', 'Sns', 'Img', hash.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeV2(join(dir, hash.slice(2)), JPEG_HEADER)

    const md5 = createHash('md5').update(JPEG_HEADER).digest('hex')
    const r = resolveSnsImageDataUrl(base, AES_KEY, 0x60, md5, timelineId, mediaId)
    expect(r.url).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('finds a V2 blob by plaintext md5 index when the cache-key hash path misses', () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-snsimg2-'))
    scratch.push(base)
    const timelineId = 'no-hash-hit'
    const mediaId = 'no-hash-hit'
    // Filename deliberately unrelated to timeline/media hash: forces md5 index.
    const indexFile = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const dir = join(base, 'cache', '2026-08', 'Sns', 'Img', indexFile.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeV2(join(dir, indexFile.slice(2)), JPEG_HEADER)

    const md5 = createHash('md5').update(JPEG_HEADER).digest('hex')
    const r = resolveSnsImageDataUrl(base, AES_KEY, 0x60, md5, timelineId, mediaId)
    expect(r.url).toMatch(/^data:image\/jpeg;base64,/)
  })
})

describe('resolveSnsVideoCoverDataUrl', () => {
  it('reads the plain jpg cover under cache/<month>/Sns/Video', () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-snsvid-'))
    scratch.push(base)
    const timelineId = 'v_timeline'
    const mediaId = 'v_media'
    const hash = createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex')
    const dir = join(base, 'cache', '2026-08', 'Sns', 'Video', hash.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, hash.slice(2) + '.jpg'), JPEG_HEADER)

    const r = resolveSnsVideoCoverDataUrl(base, undefined, timelineId, mediaId)
    expect(r.url).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('falls back to msg/video/<md5>_thumb.jpg when the Sns cover is absent', () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-snsvid2-'))
    scratch.push(base)
    const md5 = createHash('md5').update('thumb-bytes').digest('hex')
    const dir = join(base, 'msg', 'video', '2025-11')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, md5 + '_thumb.jpg'), JPEG_HEADER)

    const r = resolveSnsVideoCoverDataUrl(base, md5)
    expect(r.url).toMatch(/^data:image\/jpeg;base64,/)
  })
})

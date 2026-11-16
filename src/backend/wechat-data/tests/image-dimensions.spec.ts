/**
 * 朋友圈原图尺寸判定的格式覆盖。
 *
 * 真机归档里混着 200x300 / 150x150 预览图，而原图可能是 JPEG、PNG、WebP、
 * GIF、BMP 或 HEIC/AVIF。这里用最小合法容器头验证：
 *   · 各格式都能读出宽高；
 *   · HEIC/AVIF 取面积最大的 `ispe`（缩略图属性先出现时不能赢）；
 *   · XML 尺寸按长短边比较，支持横竖旋转与 15% 容差；
 *   · 读不出尺寸时只按字节数做保守兜底，不假装知道分辨率。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  SNS_ORIGINAL_DIMENSION_TOLERANCE,
  compareSnsOriginalQuality,
  evaluateSnsOriginal,
  readImageDimensions,
} from '../src/query/image-dimensions.ts'

function jpeg(width: number, height: number, body = 32): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.alloc(body, 0x11),
    Buffer.from([0xff, 0xd9]),
  ])
}

function png(width: number, height: number, body = 16): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr, Buffer.alloc(body, 0x22)])
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(16, 0x33)
  bytes.write('GIF89a', 0, 'latin1')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

function bmp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32, 0x44)
  bytes.write('BM', 0, 'latin1')
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  return bytes
}

function writeU24LE(bytes: Buffer, at: number, value: number): void {
  bytes[at] = value & 0xff
  bytes[at + 1] = (value >>> 8) & 0xff
  bytes[at + 2] = (value >>> 16) & 0xff
}

function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32, 0x55)
  bytes.write('RIFF', 0, 'latin1')
  bytes.writeUInt32LE(24, 4)
  bytes.write('WEBP', 8, 'latin1')
  bytes.write('VP8X', 12, 'latin1')
  bytes.writeUInt32LE(10, 16)
  writeU24LE(bytes, 24, width - 1)
  writeU24LE(bytes, 27, height - 1)
  return bytes
}

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

function ispe(width: number, height: number): Buffer {
  const payload = Buffer.alloc(12)
  payload.writeUInt32BE(width, 4)
  payload.writeUInt32BE(height, 8)
  return box('ispe', payload)
}

/** 造一个带两个 `ispe` 的 AVIF：缩略图属性在前，主图属性在后。 */
function avif(width: number, height: number, thumbWidth = 316, thumbHeight = 420): Buffer {
  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(24, 0)
  ftyp.write('ftyp', 4, 'latin1')
  ftyp.write('avif', 8, 'latin1')
  ftyp.write('mif1', 16, 'latin1')
  const ipco = box('ipco', Buffer.concat([ispe(thumbWidth, thumbHeight), ispe(width, height)]))
  const iprp = box('iprp', ipco)
  const meta = box('meta', Buffer.concat([Buffer.alloc(4), iprp]))
  return Buffer.concat([ftyp, meta])
}

function unknownImage(bytes = 256): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(Math.max(0, bytes - 12), 0x66),
  ])
}

describe('readImageDimensions：常见图片容器', () => {
  it('读 JPEG SOF、PNG IHDR、GIF 逻辑屏、BMP DIB、WebP VP8X', () => {
    expect(readImageDimensions(jpeg(1440, 1920))).toEqual({ width: 1440, height: 1920 })
    expect(readImageDimensions(png(1440, 1920))).toEqual({ width: 1440, height: 1920 })
    expect(readImageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480 })
    expect(readImageDimensions(bmp(800, 600))).toEqual({ width: 800, height: 600 })
    expect(readImageDimensions(webp(1024, 768))).toEqual({ width: 1024, height: 768 })
  })

  it('HEIC/AVIF 取最大的 ispe，不能把先出现的缩略图当原图', () => {
    expect(readImageDimensions(avif(1440, 1920))).toEqual({ width: 1440, height: 1920 })
    expect(readImageDimensions(avif(4032, 3024, 200, 300))).toEqual({ width: 4032, height: 3024 })
  })

  it('头部残缺或格式不认识时返回 null（不猜）', () => {
    expect(readImageDimensions(Buffer.alloc(8))).toBeNull()
    expect(readImageDimensions(unknownImage(64))).toBeNull()
    expect(readImageDimensions(Buffer.alloc(64, 0x5a))).toBeNull()
  })
})

describe('evaluateSnsOriginal：按 XML <size> 判定', () => {
  const expected = { width: 1440, height: 1920 }

  it('JPEG / PNG 达到期望尺寸即接受', () => {
    expect(evaluateSnsOriginal(jpeg(1440, 1920), expected).accepted).toBe(true)
    expect(evaluateSnsOriginal(png(1440, 1920), expected).accepted).toBe(true)
  })

  it('横竖旋转按长短边比较，15% 容差边界内接受', () => {
    expect(evaluateSnsOriginal(jpeg(1920, 1440), expected).accepted).toBe(true)
    const minLong = Math.ceil(1920 * SNS_ORIGINAL_DIMENSION_TOLERANCE)
    const minShort = Math.ceil(1440 * SNS_ORIGINAL_DIMENSION_TOLERANCE)
    expect(evaluateSnsOriginal(jpeg(minShort, minLong), expected).accepted).toBe(true)
    expect(evaluateSnsOriginal(jpeg(minShort - 1, minLong), expected).accepted).toBe(false)
    expect(evaluateSnsOriginal(jpeg(minShort, minLong - 1), expected).accepted).toBe(false)
  })

  it('没有 XML 尺寸时，已知的 200x300 预览图仍被下限拒绝', () => {
    const small = evaluateSnsOriginal(jpeg(200, 300))
    expect(small.accepted).toBe(false)
    expect(small.reason).toContain('200x300')
  })

  it('读不出尺寸时，只有字节数达到 XML 声明的一半才放行（legacy 兼容）', () => {
    const short = evaluateSnsOriginal(unknownImage(256), { width: 1440, height: 1920, bytes: 1024 })
    expect(short.accepted).toBe(false)
    expect(short.dimensionsKnown).toBe(false)
    expect(short.reason).toContain('不足 XML 声明')

    const legacy = evaluateSnsOriginal(unknownImage(256), { width: 1440, height: 1920 })
    expect(legacy.accepted).toBe(true)
    expect(legacy.reason).toContain('legacy')
  })
})

describe('compareSnsOriginalQuality：已知尺寸优先于未知，面积优先于字节', () => {
  it('1440x1920 的高清图胜过字节更多的 200x300 预览图', () => {
    const high = { width: 1440, height: 1920, bytes: 100 }
    const preview = { width: 200, height: 300, bytes: 10_000 }
    expect(compareSnsOriginalQuality(high, preview)).toBeGreaterThan(0)
    expect(compareSnsOriginalQuality(preview, high)).toBeLessThan(0)
  })

  it('尺寸未知的候选不能靠字节数压过已知尺寸的原图', () => {
    expect(compareSnsOriginalQuality(
      { bytes: 1_000_000 },
      { width: 200, height: 300, bytes: 100 },
    )).toBeLessThan(0)
  })
})

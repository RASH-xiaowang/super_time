/**
 * `wxgf-ffmpeg.ts` 的行为守卫（2026-10-13，移植自 WeChatDataAnalysis 的
 * `tests/test_media_wxgf_ffmpeg_fallback.py` 测试矩阵）。
 *
 * 这一族决定「微信解码库不可用时，wxgf 高清原图还能不能靠 ffmpeg 解出全分辨率 JPEG」。
 * 坏形状都是**静默**的：
 *  · 分区长度不校验 ⇒ 残缺的码流交给解码器，产出坏图被当有效结果缓存；
 *  · 单帧判定放水 ⇒ 多帧动图被解成第一帧（用户拿到静态图当动图）；
 *  · 透明度检查被拿掉 ⇒ 带透明的 wxgf 解成不透明 JPEG（数据丢失被静默吞掉）；
 *  · 内容缓存被拿掉 ⇒ 同一份 wxgf 反复起 ffmpeg（每次 1–2 秒的进程成本）。
 * 夹具：合成 wxgf（起始码 + VPS + 4 字节大端长度前缀）+ 注入假 spawn（不依赖真 ffmpeg）。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WXGF_MAX_NAL_UNITS,
  findFfmpegExecutable,
  hevcPictureCount,
  transcodeWxgfWithFfmpeg,
  wxgfHevcPartitions,
  type WxgfFfmpegSpawn,
} from '../src/query/wxgf-ffmpeg.ts'
import { jpegDimensions } from '../src/query/jpeg-dimensions.ts'

const VPS = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x40, 0x01])
const IDR = Buffer.from([0x00, 0x00, 0x01, 0x26, 0x01, 0x80])
const JPEG = ((): Buffer => {
  // 极简 JPEG（SOF0 带 32×16 尺寸 + EOI）：jpegDimensions 与魔数检查都能过。
  const buf = Buffer.alloc(32)
  buf.write('FFD8', 0, 'hex')
  buf[2] = 0xff
  buf[3] = 0xc0
  buf[4] = 0x00
  buf[5] = 0x11
  buf[6] = 0x08
  buf.writeUInt16BE(16, 7)
  buf.writeUInt16BE(32, 9)
  buf[18] = 0xff
  buf[19] = 0xd9
  return buf
})()

const buf = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

/** 一段「VPS + N 个 IDR 图」的 HEVC 码流。 */
function hevc(pictures: number): Buffer {
  return Buffer.concat([VPS, ...Array.from({ length: pictures }, () => IDR)])
}

/** 合成 wxgf：头 + 若干「4 字节大端长度 + 分区」；尾随容器字节。 */
function wxgf(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts.map((p) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(p.length, 0)
    return Buffer.concat([len, p])
  }))
  return Buffer.concat([Buffer.from('wxgf', 'latin1'), Buffer.from([0x13, 0x00, 0x02, 0x00]), body, Buffer.from([0x00, 0x00])])
}

/** 假 spawn：按命令里是否带 mjpeg 区分画面/alpha 输出。 */
function fakeSpawn(opts: { picture?: Buffer; alpha?: Buffer; fail?: boolean } = {}): WxgfFfmpegSpawn {
  return (exe, args, input, timeoutMs) => {
    if (opts.fail) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('decode error') }
    const isAlpha = args.includes('gray')
    const out = isAlpha ? (opts.alpha ?? Buffer.alloc(16, 0xff)) : (opts.picture ?? JPEG)
    return { status: 0, stdout: out, stderr: Buffer.alloc(0) }
  }
}

const deps = (spawn: WxgfFfmpegSpawn) => ({ spawn, findExe: () => 'ffmpeg.exe', useCache: false })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HEVC 分区与图数（纯判定）', () => {
  it('按「起始码 + VPS」切分，长度前缀对不上则整体放弃', () => {
    const parts = wxgfHevcPartitions(buf(wxgf(hevc(1))))
    expect(parts.length).toBe(1)
    expect(parts[0]!.length).toBe(hevc(1).length)
    // 截断长度前缀：整个放弃
    const broken = wxgf(hevc(1))
    broken[8] = 0xff
    expect(wxgfHevcPartitions(buf(broken))).toEqual([])
    // 三个分区超上限
    expect(wxgfHevcPartitions(buf(wxgf(hevc(1), hevc(1), hevc(1))))).toEqual([])
  })

  it('图数：VCL NAL 且 first_slice 位为 1 才计数；NAL 超上限按多帧处理', () => {
    expect(hevcPictureCount(buf(hevc(1)))).toBe(1)
    expect(hevcPictureCount(buf(hevc(3)))).toBe(3)
    expect(hevcPictureCount(buf(VPS))).toBe(0)
    const unit = Buffer.from([0x00, 0x00, 0x01, 0x4e, 0x01])
    const flood = Buffer.concat([Buffer.concat(Array.from({ length: WXGF_MAX_NAL_UNITS + 1 }, () => unit)), hevc(1)])
    expect(hevcPictureCount(buf(flood)), 'NAL 超上限必须按多帧拒掉').toBeGreaterThanOrEqual(2)
  })
})

describe('ffmpeg 兜底（注入假 spawn）', () => {
  it('没有 ffmpeg ⇒ 失败原因说清楚，不抛', () => {
    const r = transcodeWxgfWithFfmpeg(buf(wxgf(hevc(1))), { spawn: fakeSpawn(), findExe: () => '', useCache: false })
    expect('error' in r && r.error).toContain('未找到 ffmpeg')
  })

  it('单帧不透明 wxgf ⇒ 解出 JPEG（宽高从 SOF 读出来）', () => {
    const r = transcodeWxgfWithFfmpeg(buf(wxgf(hevc(1))), deps(fakeSpawn()))
    expect('bytes' in r, JSON.stringify(r)).toBe(true)
    if ('bytes' in r) {
      expect(jpegDimensions(r.bytes)).toEqual({ width: 32, height: 16 })
      expect(r.jpegWidth).toBe(32)
    }
  })

  it('带 alpha 分区且全不透明 ⇒ 解出画面分区', () => {
    const r = transcodeWxgfWithFfmpeg(buf(wxgf(hevc(1), hevc(1))), deps(fakeSpawn()))
    expect('bytes' in r).toBe(true)
  })

  it('带透明度（alpha 不全 0xFF）⇒ 拒解，不缓存降级画面', () => {
    const r = transcodeWxgfWithFfmpeg(buf(wxgf(hevc(1), hevc(1))), deps(fakeSpawn({ alpha: Buffer.alloc(16, 0xfe) })))
    expect('error' in r && r.error).toContain('透明度')
  })

  it('多帧动图 ⇒ 拒解（单帧 JPEG 表达不了）', () => {
    const r = transcodeWxgfWithFfmpeg(buf(wxgf(hevc(3))), deps(fakeSpawn()))
    expect('error' in r && r.error).toContain('单帧')
  })

  it('没有可解码分区 / 乱码载荷 ⇒ 不起进程、失败原因明确', () => {
    for (const payload of [Buffer.from('wxgf'), Buffer.from([0x00, 0x01, 0x02, 0x03])]) {
      const spawn = fakeSpawn()
      const spy = vi.fn(spawn)
      const r = transcodeWxgfWithFfmpeg(buf(payload), { spawn: spy, findExe: () => 'ffmpeg.exe', useCache: false })
      expect('error' in r).toBe(true)
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('ffmpeg 失败 ⇒ 返回错误、不抛（调用方继续走缩略图回退）', () => {
    const r = transcodeWxgfWithFfmpeg(buf(wxgf(hevc(1))), deps(fakeSpawn({ fail: true })))
    expect('error' in r).toBe(true)
  })

  it('内容缓存：同一份载荷只起一次 ffmpeg（失败也缓存）', () => {
    const spawn = vi.fn(fakeSpawn())
    const d = { spawn, findExe: () => 'ffmpeg.exe', useCache: true }
    const payload = buf(wxgf(hevc(1)))
    const r1 = transcodeWxgfWithFfmpeg(payload, d)
    const r2 = transcodeWxgfWithFfmpeg(payload, d)
    expect('bytes' in r1 && 'bytes' in r2).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('ffmpeg 定位', () => {
  it('DSH_WECHAT_FFMPEG 指向存在的文件时用它（排障/测试的逃生口）', () => {
    const prev = process.env.DSH_WECHAT_FFMPEG
    process.env.DSH_WECHAT_FFMPEG = process.execPath
    try {
      expect(findFfmpegExecutable()).toBe(process.execPath)
    } finally {
      if (prev === undefined) delete process.env.DSH_WECHAT_FFMPEG
      else process.env.DSH_WECHAT_FFMPEG = prev
    }
  })
})

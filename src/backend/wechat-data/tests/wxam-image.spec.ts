/**
 * wxgf 转码（调微信安装目录的解码库）+ 与之同批的**档位排序**。
 *
 * 为什么这两件事写在一个文件里：它们是**同一条链**。`_h` 原图档里 37%（本机 361/971）是
 * wxgf —— 没有转码能力时把 `_h` 排到最前，等于用解不开的高清**挡住**能渲染的聊天版，
 * 净效果比不改还差。所以排序与转码必须一起成立，守卫也一起写在这里。
 *
 * 这条链上最容易坏、又坏得静默的四件事：
 *   ① **第 5 个参数（输出结构指针）必须有效**：反汇编结论是它被无条件解引用（读 [rax] 与
 *      [rax+0x10]），传 NULL 必然访问违规、直接带走进程 —— 原生崩溃 try/catch 拦不住。
 *   ② 输出**带 24 字节 trailer**，必须截断到最后一个 `FF D9`，否则 JPEG 没有 EOI。
 *   ③ 转码失败**必须退回 `hevc`** 而不是把原始 wxgf 字节当成图片返回（那会让界面拿到
 *      一个「浏览器渲染不了但代码以为成功」的 data URL）。
 *   ④ 档位排序：`_h`(原图) 优先于主体 `.dat`，`_t` 进缩略槽；**不认识的 `_x` 后缀必须
 *      排最后** —— 旧实现「不认识就当最好的」，一旦有人给 `_b.dat`（气泡图）加上候选路径，
 *      气泡图会顶掉原图。
 *
 * 用例**不依赖本机装没装微信**：真 DLL 只在 `DSH_WECHAT_VOIP_ENGINE` 指向真实文件时才会被
 * 加载（这里不指），其余全部走 `createWxgfTranscoder(替身)`。
 * @vitest-environment node
 */
import { createCipheriv } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { at } from '../../tests/helpers/strict-index.ts'
import { decryptAllImageDats } from '../src/query/decrypt-images.ts'
import { datTierOf, datTierRank, decodeDatBytes, isThumbTier } from '../src/query/media-image.ts'
import {
  createWxgfTranscoder,
  isWxgfTranscodeAvailable,
  jpegDimensions,
  resolveVoipEnginePath,
  type WxgfNative,
  type WxgfTranscoder,
} from '../src/query/wxam-image.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 剥掉块注释后再断言：解释「为什么不这么做」的注释里会原样出现被禁的符号名。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 已删 */ } }
})

/** V2 魔数（与实现里的常量一致；这里显式写出来，免得改实现时两边一起动而没被发现）。 */
const V2_MAGIC = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07]

/** 一段最小可解析的 JPEG：SOI + SOF0(16×32) + EOI。 */
function tinyJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
}

/**
 * 造一份**真实布局**的 V2 `.dat`：魔数 + aesSize/xorSize + 标志位 + AES 段 + XOR 尾。
 *
 * 细节对齐实现：`alignedAesBlockSize(1024)` 是 1040（1024 % 16 === 0 → +16），也就是说
 * 实现会把 AesSize 之后那 16 字节**一起**当 AES 块读进来、再靠 PKCS7 去掉 —— 所以这里把
 * 末 16 字节构造成 `0x10 × 16` 的合法填充，等价于真实文件里那段分隔尾。
 */
function makeV2Dat(plain: Buffer, aesKey: string, xorKey: number): Uint8Array {
  const aesSize = 1024
  const head = Buffer.alloc(aesSize + 16, 0)
  plain.subarray(0, aesSize).copy(head)
  head.fill(0x10, aesSize) // 合法 PKCS7 填充（16 字节全 0x10）
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii'), null)
  cipher.setAutoPadding(false)
  const ct = Buffer.concat([cipher.update(head), cipher.final()])
  const tailPlain = plain.subarray(aesSize)
  const tail = Buffer.from(tailPlain).map(b => b ^ xorKey)
  const meta = Buffer.alloc(15)
  V2_MAGIC.forEach((b, i) => { meta[i] = b })
  meta.writeUInt32LE(aesSize, 6)
  meta.writeUInt32LE(tail.length, 10)
  meta[14] = 0x01
  return Buffer.concat([meta, ct, tail])
}

/** 一段 wxgf 载荷（魔数 + 若干字节），够 `decodeDatBytes` 认出 wxgf。 */
function wxgfPayload(size = 2048): Buffer {
  const b = Buffer.alloc(size, 0x5a)
  b.write('wxgf', 0, 'latin1')
  return b
}

const AES_KEY = 'f3aa7c698e166e83'
const XOR_KEY = 0x88

/** 假原生库：把构造好的 JPEG（可选带 trailer）写进输出缓冲。 */
function fakeNative(
  jpeg: Buffer,
  opts: { trailer?: number; ret?: number; reportSize?: number; seen?: Array<{ outLen: number; opt: Buffer }> } = {},
): WxgfNative {
  const trailer = opts.trailer ?? 0
  return {
    label: 'fake',
    run(input, output, outSize, opt) {
      opts.seen?.push({ outLen: output.length, opt: Buffer.from(opt) })
      const body = Buffer.concat([jpeg, Buffer.alloc(trailer, 0x00)])
      if (body.length <= output.length) body.copy(output, 0)
      const size = opts.reportSize ?? body.length
      outSize.writeInt32LE(size, 0)
      return { ret: opts.ret ?? 0, size }
    },
  }
}

describe('wxgf 转码：解码库的定位与可用性', () => {
  it('① 环境变量指向不存在的 DLL 时定位为空（不抛、不回落去查注册表）', () => {
    const prev = process.env.DSH_WECHAT_VOIP_ENGINE
    process.env.DSH_WECHAT_VOIP_ENGINE = join(tmpdir(), 'definitely-not-here', 'VoipEngine.dll')
    try {
      expect(resolveVoipEnginePath()).toBe('')
    } finally {
      if (prev === undefined) delete process.env.DSH_WECHAT_VOIP_ENGINE
      else process.env.DSH_WECHAT_VOIP_ENGINE = prev
    }
  })

  it('② 环境变量指向真实文件时就用它（排障/测试的逃生口）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxgf-dll-'))
    dirs.push(dir)
    const dll = join(dir, 'VoipEngine.dll')
    writeFileSync(dll, 'not-a-real-dll')
    const prev = process.env.DSH_WECHAT_VOIP_ENGINE
    process.env.DSH_WECHAT_VOIP_ENGINE = dll
    try {
      expect(resolveVoipEnginePath()).toBe(dll)
    } finally {
      if (prev === undefined) delete process.env.DSH_WECHAT_VOIP_ENGINE
      else process.env.DSH_WECHAT_VOIP_ENGINE = prev
    }
  })

  it('③ 开关 DSH_WECHAT_WXGF=0 时能力判为不可用，且立刻生效（不缓存开关状态）', () => {
    const prev = process.env.DSH_WECHAT_WXGF
    process.env.DSH_WECHAT_WXGF = '0'
    try {
      expect(isWxgfTranscodeAvailable()).toBe(false)
      // 关掉之后转码器也只能报错，不能抛。
      const r = createWxgfTranscoder()(wxgfPayload())
      expect('error' in r, '关掉开关时必须返回 error 而不是抛').toBe(true)
      expect('error' in r ? r.error : '').toContain('关闭')
    } finally {
      if (prev === undefined) delete process.env.DSH_WECHAT_WXGF
      else process.env.DSH_WECHAT_WXGF = prev
    }
  })

  it('④ 传 null 强制不可用：返回 error，绝不抛', () => {
    const t = createWxgfTranscoder(null)
    const r = t(wxgfPayload())
    expect('error' in r).toBe(true)
    expect(t(Buffer.alloc(0))).toMatchObject({ error: expect.any(String) as unknown as string })
  })
})

describe('wxgf 转码：DLL 契约与边界', () => {
  it('⑤ 输出结构指针必须 ≥0x20 字节且全零，并且每次调用都真的传了它', () => {
    const seen: Array<{ outLen: number; opt: Buffer }> = []
    const jpeg = tinyJpeg(32, 16)
    const t = createWxgfTranscoder(fakeNative(jpeg, { seen }))
    const r = t(wxgfPayload())
    expect('bytes' in r).toBe(true)
    const call = at(seen, 0, '原生调用记录')
    expect(call.opt.length, '反汇编结论：该结构被解引用 ≥0x20 字节').toBeGreaterThanOrEqual(0x20)
    expect([...call.opt].every(b => b === 0), '必须是有效的全零结构（传 NULL 会崩进程）').toBe(true)
  })

  it('⑥ 截断到最后一个 FFD9（DLL 输出带 trailer，不截就没有 EOI）', () => {
    const jpeg = tinyJpeg(32, 16)
    const t = createWxgfTranscoder(fakeNative(jpeg, { trailer: 24 }))
    const r = t(wxgfPayload())
    if (!('bytes' in r)) throw new Error('应当转码成功：' + r.error)
    expect(r.bytes.length).toBe(jpeg.length)
    expect([...r.bytes.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(r.jpegWidth).toBe(32)
    expect(r.jpegHeight).toBe(16)
  })

  it('⑦ 输出里没有 FFD9 判失败（写出去也是坏图）', () => {
    const t = createWxgfTranscoder(fakeNative(Buffer.from('wxgf-not-a-jpeg-at-all')))
    const r = t(wxgfPayload())
    expect('error' in r && r.error).toContain('FFD9')
  })

  it('⑧ 前两次失败会顶到上限再试，第三次换 mode 3（2026-10-13 移植自参考项目）', () => {
    const seen: Array<{ outLen: number; opt: Buffer }> = []
    const jpeg = tinyJpeg(32, 16)
    // 注入 null 关闭 ffmpeg 兜底：本用例只关心 DLL 的尝试节奏
    const t = createWxgfTranscoder(fakeNative(jpeg, { ret: 1, seen }), null)
    const r = t(wxgfPayload())
    expect('error' in r).toBe(true)
    expect(seen.length, '应当重试两次（共三次调用）').toBe(3)
    expect(at(seen, 1).outLen, '第二次的缓冲必须更大').toBeGreaterThan(at(seen, 0).outLen)
    expect(at(seen, 2).outLen, '第三次直接顶到上限').toBe(at(seen, 1).outLen)
    expect(at(seen, 2).opt.readInt32LE(0), '第三次必须换 mode 3（参考项目实测有变体只认它）').toBe(3)
    expect(at(seen, 0).opt.readInt32LE(0), '前两次保持 mode 0').toBe(0)
  })

  it('⑧b 原生报告长度超过当前缓冲时先扩容重试，不截断出坏 JPEG', () => {
    const seen: number[] = []
    const jpeg = tinyJpeg(32, 16)
    const overflowThenFits: WxgfNative = {
      label: 'fake-overflow-retry',
      run(input, output, outSize) {
        seen.push(output.length)
        if (output.length < 64 * 1024 * 1024) {
          const reported = 5 * 1024 * 1024
          outSize.writeInt32LE(reported, 0)
          return { ret: 0, size: reported }
        }
        jpeg.copy(output, 0)
        outSize.writeInt32LE(jpeg.length, 0)
        return { ret: 0, size: jpeg.length }
      },
    }
    const t = createWxgfTranscoder(overflowThenFits, null)
    const r = t(wxgfPayload())
    expect('bytes' in r, '报告溢出但 64MB 缓冲能装下时必须重试成功').toBe(true)
    expect(seen.length, '第二次就应命中上限缓冲，不再走 mode 3').toBe(2)
    expect(at(seen, 0)).toBeLessThan(at(seen, 1))
    expect(at(seen, 1)).toBe(64 * 1024 * 1024)
    if ('bytes' in r) {
      expect([...r.bytes.subarray(-2)]).toEqual([0xff, 0xd9])
    }
  })

  it('⑭ 只有 mode 3 能解的变体：前两次失败、第三次成功（不再误报失败）', () => {
    const jpeg = tinyJpeg(32, 16)
    const modeOnly3: WxgfNative = {
      label: 'fake-mode3',
      run(input, output, outSize, opt) {
        if (opt.readInt32LE(0) !== 3) return { ret: 1, size: 0 }
        jpeg.copy(output, 0)
        outSize.writeInt32LE(jpeg.length, 0)
        return { ret: 0, size: jpeg.length }
      },
    }
    const t = createWxgfTranscoder(modeOnly3, null)
    const r = t(wxgfPayload())
    expect('bytes' in r, 'mode 3 能解时不许失败').toBe(true)
    if ('bytes' in r) {
      expect([...r.bytes.subarray(-2)]).toEqual([0xff, 0xd9])
      expect(r.jpegWidth).toBe(32)
    }
  })

  it('⑮ DLL 不可用时走 ffmpeg 兜底；兜底也失败时把两段原因串起来', () => {
    const ok: WxgfTranscoder = (payload) => {
      const jpeg = tinyJpeg(32, 16)
      return { bytes: jpeg, jpegWidth: 32, jpegHeight: 16, ms: 1 }
    }
    const r1 = createWxgfTranscoder(null, ok)(wxgfPayload())
    expect('bytes' in r1, 'DLL 不可用时必须落到 ffmpeg 兜底').toBe(true)
    const bad: WxgfTranscoder = () => ({ error: 'ffmpeg 也没有' })
    const r2 = createWxgfTranscoder(null, bad)(wxgfPayload())
    expect('error' in r2 && r2.error, '两段原因都要让用户看见').toContain('微信解码库不可用')
    expect('error' in r2 && r2.error).toContain('ffmpeg 也没有')
  })

  it('⑨ 报告的输出长度超过 64MB 上限时判失败（与远端原图同口径）', () => {
    const t = createWxgfTranscoder(fakeNative(tinyJpeg(32, 16), { reportSize: 65 * 1024 * 1024 }), null)
    const r = t(wxgfPayload())
    expect('error' in r && r.error).toContain('64MB')
  })

  it('⑩ 载荷过小时不动原生库（直接报错）', () => {
    const seen: Array<{ outLen: number; opt: Buffer }> = []
    const t = createWxgfTranscoder(fakeNative(tinyJpeg(32, 16), { seen }))
    const r = t(Buffer.from([0x77, 0x78]))
    expect('error' in r ? r.error : '').toContain('过小')
    expect(seen.length, '载荷太小就该在进原生库之前返回').toBe(0)
  })

  it('⑪ jpegDimensions：能读 SOF 尺寸，非 JPEG 返回 null（不抛）', () => {
    expect(jpegDimensions(tinyJpeg(1280, 1707))).toEqual({ width: 1280, height: 1707 })
    expect(jpegDimensions(Buffer.from('not a jpeg'))).toBeNull()
    expect(jpegDimensions(Buffer.alloc(0))).toBeNull()
  })
})

describe('wxgf 接进 decodeDatBytes', () => {
  it('⑫ 解出 wxgf 时调转码器，并把转码产物按**实际魔数**当图片返回', () => {
    const dat = makeV2Dat(wxgfPayload(), AES_KEY, XOR_KEY)
    const calls: number[] = []
    const dec = decodeDatBytes(dat, AES_KEY, XOR_KEY, {
      wxgf: (payload) => {
        calls.push(payload.length)
        const bytes = tinyJpeg(64, 32)
        return { bytes, jpegWidth: 64, jpegHeight: 32, ms: 1 }
      },
    })
    if ('error' in dec) throw new Error('应当成功：' + dec.error)
    expect(calls.length, '必须真的调了转码器').toBe(1)
    expect(dec.format).toBe('jpg')
    expect([...dec.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8])
  })

  it('⑬ 转码失败时退回 hevc（保持改造前的降级），不把 wxgf 原字节当图片', () => {
    const dat = makeV2Dat(wxgfPayload(), AES_KEY, XOR_KEY)
    const dec = decodeDatBytes(dat, AES_KEY, XOR_KEY, { wxgf: () => ({ error: '解码库不可用' }) })
    if ('error' in dec) throw new Error('不该报错，应当降级：' + dec.error)
    expect(dec.format).toBe('hevc')
    expect(Buffer.from(dec.bytes).subarray(0, 4).toString('latin1')).toBe('wxgf')
  })

  it('⑭ 转码器返回了非图片字节时同样降级（不硬编码 jpg）', () => {
    const dat = makeV2Dat(wxgfPayload(), AES_KEY, XOR_KEY)
    const dec = decodeDatBytes(dat, AES_KEY, XOR_KEY, { wxgf: () => ({ bytes: Buffer.from('garbage'), jpegWidth: 0, jpegHeight: 0, ms: 0 }) })
    if ('error' in dec) throw new Error(dec.error)
    expect(dec.format).toBe('hevc')
  })

  it('⑮ 非 wxgf 的图不受影响（PNG 照常识别）', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])
    const dec = decodeDatBytes(makeV2Dat(png, AES_KEY, XOR_KEY), AES_KEY, XOR_KEY)
    if ('error' in dec) throw new Error(dec.error)
    expect(dec.format).toBe('png')
  })
})

describe('档位排序（与转码同批的耦合改动）', () => {
  it('⑯ 四档语义：_h 原图 / 主体聊天版 / _t 缩略 / 不认识的 _x 最低', () => {
    expect(datTierOf('C:/x/aa_h.dat')).toBe('original')
    expect(datTierOf('C:/x/aa.dat')).toBe('chat')
    expect(datTierOf('C:/x/aa_t.dat')).toBe('thumb')
    expect(datTierOf('C:/x/aa_b.dat'), '_b 是气泡图：不认识就当最好的，会顶掉原图').toBe('other')
    expect(datTierRank('aa_h.dat')).toBeLessThan(datTierRank('aa.dat'))
    expect(datTierRank('aa.dat')).toBeLessThan(datTierRank('aa_t.dat'))
    expect(datTierRank('aa_t.dat')).toBeLessThan(datTierRank('aa_b.dat'))
  })

  it('⑰ 只有 _t 与 _b 进缩略兜底槽（_h 是原图，必须占住「最好的一份」）', () => {
    expect(isThumbTier('aa_t.dat')).toBe(true)
    expect(isThumbTier('aa_b.dat')).toBe(true)
    expect(isThumbTier('aa_h.dat')).toBe(false)
    expect(isThumbTier('aa.dat')).toBe(false)
  })

  it('⑱ 排序后原图排在第一个（读取循环取到的就是最好的那一档）', () => {
    const files = ['aa_t.dat', 'aa.dat', 'aa_h.dat', 'aa_b.dat']
    files.sort((a, b) => datTierRank(a) - datTierRank(b))
    expect(at(files, 0)).toBe('aa_h.dat')
    expect(at(files, 3)).toBe('aa_b.dat')
  })
})

describe('批量解密：档位不能被低档覆盖（与排序同批的边界）', () => {
  /**
   * 造一段可渲染的 PNG（`decodeDatBytes` 靠魔数认格式；内容随意但要能区分两份）。
   *
   * 长度必须 **> 1024**：V2 的 AES 段是一个固定 1024 字节的头，夹具太短的话解出来会被
   * 「补到 1024」——那是夹具不真实，不是实现的问题（真实 .dat 的头就是这个量级）。
   */
  function png(tag: number): Buffer {
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1200, tag),
    ])
  }

  /**
   * 造真实布局：`<root>/msg/attach/<hash>/2026-03/Img/`。
   * 返回 root（批量解密的 `rawRoot` 参数）与 Img 目录（放 `.dat`）。
   */
  function layout(): { root: string; img: string; decoded: string } {
    const root = mkdtempSync(join(tmpdir(), 'wxgf-batch-'))
    dirs.push(root)
    const img = join(root, 'msg', 'attach', 'd0f5b6b1c8a94f0e9b7c3a1d2e4f6a8b', '2026-03', 'Img')
    mkdirSync(img, { recursive: true })
    const decoded = mkdtempSync(join(tmpdir(), 'wxgf-out-'))
    dirs.push(decoded)
    return { root, img, decoded }
  }

  it('⑲ 同一 md5 多档：最优档落主槽，低档按「已有 original 档」跳过', async () => {
    const md5 = 'a'.repeat(32)
    const { root, img, decoded } = layout()
    const original = png(0x11)
    const chat = png(0x22)
    writeFileSync(join(img, md5 + '_h.dat'), makeV2Dat(original, AES_KEY, XOR_KEY))
    writeFileSync(join(img, md5 + '.dat'), makeV2Dat(chat, AES_KEY, XOR_KEY))

    const res = await decryptAllImageDats(root, decoded, AES_KEY, XOR_KEY, 2)

    expect(res.total, '两档都该被看到').toBe(2)
    expect(res.okCount, '只该落盘一次').toBe(1)
    expect(readFileSync(join(decoded, md5 + '.png')).equals(original), '_h（原图）先落盘，且不被 .dat 覆盖').toBe(true)
    expect(
      res.skippedDetails?.some(d => d.file.endsWith('.dat') && d.reason.includes('original')),
      '低档的跳过原因要写清真因（已有原图档）',
    ).toBe(true)
  })

  it('⑳ 缩略档进 `.t.` 兜底槽，不占「本机最好的一份」', async () => {
    const md5 = 'b'.repeat(32)
    const { root, img, decoded } = layout()
    const thumb = png(0x33)
    writeFileSync(join(img, md5 + '_t.dat'), makeV2Dat(thumb, AES_KEY, XOR_KEY))

    await decryptAllImageDats(root, decoded, AES_KEY, XOR_KEY, 2)

    expect(readFileSync(join(decoded, md5 + '.t.png')).equals(thumb)).toBe(true)
    expect(existsSync(join(decoded, md5 + '.png')), '缩略图不能占主槽').toBe(false)
  })
})

describe('接线不变量（行为测试够不到的那几条）', () => {
  /** 读后端源码（spec 在 `tests/`，源码在 `../src/`）。 */
  const src = (rel: string): string => readFileSync(join(HERE, '..', 'src', rel), 'utf8')

  it('㉑ 老缓存里的 `.hevc` 占位必须能被转码能力解封（否则这张图永久钉在「需系统解码」）', () => {
    const code = stripComments(src('query/media-image.ts'))
    expect(
      code.includes('existsSync(hevc) && !isWxgfTranscodeAvailable()'),
      '`.hevc` 早退必须受转码能力约束：装上解码库之后要回去重解，而不是被占位文件钉死',
    ).toBe(true)
  })

  it('㉒ 只绑定验证过的那一个导出（多绑一个未验证签名的原生函数会直接崩进程）', () => {
    const code = stripComments(src('query/wxam-image.ts'))
    // 注释里会**解释**为什么不调 getWXGFInfo/isWXGF，所以必须先剥注释再取名字集合。
    const used = new Set([...code.matchAll(/wxam_(?:dec|enc)_[a-z0-9_]+/gi)].map(m => at(m, 0)))
    expect([...used], '只允许 wxam_dec_wxam2pic_5（其余导出的签名没有验证过）').toEqual(['wxam_dec_wxam2pic_5'])
  })

  it('㉓ 档位判据只有一份（上一版的病根就是两份各自漂移）', () => {
    const batch = stripComments(src('query/decrypt-images.ts'))
    expect(batch.includes("from './media-image.ts'"), '批量解密要复用共享的档位 API').toBe(true)
    expect(batch.includes('isThumbTier'), '缩略槽的判定要用共享 API').toBe(true)
    expect(/'_t\.dat'|\.endsWith\('_t\.dat'\)/.test(batch), '不许在批量解密里再写一份后缀判断').toBe(false)
  })
})

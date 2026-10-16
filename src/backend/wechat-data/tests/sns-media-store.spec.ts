/**
 * 原图落盘缓存（`sns-media-store.ts`）的行为守卫。
 *
 * 钉住的纪律：
 *   · **只收认得出的图片字节** —— 猜错格式会把坏字节当原图永久缓存，而坏原图比没有原图更坏
 *     （它会被一直返回，且再也不会重抓）；
 *   · **落盘失败不影响本次展示**（返回 `null` 而不抛），与 `article-cover.ts` 同口径；
 *   · **先写 `.part` 再改名** —— 半个文件绝不能被当成有效缓存；
 *   · 读回来会**再认一次头**：被外部工具截断过的文件当作没有（宁可重抓）；
 *   · 淘汰按**字节**且删最旧的，不是按条数。
 *
 * @vitest-environment node
 */
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../../tests/helpers/temp-db.ts'
import {
  forgetSweepStateForTest,
  lookupOriginal,
  mimeOfExt,
  originalAsDataUrl,
  saveOriginal,
  sniffOriginalExt,
  sweepOriginalStore,
} from '../src/query/sns-media-store.ts'

const workspaces: TempWorkspace[] = []
const decodedDir = (): string => {
  const w = createTempWorkspace('sns-store')
  workspaces.push(w)
  return w.dir
}
afterEach(async () => {
  forgetSweepStateForTest()
  const list = workspaces.splice(0, workspaces.length)
  for (const w of list) await w.cleanup()
})

const MD5_A = 'a'.repeat(32)
const MD5_B = 'b'.repeat(32)

/**
 * 造一段「合法图片」字节（头对即可，不必真能解码 —— 这里验的是格式识别与搬运）。
 * 每段都 ≥16 字节：低于这个数会被 `MIN_ORIGINAL_BYTES` 挡住（那是有意的门槛）。
 */
function jpegBytes(body = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(body, 7)])
}
function pngBytes(body = 64): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(body, 7)])
}
function avifBytes(body = 64): Buffer {
  return Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypavif'), Buffer.alloc(body, 7)])
}
/** 第 i 个夹具的 md5（32 位小写十六进制）。 */
const md5Of = (i: number): string => i.toString(16).padStart(32, '0')

describe('sniffOriginalExt：认不出就返回 null（不猜）', () => {
  it('认得 jpeg / png / webp / avif / heic / gif / bmp', () => {
    expect(sniffOriginalExt(jpegBytes())).toBe('jpg')
    expect(sniffOriginalExt(pngBytes())).toBe('png')
    expect(sniffOriginalExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(16, 0)]))).toBe('webp')
    expect(sniffOriginalExt(avifBytes())).toBe('avif')
    expect(sniffOriginalExt(Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypheic'), Buffer.alloc(16, 0)]))).toBe('heic')
    expect(sniffOriginalExt(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 0)]))).toBe('gif')
    expect(sniffOriginalExt(Buffer.concat([Buffer.from('BM'), Buffer.alloc(16, 0)]))).toBe('bmp')
  })

  it('太短的残桩一律不认（哪怕头是对的）—— 半截文件会被永久缓存，比没有更坏', () => {
    expect(sniffOriginalExt(Buffer.from([0xff, 0xd8]))).toBeNull()
    expect(sniffOriginalExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull()
    expect(sniffOriginalExt(Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypavif')]))).toBeNull()
  })

  it('密文、随机字节、空串一律认不出', () => {
    expect(sniffOriginalExt(Buffer.from([0xce, 0x6c, 0xe7, 0xd1, 1, 2, 3, 4]))).toBeNull()
    expect(sniffOriginalExt(Buffer.from('not an image at all'))).toBeNull()
    expect(sniffOriginalExt(Buffer.alloc(0))).toBeNull()
  })

  it('heif 家族（heif/mif1/msf1）认成 heic 那档之外也能落盘 —— 别把真图判成垃圾', () => {
    expect(sniffOriginalExt(Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypmif1'), Buffer.alloc(8, 0)]))).not.toBeNull()
  })
})

describe('saveOriginal / lookupOriginal：往返', () => {
  it('存进去能原样取回，且给出正确的 mime 与 data URL', () => {
    const dir = decodedDir()
    const bytes = jpegBytes(128)
    expect(saveOriginal(dir, MD5_A, bytes)).toBe('jpg')
    const hit = lookupOriginal(dir, MD5_A)
    expect(hit).not.toBeNull()
    expect(hit?.bytes.equals(bytes)).toBe(true)
    expect(hit?.ext).toBe('jpg')
    expect(mimeOfExt('jpg')).toBe('image/jpeg')
    expect(originalAsDataUrl(hit!)).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('png / avif 各自落到自己的扩展名上', () => {
    const dir = decodedDir()
    expect(saveOriginal(dir, MD5_A, pngBytes())).toBe('png')
    expect(saveOriginal(dir, MD5_B, avifBytes())).toBe('avif')
    expect(lookupOriginal(dir, MD5_A)?.ext).toBe('png')
    expect(lookupOriginal(dir, MD5_B)?.ext).toBe('avif')
  })

  it('不是图片的字节 ⇒ 不落盘，且之后查不到（坏原图比没有原图更坏）', () => {
    const dir = decodedDir()
    expect(saveOriginal(dir, MD5_A, Buffer.from([0xce, 0x6c, 0xe7, 0xd1, 9, 9, 9, 9]))).toBeNull()
    expect(lookupOriginal(dir, MD5_A)).toBeNull()
  })

  it('非法 md5 一律拒绝（绝不把脏字符串拼进路径）', () => {
    const dir = decodedDir()
    for (const bad of ['', '  ', 'not-an-md5', '../../etc/passwd', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)]) {
      expect(saveOriginal(dir, bad, jpegBytes()), bad).toBeNull()
      expect(lookupOriginal(dir, bad), bad).toBeNull()
    }
  })

  it('大写 md5 归一化后照样命中（微信侧可能给大写，不能因此查不到）', () => {
    const dir = decodedDir()
    const upper = 'A'.repeat(32)
    expect(saveOriginal(dir, upper, jpegBytes())).toBe('jpg')
    expect(lookupOriginal(dir, upper)).not.toBeNull()
    expect(lookupOriginal(dir, upper.toLowerCase())).not.toBeNull()
  })

  it('重复存同一个 md5 不报错，且内容不被改动（内容寻址）', () => {
    const dir = decodedDir()
    saveOriginal(dir, MD5_A, jpegBytes(32))
    expect(saveOriginal(dir, MD5_A, jpegBytes(999))).toBe('jpg')
    expect(lookupOriginal(dir, MD5_A)?.bytes.length).toBe(jpegBytes(32).length)
  })

  it('落盘用临时文件改名 ⇒ 目录里不该留下 .part', () => {
    const dir = decodedDir()
    saveOriginal(dir, MD5_A, jpegBytes())
    const shard = join(dir, 'sns-media', MD5_A.slice(0, 2))
    expect(readdirSync(shard).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('落盘目录不存在时会自己建', () => {
    const dir = decodedDir()
    expect(existsSync(join(dir, 'sns-media'))).toBe(false)
    saveOriginal(dir, MD5_A, jpegBytes())
    expect(existsSync(join(dir, 'sns-media', MD5_A.slice(0, 2), MD5_A + '.jpg'))).toBe(true)
  })
})

describe('lookupOriginal：读回来的字节要再认一次头', () => {
  it('文件被外部截断（不再是图片）⇒ 当作没有，让上层重抓', () => {
    const dir = decodedDir()
    saveOriginal(dir, MD5_A, jpegBytes(64))
    // 模拟被外部工具截断：只剩半个头
    writeFileSync(join(dir, 'sns-media', MD5_A.slice(0, 2), MD5_A + '.jpg'), Buffer.from([0xff, 0xd8]))
    expect(lookupOriginal(dir, MD5_A)).toBeNull()
  })

  it('空文件 ⇒ 当作没有', () => {
    const dir = decodedDir()
    const shard = join(dir, 'sns-media', MD5_A.slice(0, 2))
    mkdirSync(shard, { recursive: true })
    writeFileSync(join(shard, MD5_A + '.jpg'), Buffer.alloc(0))
    expect(lookupOriginal(dir, MD5_A)).toBeNull()
  })
})

describe('sweepOriginalStore：按字节删最旧的', () => {
  /** 造 n 个大小相同、mtime 依次递增的缓存文件。 */
  function seed(dir: string, n: number, size: number): void {
    for (let i = 0; i < n; i += 1) {
      const md5 = md5Of(i)
      saveOriginal(dir, md5, jpegBytes(size))
      const p = join(dir, 'sns-media', md5.slice(0, 2), md5 + '.jpg')
      // mtime 拉开，确保「最旧」是确定的第 i 个
      const t = new Date(Date.now() - (n - i) * 60_000)
      utimesSync(p, t, t)
    }
  }

  it('超预算时从最旧开始删，直到落进预算', () => {
    const dir = decodedDir()
    seed(dir, 4, 4096)
    const each = statSync(join(dir, 'sns-media', md5Of(0).slice(0, 2), md5Of(0) + '.jpg')).size
    // 预算只够 2 张 ⇒ 删掉最旧的 2 张
    const dropped = sweepOriginalStore(dir, each * 2)
    expect(dropped).toBe(2)
    expect(lookupOriginal(dir, md5Of(0))).toBeNull() // 最旧
    expect(lookupOriginal(dir, md5Of(1))).toBeNull() // 次旧
    expect(lookupOriginal(dir, md5Of(2))).not.toBeNull() // 保留
    expect(lookupOriginal(dir, md5Of(3))).not.toBeNull()
  })

  it('没超预算时一个都不删', () => {
    const dir = decodedDir()
    seed(dir, 3, 1024)
    const each = statSync(join(dir, 'sns-media', md5Of(0).slice(0, 2), md5Of(0) + '.jpg')).size
    expect(sweepOriginalStore(dir, each * 10)).toBe(0)
    expect(lookupOriginal(dir, md5Of(0))).not.toBeNull()
  })

  it('目录不存在时返回 0（不抛）', () => {
    expect(sweepOriginalStore(decodedDir(), 1)).toBe(0)
  })
})
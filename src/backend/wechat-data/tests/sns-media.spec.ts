/**
 * Offline SNS media resolution: V2-encrypted image blobs under
 * cache/<month>/Sns/Img and plain JPEG covers under Sns/Video / msg/video.
 * @vitest-environment node
 */
import { createCipheriv, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSnsImageDataUrl, snsAttachProgressForTest, ATTACH_BUDGET_FILES } from '../src/query/sns-image.ts'
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
  it('decodes a V2 SNS image blob located by the timeline+media cache key', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-snsimg-'))
    scratch.push(base)
    const timelineId = '123456789'
    const mediaId = '987654321'
    const hash = createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex')
    const dir = join(base, 'cache', '2026-08', 'Sns', 'Img', hash.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeV2(join(dir, hash.slice(2)), JPEG_HEADER)

    const md5 = createHash('md5').update(JPEG_HEADER).digest('hex')
    const r = await resolveSnsImageDataUrl(base, AES_KEY, 0x60, md5, timelineId, mediaId)
    expect(r.url).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('finds a V2 blob by plaintext md5 index when the cache-key hash path misses', async () => {
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
    const r = await resolveSnsImageDataUrl(base, AES_KEY, 0x60, md5, timelineId, mediaId)
    expect(r.url).toMatch(/^data:image\/jpeg;base64,/)
  })

  /**
   * 2026-09-29 性能修复的两条行为契约（真机 130 秒 → 亚秒级就是靠它们）。
   *
   * 为什么必须有测试：这两条都是**速度换语义**的取舍，很容易在后续重构里被"顺手改回去"，
   * 而改回去的表现是"某个面板卡几分钟"——在单测里看不出来，只有真机才暴露。
   */
  it('msg/attach 兜底：**非哈希命名**的文件按预算分摊解密，进度跨调用累积', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-attach-budget-'))
    scratch.push(base)
    // 真机上有 3,294 个**非哈希命名**的 attach 文件（形如 `1000_17_t.dat`）：只看名字排除不掉，
    // 只能解密出来比 md5。旧实现每次未命中都把 5 万个文件全解一遍 ⇒ 单次 3.5 秒。
    // 新实现：单次有预算、进度跨调用累积 —— 这里用**进度读数**钉住这两条（不靠枚举顺序）。
    // ⚠️ 明文长度必须 16 字节对齐：`writeV2` 按 `aesSize` 算块长（见 `alignedAesBlockSize`），
    // 非对齐长度会让解密出来的填充块对不上（`wrong final block length`）。
    const dir = join(base, 'msg', 'attach', 'ab')
    mkdirSync(dir, { recursive: true })
    // ⚠️ 每个文件的明文**必须各不相同**，且查询的 md5 谁都匹配不上：
    // 否则第一个被解出来的文件就命中了（函数提前 return），第二趟又直接被 `md5UrlCache` 挡掉
    // —— 那样量到的是"缓存命中"，根本量不到"进度累积"。
    const total = ATTACH_BUDGET_FILES * 2
    for (let i = 0; i < total; i += 1) {
      // 16 字节对齐（见下一条用例的说明），并让每个文件内容唯一。
      const jpeg = Buffer.concat([JPEG_HEADER, Buffer.from(String(i).padStart(16, '0'))])
      writeV2(join(dir, `10${String(i).padStart(3, '0')}_1700000000_t.dat`), jpeg)
    }
    const nobody = '0123456789abcdef0123456789abcdef'
    // 闸门是**按墙上时间**判的 ⇒ 用假时钟把它变确定（只 fake Date，`yieldToLoop` 的
    // setTimeout 仍走真实时钟，否则让出会卡住）。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T00:00:00Z'))

    const first = await resolveSnsImageDataUrl(base, AES_KEY, 0x60, nobody)
    expect(first.url, '这批文件里没有目标 md5').toBeUndefined()
    const after1 = snsAttachProgressForTest(base)
    expect(after1, '第一趟应当建起索引').toBeDefined()
    expect(after1?.decoded ?? 0, '单次解密量必须有上限（这正是"单次有界"）').toBeLessThanOrEqual(ATTACH_BUDGET_FILES)
    expect(after1?.decoded ?? 0, '而且确实干活了').toBeGreaterThan(0)
    expect(after1?.pending ?? 0, '剩下的必须留在队列里，不能丢').toBeGreaterThan(0)

    // ③ **突发闸门**（2026-09-29 加）：150ms 内的连续调用只推进一次。
    //    这是有意的 —— 一屏里连续多个未命中不该每个都把"解码一批无关文件"重付一遍
    //    （真机 `[sns-trace]` 曾经是 7 个未命中各付 25ms）。这条把它钉住：
    //    同一时刻再调一次，进度**不许**前进。
    await resolveSnsImageDataUrl(base, AES_KEY, 0x60, nobody)
    expect(snsAttachProgressForTest(base)?.decoded ?? 0, '闸门期内不该再推进一次').toBe(after1?.decoded ?? 0)

    // ④ 过了闸门期 ⇒ 必须继续推进（进度只会前进、不会卡死）
    vi.setSystemTime(new Date(Date.now() + 200))
    await resolveSnsImageDataUrl(base, AES_KEY, 0x60, nobody)
    const after2 = snsAttachProgressForTest(base)
    expect(after2?.decoded ?? 0, '过了闸门期必须接着上一趟继续').toBeGreaterThan(after1?.decoded ?? 0)

    // ⑤ 一直推进下去必须清空队列，且每个文件都算过
    for (let round = 0; round < 200 && (snsAttachProgressForTest(base)?.pending ?? 0) > 0; round += 1) {
      vi.setSystemTime(new Date(Date.now() + 200))
      await resolveSnsImageDataUrl(base, AES_KEY, 0x60, nobody)
    }
    const drained = snsAttachProgressForTest(base)
    expect(drained?.pending ?? -1, '一直调用下去必须把队列清空（进度只会前进、不会卡死）').toBe(0)
    expect(drained?.decoded ?? 0, '清空时应当每个文件都算过了').toBe(total)
    vi.useRealTimers()
  })

  it('msg/attach 兜底：名字是 32 位哈希且对不上的文件**不解密**（命名规则即内容 md5）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-attach-skip-'))
    scratch.push(base)
    // 这份文件的**明文**就是目标 JPEG，但文件名是另一个 32 位哈希 —— 旧实现会解密它并按
    // 明文 md5 命中。新实现按"名字 = 内容 md5"的命名规则直接跳过（本机 47,012 个哈希命名文件
    // 全靠这条跳过，否则单次要多花 3.5 秒）。这条测试把这个**有意的取舍**钉住：
    // 一旦有人把它改回"全解密"，这里会红，从而逼他重新量那 3.5 秒。
    // （明文刻意与本文件其它用例不同：`md5UrlCache` 是模块级的，同图会被上一轮的缓存直接命中。
    //   长度同样要 16 字节对齐，理由见上一条用例。）
    const jpeg = Buffer.concat([JPEG_HEADER, Buffer.from('skip-case-000000')])
    const md5 = createHash('md5').update(jpeg).digest('hex')
    const dir = join(base, 'msg', 'attach', 'cd')
    mkdirSync(dir, { recursive: true })
    writeV2(join(dir, 'ffffffffffffffffffffffffffffffff_t.dat'), jpeg)
    const r = await resolveSnsImageDataUrl(base, AES_KEY, 0x60, md5)
    expect(r.url).toBeUndefined()
    expect(snsAttachProgressForTest(base)?.decoded ?? 0, '一个哈希命名的文件都不该解密').toBe(0)
  })
})

describe('resolveSnsVideoCoverDataUrl', () => {
  it('reads the plain jpg cover under cache/<month>/Sns/Video', () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-snsvid-'))
    scratch.push(base)
    const timelineId = 'v_timeline'
    const mediaId = 'v_media'
    // 文件名与 timeline/media 标识无关：现实现只按**内容 md5** 建索引。
    // 旧的 md5(timelineId_mediaId_2) 公式已废弃 —— 真实数据实测 11 种公式 × 4 种后缀
    // 对 127 个磁盘基名零命中（见 sns-video.ts 头注释）。
    // timelineId/mediaId 仍照旧传入，用于说明这两个参数现在已被忽略。
    const indexFile = 'cafebabecafebabecafebabecafebabe'
    const dir = join(base, 'cache', '2026-08', 'Sns', 'Video', indexFile.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, indexFile.slice(2) + '.jpg'), JPEG_HEADER)

    const md5 = createHash('md5').update(JPEG_HEADER).digest('hex')
    const r = resolveSnsVideoCoverDataUrl(base, md5, timelineId, mediaId)
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

/**
 * 文件库图片按需解密（2026-10-21，借鉴 Alpha 的 thumb/full 两档 + 协议流式）。
 *
 * 这一层的存在理由：文件库图片从不进 decoded 缓存（实测 13,071 张命中 0），
 * 面板因此永远只显示「dat」占位。判据：
 *  ① 解码键剥离规则与客户端 `fileKey()` 完全一致（少剥一个 `_h` 就会查错槽）；
 *  ② decoded 槽位先主槽再 `.t.` 缩略槽；
 *  ③ 附件索引能按 md5 前缀定位 `.dat`（含 `_t/_h` 档位）；
 *  ④ 缓存命中/参数非法/未配置目录都给可展示结果，不抛。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodedFileRel,
  ensureFileImageDecoded,
  ensureFileImagesDecodedBatch,
  fileImageKeyOf,
  locateFileDats,
  MAX_BATCH_KEYS,
  resetAttachIndexForTest,
} from '../src/query/file-image-on-demand.ts'

const KEYS = {
  h: '0123456789abcdef0123456789abcdef',
  t: 'fedcba9876543210fedcba9876543210',
}
const scratch: string[] = []
afterEach(() => {
  resetAttachIndexForTest()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'file-img-ondemand-'))
  scratch.push(dir)
  return dir
}

describe('fileImageKeyOf：与客户端 fileKey 同一套剥离规则', () => {
  it('`.dat` 与档位后缀（_t/_h/_b）都要剥掉', () => {
    expect(fileImageKeyOf(KEYS.h + '_h.dat')).toBe(KEYS.h)
    expect(fileImageKeyOf(KEYS.t + '_t.dat')).toBe(KEYS.t)
    expect(fileImageKeyOf(KEYS.h + '.dat')).toBe(KEYS.h)
    expect(fileImageKeyOf(KEYS.h.toUpperCase() + '_H.DAT')).toBe(KEYS.h)
  })

  it('非 32 位 md5 形状返回空串（客户端就不该发这类 key）', () => {
    expect(fileImageKeyOf('李吉元-交车确认书.pdf')).toBe('')
    expect(fileImageKeyOf('短哈希.dat')).toBe('')
    expect(fileImageKeyOf('')).toBe('')
  })
})

describe('decodedFileRel：先主槽再缩略槽', () => {
  it('主槽命中返回 `<key>.<ext>`；只有 `.t.` 时返回缩略槽路径', () => {
    const root = tempDir()
    expect(decodedFileRel(root, KEYS.h)).toBeNull()
    writeFileSync(join(root, KEYS.t + '.t.jpg'), 'thumb')
    expect(decodedFileRel(root, KEYS.t)).toBe(KEYS.t + '.t.jpg')
    writeFileSync(join(root, KEYS.h + '.png'), 'full')
    expect(decodedFileRel(root, KEYS.h)).toBe(KEYS.h + '.png')
  })
})

describe('locateFileDats：msg/attach 索引按 md5 前缀定位', () => {
  it('返回该 md5 的 .dat 候选（含 _t/_h 两档）', async () => {
    const raw = tempDir()
    const dir = join(raw, 'msg', 'attach', '2026-09', 'abc')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, KEYS.h + '_h.dat'), 'hd')
    writeFileSync(join(dir, KEYS.t + '_t.dat'), 'thumb')
    writeFileSync(join(dir, 'not-md5-name.dat'), 'x')
    const hits = await locateFileDats(raw, KEYS.t)
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain(KEYS.t + '_t.dat')
    expect((await locateFileDats(raw, 'ffffffffffffffffffffffffffffffff')).length).toBe(0)
  })

  it('rawBase 为空 / key 为空 ⇒ 空结果（不抛）', async () => {
    expect(await locateFileDats('', KEYS.h)).toEqual([])
    expect(await locateFileDats('D:/whatever', '')).toEqual([])
  })
})

describe('ensureFileImageDecoded：缓存命中/参数错误都有可展示结果', () => {
  it('decoded 缓存命中 ⇒ 直接给相对路径（thumb 槽标记 thumb=true）', async () => {
    const decoded = tempDir()
    writeFileSync(join(decoded, KEYS.t + '.t.jpg'), 'thumb')
    const hit = await ensureFileImageDecoded({
      decryptedDir: '/dec', decodedDir: decoded, rawBase: '/raw', key: KEYS.t,
      thumbFirst: true,
    })
    expect(hit.file).toBe(KEYS.t + '.t.jpg')
    expect(hit.thumb).toBe(true)
  })

  it('非法 key / 未配置目录 ⇒ error（界面保留图标兜底）', async () => {
    const decoded = tempDir()
    const bad = await ensureFileImageDecoded({ decryptedDir: '/dec', decodedDir: decoded, rawBase: '/raw', key: '不是md5' })
    expect(bad.error).toContain('缺少图片 MD5')
    const noBase = await ensureFileImageDecoded({ decryptedDir: '/dec', decodedDir: decoded, rawBase: '', key: KEYS.h })
    expect(noBase.error).toContain('未配置微信数据目录')
  })

  it('附件索引里没有该 md5 ⇒ 可读的中文错误（不是异常）', async () => {
    const decoded = tempDir()
    const raw = tempDir()
    mkdirSync(join(raw, 'msg', 'attach'), { recursive: true })
    const miss = await ensureFileImageDecoded({ decryptedDir: '/dec', decodedDir: decoded, rawBase: raw, key: KEYS.h })
    expect(miss.error).toContain('未找到附件原图')
  })
})

describe('ensureFileImagesDecodedBatch：一屏一次 RPC（去重/顺序/上限）', () => {
  it('去重并保持首次出现顺序；缓存命中走文件路径', async () => {
    const decoded = tempDir()
    writeFileSync(join(decoded, KEYS.h + '.jpg'), 'full')
    writeFileSync(join(decoded, KEYS.t + '.t.jpg'), 'thumb')
    const items = await ensureFileImagesDecodedBatch(
      { decryptedDir: '/dec', decodedDir: decoded, rawBase: '/raw' },
      [KEYS.t.toUpperCase(), KEYS.h, KEYS.t, '不是md5', ''],
      true,
    )
    expect(items.map((i) => i.key)).toEqual([KEYS.t, KEYS.h, '不是md5'])
    expect(items[0]?.file).toBe(KEYS.t + '.t.jpg')
    expect(items[1]?.file).toBe(KEYS.h + '.jpg')
    expect(items[2]?.error).toContain('缺少图片 MD5')
  })

  it('超过单批上限直接截断（保护 worker）', async () => {
    const decoded = tempDir()
    const keys = Array.from({ length: MAX_BATCH_KEYS + 10 }, (_, i) => i.toString(16).padStart(32, '0'))
    const items = await ensureFileImagesDecodedBatch(
      { decryptedDir: '/dec', decodedDir: decoded, rawBase: '' },
      keys,
      true,
    )
    expect(items.length).toBe(MAX_BATCH_KEYS)
  })
})

describe('接线守卫：别让优化只活在测试里', () => {
  it('批量链路/IPC 协议/缩略档都接上了', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const base = join(fileURLToPath(import.meta.url), '..', '..')
    const media = readFileSync(join(base, 'src', 'remotes', 'media.ts'), 'utf8')
    expect(media, '两个方法由工厂提供').toContain('createFileImageRemotes(rc)')
    const fileRemotes = readFileSync(join(base, 'src', 'remotes', 'media-file-images.ts'), 'utf8')
    expect(fileRemotes).toContain('ensureFileImageDecoded')
    expect(fileRemotes, '批量 Remote 必须用批量实现').toContain('ensureFileImagesDecodedBatch')
    const gateway = readFileSync(join(base, 'src', 'gateway-media-ops.ts'), 'utf8')
    expect(gateway).toContain("@Remote('getFileImageDataUrls')")
    const panels = join(base, '..', '..', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels')
    const files = readFileSync(join(panels, 'Files.tsx'), 'utf8')
    expect(files, '网格必须走攒批').toContain('fetchFileThumbUrls')
    const thumbs = readFileSync(join(panels, 'files-thumbs.ts'), 'utf8')
    expect(thumbs).toContain('apiGetFileImageDataUrls')
    expect(thumbs, '缩略档必须带 w 参数').toContain('withThumbWidth(url, width)')
    const protocol = readFileSync(join(base, '..', '..', '..', 'src', 'backend', 'media-protocol.js'), 'utf8')
    expect(protocol).toContain('function parseThumbWidth')
    expect(protocol, '缩略图要落盘复用').toContain('thumbPathFor')
    expect(existsSync(join(base, 'src', 'query', 'file-image-on-demand.ts'))).toBe(true)
  })
})

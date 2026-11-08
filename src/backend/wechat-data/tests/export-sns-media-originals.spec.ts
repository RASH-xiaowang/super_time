/**
 * Moments original-media export:
 * - every supported image/video magic maps to the correct extension;
 * - Live Photos produce paired still + motion resources;
 * - thumbnails/ciphertext are rejected rather than archived;
 * - the 5000-resource cap is represented by `truncated: true`;
 * - ZIP bytes are the exact resolver bytes (no transcoding).
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  sniffExportMediaBytes,
  writeMomentsMediaArchive,
  type MomentsMediaResolver,
  type OriginalMediaBytes,
} from '../src/query/export-sns-media.ts'
import { ensureFileImageOriginalDecoded } from '../src/query/file-image-on-demand.ts'
import { originalExportDestination } from '../src/remotes/media-original-exports.ts'
import { ZipFileWriter, crc32 } from '../src/query/zip.ts'
import { exportMoments } from '../src/query/export.ts'
import { saveArchivedOriginal } from '../src/query/sns-media-store.ts'
import { createMediaRemotes } from '../src/remotes/media.ts'
import type { MomentItem } from '../src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sns-export-originals-'))
  scratch.push(dir)
  return dir
}

function imageBytes(prefix: number[], size = 32): Buffer {
  return Buffer.concat([Buffer.from(prefix), Buffer.alloc(Math.max(0, size - prefix.length), 7)])
}

function ftyp(brand: string): Buffer {
  const bytes = Buffer.alloc(32, 0)
  bytes.writeUInt32BE(bytes.length, 0)
  bytes.write('ftyp', 4, 'latin1')
  bytes.write(brand, 8, 'latin1')
  return bytes
}

const JPEG = imageBytes([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])
const PNG = imageBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WEBP = imageBytes([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])
const AVIF = ftyp('avif')
const HEIC = ftyp('heic')
const HEIF = ftyp('mif1')
const MP4 = ftyp('isom')
const MOV = ftyp('qt  ')
const M4V = ftyp('M4V ')

function momentWith(
  images: MomentItem['images'],
  videos: MomentItem['videos'] = [],
): MomentItem {
  return {
    tid: 'timeline-1',
    username: 'wxid_owner',
    author: 'Owner',
    text: 'media export',
    ts: 1,
    time: '2026-01-01 00:00:01',
    media_count: images.length + videos.length,
    media_desc: '',
    images,
    videos,
    location: '',
    link_title: '',
    is_self: true,
    likes: [],
    comments: [],
  }
}

function resolverFrom(map: Record<string, OriginalMediaBytes>): MomentsMediaResolver {
  return {
    async resolve(kind, input) {
      const hit = map[kind + ':' + String(input.md5 ?? '')]
      return hit ?? { error: 'fixture missing' }
    },
  }
}

interface ZipEntry {
  name: string
  data: Buffer
}

function unzip(buf: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  expect(eocd).toBeGreaterThanOrEqual(0)
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const dataStart = localOffset + 30
      + buf.readUInt16LE(localOffset + 26)
      + buf.readUInt16LE(localOffset + 28)
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    expect(crc32(data), 'ZIP CRC mismatch: ' + name).toBe(buf.readUInt32LE(offset + 16))
    out.push({ name, data })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return out
}

describe('sniffExportMediaBytes', () => {
  it('recognizes required image and video container formats', () => {
    expect(sniffExportMediaBytes(JPEG, 'image')?.format).toBe('jpg')
    expect(sniffExportMediaBytes(PNG, 'image')?.format).toBe('png')
    expect(sniffExportMediaBytes(WEBP, 'image')?.format).toBe('webp')
    expect(sniffExportMediaBytes(AVIF, 'image')?.format).toBe('avif')
    expect(sniffExportMediaBytes(HEIC, 'image')?.format).toBe('heic')
    expect(sniffExportMediaBytes(HEIF, 'image')?.format).toBe('heif')
    expect(sniffExportMediaBytes(MP4, 'video')?.format).toBe('mp4')
    expect(sniffExportMediaBytes(MOV, 'video')?.format).toBe('mov')
    expect(sniffExportMediaBytes(M4V, 'video')?.format).toBe('m4v')
  })

  it('rejects ciphertext and bytes placed in the wrong media slot', () => {
    const ciphertext = Buffer.alloc(64, 0x5a)
    expect(sniffExportMediaBytes(ciphertext, 'image')).toBeNull()
    expect(sniffExportMediaBytes(JPEG, 'video')).toBeNull()
    expect(sniffExportMediaBytes(MP4, 'image')).toBeNull()
  })
})

describe('single-item original export helpers', () => {
  it('corrects an incorrect media extension using the sniffed container format', () => {
    expect(originalExportDestination(join('C:', 'saved.jpg'), 'png')).toBe(join('C:', 'saved.png'))
    expect(originalExportDestination(join('C:', 'saved'), 'mp4')).toBe(join('C:', 'saved.mp4'))
    expect(originalExportDestination(join('C:', 'saved.bin'), 'mp4')).toBe(join('C:', 'saved.mp4'))
    expect(originalExportDestination(join('C:', 'saved.jpeg'), 'jpg')).toBe(join('C:', 'saved.jpeg'))
  })

  it('accepts a cached file-library original only when plaintext MD5 matches', async () => {
    const root = tempDir()
    const decoded = join(root, 'decoded_images')
    mkdirSync(decoded, { recursive: true })
    const key = createHash('md5').update(PNG).digest('hex')
    writeFileSync(join(decoded, key + '.png'), PNG)

    const hit = await ensureFileImageOriginalDecoded({
      decryptedDir: join(root, 'decrypted'),
      decodedDir: decoded,
      rawBase: '',
      key,
    })
    expect(hit).toMatchObject({ file: key + '.png', format: 'png' })
  })

  it('rejects a thumbnail-only file-library image without writing an original', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const key = 'b2'.repeat(16)
    const thumbDir = join(raw, 'msg', 'attach', '2026-01', 'thumb')
    mkdirSync(thumbDir, { recursive: true })
    writeFileSync(join(thumbDir, key + '_t.dat'), Buffer.from([7, 8, 86, 50]))

    const hit = await ensureFileImageOriginalDecoded({
      decryptedDir: join(root, 'decrypted'),
      decodedDir: join(root, 'decoded_images'),
      rawBase: raw,
      key,
    })
    expect(hit.file).toBeUndefined()
    expect(hit.error).toContain('只有微信缩略图')
  })

  it('decrypts a non-thumbnail file-library .dat and verifies its plaintext MD5', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const decoded = join(root, 'decoded_images')
    const key = createHash('md5').update(PNG).digest('hex')
    const datDir = join(raw, 'msg', 'attach', '2026-01', 'originals')
    mkdirSync(datDir, { recursive: true })
    // A plain single-byte XOR .dat exercises the real attachment tier rather
    // than the already-decoded-cache fast path.
    writeFileSync(join(datDir, key + '_h.dat'), PNG.map((byte) => byte ^ 0x5a))

    const hit = await ensureFileImageOriginalDecoded({
      decryptedDir: join(root, 'decrypted'),
      decodedDir: decoded,
      rawBase: raw,
      key,
    })
    expect(hit).toMatchObject({ file: key + '.png', format: 'png' })
    expect(readFileSync(join(decoded, key + '.png')).equals(PNG)).toBe(true)
  })
})

describe('writeMomentsMediaArchive', () => {
  it('writes exact original bytes and pairs Live Photo still + motion', async () => {
    const item = momentWith([
      {
        thumb: 'thumb-only',
        url: 'https://cdn.example/image',
        key: 'image-seed',
        md5: 'a'.repeat(32),
        id: 'img-1',
        timelineId: 'timeline-1',
      },
      {
        thumb: 'thumb-only',
        url: 'https://cdn.example/live-still',
        key: 'still-seed',
        md5: 'b'.repeat(32),
        id: 'live-1',
        timelineId: 'timeline-1',
        livePhoto: {
          url: 'https://cdn.example/live-motion',
          thumb: '',
          key: 'motion-seed',
          md5: 'c'.repeat(32),
          duration: 3,
          stillImageTimeMs: 420,
          id: 'motion-1',
          timelineId: 'timeline-1',
        },
      },
    ], [{
      url: 'https://cdn.example/video',
      thumb: '',
      key: 'video-seed',
      md5: 'd'.repeat(32),
      duration: 12,
      id: 'video-1',
      timelineId: 'timeline-1',
    }])
    const resolver = resolverFrom({
      ['image:' + 'a'.repeat(32)]: { bytes: JPEG, source: 'cdn', format: 'jpg' },
      ['image:' + 'b'.repeat(32)]: { bytes: PNG, source: 'local', format: 'png' },
      ['video:' + 'c'.repeat(32)]: { bytes: MOV, source: 'cdn', format: 'mov' },
      ['video:' + 'd'.repeat(32)]: { bytes: MP4, source: 'local', format: 'mp4' },
    })
    const dir = tempDir()
    const zipPath = join(dir, 'moments.zip')
    const zip = await ZipFileWriter.create(zipPath)
    const manifest = await writeMomentsMediaArchive({
      zip,
      items: [item],
      ctx: { decodedDir: join(dir, 'decoded_images'), xorKey: 0xff },
      resolver,
    })
    await zip.close()

    expect(manifest).toMatchObject({ total: 4, ok: 4, missing: 0, error: 0, truncated: false })
    const entries = unzip(readFileSync(zipPath))
    expect(entries).toHaveLength(4)
    expect(entries.find((entry) => entry.name.endsWith('.jpg'))?.data.equals(JPEG)).toBe(true)
    expect(entries.find((entry) => entry.name.endsWith('.png'))?.data.equals(PNG)).toBe(true)
    expect(entries.find((entry) => entry.name.endsWith('.mov'))?.data.equals(MOV)).toBe(true)
    expect(entries.find((entry) => entry.name.endsWith('.mp4'))?.data.equals(MP4)).toBe(true)

    const still = manifest.resources.find((resource) => resource.kind === 'live_photo_still')
    const motion = manifest.resources.find((resource) => resource.kind === 'live_photo_video')
    expect(still?.pairId).toBeTruthy()
    expect(motion?.pairId).toBe(still?.pairId)
    expect(motion).toMatchObject({ duration: 3, stillImageTimeMs: 420, source: 'cdn', local: false })
    expect(still).toMatchObject({ source: 'local', local: true, mime: 'image/png' })
  })

  it('keeps include* filters independent and defaults to including all categories', async () => {
    const item = momentWith([{
      thumb: '',
      url: '',
      key: 'still-seed',
      md5: 'e'.repeat(32),
      id: 'live-2',
      timelineId: 'timeline-1',
      livePhoto: {
        url: '',
        thumb: '',
        key: 'motion-seed',
        md5: 'f'.repeat(32),
        duration: 2,
        id: 'motion-2',
        timelineId: 'timeline-1',
      },
    }], [{
      url: '',
      thumb: '',
      key: 'video-seed',
      md5: '1'.repeat(32),
      duration: 8,
      id: 'video-2',
      timelineId: 'timeline-1',
    }])
    const resolver = resolverFrom({
      ['image:' + 'e'.repeat(32)]: { bytes: HEIC, source: 'local', format: 'heic' },
      ['video:' + 'f'.repeat(32)]: { bytes: M4V, source: 'local', format: 'm4v' },
      ['video:' + '1'.repeat(32)]: { bytes: MP4, source: 'local', format: 'mp4' },
    })
    const dir = tempDir()
    const zip = await ZipFileWriter.create(join(dir, 'live.zip'))
    const manifest = await writeMomentsMediaArchive({
      zip,
      items: [item],
      ctx: { decodedDir: join(dir, 'decoded_images'), xorKey: 0xff },
      resolver,
      options: { includeImages: false, includeVideos: false, includeLivePhotos: true },
    })
    await zip.close()
    expect(manifest.resources.map((resource) => resource.kind)).toEqual([
      'live_photo_still',
      'live_photo_video',
    ])
  })

  it('refuses thumbnails and ciphertext while still recording manifest errors', async () => {
    const item = momentWith([{
      thumb: '',
      url: '',
      key: '',
      md5: '2'.repeat(32),
      id: 'thumb',
      timelineId: 'timeline-1',
    }, {
      thumb: '',
      url: '',
      key: '',
      md5: '3'.repeat(32),
      id: 'cipher',
      timelineId: 'timeline-1',
    }])
    const resolver = resolverFrom({
      ['image:' + '2'.repeat(32)]: { bytes: JPEG, source: 'local', thumb: true },
      ['image:' + '3'.repeat(32)]: { bytes: Buffer.alloc(64, 0x44), source: 'cdn' },
    })
    const dir = tempDir()
    const zipPath = join(dir, 'reject.zip')
    const zip = await ZipFileWriter.create(zipPath)
    const manifest = await writeMomentsMediaArchive({
      zip,
      items: [item],
      ctx: { decodedDir: join(dir, 'decoded_images'), xorKey: 0xff },
      resolver,
    })
    await zip.close()
    expect(manifest).toMatchObject({ total: 2, ok: 0, missing: 0, error: 2 })
    expect(manifest.resources.every((resource) => resource.archivePath === undefined)).toBe(true)
    expect(manifest.resources[0]?.error).toContain('缩略图')
    expect(manifest.resources[1]?.error).toContain('不是可识别的图片')
    expect(unzip(readFileSync(zipPath))).toEqual([])
  })

  it('marks truncation when more resources exist than the configured cap', async () => {
    const item = momentWith([
      { thumb: '', url: '', key: '', md5: '4'.repeat(32), id: '1', timelineId: 't' },
      { thumb: '', url: '', key: '', md5: '5'.repeat(32), id: '2', timelineId: 't' },
      { thumb: '', url: '', key: '', md5: '6'.repeat(32), id: '3', timelineId: 't' },
    ])
    const resolver = resolverFrom({
      ['image:' + '4'.repeat(32)]: { bytes: JPEG, source: 'local' },
      ['image:' + '5'.repeat(32)]: { bytes: PNG, source: 'local' },
      ['image:' + '6'.repeat(32)]: { bytes: WEBP, source: 'local' },
    })
    const dir = tempDir()
    const zip = await ZipFileWriter.create(join(dir, 'cap.zip'))
    const manifest = await writeMomentsMediaArchive({
      zip,
      items: [item],
      ctx: { decodedDir: join(dir, 'decoded_images'), xorKey: 0xff },
      resolver,
      maxMedia: 2,
    })
    await zip.close()
    expect(manifest).toMatchObject({ total: 2, ok: 2, truncated: true })
  })
})

describe('exportMoments ZIP wiring', () => {
  it('passes include* filters through and writes paired Live Photo resources + manifest', async () => {
    const root = tempDir()
    const decrypted = join(root, 'decrypted')
    const decoded = join(root, 'decoded_images')
    const out = join(root, 'out')
    mkdirSync(join(decrypted, 'sns', 'db_sns'), { recursive: true })
    mkdirSync(decoded, { recursive: true })
    mkdirSync(out, { recursive: true })

    // Real XML ids are not guaranteed to equal the raw digest of the decrypted,
    // CDN-tail-trimmed file. The archive is keyed by the XML identity.
    const imageMd5 = createHash('md5').update('timeline-html-image').digest('hex')
    const motionMd5 = '8'.repeat(32)
    saveArchivedOriginal(decoded, imageMd5, JPEG)
    const xml = '<SnsDataItem><TimelineObject>'
      + '<id>timeline-zip</id><createTime>1792240123</createTime>'
      + '<contentDesc><![CDATA[archive fixture]]></contentDesc>'
      + '<ContentObject><type>54</type><mediaList><media>'
      + '<id>live-still</id><type>2</type>'
      + `<url md5="${imageMd5}" key="still-seed">http://shmmsns.qpic.cn/mmsns/still/0</url>`
      + '<thumb key="still-seed">http://shmmsns.qpic.cn/mmsns/still/150</thumb>'
      + '<LivePhoto><liveMedia><id>live-motion</id><type>6</type>'
      + `<url md5="${motionMd5}">http://szzjwxsns.video.qq.com/102/snsvideodownload?encfilekey=x&amp;idx=1</url>`
      + '<thumb type="1">http://szzjwxsns.video.qq.com/102/cover?idx=1</thumb>'
      + '<videoDuration>3</videoDuration><liveStillImageTimeMs>400</liveStillImageTimeMs>'
      + '<enc key="motion-seed">1</enc></liveMedia></LivePhoto>'
      + '</media></mediaList></ContentObject></TimelineObject></SnsDataItem>'
    const db = new DatabaseSync(join(decrypted, 'sns', 'db_sns', 'sns.db'))
    db.exec('CREATE TABLE SnsTimeLine (tid TEXT, user_name TEXT, content TEXT)')
    db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run('timeline-zip', 'wxid_owner', xml)
    db.close()

    const result = await exportMoments(decrypted, {
      zip: true,
      dir: out,
      filename: 'live-export',
      includeImages: false,
      includeVideos: false,
      includeLivePhotos: true,
    })
    const entries = unzip(readFileSync(result.path))
    const manifest = JSON.parse(
      entries.find((entry) => entry.name === 'record_media.json')?.data.toString('utf8') ?? '{}',
    ) as {
      total: number
      ok: number
      truncated: boolean
      resources: Array<{ kind: string; status: string; pairId?: string; archivePath?: string }>
    }
    expect(manifest.total).toBe(2)
    expect(manifest.ok).toBe(1)
    expect(manifest.truncated).toBe(false)
    const still = manifest.resources.find((resource) => resource.kind === 'live_photo_still')
    const motion = manifest.resources.find((resource) => resource.kind === 'live_photo_video')
    expect(still?.status).toBe('ok')
    expect(motion?.status).toBe('missing')
    expect(still?.pairId).toBe(motion?.pairId)
    expect(entries.find((entry) => entry.name === still?.archivePath)?.data.equals(JPEG)).toBe(true)
  })

  it('non-ZIP HTML embeds an archived original and never substitutes the thumbnail URL', async () => {
    const root = tempDir()
    const decrypted = join(root, 'decrypted')
    const decoded = join(root, 'decoded_images')
    const out = join(root, 'out')
    mkdirSync(join(decrypted, 'sns', 'db_sns'), { recursive: true })
    mkdirSync(decoded, { recursive: true })
    mkdirSync(out, { recursive: true })

    // The XML media id is a lookup key, not necessarily a digest of the
    // decrypted file after WeChat's CDN signature tail is removed.
    const imageMd5 = createHash('md5').update('timeline-html-image').digest('hex')
    saveArchivedOriginal(decoded, imageMd5, JPEG)
    const xml = '<SnsDataItem><TimelineObject>'
      + '<id>timeline-html</id><createTime>1792240123</createTime>'
      + '<contentDesc><![CDATA[html fixture]]></contentDesc>'
      + '<ContentObject><type>54</type><mediaList><media>'
      + '<id>image-html</id><type>2</type>'
      + `<url md5="${imageMd5}" key="seed">http://shmmsns.qpic.cn/mmsns/original/0</url>`
      + '<thumb key="seed">https://thumbnail.invalid/preview.jpg</thumb>'
      + '</media></mediaList></ContentObject></TimelineObject></SnsDataItem>'
    const db = new DatabaseSync(join(decrypted, 'sns', 'db_sns', 'sns.db'))
    db.exec('CREATE TABLE SnsTimeLine (tid TEXT, user_name TEXT, content TEXT)')
    db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run('timeline-html', 'wxid_owner', xml)
    db.close()

    const result = await exportMoments(decrypted, {
      format: 'html',
      images: true,
      dir: out,
      filename: 'html-originals.html',
    })
    const html = readFileSync(result.path, 'utf8')
    expect(html).toContain('data:image/jpeg;base64,')
    expect(html).not.toContain('原图未在本地解锁')
    expect(html).not.toContain('thumbnail.invalid')
  })

  it('HTML without embedded images shows text placeholders instead of encrypted CDN URLs', async () => {
    const root = tempDir()
    const decrypted = join(root, 'decrypted')
    const out = join(root, 'out')
    mkdirSync(join(decrypted, 'sns', 'db_sns'), { recursive: true })
    mkdirSync(out, { recursive: true })

    const imageMd5 = createHash('md5').update(JPEG).digest('hex')
    const videoMd5 = 'e'.repeat(32)
    const xml = '<SnsDataItem><TimelineObject>'
      + '<id>timeline-html-text</id><createTime>1792240123</createTime>'
      + '<contentDesc><![CDATA[html fixture]]></contentDesc>'
      + '<ContentObject><type>54</type><mediaList>'
      + '<media><id>image-html</id><type>2</type>'
      + `<url md5="${imageMd5}" key="seed">http://image-cdn.invalid/encrypted</url>`
      + '<thumb key="seed">https://thumbnail.invalid/preview.jpg</thumb>'
      + '</media>'
      + '<media><id>video-html</id><type>6</type>'
      + `<url md5="${videoMd5}">http://video-cdn.invalid/encrypted.mp4</url>`
      + '<thumb>https://video-cover.invalid/preview.jpg</thumb>'
      + '</media>'
      + '</mediaList></ContentObject></TimelineObject></SnsDataItem>'
    const db = new DatabaseSync(join(decrypted, 'sns', 'db_sns', 'sns.db'))
    db.exec('CREATE TABLE SnsTimeLine (tid TEXT, user_name TEXT, content TEXT)')
    db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run('timeline-html-text', 'wxid_owner', xml)
    db.close()

    const result = await exportMoments(decrypted, {
      format: 'html',
      dir: out,
      filename: 'html-no-embedded-images.html',
    })
    const html = readFileSync(result.path, 'utf8')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('image-cdn.invalid')
    expect(html).not.toContain('thumbnail.invalid')
    expect(html).not.toContain('video-cover.invalid')
    expect(html).toContain('未内嵌')
    expect(html).toContain('视频文件请用 ZIP 含媒体导出')
  })
})

describe('single-resource original export RPCs', () => {
  function mediaRemotes(root: string, rawBase = '') {
    return createMediaRemotes({
      dirs: () => ({ decrypted: join(root, 'decrypted'), decoded: join(root, 'decoded_images') }),
      op: () => {},
      rawWechatBase: () => rawBase,
      decryptState: { active: false, op: null } as never,
      warmDecodedImages: async () => {},
    })
  }

  function writeChatFileMessage(root: string, options: {
    username?: string
    localId?: number
    shard?: string
    body?: Buffer
    fileName?: string
    declaredMd5?: string
    declaredSize?: number
    createTime?: number
    localType?: number
  } = {}) {
    const username = options.username ?? 'wxid_chat_file'
    const localId = options.localId ?? 1
    const body = options.body ?? Buffer.from('exact chat attachment bytes', 'utf8')
    const fileName = options.fileName ?? 'report.txt'
    const actualMd5 = createHash('md5').update(body).digest('hex')
    const declaredMd5 = options.declaredMd5 ?? actualMd5
    const declaredSize = options.declaredSize ?? body.length
    const createTime = options.createTime ?? 1_767_225_600
    const localType = options.localType ?? 49
    const raw = join(root, 'raw')
    const date = new Date(createTime * 1000)
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    const fileDir = join(raw, 'msg', 'file', month)
    mkdirSync(fileDir, { recursive: true })
    const sourcePath = join(fileDir, fileName)
    writeFileSync(sourcePath, body)

    const decrypted = join(root, 'decrypted')
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
    const db = new DatabaseSync(join(decrypted, 'message', options.shard ?? 'message_0.db'))
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
      local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER,
      create_time INTEGER, real_sender_id INTEGER, message_content TEXT,
      server_id INTEGER, source TEXT
    )`)
    const content = localType === 49
      ? `<msg><appmsg><title>${fileName}</title><type>6</type><appattach>`
        + `<totallen>${declaredSize}</totallen><fileext>${fileName.split('.').pop() ?? ''}</fileext>`
        + `<md5>${declaredMd5}</md5></appattach></appmsg></msg>`
      : `<msg><img md5="${declaredMd5}" /></msg>`
    db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(localId, localId, localType, 0, createTime, 0, content, localId, null)
    db.close()
    return { raw, username, localId, body, sourcePath }
  }

  it('exportSnsImage writes the archived original bytes and accepts the UI key alias', async () => {
    const root = tempDir()
    const decoded = join(root, 'decoded_images')
    mkdirSync(join(root, 'decrypted'), { recursive: true })
    mkdirSync(decoded, { recursive: true })
    const md5 = createHash('md5').update(HEIF).digest('hex')
    saveArchivedOriginal(decoded, md5, HEIF)
    const dest = join(root, 'saved-original.heif')
    const result = await mediaRemotes(root).exportSnsImage({
      md5,
      key: 'front-end-key-alias',
      dest,
    })
    expect(result).toMatchObject({ ok: true, source: 'local', format: 'heif', bytes: HEIF.length })
    expect(readFileSync(dest).equals(HEIF)).toBe(true)
  })

  it('exportSnsImage corrects a PNG requested as .jpg and returns the actual path', async () => {
    const root = tempDir()
    const decoded = join(root, 'decoded_images')
    mkdirSync(join(root, 'decrypted'), { recursive: true })
    mkdirSync(decoded, { recursive: true })
    const md5 = createHash('md5').update(PNG).digest('hex')
    saveArchivedOriginal(decoded, md5, PNG)
    const requested = join(root, 'sns-saved-as-jpeg.jpg')

    const result = await mediaRemotes(root).exportSnsImage({ md5, dest: requested })
    const finalPath = join(root, 'sns-saved-as-jpeg.png')
    expect(result).toMatchObject({
      ok: true, path: finalPath, source: 'local', format: 'png', bytes: PNG.length,
    })
    expect(readFileSync(finalPath).equals(PNG)).toBe(true)
    expect(existsSync(requested)).toBe(false)
  })

  it('exportSnsImage accepts a verified archived original keyed by the XML media MD5', async () => {
    const root = tempDir()
    const decoded = join(root, 'decoded_images')
    mkdirSync(join(root, 'decrypted'), { recursive: true })
    mkdirSync(decoded, { recursive: true })
    const claimedMd5 = createHash('md5').update('different original').digest('hex')
    saveArchivedOriginal(decoded, claimedMd5, JPEG)
    const dest = join(root, 'archived-original.jpg')
    const result = await mediaRemotes(root).exportSnsImage({ md5: claimedMd5, dest })
    // Real WeChat archives are keyed by the XML identity; decrypting and trimming
    // the CDN signature tail can produce bytes whose raw MD5 differs from that key.
    expect(result.ok).toBe(true)
    expect(readFileSync(dest).equals(JPEG)).toBe(true)
  })

  it('exportChatImage leaves no file when only a thumbnail cache entry exists', async () => {
    const root = tempDir()
    const decrypted = join(root, 'decrypted')
    const decoded = join(root, 'decoded_images')
    const username = 'wxid_thumbnail_only'
    const md5 = 'a1'.repeat(16)
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    mkdirSync(join(decoded, username), { recursive: true })
    writeFileSync(join(decoded, username, md5 + '.t.jpg'), imageBytes([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9], 20))

    const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
    const db = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    db.exec(`CREATE TABLE "${table}" (
      local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER,
      create_time INTEGER, real_sender_id INTEGER, message_content TEXT,
      server_id INTEGER, compress_content TEXT, packed_info_data BLOB, source TEXT
    )`)
    db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(1, 1, 3, 0, 1700000000, 0, `<msg><img md5="${md5}" /></msg>`, 1, '', Buffer.from(md5), null)
    db.close()

    const dest = join(root, 'must-not-exist.jpg')
    const result = await mediaRemotes(root).exportChatImage({ username, localId: 1, dest })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缩略图')
    expect(existsSync(dest)).toBe(false)
  })

  it('exportChatImage verifies the decoded plaintext MD5 before writing', async () => {
    const root = tempDir()
    const decrypted = join(root, 'decrypted')
    const decoded = join(root, 'decoded_images')
    const username = 'wxid_original'
    const bytes = imageBytes([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9], 40)
    const md5 = createHash('md5').update(bytes).digest('hex')
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    mkdirSync(join(decoded, username), { recursive: true })
    writeFileSync(join(decoded, username, md5 + '.jpg'), bytes)

    const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
    const db = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    db.exec(`CREATE TABLE "${table}" (
      local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER,
      create_time INTEGER, real_sender_id INTEGER, message_content TEXT,
      server_id INTEGER, compress_content TEXT, packed_info_data BLOB, source TEXT
    )`)
    db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(1, 1, 3, 0, 1700000000, 0, `<msg><img md5="${md5}" /></msg>`, 1, '', Buffer.from(md5), null)
    db.close()

    const dest = join(root, 'saved-original.jpg')
    const result = await mediaRemotes(root).exportChatImage({ username, localId: 1, dest })
    expect(result).toMatchObject({ ok: true, format: 'jpg', bytes: bytes.length })
    expect(readFileSync(dest).equals(bytes)).toBe(true)
  })

  it('exportChatImage corrects a PNG requested as .jpg', async () => {
    const root = tempDir()
    const decrypted = join(root, 'decrypted')
    const decoded = join(root, 'decoded_images')
    const username = 'wxid_original_png'
    const md5 = createHash('md5').update(PNG).digest('hex')
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    mkdirSync(join(decoded, username), { recursive: true })
    writeFileSync(join(decoded, username, md5 + '.png'), PNG)

    const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
    const db = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    db.exec(`CREATE TABLE "${table}" (
      local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER,
      create_time INTEGER, real_sender_id INTEGER, message_content TEXT,
      server_id INTEGER, compress_content TEXT, packed_info_data BLOB, source TEXT
    )`)
    db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(1, 1, 3, 0, 1700000000, 0, `<msg><img md5="${md5}" /></msg>`, 1, '', Buffer.from(md5), null)
    db.close()

    const requested = join(root, 'chat-saved-as-jpeg.jpg')
    const result = await mediaRemotes(root).exportChatImage({ username, localId: 1, dest: requested })
    const finalPath = join(root, 'chat-saved-as-jpeg.png')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'png', bytes: PNG.length })
    expect(readFileSync(finalPath).equals(PNG)).toBe(true)
    expect(existsSync(requested)).toBe(false)
  })

  it('exportFileImage writes verified original bytes and corrects a wrong extension', async () => {
    const root = tempDir()
    const decoded = join(root, 'decoded_images')
    mkdirSync(decoded, { recursive: true })
    const key = createHash('md5').update(PNG).digest('hex')
    writeFileSync(join(decoded, key + '.png'), PNG)
    const requested = join(root, 'saved-as-jpeg.jpg')

    const result = await mediaRemotes(root).exportFileImage({ md5: key, dest: requested })
    const finalPath = join(root, 'saved-as-jpeg.png')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'png', bytes: PNG.length })
    expect(readFileSync(finalPath).equals(PNG)).toBe(true)
    expect(existsSync(requested)).toBe(false)
  })

  it('exportFileImage rejects a thumbnail-only cache and creates no target', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const decoded = join(root, 'decoded_images')
    const key = 'b4'.repeat(16)
    mkdirSync(join(raw, 'msg', 'attach', '2026-01', 'thumb'), { recursive: true })
    mkdirSync(decoded, { recursive: true })
    writeFileSync(join(raw, 'msg', 'attach', '2026-01', 'thumb', key + '_t.dat'), Buffer.from([7, 8, 86, 50]))
    writeFileSync(join(decoded, key + '.t.jpg'), JPEG)
    const requested = join(root, 'file-thumb-as-original.jpg')

    const result = await mediaRemotes(root, raw).exportFileImage({ md5: key, dest: requested })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缩略图')
    expect(existsSync(requested)).toBe(false)
    expect(existsSync(join(root, 'file-thumb-as-original.png'))).toBe(false)
  })

  it('exportFileVideo copies the local original and rejects a non-video source', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const md5 = createHash('md5').update(MP4).digest('hex')
    const dir = join(raw, 'msg', 'video', '2026-01')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, md5 + '.mp4'), MP4)
    mkdirSync(join(root, 'decoded_images'), { recursive: true })

    const result = await mediaRemotes(root, raw).exportFileVideo({
      md5,
      dest: join(root, 'saved.mov'),
    })
    const finalPath = join(root, 'saved.mp4')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'mp4', bytes: MP4.length })
    expect(readFileSync(finalPath).equals(MP4)).toBe(true)

    writeFileSync(join(dir, md5 + '.mp4'), JPEG)
    const rejected = await mediaRemotes(root, raw).exportFileVideo({
      md5,
      dest: join(root, 'rejected.mp4'),
    })
    expect(rejected.ok).toBe(false)
    expect(existsSync(join(root, 'rejected.mp4'))).toBe(false)
  })

  it('exportFileAttachment copies the exact attachment bytes', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const fileDir = join(raw, 'msg', 'file', '2026-01')
    mkdirSync(fileDir, { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const body = Buffer.from('attachment bytes: 2026-11-04', 'utf8')
    const md5 = createHash('md5').update(body).digest('hex')
    writeFileSync(join(fileDir, 'report.txt'), body)
    const dest = join(root, 'saved-report.txt')

    const result = await mediaRemotes(root, raw).exportFileAttachment({
      fileName: 'report.txt',
      size: body.length,
      md5,
      dest,
    })
    expect(result).toMatchObject({ ok: true, path: dest, bytes: body.length, source: 'local' })
    expect(readFileSync(dest).equals(body)).toBe(true)

    const rejectedDest = join(root, 'rejected-report.txt')
    const rejected = await mediaRemotes(root, raw).exportFileAttachment({
      fileName: 'report.txt',
      size: body.length,
      md5: 'f'.repeat(32),
      dest: rejectedDest,
    })
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('MD5')
    expect(existsSync(rejectedDest)).toBe(false)
  })

  it('exportFileAttachment preserves an existing destination when MD5 does not match', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const fileDir = join(raw, 'msg', 'file', '2026-01')
    mkdirSync(fileDir, { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const body = Buffer.from('trusted existing destination', 'utf8')
    const source = Buffer.from('different message attachment', 'utf8')
    writeFileSync(join(fileDir, 'report.txt'), source)
    const dest = join(root, 'existing-report.txt')
    writeFileSync(dest, body)

    const result = await mediaRemotes(root, raw).exportFileAttachment({
      fileName: 'report.txt',
      size: source.length,
      md5: createHash('md5').update('not the source').digest('hex'),
      dest,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('MD5')
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  it('exportFileAttachment refuses ambiguous same-name files without an MD5', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    mkdirSync(join(raw, 'msg', 'file', '2026-01'), { recursive: true })
    mkdirSync(join(raw, 'msg', 'file', '2026-02'), { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const body = Buffer.from('same length but different attachment bytes')
    writeFileSync(join(raw, 'msg', 'file', '2026-01', 'report.txt'), body)
    writeFileSync(join(raw, 'msg', 'file', '2026-02', 'report.txt'), Buffer.concat([
      Buffer.from('X'),
      body.subarray(1),
    ]))
    const dest = join(root, 'ambiguous-report.txt')

    const result = await mediaRemotes(root, raw).exportFileAttachment({
      fileName: 'report.txt',
      size: body.length,
      dest,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缺少 MD5')
    expect(existsSync(dest)).toBe(false)
  })

  it('exportChatFile copies exact bytes above the old 16 MiB data-URL limit', async () => {
    const root = tempDir()
    const body = Buffer.alloc(16 * 1024 * 1024 + 257, 0x61)
    const fixture = writeChatFileMessage(root, { body, fileName: 'large-report.txt' })
    const dest = join(root, 'saved-large-report.txt')

    const result = await mediaRemotes(root, fixture.raw).exportChatFile({
      username: fixture.username,
      localId: fixture.localId,
      dest,
    })

    expect(result).toMatchObject({
      ok: true,
      path: dest,
      bytes: body.length,
      format: 'txt',
      source: 'local',
    })
    expect(statSync(dest).size).toBe(body.length)
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  it('exportChatFile rejects missing messages and non-file cards without creating a target', async () => {
    const root = tempDir()
    const fixture = writeChatFileMessage(root)
    const missingDest = join(root, 'missing.txt')
    const missing = await mediaRemotes(root, fixture.raw).exportChatFile({
      username: fixture.username,
      localId: fixture.localId + 100,
      dest: missingDest,
    })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('找不到')
    expect(existsSync(missingDest)).toBe(false)

    const image = writeChatFileMessage(root, {
      localId: 2,
      fileName: 'not-a-file.jpg',
      localType: 3,
    })
    const nonFileDest = join(root, 'not-a-file.jpg')
    const nonFile = await mediaRemotes(root, image.raw).exportChatFile({
      username: image.username,
      localId: image.localId,
      dest: nonFileDest,
    })
    expect(nonFile.ok).toBe(false)
    expect(nonFile.error).toContain('不是文件消息')
    expect(existsSync(nonFileDest)).toBe(false)
  })

  it('exportChatFile rejects duplicate local ids across shards', async () => {
    const root = tempDir()
    const one = writeChatFileMessage(root, { shard: 'message_0.db' })
    writeChatFileMessage(root, { shard: 'message_1.db' })
    const dest = join(root, 'ambiguous.txt')

    const result = await mediaRemotes(root, one.raw).exportChatFile({
      username: one.username,
      localId: one.localId,
      dest,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('不唯一')
    expect(existsSync(dest)).toBe(false)
  })

  it('exportChatFile rejects MD5 and size mismatches from the canonical message row', async () => {
    const root = tempDir()
    const wrongMd5 = writeChatFileMessage(root, {
      fileName: 'wrong-md5.txt',
      declaredMd5: 'f'.repeat(32),
    })
    const wrongMd5Dest = join(root, 'wrong-md5.txt')
    const md5Result = await mediaRemotes(root, wrongMd5.raw).exportChatFile({
      username: wrongMd5.username,
      localId: wrongMd5.localId,
      dest: wrongMd5Dest,
    })
    expect(md5Result.ok).toBe(false)
    expect(md5Result.error).toContain('MD5')
    expect(existsSync(wrongMd5Dest)).toBe(false)

    const wrongSize = writeChatFileMessage(root, {
      localId: 2,
      fileName: 'wrong-size.txt',
      declaredSize: Buffer.byteLength('exact chat attachment bytes') + 1,
    })
    const wrongSizeDest = join(root, 'wrong-size.txt')
    const sizeResult = await mediaRemotes(root, wrongSize.raw).exportChatFile({
      username: wrongSize.username,
      localId: wrongSize.localId,
      dest: wrongSizeDest,
    })
    expect(sizeResult.ok).toBe(false)
    expect(sizeResult.error).toContain('大小')
    expect(existsSync(wrongSizeDest)).toBe(false)
  })

  it('exportFileVideo locates MOV and M4V originals and corrects the extension', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const dir = join(raw, 'msg', 'video', '2026-01')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const movMd5 = createHash('md5').update(MOV).digest('hex')
    const m4vMd5 = createHash('md5').update(M4V).digest('hex')
    writeFileSync(join(dir, movMd5 + '.mov'), MOV)
    writeFileSync(join(dir, m4vMd5 + '.m4v'), M4V)

    const mov = await mediaRemotes(root, raw).exportFileVideo({
      md5: movMd5,
      dest: join(root, 'file-mov-as-mp4.mp4'),
    })
    const movPath = join(root, 'file-mov-as-mp4.mov')
    expect(mov).toMatchObject({ ok: true, path: movPath, format: 'mov', bytes: MOV.length })
    expect(readFileSync(movPath).equals(MOV)).toBe(true)

    const m4v = await mediaRemotes(root, raw).exportFileVideo({
      md5: m4vMd5,
      dest: join(root, 'file-m4v-as-mp4.mp4'),
    })
    const m4vPath = join(root, 'file-m4v-as-mp4.m4v')
    expect(m4v).toMatchObject({ ok: true, path: m4vPath, format: 'm4v', bytes: M4V.length })
    expect(readFileSync(m4vPath).equals(M4V)).toBe(true)
  })

  it('exportSnsVideo corrects a MOV requested as .mp4', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    mkdirSync(join(root, 'decrypted'), { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const videoDir = join(raw, 'msg', 'video', '2026-01')
    mkdirSync(videoDir, { recursive: true })
    const md5 = createHash('md5').update(MOV).digest('hex')
    writeFileSync(join(videoDir, md5 + '.mov'), MOV)
    const requested = join(root, 'sns-video-as-mp4.mp4')

    const result = await mediaRemotes(root, raw).exportSnsVideo({ md5, dest: requested })
    const finalPath = join(root, 'sns-video-as-mp4.mov')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'mov', source: 'local', bytes: MOV.length })
    expect(readFileSync(finalPath).equals(MOV)).toBe(true)
    expect(existsSync(requested)).toBe(false)
  })

  it('exportSnsVideo finds and exports an M4V from the local Moments cache', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    mkdirSync(join(root, 'decrypted'), { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const videoDir = join(raw, 'cache', '2026-11', 'Sns', 'Video', 'ab')
    mkdirSync(videoDir, { recursive: true })
    const md5 = createHash('md5').update(M4V).digest('hex')
    writeFileSync(join(videoDir, 'opaque-cache-name.m4v'), M4V)
    const requested = join(root, 'sns-m4v-as-mp4.mp4')

    const result = await mediaRemotes(root, raw).exportSnsVideo({ md5, dest: requested })
    const finalPath = join(root, 'sns-m4v-as-mp4.m4v')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'm4v', source: 'local', bytes: M4V.length })
    expect(readFileSync(finalPath).equals(M4V)).toBe(true)
    expect(existsSync(requested)).toBe(false)
  })

  it('exportChatVideo copies the message video, rejects non-video bytes, and leaves no file when absent', async () => {
    const root = tempDir()
    const decrypted = join(root, 'decrypted')
    const raw = join(root, 'raw')
    const username = 'wxid_video_export'
    const body = MP4
    const md5 = createHash('md5').update(body).digest('hex')
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const videoDir = join(raw, 'msg', 'video', '2026-01')
    mkdirSync(videoDir, { recursive: true })
    writeFileSync(join(videoDir, md5 + '.mp4'), body)

    const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
    const db = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    db.exec(`CREATE TABLE "${table}" (
      local_id INTEGER, local_type INTEGER, packed_info_data TEXT
    )`)
    db.prepare(`INSERT INTO "${table}" VALUES (?,?,?)`)
      .run(1, 43, Array.from(Buffer.from(md5, 'utf8')).join(','))
    db.close()

    const result = await mediaRemotes(root, raw).exportChatVideo({
      username,
      localId: 1,
      dest: join(root, 'chat-video.bin'),
    })
    const finalPath = join(root, 'chat-video.mp4')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'mp4' })
    expect(readFileSync(finalPath).equals(body)).toBe(true)

    writeFileSync(join(videoDir, md5 + '.mp4'), JPEG)
    const rejected = await mediaRemotes(root, raw).exportChatVideo({
      username,
      localId: 1,
      dest: join(root, 'chat-video-rejected.mp4'),
    })
    expect(rejected.ok).toBe(false)
    expect(existsSync(join(root, 'chat-video-rejected.mp4'))).toBe(false)

    const absent = await mediaRemotes(root, raw).exportChatVideo({
      username,
      localId: 2,
      dest: join(root, 'absent.mp4'),
    })
    expect(absent.ok).toBe(false)
    expect(existsSync(join(root, 'absent.mp4'))).toBe(false)
  })

  it('exportFavoriteImage refuses to guess from a thumbnail MD5', async () => {
    const root = tempDir()
    const dest = join(root, 'favorite-thumb.jpg')
    const result = await mediaRemotes(root).exportFavoriteImage({
      md5: 'c3'.repeat(16),
      thumbMd5: 'c3'.repeat(16),
      kind: 'image',
      dest,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缺少原图 MD5')
    expect(existsSync(dest)).toBe(false)
  })

  it('exportFavoriteImage writes the full-MD5 original and corrects the extension', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const bucket = join(raw, 'business', 'favorite', 'data')
    mkdirSync(bucket, { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const md5 = createHash('md5').update(PNG).digest('hex')
    writeFileSync(join(bucket, 'opaque-cache-file'), PNG)
    const requested = join(root, 'favorite-as-jpeg.jpg')

    const result = await mediaRemotes(root, raw).exportFavoriteImage({
      fullMd5: md5,
      kind: 'image',
      dest: requested,
    })
    const finalPath = join(root, 'favorite-as-jpeg.png')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'png', bytes: PNG.length, source: 'local' })
    expect(readFileSync(finalPath).equals(PNG)).toBe(true)
    expect(existsSync(requested)).toBe(false)
  })

  it('exportFavoriteVideo writes only the full-MD5 video body and corrects the extension', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const bucket = join(raw, 'business', 'favorite', 'data')
    mkdirSync(bucket, { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const md5 = createHash('md5').update(MOV).digest('hex')
    writeFileSync(join(bucket, 'opaque-video-cache'), MOV)
    const requested = join(root, 'favorite-video-as-mp4.mp4')

    const result = await mediaRemotes(root, raw).exportFavoriteVideo({
      fullMd5: md5,
      kind: 'video',
      dest: requested,
    })
    const finalPath = join(root, 'favorite-video-as-mp4.mov')
    expect(result).toMatchObject({ ok: true, path: finalPath, format: 'mov', bytes: MOV.length, source: 'local' })
    expect(readFileSync(finalPath).equals(MOV)).toBe(true)
    expect(existsSync(requested)).toBe(false)

    const noFullMd5 = await mediaRemotes(root, raw).exportFavoriteVideo({
      md5,
      kind: 'video',
      dest: join(root, 'must-not-save.mp4'),
    })
    expect(noFullMd5.ok).toBe(false)
    expect(noFullMd5.error).toContain('缺少原视频 MD5')
    expect(existsSync(join(root, 'must-not-save.mp4'))).toBe(false)
  })

  it('exportFavoriteFile keeps the exact favorite attachment bytes from the favorite cache', async () => {
    const root = tempDir()
    const raw = join(root, 'raw')
    const bucket = join(raw, 'business', 'favorite', 'temp', 'opaque')
    mkdirSync(bucket, { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    const body = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('favorite-docx-body'),
    ])
    const fullMd5 = createHash('md5').update(body).digest('hex')
    writeFileSync(join(bucket, 'stored-without-extension'), body)
    const dest = join(root, '收藏附件.docx')

    const result = await mediaRemotes(root, raw).exportFavoriteFile({
      fullMd5,
      kind: 'file',
      dest,
    })
    expect(result).toMatchObject({ ok: true, path: dest, bytes: body.length, source: 'local' })
    expect(readFileSync(dest).equals(body)).toBe(true)

    const wrongMd5Dest = join(root, 'must-not-save.pdf')
    const rejected = await mediaRemotes(root, raw).exportFavoriteFile({
      fullMd5: '0'.repeat(32),
      kind: 'file',
      dest: wrongMd5Dest,
    })
    expect(rejected.ok).toBe(false)
    expect(existsSync(wrongMd5Dest)).toBe(false)
  })

  it('registers every single-resource original export on the media factory and gateway', () => {
    const media = readFileSync(join(HERE, '..', 'src', 'remotes', 'media.ts'), 'utf8')
    const gateway = readFileSync(join(HERE, '..', 'src', 'gateway-media-ops.ts'), 'utf8')
    expect(media).toContain('createOriginalMediaExportRemotes(rc)')
    expect(media).toContain('createFavoriteMediaRemotes(rc)')
    for (const method of [
      'exportSnsVideo', 'exportSnsImage', 'exportChatImage', 'exportChatVideo', 'exportChatFile',
      'exportFileImage', 'exportFileVideo', 'exportFileAttachment',
      'exportFavoriteImage', 'exportFavoriteVideo', 'exportFavoriteFile',
    ]) {
      expect(gateway, `${method} 缺少 @Remote 接线`).toContain(`@Remote('${method}')`)
    }
  })
})

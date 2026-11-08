/**
 * Real chat-export media archive:
 * - image/video cover+body/voice/file/sticker bytes must match their source;
 * - missing local media must not fail the transcript export;
 * - HTML/JSON must reference the archived relative paths, not placeholder-only text.
 *
 * @vitest-environment node
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { exportSessionMessagesStreamed, formatCsv, formatMarkdown, formatSql, formatTxt, formatXlsx } from '../src/query/export.ts'
import type { ExportMediaLinks } from '../src/query/export-media.ts'
import type { WechatMessage } from '../src/types.ts'
import { crc32 } from '../src/query/zip.ts'

const USER = 'wxid_export_media'
const CREATE_TIME = Math.floor(Date.UTC(2023, 10, 15, 8, 0, 0) / 1000)
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])
const IMAGE_THUMB_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9])
const COVER_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 8, 7, 0xff, 0xd9])
const VIDEO_BYTES = Buffer.from('real-video-bytes-for-export')
const FILE_BYTES = Buffer.from('real-pdf-attachment-bytes')
const STICKER_BYTES = Buffer.from('GIF89a-real-sticker')
const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(96, 7)])
const THUMB_BYTES = COVER_BYTES

const IMAGE_MD5 = createHash('md5').update(IMAGE_BYTES).digest('hex')
const MISSING_IMAGE_MD5 = '22222222222222222222222222222222'
const VIDEO_MD5 = createHash('md5').update(VIDEO_BYTES).digest('hex')
const STICKER_MD5 = createHash('md5').update(STICKER_BYTES).digest('hex')
const VOICE_SVR_ID = '9876543210123'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

function monthOf(ts: number): string {
  const d = new Date(ts * 1000)
  return String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

function msgTable(): string {
  return 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
}

function createFixture(): {
  root: string
  decrypted: string
  decoded: string
  raw: string
  out: string
} {
  const root = tempDir('wx-export-media-')
  const decrypted = join(root, 'decrypted')
  const decoded = join(root, 'decoded_images')
  const raw = join(root, 'raw')
  const out = join(root, 'out')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(decoded, { recursive: true })
  mkdirSync(raw, { recursive: true })
  mkdirSync(out, { recursive: true })

  mkdirSync(join(decoded, USER), { recursive: true })
  writeFileSync(join(decoded, USER, IMAGE_MD5 + '.jpg'), IMAGE_BYTES)
  writeFileSync(join(decoded, STICKER_MD5 + '.gif'), STICKER_BYTES)
  mkdirSync(join(decoded, 'voices'), { recursive: true })
  writeFileSync(join(decoded, 'voices', VOICE_SVR_ID + '.wav'), WAV_BYTES)

  const month = monthOf(CREATE_TIME)
  mkdirSync(join(raw, 'msg', 'video', month), { recursive: true })
  writeFileSync(join(raw, 'msg', 'video', month, VIDEO_MD5 + '.mp4'), VIDEO_BYTES)
  writeFileSync(join(raw, 'msg', 'video', month, VIDEO_MD5 + '_thumb.jpg'), THUMB_BYTES)
  mkdirSync(join(raw, 'msg', 'file', month), { recursive: true })
  writeFileSync(join(raw, 'msg', 'file', month, '报价单.pdf'), FILE_BYTES)

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const table = msgTable()
  mdb.exec(`CREATE TABLE "${table}" (
    local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER,
    create_time INTEGER, real_sender_id INTEGER, message_content TEXT,
    server_id INTEGER, compress_content TEXT, packed_info_data BLOB, source TEXT
  )`)
  const ins = mdb.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  const imageXml = '<msg><img md5="' + IMAGE_MD5 + '" /></msg>'
  const missingImageXml = '<msg><img md5="' + MISSING_IMAGE_MD5 + '" /></msg>'
  const videoXml = '<msg><videomsg md5="' + VIDEO_MD5 + '" playlength="12" /></msg>'
  const voiceXml = '<msg><voicemsg voicelength="2400" /></msg>'
  const fileXml = '<msg><appmsg><title>报价单.pdf</title><type>6</type><appattach>'
    + '<totallen>' + String(FILE_BYTES.length) + '</totallen><fileext>pdf</fileext>'
    + '</appattach></appmsg></msg>'
  const stickerXml = '<msg><emoji md5="' + STICKER_MD5 + '" /></msg>'
  const rows: Array<{ id: number; type: number; xml: string; packed?: Buffer }> = [
    { id: 1, type: 3, xml: imageXml, packed: Buffer.from(IMAGE_MD5) },
    { id: 2, type: 43, xml: videoXml },
    { id: 3, type: 34, xml: voiceXml },
    { id: 4, type: 49, xml: fileXml },
    { id: 5, type: 47, xml: stickerXml },
    { id: 6, type: 3, xml: missingImageXml, packed: Buffer.from(MISSING_IMAGE_MD5) },
    { id: 7, type: 1, xml: '<msg><content>普通文本</content></msg>' },
  ]
  for (const row of rows) {
    ins.run(row.id, row.id, row.type, row.id === 7 ? 1 : 0, CREATE_TIME + row.id, 0, row.xml, row.id, '', row.packed ?? null, null)
  }
  mdb.close()

  const voiceDb = new DatabaseSync(join(decrypted, 'message', 'media_0.db'))
  voiceDb.exec('CREATE TABLE Name2Id (rowid INTEGER PRIMARY KEY, user_name TEXT)')
  voiceDb.exec('CREATE TABLE VoiceInfo (chat_name_id INTEGER, local_id INTEGER, svr_id INTEGER, create_time INTEGER)')
  voiceDb.prepare('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)').run(7, USER)
  voiceDb.prepare('INSERT INTO VoiceInfo (chat_name_id, local_id, svr_id, create_time) VALUES (?, ?, ?, ?)')
    .run(7, 3, Number(VOICE_SVR_ID), CREATE_TIME + 3)
  voiceDb.close()

  return { root, decrypted, decoded, raw, out }
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
  let off = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(dataStart, dataStart + csize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    expect(crc32(data), 'ZIP CRC mismatch: ' + name).toBe(buf.readUInt32LE(off + 16))
    out.push({ name, data })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function entry(entries: ZipEntry[], prefix: string): ZipEntry {
  const hit = entries.find((it) => it.name.startsWith(prefix))
  expect(hit, 'ZIP missing ' + prefix).toBeTruthy()
  return hit as ZipEntry
}

describe('session export writes real media files into the ZIP', () => {
  it('archives every available media type and reports one missing resource', async () => {
    const fixture = createFixture()
    const result = await exportSessionMessagesStreamed(fixture.decrypted, {
      username: USER,
      format: 'html',
      count: 0,
      dir: fixture.out,
      filename: 'chat',
      zip: true,
      decodedDir: fixture.decoded,
      wechatBaseDir: fixture.raw,
    })
    expect(existsSync(result.path)).toBe(true)
    expect(result.count).toBe(7)
    expect(result.mediaCount).toBe(5)
    expect(result.mediaMissingCount).toBe(1)

    const entries = unzip(readFileSync(result.path))
    expect(entry(entries, 'media/images/').data.equals(IMAGE_BYTES)).toBe(true)
    expect(entry(entries, 'media/videos/covers/').data.equals(COVER_BYTES)).toBe(true)
    const video = entries.find((it) => it.name.startsWith('media/videos/') && it.name.endsWith('.mp4'))
    expect(video?.data.equals(VIDEO_BYTES)).toBe(true)
    expect(entry(entries, 'media/voices/').data.equals(WAV_BYTES)).toBe(true)
    expect(entry(entries, 'media/files/').data.equals(FILE_BYTES)).toBe(true)
    expect(entry(entries, 'media/stickers/').data.equals(STICKER_BYTES)).toBe(true)

    const manifest = JSON.parse(entry(entries, 'record_media.json').data.toString('utf8')) as {
      version: number
      archive: {
        resourceCount: number
        missingCount: number
        originalCount: number
        thumbnailCount: number
        previewCount: number
        thumbnailOnlyCount: number
      }
      resources: Array<{ kind: string; status: string; quality?: string; archivePath?: string; messageLocalId: number }>
    }
    expect(manifest.version).toBe(3)
    expect(manifest.archive).toEqual({
      mediaRoot: 'media',
      resourceCount: 6,
      missingCount: 1,
      originalCount: 5,
      thumbnailCount: 0,
      previewCount: 1,
      thumbnailOnlyCount: 0,
    })
    const missing = manifest.resources.find((it) => it.status === 'missing')
    expect(missing).toMatchObject({ kind: 'image', messageLocalId: 6 })
    expect(manifest.resources.find((it) => it.kind === 'video' && it.messageLocalId === 2)?.quality).toBe('original')
    for (const item of manifest.resources.filter((it) => it.status === 'ok')) {
      expect(item.archivePath).toBeTruthy()
      expect(entries.some((it) => it.name === item.archivePath)).toBe(true)
    }

    const html = entry(entries, 'chat.html').data.toString('utf8')
    expect(html).toContain('<img src="media/images/')
    expect(html).toContain('<video controls')
    expect(html).toContain('poster="media/videos/covers/')
    expect(html).toContain('<audio controls')
    expect(html).toContain('class="media-file"')
    expect(html).toContain('media-missing')
    expect(html).not.toContain('[图片]</span>')
  })

  it('never writes a .t thumbnail and reports thumbnail_only without aborting the ZIP', async () => {
    const fixture = createFixture()
    rmSync(join(fixture.decoded, USER, IMAGE_MD5 + '.jpg'), { force: true })
    writeFileSync(join(fixture.decoded, USER, IMAGE_MD5 + '.t.jpg'), IMAGE_THUMB_BYTES)
    const result = await exportSessionMessagesStreamed(fixture.decrypted, {
      username: USER,
      format: 'html',
      count: 0,
      dir: fixture.out,
      filename: 'thumb',
      zip: true,
      decodedDir: fixture.decoded,
      wechatBaseDir: fixture.raw,
    })
    expect(result.mediaCount).toBe(4)
    expect(result.mediaMissingCount).toBe(2)
    const entries = unzip(readFileSync(result.path))
    const manifest = JSON.parse(entry(entries, 'record_media.json').data.toString('utf8')) as {
      archive: {
        resourceCount: number
        missingCount: number
        originalCount: number
        thumbnailCount: number
        previewCount: number
        thumbnailOnlyCount: number
      }
      resources: Array<{
        kind: string
        status: string
        messageLocalId: number
        quality?: string
        archivePath?: string
        thumbnailOnly?: boolean
        error?: string
      }>
    }
    const image = manifest.resources.find((it) => it.kind === 'image' && it.messageLocalId === 1)
    expect(image).toMatchObject({
      status: 'missing',
      quality: 'thumbnail',
      thumbnailOnly: true,
    })
    expect(image?.archivePath).toBeUndefined()
    expect(image?.error).toContain('thumbnail_only')
    expect(entries.some((it) => it.name.startsWith('media/images/'))).toBe(false)
    expect(entries.some((it) => it.data.equals(IMAGE_THUMB_BYTES))).toBe(false)
    expect(manifest.archive).toEqual({
      mediaRoot: 'media',
      resourceCount: 5,
      missingCount: 2,
      originalCount: 4,
      thumbnailCount: 0,
      previewCount: 1,
      thumbnailOnlyCount: 1,
    })
  })

  it('writes resource paths into JSON and keeps CSV UTF-8 BOM/resource column', async () => {
    const fixture = createFixture()
    const result = await exportSessionMessagesStreamed(fixture.decrypted, {
      username: USER,
      format: 'json',
      count: 0,
      dir: fixture.out,
      filename: 'chat',
      zip: true,
      decodedDir: fixture.decoded,
      wechatBaseDir: fixture.raw,
    })
    const entries = unzip(readFileSync(result.path))
    const json = JSON.parse(entry(entries, 'chat.json').data.toString('utf8')) as Array<{
      localId: number
      resources?: Array<{ path?: string; status: string }>
    }>
    const image = json.find((it) => it.localId === 1)
    expect(image?.resources?.[0]).toMatchObject({ status: 'ok', path: expect.stringContaining('media/images/') })
    const missing = json.find((it) => it.localId === 6)
    expect(missing?.resources?.[0]).toMatchObject({ status: 'missing' })

    const message = { localId: 1, type: 3, isSender: 0, createTime: CREATE_TIME, displayText: '[图片]' } as WechatMessage
    const links: ExportMediaLinks = new Map([[1, [{
      id: 'media_0001',
      kind: 'image',
      role: 'content',
      status: 'ok',
      label: '图片',
      messageLocalId: 1,
      messageLocalIds: [1],
      messageTime: CREATE_TIME,
      sender: '',
      archivePath: 'media/images/1_image.jpg',
      mime: 'image/jpeg',
      size: IMAGE_BYTES.length,
    }]]])
    const csv = formatCsv([message], USER, links)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.split('\r\n')[0]).toContain('资源')
    expect(csv).toContain('media/images/1_image.jpg')
  })

  it('keeps the same resource path in Markdown, TXT, SQL and XLSX', () => {
    const message = { localId: 1, type: 3, isSender: 0, createTime: CREATE_TIME, displayText: '[图片]' } as WechatMessage
    const links: ExportMediaLinks = new Map([[1, [{
      id: 'media_0001',
      kind: 'image',
      role: 'content',
      status: 'ok',
      label: '图片',
      messageLocalId: 1,
      messageLocalIds: [1],
      messageTime: CREATE_TIME,
      sender: '',
      archivePath: 'media/images/1_image.jpg',
      mime: 'image/jpeg',
      size: IMAGE_BYTES.length,
    }]]])
    expect(formatMarkdown([message], USER, links)).toContain('![图片](media/images/1_image.jpg)')
    expect(formatTxt([message], USER, links)).toContain('图片：media/images/1_image.jpg')
    expect(formatSql([message], USER, links)).toContain('resources TEXT')
    const xlsx = unzip(Buffer.from(formatXlsx([message], USER, undefined, links)))
    const sheet = xlsx.find((it) => it.name === 'xl/worksheets/sheet1.xml')?.data.toString('utf8') ?? ''
    expect(sheet).toContain('资源')
    expect(sheet).toContain('media/images/1_image.jpg')
  })

  it('downgrades a file that disappears between planning and writing without failing the archive', async () => {
    const fixture = createFixture()
    const videoPath = join(fixture.raw, 'msg', 'video', monthOf(CREATE_TIME), VIDEO_MD5 + '.mp4')
    let removed = false
    const result = await exportSessionMessagesStreamed(fixture.decrypted, {
      username: USER,
      format: 'html',
      count: 0,
      dir: fixture.out,
      filename: 'chat',
      zip: true,
      decodedDir: fixture.decoded,
      wechatBaseDir: fixture.raw,
      onProgress: (progress) => {
        if (!removed && progress.phase === 'media' && progress.done === 7) {
          removed = true
          rmSync(videoPath, { force: true })
        }
      },
    })
    expect(removed).toBe(true)
    expect(result.mediaMissingCount).toBe(2)
    const entries = unzip(readFileSync(result.path))
    const manifest = JSON.parse(entry(entries, 'record_media.json').data.toString('utf8')) as {
      resources: Array<{ kind: string; status: string; archivePath?: string; error?: string }>
    }
    const video = manifest.resources.find((it) => it.kind === 'video')
    expect(video).toMatchObject({ status: 'error' })
    expect(video?.archivePath).toBeUndefined()
    expect(video?.error).toBeTruthy()
    expect(entries.some((it) => it.name === video?.archivePath)).toBe(false)
    expect(entry(entries, 'media/images/').data.equals(IMAGE_BYTES)).toBe(true)
    expect(entry(entries, 'media/voices/').data.equals(WAV_BYTES)).toBe(true)
    expect(entry(entries, 'chat.html').data.toString('utf8')).toContain('视频未导出')
  })

  it('cancels atomically and leaves neither partial archives nor stream-entry temp files', async () => {
    const fixture = createFixture()
    const videoPath = join(fixture.raw, 'msg', 'video', monthOf(CREATE_TIME), VIDEO_MD5 + '.mp4')
    writeFileSync(videoPath, randomBytes(256 * 1024))
    const controller = new AbortController()
    let cancelRequested = false
    let failure: unknown
    try {
      await exportSessionMessagesStreamed(fixture.decrypted, {
        username: USER,
        format: 'html',
        count: 0,
        dir: fixture.out,
        filename: 'chat',
        zip: true,
        decodedDir: fixture.decoded,
        wechatBaseDir: fixture.raw,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!cancelRequested && progress.phase === 'compress') {
            cancelRequested = true
            controller.abort()
          }
        },
      })
    } catch (e) {
      failure = e
    }
    expect(cancelRequested).toBe(true)
    expect((failure as Error).name).toBe('AbortError')
    expect(existsSync(join(fixture.out, 'chat.zip'))).toBe(false)
    expect(readdirSync(fixture.out).filter((name) => name.includes('.partial-') || name.includes('.entry-'))).toEqual([])
  })
})

// @vitest-environment node
/**
 * Live Photo support for moments.
 *
 * Real WeChat XML stores the motion video inside the outer image:
 * `<media>...image...<LivePhoto><liveMedia>...video...</liveMedia></LivePhoto></media>`.
 * The parser must expose it as `images[].livePhoto`, never as a separate video tile.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureMomentsArchiveFresh,
  parseSnsXml,
  queryMoments,
} from '../src/query/moments.ts'
import { upsertArchivedMoments } from '../src/query/moments-archive.ts'
import { createMediaRemotes } from '../src/remotes/media.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0, scratch.length)) rmSync(dir, { recursive: true, force: true })
})

const IMAGE_MD5 = '6d72f08507692b2529c6810716584153'
const VIDEO_MD5 = '62243cb638565ad6d5a365c15716142a'
const VIDEO_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(16, 0x22),
])

function liveMedia(videoMd5: string): string {
  return '<LivePhoto><liveMedia>'
    + '<id>0</id><type>6</type>'
    + `<url md5="${videoMd5}">http://szzjwxsns.video.qq.com/102/20202/snsvideodownload?encfilekey=x&amp;token=y&amp;idx=1</url>`
    + '<thumb type="1">http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1</thumb>'
    + '<size width="316" height="420" totalSize="2042268"/>'
    + '<videoDuration>3.03</videoDuration>'
    + '<liveStillImageTimeMs>1466</liveStillImageTimeMs>'
    + '<enc key="1474243079">1</enc>'
    + '</liveMedia></LivePhoto>'
}

function momentXml(opts: {
  timelineId?: string
  imageId?: string
  videoMd5?: string
  withLive?: boolean
  withSecondImage?: boolean
} = {}): string {
  const timelineId = opts.timelineId ?? 'tl-live-1'
  const imageId = opts.imageId ?? 'img-live-1'
  const live = opts.withLive === false ? '' : liveMedia(opts.videoMd5 ?? VIDEO_MD5)
  const second = opts.withSecondImage === true
    ? '<media><id>img-plain-2</id><type>2</type>'
      + '<url md5="11111111111111111111111111111111" key="plain-seed" token="tk-plain">http://shmmsns.qpic.cn/mmsns/plain/0</url>'
      + '<thumb key="plain-seed" token="tk-plain">http://shmmsns.qpic.cn/mmsns/plain/150</thumb>'
      + '<enc>0</enc></media>'
    : ''
  return '<SnsDataItem><TimelineObject>'
    + `<id>${timelineId}</id><createTime>1792240123</createTime>`
    + '<contentDesc><![CDATA[live photo fixture]]></contentDesc>'
    + '<ContentObject><type>54</type><mediaList>'
    + '<media>'
    + `<id>${imageId}</id><type>2</type>`
    + `<url md5="${IMAGE_MD5}" key="image-seed" token="tk-image">http://szmmsns.qpic.cn/mmsns/image/0</url>`
    + '<thumb key="image-seed" token="tk-image">http://szmmsns.qpic.cn/mmsns/image/150</thumb>'
    + '<videoDuration>0</videoDuration><enc>0</enc>'
    + live
    + '</media>'
    + second
    + '</mediaList></ContentObject></TimelineObject></SnsDataItem>'
}

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(root)
  return root
}

function writeLiveMomentDb(decrypted: string, xml: string): void {
  const dir = join(decrypted, 'sns', 'db_sns')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'sns.db'))
  db.exec('CREATE TABLE SnsTimeLine (tid TEXT, user_name TEXT, content TEXT)')
  db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run('-3412344236794441123', 'wxid_live', xml)
  db.close()
}

describe('parseSnsXml: live photo', () => {
  it('attaches liveMedia to the outer image and does not create a video tile', () => {
    const r = parseSnsXml(momentXml())
    expect(r.videos).toEqual([])
    expect(r.mediaDesc).toBe('图片×1')
    expect(r.images).toHaveLength(1)
    expect(r.images[0]).toMatchObject({
      id: 'img-live-1',
      md5: IMAGE_MD5,
      key: 'image-seed',
      token: 'tk-image',
      timelineId: 'tl-live-1',
    })
    expect(r.images[0]?.livePhoto).toEqual({
      url: 'http://szzjwxsns.video.qq.com/102/20202/snsvideodownload?encfilekey=x&token=y&idx=1',
      thumb: 'http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1',
      key: '1474243079',
      md5: VIDEO_MD5,
      duration: 3.03,
      stillImageTimeMs: 1466,
      timelineId: 'tl-live-1',
    })
  })

  it('keeps a plain image without livePhoto when live and normal images are mixed', () => {
    const r = parseSnsXml(momentXml({ withSecondImage: true }))
    expect(r.images).toHaveLength(2)
    expect(r.images[0]?.livePhoto?.md5).toBe(VIDEO_MD5)
    expect(r.images[1]?.livePhoto).toBeUndefined()
    expect(r.videos).toEqual([])
    expect(r.mediaDesc).toBe('图片×2')
  })
})

describe('live photo backend data flow', () => {
  it('feeds image.livePhoto metadata into the existing video RPC', async () => {
    const root = makeRoot('moments-live-rpc-')
    const base = join(root, 'wechat-base')
    const videoDir = join(base, 'cache', '2026-11', 'Sns', 'Video', 'aa')
    mkdirSync(videoDir, { recursive: true })
    writeFileSync(join(videoDir, 'live.mp4'), VIDEO_BYTES)

    const parsed = parseSnsXml(momentXml({ videoMd5: createHash('md5').update(VIDEO_BYTES).digest('hex') }))
    const live = parsed.images[0]?.livePhoto
    expect(live).toBeDefined()

    const remotes = createMediaRemotes({
      dirs: () => ({ decrypted: join(root, 'decrypted'), decoded: join(root, 'decoded') }),
      op: () => {},
      rawWechatBase: () => base,
      decryptState: { active: false, op: null } as never,
      warmDecodedImages: async () => {},
    })
    const got = await remotes.getSnsVideoDataUrl({
      md5: live?.md5,
      timelineId: live?.timelineId,
      mediaId: live?.id,
      url: live?.url,
      key: live?.key,
    })
    expect(got.url).toMatch(/^data:video\/mp4;base64,/)
    expect(Buffer.from(got.url?.split(',')[1] ?? '', 'base64').equals(VIDEO_BYTES)).toBe(true)
  })

  it('reparses an old archived payload once the parser-versioned content hash changes', () => {
    const root = makeRoot('moments-live-archive-')
    const decrypted = join(root, 'decrypted')
    mkdirSync(decrypted, { recursive: true })
    const xml = momentXml()
    writeLiveMomentDb(decrypted, xml)

    const oldHash = createHash('sha1').update(xml).digest('hex')
    const oldPayload = {
      tid: '-3412344236794441123',
      username: 'wxid_live',
      author: 'wxid_live',
      text: 'live photo fixture',
      ts: 1792240123,
      time: '',
      media_count: 1,
      media_desc: '图片×1',
      images: [{
        id: 'img-live-1',
        timelineId: 'tl-live-1',
        md5: IMAGE_MD5,
        url: 'http://szmmsns.qpic.cn/mmsns/image/0',
        thumb: 'http://szmmsns.qpic.cn/mmsns/image/150',
      }],
      videos: [],
      location: '',
      link_title: '',
      link_url: '',
      is_self: false,
      likes: [],
      comments: [],
    }
    upsertArchivedMoments(decrypted, [{
      tid: '-3412344236794441123',
      username: 'wxid_live',
      author: 'wxid_live',
      ts: 1792240123,
      content: xml,
      contentHash: oldHash,
      payload: JSON.stringify(oldPayload),
    }])

    expect(ensureMomentsArchiveFresh(decrypted, true)).toBe(1)
    const snap = queryMoments(decrypted, 0, 10)
    expect(snap.moments[0]?.images[0]?.livePhoto?.md5).toBe(VIDEO_MD5)
    expect(snap.moments[0]?.images[0]?.key).toBe('image-seed')
    expect(snap.moments[0]?.images[0]?.token).toBe('tk-image')
    expect(snap.moments[0]?.videos).toEqual([])
  })
})

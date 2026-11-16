// @vitest-environment node
/**
 * 视频号朋友圈分享的解析守卫。
 *
 * 真实 XML 里 `<ContentObject type="28">` 的 `<finderFeed>` 会再嵌一层
 * `<mediaList><media>`；它没有 md5/id，不是朋友圈九宫格图片。旧解析器把它当普通图片，
 * 界面就会显示「这条媒体没有 md5/id，无法定位」。这里从解析入口钉住：
 *   · finderFeed 内的 media 不进入 images/videos；
 *   · 封面取 coverUrl/thumbUrl；
 *   · 标题优先使用 finderFeed 的真实 desc，不显示“版本不支持”占位；
 *   · 旧归档里的伪图片在升级解析后被清掉。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureMomentsArchiveFresh, parseSnsXml, queryMoments } from '../src/query/moments.ts'
import { upsertArchivedMoments } from '../src/query/moments-archive.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const TID = '-3397354573142609140'
const TIMELINE_ID = '15049389500566942476'
const COVER = 'https://wxapp.tc.qq.com/251/20304/stodownload?encfilekey=cover&amp;token=cover-token'
const VIDEO = 'http://wxapp.tc.qq.com/251/20302/stodownload?encfilekey=video'

function videoChannelXml(): string {
  return '<SnsDataItem><TimelineObject>'
    + `<id>${TIMELINE_ID}</id><username>wxid_video</username><createTime>1794027030</createTime>`
    + '<contentDesc>视频号分享</contentDesc>'
    + '<sourceNickName>视频号</sourceNickName>'
    + '<ContentObject><title>当前微信版本不支持展示该内容，请升级至最新版本。</title>'
    + '<contentUrl>https://support.weixin.qq.com/update/</contentUrl><type>28</type>'
    + '<mediaList/>'
    + '<finderFeed><objectId>15047817374101867091</objectId>'
    + '<desc>真实视频号标题 #大众严选</desc>'
    + '<mediaList><media><mediaType>4</mediaType>'
    + `<url>${VIDEO}</url><thumbUrl>${COVER}</thumbUrl><coverUrl>${COVER}</coverUrl>`
    + '<width>1920</width><height>1080</height></media></mediaList>'
    + '</finderFeed></ContentObject>'
    + '</TimelineObject></SnsDataItem>'
}

function makeRoot(): { root: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'moments-video-channel-'))
  roots.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return { root, decrypted }
}

function writeLiveRow(decrypted: string, xml: string): void {
  const dir = join(decrypted, 'sns', 'db_sns')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'sns.db'))
  db.exec('CREATE TABLE SnsTimeLine (tid TEXT, user_name TEXT, content TEXT)')
  db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(TID, 'wxid_video', xml)
  db.close()
}

describe('朋友圈视频号分享：finderFeed 不是九宫格图片', () => {
  it('解析时排除内嵌视频媒体，并提取真实标题与封面', () => {
    const parsed = parseSnsXml(videoChannelXml())

    expect(parsed.contentType).toBe(28)
    expect(parsed.images).toEqual([])
    expect(parsed.videos).toEqual([])
    expect(parsed.mediaDesc).toBe('视频号')
    expect(parsed.linkTitle).toBe('真实视频号标题 #大众严选')
    expect(parsed.linkThumb).toBe(COVER.replace('&amp;', '&'))
  })

  it('旧归档里的无 md5/id 伪图片会被升级解析清掉', () => {
    const { decrypted } = makeRoot()
    const xml = videoChannelXml()
    writeLiveRow(decrypted, xml)
    const oldPayload = JSON.stringify({
      tid: TID,
      username: 'wxid_video',
      author: '视频号作者',
      text: '视频号分享',
      ts: 1794027030,
      time: '',
      media_count: 1,
      media_desc: '图片×1',
      images: [{
        thumb: COVER,
        url: VIDEO,
        key: '',
        md5: '',
        timelineId: TIMELINE_ID,
      }],
      videos: [],
      location: '',
      link_title: '当前微信版本不支持展示该内容，请升级至最新版本。',
      link_url: 'https://support.weixin.qq.com/update/',
      is_self: false,
      likes: [],
      comments: [],
    })
    upsertArchivedMoments(decrypted, [{
      tid: TID,
      username: 'wxid_video',
      author: '视频号作者',
      ts: 1794027030,
      content: xml,
      contentHash: 'old-parser-before-video-channel',
      payload: oldPayload,
    }])

    expect(ensureMomentsArchiveFresh(decrypted, true)).toBe(1)
    const result = queryMoments(decrypted, 0, 50, undefined, 'wxid_self')
    const moment = result.moments[0]
    expect(moment?.images).toEqual([])
    expect(moment?.link_title).toBe('真实视频号标题 #大众严选')
    expect(moment?.link_thumb).toBe(COVER.replace('&amp;', '&'))
  })
})

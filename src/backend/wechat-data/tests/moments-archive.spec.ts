// @vitest-environment node
/**
 * 朋友圈**防撤回 / 本地优先**的行为守卫（2026-10-19 需求）。
 *
 * 用户要的两件事：
 *   ① 已经拿到的朋友圈信息（正文、点赞、评论、图片元数据、作者名）要留在本地，
 *     好友删掉动态后仍然看得到；
 *   ② CDN 原图落盘后要长期保留，下次进入先判本地、本地没有才用 CDN。
 *
 * 这份 spec 用临时 SQLite 造真实形态的 `sns.db`，然后**把线上行删掉**，验证归档库
 * 仍能出数据；同时验证长期原图目录独立于解码缓存（删掉 `decoded_images/sns-media`
 * 不影响归档）。判据全部是「事实有没有保留」，不靠计时。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureMomentsArchiveFresh, queryMoments, queryMomentsAuthors } from '../src/query/moments.ts'
import { queryMomentsMonthly } from '../src/query/moments-monthly.ts'
import {
  momentsArchivePath,
  readArchivedAvatar,
  readArchivedAvatars,
  saveArchivedAvatar,
} from '../src/query/moments-archive.ts'
import {
  lookupArchivedOriginal,
  momentsMediaArchiveRoot,
  saveArchivedOriginal,
} from '../src/query/sns-media-store.ts'
import { createMediaRemotes } from '../src/remotes/media.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function makeRoot(prefix = 'moments-archive-'): { root: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return { root, decrypted }
}

/** 一条互动（type 1 = 点赞，type 2 = 评论，与 `parseSnsLikesComments` 对应）。 */
function interact(type: number, u: string, nickname: string, content = ''): string {
  return '<user_comment>'
    + `<comment_id>c-${type}-${u}</comment_id>`
    + `<username>${u}</username><nickname>${nickname}</nickname>`
    + `<content>${content}</content><create_time>1700000000</create_time>`
    + `<ref_comment_id>0</ref_comment_id><type>${type}</type>`
    + '</user_comment>'
}

/** 一条带图片/点赞/评论的 content XML（标签形态照 `parseSnsXml` 认的写）。 */
function contentXml(ts: number, text: string, opts: { likes?: string[]; comments?: string[]; md5?: string } = {}): string {
  const social = (opts.likes ?? []).map(u => interact(1, u, u)).join('')
    + (opts.comments ?? []).map(u => interact(2, u, u, '说得对')).join('')
  const image = opts.md5
    ? '<media><id>m-1</id><type>2</type>'
      + `<url md5="${opts.md5}" token="tk-1">http://wx.cdn.example/0</url>`
      + '<thumb token="tk-1">http://wx.cdn.example/thumb</thumb>'
      + '<enc key="seed-1" /></media>'
    : ''
  return '<TimelineObject><id>tl-' + String(ts) + '</id>'
    + `<createTime>${String(ts)}</createTime>`
    + `<contentDesc><![CDATA[${text}]]></contentDesc>`
    + image
    + (social ? `<LocalExtraInfo>${social}</LocalExtraInfo>` : '')
    + '</TimelineObject>'
}

/** 写入 `sns/db_sns/sns.db`（列形态照真实数据）。 */
function writeSnsDb(decrypted: string, rows: Array<{ index: number; ts: number; text: string; likes?: string[]; comments?: string[]; md5?: string }>): void {
  const dir = join(decrypted, 'sns', 'db_sns')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'sns.db'))
  db.exec('CREATE TABLE IF NOT EXISTS SnsTimeLine (tid TEXT, user_name TEXT, content BLOB)')
  db.exec('DELETE FROM SnsTimeLine')
  const stmt = db.prepare('INSERT INTO SnsTimeLine VALUES (?,?,?)')
  for (const r of rows) {
    stmt.run(String(7330000000000000000n + BigInt(r.index)), 'wxid_a', contentXml(r.ts, r.text, r))
  }
  db.close()
}

/** 删掉线上行（模拟好友删动态）。 */
function deleteLiveRows(decrypted: string): void {
  const db = new DatabaseSync(join(decrypted, 'sns', 'db_sns', 'sns.db'))
  db.exec('DELETE FROM SnsTimeLine')
  db.close()
}

describe('朋友圈防撤回：线上行删掉后，归档仍保留全部内容', () => {
  it('正文/点赞/评论/图片元数据/作者名都留在归档库，且作者过滤、作者统计、月度分布仍可见', async () => {
    const { decrypted } = makeRoot()
    const ts = Math.floor(new Date(2026, 8, 15, 12, 0, 0).getTime() / 1000)
    writeSnsDb(decrypted, [{
      index: 1, ts, text: '今天去看海了，风很大。', likes: ['wxid_like'], comments: ['wxid_cmt'],
      md5: 'aa'.repeat(16),
    }])
    const first = queryMoments(decrypted, 0, 50, undefined, 'wxid_self')
    expect(first.total).toBe(1)
    expect(first.moments[0]?.text).toBe('今天去看海了，风很大。')
    expect(first.moments[0]?.images[0]?.md5).toBe('aa'.repeat(16))
    expect(first.moments[0]?.images[0]?.token).toBe('tk-1')
    expect(first.moments[0]?.likes.map(l => l.username)).toEqual(['wxid_like'])
    expect(first.moments[0]?.comments.map(c => c.content)).toEqual(['说得对'])

    // 好友删除动态：线上行没了。
    deleteLiveRows(decrypted)
    const afterDelete = queryMoments(decrypted, 0, 50, undefined, 'wxid_self')
    expect(afterDelete.total, '删掉后总数变了').toBe(1)
    expect(afterDelete.moments[0]?.text, '正文丢了').toBe('今天去看海了，风很大。')
    expect(afterDelete.moments[0]?.likes[0]?.username, '点赞丢了').toBe('wxid_like')
    expect(afterDelete.moments[0]?.comments[0]?.username, '评论丢了').toBe('wxid_cmt')

    // 作者过滤用稳定 username，删除后仍能筛到。
    expect(queryMoments(decrypted, 0, 50, 'wxid_a').total).toBe(1)
    expect(queryMoments(decrypted, 0, 50, 'wxid_other').total).toBe(0)

    // 作者统计与月度分布都从归档出：删掉后仍计入。
    expect(queryMomentsAuthors(decrypted).some(a => a.count === 1)).toBe(true)
    const monthly = await queryMomentsMonthly(decrypted)
    expect(monthly.months.some(m => m.month === '2026-09' && m.count === 1)).toBe(true)
  })

  it('连 sns.db 整个消失也还能读（归档库独立于解密数据）', () => {
    const { decrypted } = makeRoot()
    const ts = Math.floor(new Date(2026, 9, 1, 9, 0, 0).getTime() / 1000)
    writeSnsDb(decrypted, [{ index: 2, ts, text: '归档后连库都不在了。' }])
    expect(queryMoments(decrypted, 0, 50).total).toBe(1)
    rmSync(join(decrypted, 'sns'), { recursive: true, force: true })
    const snap = queryMoments(decrypted, 0, 50)
    expect(snap.total).toBe(1)
    expect(snap.moments[0]?.text).toBe('归档后连库都不在了。')
  })

  it('好友后来删掉评论/点赞/图片，归档仍保留第一次拿到的那些（并集而不是覆盖）', () => {
    const { decrypted } = makeRoot()
    const ts = Math.floor(new Date(2026, 7, 8, 10, 0, 0).getTime() / 1000)
    const md5 = 'bb'.repeat(16)
    writeSnsDb(decrypted, [{
      index: 9, ts, text: '原帖正文', likes: ['wxid_like'], comments: ['wxid_cmt'], md5,
    }])
    expect(queryMoments(decrypted, 0, 50).total).toBe(1)

    // 线上 XML 里评论/点赞/图片被去掉了；强制同步后归档不应跟着丢。
    writeSnsDb(decrypted, [{ index: 9, ts, text: '原帖正文' }])
    ensureMomentsArchiveFresh(decrypted, true)
    const snap = queryMoments(decrypted, 0, 50)
    expect(snap.moments[0]?.likes.map(l => l.username), '点赞被覆盖丢了').toEqual(['wxid_like'])
    expect(snap.moments[0]?.comments.map(c => c.username), '评论被覆盖丢了').toEqual(['wxid_cmt'])
    expect(snap.moments[0]?.images[0]?.md5, '图片元数据被覆盖丢了').toBe(md5)
  })

  it('归档库在数据根下（不是解密目录，避免被同步覆盖）', () => {
    const { root, decrypted } = makeRoot()
    writeSnsDb(decrypted, [{ index: 1, ts: 1_760_000_000, text: 'x' }])
    queryMoments(decrypted, 0, 50)
    expect(momentsArchivePath(decrypted)).toBe(join(root, 'moments-archive.db'))
  })

  it('负数 tid（真机形态）仍按数值倒序：最新动态在最上面，不能按字符串长度/字典序', () => {
    const { decrypted } = makeRoot()
    // 真机实测 tid 是 64 位**有符号**整数，例如 -3410996087506914705（较新）、
    // -6227245549885124513（较旧）。文本字典序会把 -6… 排到 -3… 前面 ⇒ 顺序反了。
    mkdirSync(join(decrypted, 'sns', 'db_sns'), { recursive: true })
    const db = new DatabaseSync(join(decrypted, 'sns', 'db_sns', 'sns.db'))
    db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content BLOB)')
    const ins = db.prepare('INSERT INTO SnsTimeLine VALUES (?,?,?)')
    const olderTid = '-6227245549885124513'
    const newerTid = '-3410996087506914705'
    const olderTs = Math.floor(new Date(2016, 1, 1).getTime() / 1000)
    const newerTs = Math.floor(new Date(2026, 9, 1).getTime() / 1000)
    ins.run(olderTid, 'wxid_a', contentXml(olderTs, '较旧的动态'))
    ins.run(newerTid, 'wxid_a', contentXml(newerTs, '较新的动态'))
    db.close()

    const snap = queryMoments(decrypted, 0, 50)
    expect(snap.moments.map(m => m.tid)).toEqual([newerTid, olderTid])
    expect(snap.moments.map(m => m.text)).toEqual(['较新的动态', '较旧的动态'])
  })
})

describe('头像归档：本机解析到的头像写入归档，好友删除后仍能取到', () => {
  it('批量/单张读取与覆盖更新', () => {
    const { decrypted } = makeRoot()
    const avatar = 'data:image/png;base64,iVBORw0KGgo='
    saveArchivedAvatar(decrypted, 'wxid_a', '张三', avatar)
    expect(readArchivedAvatar(decrypted, 'wxid_a')).toBe(avatar)
    expect(readArchivedAvatars(decrypted, ['wxid_a', 'wxid_missing'])).toEqual({ wxid_a: avatar })
    // 只更新名字时头像不能被空串清掉。
    saveArchivedAvatar(decrypted, 'wxid_a', '张三（新备注）', '')
    expect(readArchivedAvatar(decrypted, 'wxid_a')).toBe(avatar)
  })

  it('头像接口：本机解析不到时回落到归档头像（好友删除后的渲染兜底）', () => {
    const { root, decrypted } = makeRoot()
    const avatar = 'data:image/png;base64,iVBORw0KGgo='
    saveArchivedAvatar(decrypted, 'wxid_a', '张三', avatar)
    const remotes = createMediaRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'decoded_images') }),
      op: () => {},
      rawWechatBase: () => '',
      decryptState: { active: false, op: null } as never,
      warmDecodedImages: async () => {},
    })
    expect(remotes.getAvatar({ username: 'wxid_a' })).toEqual({ kind: 'data', data: avatar })
    expect(remotes.getAvatarsLocal({ usernames: ['wxid_a'] })).toEqual({ wxid_a: avatar })
  })

  it('归档头像是 https 地址时按 kind:url 返回（不能冒充 data URL，CSP 会挡掉）', () => {
    const { root, decrypted } = makeRoot()
    const url = 'https://wework.qpic.cn/wwpic3az/44281_9wPMQESRR6GGk7e_1719295706/140'
    saveArchivedAvatar(decrypted, 'wxid_url', '', url)
    const remotes = createMediaRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'decoded_images') }),
      op: () => {},
      rawWechatBase: () => '',
      decryptState: { active: false, op: null } as never,
      warmDecodedImages: async () => {},
    })
    expect(remotes.getAvatar({ username: 'wxid_url' })).toEqual({ kind: 'url', url })
    expect(remotes.getAvatarsLocal({ usernames: ['wxid_url'] })).toEqual({ wxid_url: url })
  })
})

describe('CDN 原图长期归档：独立于解码缓存，删掉缓存仍能命中', () => {
  it('长期归档命中时不再出网（后端 getSnsImageDataUrl 先查它）', async () => {
    const { root } = makeRoot()
    const decoded = join(root, 'decoded_images')
    const md5 = 'cc'.repeat(16)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 0x22)])
    expect(saveArchivedOriginal(decoded, md5, jpeg)).toBe('jpg')
    const remotes = createMediaRemotes({
      dirs: () => ({ decrypted: join(root, 'decrypted'), decoded }),
      op: () => {},
      rawWechatBase: () => '',
      decryptState: { active: false, op: null } as never,
      warmDecodedImages: async () => {},
    })
    const r = await remotes.getSnsImageDataUrl({ md5, offline: false })
    expect(r.url?.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(r.thumb).toBeUndefined()
  })

  it('视频封面也先读长期归档（删帖/清缓存后封面仍能显示）', async () => {
    const { root } = makeRoot()
    const decoded = join(root, 'decoded_images')
    const md5 = 'dd'.repeat(16)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 0x33)])
    expect(saveArchivedOriginal(decoded, md5, jpeg)).toBe('jpg')
    const remotes = createMediaRemotes({
      dirs: () => ({ decrypted: join(root, 'decrypted'), decoded }),
      op: () => {},
      rawWechatBase: () => '',
      decryptState: { active: false, op: null } as never,
      warmDecodedImages: async () => {},
    })
    const one = await remotes.getSnsVideoCoverDataUrl({ md5, offline: false })
    expect(one.url?.startsWith('data:image/jpeg;base64,')).toBe(true)
    const batch = await remotes.getSnsVideoCoversBatch({ items: [{ md5 }], offline: false })
    expect(batch.items[0]?.url?.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('写入后可读回字节；清空 decoded_images/sns-media 不影响长期归档', () => {
    const { root } = makeRoot()
    const decoded = join(root, 'decoded_images')
    mkdirSync(join(decoded, 'sns-media', 'aa'), { recursive: true })
    // 真实 JPEG 头 + 足够长度（`sniffOriginalExt` 要求 ≥16 字节）。
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 0x11)])
    const md5 = 'aa'.repeat(16)
    expect(saveArchivedOriginal(decoded, md5, jpeg)).toBe('jpg')
    expect(lookupArchivedOriginal(decoded, md5)?.bytes.equals(jpeg)).toBe(true)
    // 解码缓存被清（例如换密钥）——长期归档还在。
    rmSync(join(decoded, 'sns-media'), { recursive: true, force: true })
    expect(lookupArchivedOriginal(decoded, md5)?.bytes.equals(jpeg)).toBe(true)
    expect(momentsMediaArchiveRoot(decoded)).toBe(join(root, 'moments-media'))
    expect(readFileSync(join(momentsMediaArchiveRoot(decoded), 'aa', md5 + '.jpg')).length).toBe(jpeg.length)
  })

  it('非图片 / 坏 md5 拒绝写入（坏原图会被永久缓存，比没有更坏）', () => {
    const { root } = makeRoot()
    const decoded = join(root, 'decoded_images')
    expect(saveArchivedOriginal(decoded, 'aa'.repeat(16), Buffer.from('not an image at all'))).toBeNull()
    expect(saveArchivedOriginal(decoded, 'bad-md5', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toBeNull()
    expect(lookupArchivedOriginal(decoded, 'aa'.repeat(16))).toBeNull()
  })
})

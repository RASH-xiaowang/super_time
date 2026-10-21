/**
 * 收藏来源头像（用户反馈「其他收藏类型为什么没有头像」）。
 *
 * 收藏 XML 的 `<head256md5>` 只覆盖部分资源型条目，文本/位置/公众号经常没有；
 * 头像必须从库里的来源用户走 contact / head_image 解析。群聊收藏的 `fromusr`
 * 是群 ID，`realchatname` 才是实际发送者，所以两者都要参与且发送者优先。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAvatarsLocal } from '../src/query/avatar.ts'
import { queryFavorites } from '../src/query/favorites.ts'

vi.mock('../src/query/avatar.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/query/avatar.ts')>()
  return { ...actual, resolveAvatarsLocal: vi.fn(actual.resolveAvatarsLocal) }
})

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.mocked(resolveAvatarsLocal).mockClear()
})

/** 建一个带 contact 表的最小解密目录。 */
function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'st-fav-avatar-'))
  scratch.push(dir)
  mkdirSync(join(dir, 'favorite'), { recursive: true })
  mkdirSync(join(dir, 'contact'), { recursive: true })
  const fav = new DatabaseSync(join(dir, 'favorite', 'favorite.db'))
  fav.exec(`CREATE TABLE fav_db_item (
    local_id INTEGER, type INTEGER, update_time INTEGER, content TEXT,
    fromusr TEXT, realchatname TEXT)`)
  const contact = new DatabaseSync(join(dir, 'contact', 'contact.db'))
  contact.exec('CREATE TABLE contact (username TEXT, nick_name TEXT, remark TEXT, small_head_url TEXT, big_head_url TEXT)')
  contact.close()
  fav.close()
  return dir
}

function insertFavorite(
  dir: string,
  values: { id: number; type: number; time: number; content: string; fromUsr: string; chatName: string },
): void {
  const db = new DatabaseSync(join(dir, 'favorite', 'favorite.db'))
  db.prepare('INSERT INTO fav_db_item VALUES (?,?,?,?,?,?)')
    .run(values.id, values.type, values.time, values.content, values.fromUsr, values.chatName)
  db.close()
}

function setContactAvatar(dir: string, username: string, url: string, nick = username): void {
  const db = new DatabaseSync(join(dir, 'contact', 'contact.db'))
  db.prepare('INSERT INTO contact VALUES (?,?,?,?,?)').run(username, nick, '', url, '')
  db.close()
}

describe('queryFavorites 来源头像', () => {
  it('文本/位置等没有 head256md5 的收藏也从来源用户回填头像（不再只有资源型收藏有）', () => {
    const dir = makeTree()
    setContactAvatar(dir, 'wxid_text', 'https://wx.qlogo.cn/text/132', '文本发送者')
    insertFavorite(dir, {
      id: 1, type: 1, time: 100, content: '<desc>纯文本收藏</desc>', fromUsr: 'wxid_text', chatName: '',
    })
    insertFavorite(dir, {
      id: 2, type: 6, time: 90, content: '<locitem><poiname>某地</poiname><label>某地址</label></locitem>',
      fromUsr: 'wxid_text', chatName: '',
    })
    const r = queryFavorites(dir)
    expect(r.favorites.map((f) => f.avatar)).toEqual([
      'https://wx.qlogo.cn/text/132',
      'https://wx.qlogo.cn/text/132',
    ])
  })

  it('群聊收藏按 realchatname（实际发送者）取头像；发送者没有时再回落到群头像', () => {
    const dir = makeTree()
    setContactAvatar(dir, 'wxid_sender', 'https://wx.qlogo.cn/sender/132')
    setContactAvatar(dir, 'room@chatroom', 'https://wx.qlogo.cn/room/132')
    insertFavorite(dir, {
      id: 3, type: 8, time: 80, content: '<desc>文件.pdf</desc>',
      fromUsr: 'room@chatroom', chatName: 'wxid_sender',
    })
    insertFavorite(dir, {
      id: 4, type: 8, time: 70, content: '<desc>另一个文件.pdf</desc>',
      fromUsr: 'room@chatroom', chatName: 'wxid_no_avatar',
    })
    const r = queryFavorites(dir)
    const byId = new Map(r.favorites.map((f) => [f.localId, f.avatar]))
    expect(byId.get(3)).toBe('https://wx.qlogo.cn/sender/132')
    expect(byId.get(4), '发送者没头像时必须回落群头像，而不是整条空着').toBe('https://wx.qlogo.cn/room/132')
  })

  it('当前页只批量解析一次头像，调用参数去重后同时包含发送者与群', () => {
    const dir = makeTree()
    insertFavorite(dir, {
      id: 5, type: 8, time: 60, content: '<desc>a.pdf</desc>',
      fromUsr: 'room@chatroom', chatName: 'wxid_sender',
    })
    insertFavorite(dir, {
      id: 6, type: 1, time: 50, content: '<desc>文本</desc>',
      fromUsr: 'wxid_sender', chatName: '',
    })
    queryFavorites(dir)
    expect(vi.mocked(resolveAvatarsLocal)).toHaveBeenCalledTimes(1)
    const users = vi.mocked(resolveAvatarsLocal).mock.calls[0]?.[1] ?? []
    expect(users).toEqual(['wxid_sender', 'room@chatroom'])
  })

  it('联系人没有头像时回落到收藏 XML 的 head256md5，并过滤空 MD5', () => {
    const dir = makeTree()
    insertFavorite(dir, {
      id: 7, type: 8, time: 40,
      content: '<favorite><desc>文件.pdf</desc><head256md5>f18572f2133c91307dc98c1cc095d995</head256md5></favorite>',
      fromUsr: 'room@chatroom', chatName: 'wxid_removed_sender',
    })
    insertFavorite(dir, {
      id: 8, type: 8, time: 30,
      content: '<favorite><desc>另一个.pdf</desc><head256md5>d41d8cd98f00b204e9800998ecf8427e</head256md5></favorite>',
      fromUsr: 'room@chatroom', chatName: 'wxid_removed_sender',
    })
    const r = queryFavorites(dir)
    const byId = new Map(r.favorites.map((f) => [f.localId, f.avatar]))
    expect(byId.get(7)).toBe('f18572f2133c91307dc98c1cc095d995')
    expect(byId.get(8), '空串 MD5 不是头像，必须当成没有').toBe('')
  })

  it('位置、小程序与未知 datatype 也保留可渲染资源，不再只剩一条空详情', () => {
    const dir = makeTree()
    insertFavorite(dir, {
      id: 9, type: 6, time: 20,
      content: '<favorite><locitem><poiname>登记服务站</poiname><label>星光大道</label><lat>22.78</lat><lng>108.31</lng><poiCategoryTips>汽车服务</poiCategoryTips></locitem></favorite>',
      fromUsr: 'wxid_location', chatName: '',
    })
    insertFavorite(dir, {
      id: 10, type: 19, time: 10,
      content: '<favorite><datalist><dataitem datatype="19" dataid="mini-cover"><datatitle>小程序标题</datatitle></dataitem></datalist><appbranditem><appid>wx123</appid><username>gh_demo</username><pagepath>pages/index</pagepath><iconurl>https://wx.qlogo.cn/icon</iconurl></appbranditem></favorite>',
      fromUsr: 'wxid_mini', chatName: '',
    })
    insertFavorite(dir, {
      id: 11, type: 999, time: 0,
      content: '<favorite><datalist><dataitem datatype="77"><datatitle>新资源</datatitle><datadesc>未知类型描述</datadesc><url>https://example.com/new</url><fullsize>1024</fullsize></dataitem></datalist></favorite>',
      fromUsr: 'wxid_unknown', chatName: '',
    })
    const byId = new Map(queryFavorites(dir).favorites.map((f) => [f.localId, f.items[0]]))
    expect(byId.get(9)).toMatchObject({
      kind: 'location',
      poiName: '登记服务站',
      address: '星光大道',
      lat: 22.78,
      lng: 108.31,
      category: '汽车服务',
    })
    expect(byId.get(10)).toMatchObject({
      kind: 'miniapp',
      appId: 'wx123',
      appUsername: 'gh_demo',
      pagePath: 'pages/index',
      iconUrl: 'https://wx.qlogo.cn/icon',
      fullMd5: 'mini-cover',
    })
    expect(byId.get(11)).toMatchObject({
      kind: 'unknown',
      dataType: 77,
      title: '新资源',
      desc: '未知类型描述',
      url: 'https://example.com/new',
    })
    expect(byId.get(11)?.meta).toContainEqual({ label: '大小', value: '1024' })
    expect(byId.get(11)?.meta).toContainEqual({ label: '链接', value: 'https://example.com/new' })
  })
})

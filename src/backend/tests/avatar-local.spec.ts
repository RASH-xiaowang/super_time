/**
 * 批量头像解析的三级回退（`query/avatar.ts` 的 `resolveAvatarsLocal`）。
 *
 * 为什么值得单独测：图谱面板一次要 250 个头像，而 `head_image.db` 只覆盖本机收过的那些 ——
 * 真机实测「好友图」上 240 个节点只命中 131 个，另外 109 个只能画成「社区色 + 首字」，
 * 表现就是用户报的「有些节点没有头像」。补齐的两级（temp 缓存 / contact 表 https URL）
 * 一旦哪一级被写反，界面**照样能出图**，只是又有一批人变回字母 —— 肉眼很难判断是
 * 「这个人本地就没数据」还是「代码没回退」，所以必须锁住。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAvatarsLocal } from '../wechat-data/src/query/avatar.ts'
import { withTempWorkspace, type TempWorkspace } from './helpers/temp-db.ts'

/** 一段最小 JPEG 头（`sniffImageFormat` 只认 magic bytes，长度够 16 字节即可）。 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0x11)])

/** 造 `head_image/head_image.db`：username → image_buffer（相册里「收过的头像」）。 */
function seedHeadImage(ws: TempWorkspace, rows: Array<{ username: string; buf: Buffer }>): void {
  mkdirSync(join(ws.dir, 'head_image'), { recursive: true })
  const db = ws.db('head_image/head_image.db')
  db.exec('CREATE TABLE head_image (username TEXT, image_buffer BLOB, update_time INTEGER)')
  const ins = db.prepare('INSERT INTO head_image (username, image_buffer, update_time) VALUES (?, ?, ?)')
  rows.forEach((r, i) => { ins.run(r.username, r.buf, i) })
}

/** 造 `contact/contact.db`：username → small/big_head_url。 */
function seedContact(ws: TempWorkspace, rows: Array<{ username: string; small?: string; big?: string }>): void {
  mkdirSync(join(ws.dir, 'contact'), { recursive: true })
  const db = ws.db('contact/contact.db')
  db.exec('CREATE TABLE contact (username TEXT, local_type INTEGER, delete_flag INTEGER, small_head_url TEXT, big_head_url TEXT)')
  const ins = db.prepare('INSERT INTO contact (username, local_type, delete_flag, small_head_url, big_head_url) VALUES (?, 1, 0, ?, ?)')
  for (const r of rows) ins.run(r.username, r.small ?? '', r.big ?? '')
}

/** 造 temp/head_image 缓存文件（文件名 = md5(头像 URL)），返回写入的路径。 */
function seedTempHead(ws: TempWorkspace, url: string, buf: Buffer = JPEG): string {
  const dir = join(ws.dir, 'temp', 'head_image')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, createHash('md5').update(Buffer.from(url, 'utf8')).digest('hex'))
  writeFileSync(f, buf)
  return f
}

describe('批量头像的三级回退', () => {
  it('优先级：head_image.db > temp 缓存 > contact 的 https URL；都没有就不返回', async () => {
    await withTempWorkspace('avatar-local', (ws) => {
      const tailUrl = 'https://wx.qlogo.cn/mmhead/aaa/0'
      seedHeadImage(ws, [{ username: 'in_db', buf: JPEG }])
      seedContact(ws, [
        { username: 'in_db', small: 'https://wx.qlogo.cn/mmhead/bbb/0' },
        { username: 'in_temp', small: tailUrl },
        { username: 'remote_only', small: 'https://wx.qlogo.cn/mmhead/ccc/0' },
      ])
      seedTempHead(ws, tailUrl)

      const out = resolveAvatarsLocal(ws.dir, ['in_db', 'in_temp', 'remote_only', 'nowhere'], {
        wechatBaseDir: ws.dir,
        allowRemote: true,
      })

      // ① 库里有字节 → data URL（本地，不联网）
      expect(out.in_db).toMatch(/^data:image\/jpeg;base64,/)
      // ② 库外有 temp 缓存 → 同样是 data URL（不是把 URL 丢给前端去下载）
      expect(out.in_temp).toMatch(/^data:image\/jpeg;base64,/)
      // ③ 只有远端 URL → 原样返回 https
      expect(out.remote_only).toBe('https://wx.qlogo.cn/mmhead/ccc/0')
      // ④ 什么都没有 → 不出现在结果里（渲染端退回「社区色 + 首字」）
      expect(out.nowhere).toBeUndefined()
    })
  })

  it('big_head_url 在小图 URL 缺失时顶上', async () => {
    await withTempWorkspace('avatar-local', (ws) => {
      seedContact(ws, [{ username: 'a', big: 'https://wx.qlogo.cn/mmhead/big/0' }])
      const out = resolveAvatarsLocal(ws.dir, ['a'], { allowRemote: true })
      expect(out.a).toBe('https://wx.qlogo.cn/mmhead/big/0')
    })
  })

  it('http 远端 URL 不返回 —— CSP 的 img-src 只放行 https，返回了也显示不出来', async () => {
    await withTempWorkspace('avatar-local', (ws) => {
      seedContact(ws, [{ username: 'plain_http', small: 'http://wx.qlogo.cn/mmhead/ddd/0' }])
      const out = resolveAvatarsLocal(ws.dir, ['plain_http'], { allowRemote: true })
      expect(out.plain_http).toBeUndefined()
    })
  })

  it('用户开了「出站拦截」时不下发远端 URL，但本地那两级照常给', async () => {
    await withTempWorkspace('avatar-local', (ws) => {
      const tempUrl = 'https://wx.qlogo.cn/mmhead/eee/0'
      seedContact(ws, [
        { username: 'remote_only', small: 'https://wx.qlogo.cn/mmhead/fff/0' },
        { username: 'in_temp', small: tempUrl },
      ])
      seedTempHead(ws, tempUrl)

      const out = resolveAvatarsLocal(ws.dir, ['remote_only', 'in_temp'], {
        wechatBaseDir: ws.dir,
        allowRemote: false,
      })
      expect(out.remote_only).toBeUndefined()
      expect(out.in_temp).toMatch(/^data:image\/jpeg;base64,/)
    })
  })

  it('库文件缺失（首次解密前）不抛，只是回退到 URL', async () => {
    await withTempWorkspace('avatar-local', (ws) => {
      seedContact(ws, [{ username: 'a', small: 'https://wx.qlogo.cn/mmhead/ggg/0' }])
      // 故意不建 head_image.db
      const out = resolveAvatarsLocal(ws.dir, ['a'], { allowRemote: true })
      expect(out.a).toBe('https://wx.qlogo.cn/mmhead/ggg/0')
      // 空输入直接返回空（别为了空集合去开库）
      expect(resolveAvatarsLocal(ws.dir, [])).toEqual({})
    })
  })
})

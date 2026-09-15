/**
 * Moments insights for one author (usually self): post/like/comment totals,
 * top likers and commenters, monthly distribution, and "on this day" items.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MomentsGeo, MomentsGeoPoint, MomentsInsightsSnapshot, MomentsInteractorRow, MomentsTopItems } from '../types.ts'
import { parseSnsLikesComments, parseSnsXml } from './moments.ts'
import { cachedBySig, contactMeta, fileSigOf } from './meta.ts'

function cellString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function snsDb(decryptedDir: string): string | null {
  for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
    if (existsSync(p)) return p
  }
  return null
}

function addInteractor(map: Map<string, { username: string; nickname: string; count: number }>, username: string, nickname: string): void {
  const key = username || nickname || '?'
  const cur = map.get(key)
  if (cur) {
    cur.count += 1
  } else {
    map.set(key, { username, nickname, count: 1 })
  }
}

function sortedTop(map: Map<string, { username: string; nickname: string; count: number }>, cap: number): MomentsInteractorRow[] {
  return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, cap)
}

/**
 * 朋友圈「新动态提醒」表（`SnsTopItem_1`）的统计。
 *
 * 这张表是微信自己记的**提醒列表**：一行 = 一条被推入「朋友的新动态」的帖子，
 * `is_read` 表示有没有看过，`last_read_time` 是最近一次清空提醒的时间。
 *
 * 实测（本机 116 行 / 33 人）：
 *  - `<summary>` **恒为空**（116/116）——不要拿它当摘要；
 *  - `last_read_time` **只有一个取值**（全量同一次批量已读），所以它不能用来算「某个人的回访延迟」；
 *  - 28/116 条的 `tid` **不在** `SnsTimeLine` 里 —— 帖子已被删除/设为私密，提醒还在；
 *  - 因此这里只给三件能站得住的事：谁最常进入提醒、有几条没看、有几条已经看不到。
 *
 * 与「发布量」的区别：同一作者在 SnsTimeLine 里可能有 158 条，但只进过 14 次提醒 ——
 * 提醒列表是**推送窗口**，不是发布总量。
 */
function computeTopItems(db: DatabaseSync, tidCol: string, names: Map<string, string>): MomentsTopItems {
  const empty: MomentsTopItems = { rows: 0, users: 0, unread: 0, vanished: 0, top: [] }
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTopItem_1'").get() === undefined) return empty
    // 提醒清单：量级是「你被提醒过的动态条数」（本机 490 条），与消息量无关，
    // 且下面要先判空再遍历，所以保留一次性取回（N8 清单里属「有界」一类）。
    const rows = db.prepare(
      `SELECT CAST(tid AS TEXT) AS t, username AS u, create_time AS c, last_read_time AS r, is_read AS d FROM SnsTopItem_1`,
    ).all() as Array<{ t: unknown; u: unknown; c: unknown; r: unknown; d: unknown }>
    if (rows.length === 0) return empty
    // 提醒过的 tid 是否还在时间线上（不在 = 帖子已不可见）
    const alive = new Set<string>()
    try {
      // 这一条**随朋友圈条数增长**：游标直接灌进 Set，不先物化成数组（N8）
      for (const r of db.prepare(`SELECT CAST(${tidCol} AS TEXT) AS t FROM SnsTimeLine`).iterate() as Iterable<{ t: unknown }>) {
        alive.add(cellString(r.t))
      }
    } catch { /* 时间线不可读时全部按「未知」处理，下面按 vanished=0 计 */ }
    const byUser = new Map<string, { count: number; unread: number; vanished: number; lastRead: number }>()
    let unread = 0
    let vanished = 0
    for (const r of rows) {
      const username = cellString(r.u)
      if (!username) continue
      const isUnread = Number(r.d ?? 1) === 0
      const isGone = alive.size > 0 && !alive.has(cellString(r.t))
      if (isUnread) unread += 1
      if (isGone) vanished += 1
      const cur = byUser.get(username) ?? { count: 0, unread: 0, vanished: 0, lastRead: 0 }
      cur.count += 1
      if (isUnread) cur.unread += 1
      if (isGone) cur.vanished += 1
      cur.lastRead = Math.max(cur.lastRead, Number(r.r ?? 0))
      byUser.set(username, cur)
    }
    const top = Array.from(byUser.entries())
      .map(([username, v]) => ({ username, name: names.get(username) ?? username, count: v.count, unread: v.unread, vanished: v.vanished, lastRead: v.lastRead }))
      .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username))
      .slice(0, 10)
    return { rows: rows.length, users: byUser.size, unread, vanished, top }
  } catch {
    return empty
  }
}

/**
 * 朋友圈「足迹」：城市/国家分布与打卡地点排行。
 *
 * 数据来自每条朋友圈 XML 的 `<location>`：
 * `<location city="南宁市" latitude="108.249237" longitude="22.8694096" poiName="…"/>`
 *
 * ⚠️ 两个坐标属性**语义是反的**（南宁真实为 22.87°N / 108.25°E，而 latitude 属性写的是 108.25）：
 * 本机 490 条里 **485 条 latitude > 90** —— 纬度不可能超过 90，所以按「纬度=longitude 属性」用。
 * 这里输出的 `lat/lng` 已经是**修正后**的值，可直接画地图。
 */
function computeGeo(db: DatabaseSync): MomentsGeo {
  const empty: MomentsGeo = { points: 0, cities: [], countries: [], places: [], pointList: [] }
  try {
    const cityCount = new Map<string, number>()
    const countryCount = new Map<string, number>()
    const placeCount = new Map<string, { count: number; city: string; lat: number; lng: number }>()
    let points = 0
    // 逐条保留定位点：地图要画的是「每一次打卡」，不是聚合后的城市（同城多点会重叠成 1 个）
    const pointList: MomentsGeoPoint[] = []
    // 游标读（N8）：`SnsTimeLine` 随朋友圈条数增长，而这里只是逐条解析后累加，
    // 不需要先把整表物化成数组。
    for (const r of db.prepare('SELECT user_name AS u, content AS c FROM SnsTimeLine').iterate() as Iterable<{ u: unknown; c: unknown }>) {
      const xml = cellString(r.c)
      const li = xml.indexOf('<location')
      if (li < 0) continue
      const gt = xml.indexOf('>', li)
      const attrs = gt > 0 ? xml.slice(li + 9, gt) : ''
      const attr = (n: string): string => {
        const m = new RegExp(n + '="([^"]*)"').exec(attrs)
        return m ? (m[1] ?? '') : ''
      }
      const city = attr('city').trim()
      const country = attr('country').trim()
      const poi = attr('poiName').trim() || attr('poiname').trim()
      // 属性反置：见函数头注释。lat 取 longitude 属性、lng 取 latitude 属性
      const lat = Number(attr('longitude')) || 0
      const lng = Number(attr('latitude')) || 0
      // 只有「修正后落在合法区间且非 0」才算真坐标。本机 2341 行**全部**带 <location>：
      // 1851 行 0/0（未定位）、5 行 -180/-180（微信定位失败的哨兵值，city 仍写南宁市）、485 行真实坐标。
      // 哨兵值不筛掉的话会在地图左下角堆出 5 个假点。
      const usable = (lat !== 0 || lng !== 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      if (city) cityCount.set(city, (cityCount.get(city) ?? 0) + 1)
      if (country) countryCount.set(country, (countryCount.get(country) ?? 0) + 1)
      if (poi) {
        const cur = placeCount.get(poi) ?? { count: 0, city, lat: usable ? lat : 0, lng: usable ? lng : 0 }
        cur.count += 1
        placeCount.set(poi, cur)
      }
      if (usable) {
        points += 1
        pointList.push({ lat, lng, city, poi })
      }
    }
    return {
      points,
      cities: [...cityCount.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city)),
      countries: [...countryCount.entries()].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count || a.country.localeCompare(b.country)),
      places: [...placeCount.entries()].map(([name, v]) => ({ name, city: v.city, count: v.count, lat: v.lat, lng: v.lng })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10),
      pointList,
    }
  } catch {
    return empty
  }
}

/**
 * Compute moments insights for an author.
 * @param decryptedDir - decrypted data root.
 * @param author - author username (default: all).
 * @returns the insights snapshot.
 */
export function queryMomentsInsights(decryptedDir: string, author?: string): MomentsInsightsSnapshot {
  const dbPath = snsDb(decryptedDir)
  // 签名覆盖 sns.db 与 contact.db：互动人昵称来自后者。原先只签 sns.db，靠「事件后整表
  // 清空」兜住 —— M8 去掉那层兜底后必须补上真正读了的东西。
  const sig = [
    dbPath === null ? '' : fileSigOf(dbPath),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
  ].join('|')
  return cachedBySig('moments-insights:' + decryptedDir + ':' + (author ?? ''), sig, () => computeMomentsInsights(decryptedDir, author))
}

function computeMomentsInsights(decryptedDir: string, author?: string): MomentsInsightsSnapshot {
  const empty: MomentsInsightsSnapshot = {
    author: author ?? '', posts: 0, likes: 0, comments: 0, likedBy: [], commenters: [], monthly: [], today: [],
    topItems: { rows: 0, users: 0, unread: 0, vanished: 0, top: [] },
    geo: { points: 0, cities: [], countries: [], places: [], pointList: [] },
    updatedAt: Math.floor(Date.now() / 1000),
  }
  const dbPath = snsDb(decryptedDir)
  if (dbPath === null) return empty
  let posts = 0
  let likes = 0
  let comments = 0
  const likers = new Map<string, { username: string; nickname: string; count: number }>()
  const commenters = new Map<string, { username: string; nickname: string; count: number }>()
  const monthly = new Map<string, number>()
  const now = new Date()
  const today: Array<{ tid: string; text: string; ts: number; author: string }> = []
  let topItems: MomentsTopItems = { rows: 0, users: 0, unread: 0, vanished: 0, top: [] }
  let geo: MomentsGeo = { points: 0, cities: [], countries: [], places: [], pointList: [] }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const cols = new Set((db.prepare('PRAGMA table_info(SnsTimeLine)').all() as Array<{ name: string }>).map(r => r.name))
    const tidCol = cols.has('tid') ? 'tid' : cols.has('Id') ? 'Id' : ''
    // 提醒列表与「按作者过滤」无关：它永远是**我的**提醒清单，所以无条件计算。
    topItems = computeTopItems(db, tidCol, contactMeta(decryptedDir).names)
    geo = computeGeo(db)
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
    if (!has) { db.close(); return { ...empty, topItems } }
    const userCol = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
    const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
    if (!tidCol || !userCol || !contentCol) { db.close(); return { ...empty, topItems } }
    const where = author ? ` WHERE ${userCol} = ?` : ''
    const rows = db.prepare(`SELECT CAST(${tidCol} AS TEXT) AS t, ${userCol} AS u, ${contentCol} AS c FROM SnsTimeLine${where}`).all(...(author ? [author] : [])) as Array<{ t: unknown; u: unknown; c: unknown }>
    db.close()
    for (const r of rows) {
      posts += 1
      const xml = cellString(r.c)
      const parsed = parseSnsXml(xml)
      const social = parseSnsLikesComments(xml)
      likes += social.likes.length
      comments += social.comments.length
      for (const like of social.likes) addInteractor(likers, like.username, like.nickname)
      for (const cm of social.comments) addInteractor(commenters, cm.username, cm.nickname)
      if (parsed.createTime > 0) {
        const d = new Date(parsed.createTime * 1000)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        monthly.set(key, (monthly.get(key) ?? 0) + 1)
        if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
          today.push({ tid: cellString(r.t), text: parsed.text, ts: parsed.createTime, author: cellString(r.u) })
        }
      }
    }
  } catch (e) {
    // 不再静默吞错：曾因此让「朋友圈洞察」长期显示全 0 而无人察觉
    // （SnsTimeLine.tid 在本机 2335 行里 100% 超出 JS 安全整数范围，
    //   未 CAST 时 node:sqlite 物化行会抛 ERR_OUT_OF_RANGE）。
    console.warn('[moments-insights] 查询失败，返回空结果:', (e as Error)?.message ?? e)
  }
  const monthlyArr = Array.from(monthly.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month))
  return {
    author: author ?? '',
    posts,
    likes,
    comments,
    likedBy: sortedTop(likers, 10),
    commenters: sortedTop(commenters, 10),
    monthly: monthlyArr,
    today: today.slice(0, 20).sort((a, b) => b.ts - a.ts),
    topItems,
    geo,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

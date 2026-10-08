/**
 * 微信数据总览「战术分析」：基于解密数据库做交互画像/作息浓度/关系浓度/
 * 内容资产/数据健康五块统计，供总览页展示。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contactMeta, shardCatalogDirs, shardCatalogSig, fileSigOf, cachedBySigAsync } from './meta.ts'
import { withDb, withDbAsync } from './db-open.ts'
import { yieldToLoop } from './search-build.ts'
import type { OverviewExtras } from '../types.ts'
import { queryOverviewExtras } from './overview-extras.ts'

/**
 * 朋友圈整表扫每多少行让出一次。
 * 导出是给守卫用例**按这个数造数据**用的 —— 判据不该依赖墙上时钟（CI 机器比本机慢 20 倍，
 * 任何「跑够 25ms」的断言在那边都会假红）。
 */
export const SNS_YIELD_EVERY_ROWS = 2000

export interface OverviewInsights {
  messages: {
    total: number
    sent: number
    received: number
    text: number
    image: number
    voice: number
    video: number
    rich: number
    system: number
    revoked: number
  }
  time: {
    activeDays: number
    spanDays: number
    busyHour: number
    busyCount: number
    hourDist: number[]
    deepNightPct: number
    weekendPct: number
    lastActive: string
  }
  relations: {
    total: number
    active: number
    silent: number
    groupsWithMsg: number
    top: Array<{ username: string; name: string; count: number }>
  }
  moments: { total: number; images: number; videos: number; likes: number; comments: number }
  assets: { favorites: number; emoticons: number; files: number; fileBytes: number; mediaItems: number; mediaBytes: number }
  health: { dbFiles: number; dbBytes: number; ok: boolean }
  extras: OverviewExtras
}

function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

/** 枚举 decrypted 目录下所有 *.db（不含 -wal/-shm）。 */
function walkDbFiles(dir: string, out: Array<{ path: string; bytes: number }>, depth: number): void {
  if (depth > 4 || !existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      walkDbFiles(p, out, depth + 1)
    } else if (e.name.endsWith('.db') && !e.name.includes('-wal') && !e.name.includes('-shm')) {
      try { out.push({ path: p, bytes: statSync(p).size }) } catch { /* ignore */ }
    }
  }
}

/** 行内计数：按本地类型归一化后分类。 */
function typeBucket(t: number): string {
  const m = t > 0x100000000 ? t % 0x100000000 : t
  if (m === 1) return 'text'
  if (m === 3) return 'image'
  if (m === 34) return 'voice'
  if (m === 43) return 'video'
  if (m === 49) return 'rich'
  if (m === 10000) return 'system'
  if (m === 10002) return 'revoked'
  return 'other'
}

/**
 * Compute overview insights.
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid, used to split 发出/收到.
 * @returns the insights snapshot.
 */
export async function queryOverviewInsights(decryptedDir: string, selfUsername?: string): Promise<OverviewInsights> {
  const dec = decryptedDir
  const self = (selfUsername ?? '').trim()
  const sns = existsSync(join(dec, 'sns', 'db_sns', 'sns.db')) ? join(dec, 'sns', 'db_sns', 'sns.db') : join(dec, 'sns', 'sns.db')
  const sig = [
    shardCatalogSig(dec, ['message', 'bizchat']),
    fileSigOf(join(dec, 'contact', 'contact.db')),
    fileSigOf(join(dec, 'session', 'session.db')),
    fileSigOf(sns),
    fileSigOf(join(dec, 'favorite', 'favorite.db')),
    fileSigOf(join(dec, 'emoticon', 'emoticon.db')),
    fileSigOf(join(dec, 'hardlink', 'hardlink.db')),
    fileSigOf(join(dec, 'message', 'message_resource.db')),
  ].join('|')
  return cachedBySigAsync('overview-insights:' + dec + ':' + self, sig, () => computeOverviewInsights(decryptedDir, self))
}

/** 一个分片的**部分聚合**（可加）：分片级增量缓存的单元。 */
interface InsightsShardAgg {
  n: number
  sent: number
  buckets: Record<string, number>
  hourDist: number[]
  dayCounts: Array<[number, number]>
  talker: Array<[string, number]>
  minDay: number
  maxDay: number
  lastActive: number
}

/** 分片级聚合缓存：键 `分片#self#talkerKey`，指纹 `fileSigOf(分片)`（含 SQLite 变更计数器）。 */
const INSIGHTS_SHARD_CACHE_MAX = 64
const insightsShardCache = new Map<string, { sig: string; agg: InsightsShardAgg }>()

/** 累计量与极值的容器（循环里用 `t` / `b` 两个对象，便于整体抽到模块级纯函数）。 */
interface InsightsTotals {
  total: { n: number; sent: number }
  buckets: Record<string, number>
  hourDist: number[]
  dayCounts: Map<number, number>
  talkerCount: Map<string, number>
}
interface InsightsBounds { minDay: number; maxDay: number; lastActive: number }

/**
 * 循环后的纯计算：最忙小时、深夜条数、周末条数。
 * 抽出来是为了**净缩短** `computeOverviewInsights`（单函数行数棘轮）。
 */
function postProcessInsights (hourDist: number[], dayCounts: Map<number, number>): { busyHour: number; busyCount: number; deepNight: number; weekend: number } {
  let busyHour = 0
  let busyCount = 0
  let deepNight = 0
  for (let i = 0; i < 24; i++) {
    const n = hourDist[i] ?? 0
    if (n > busyCount) { busyCount = n; busyHour = i }
    if (i >= 23 || i <= 5) deepNight += n
  }
  let weekend = 0
  for (const [d, n] of dayCounts) {
    const dow = (d + 4) % 7
    if (dow === 0 || dow === 6) weekend += n
  }
  return { busyHour, busyCount, deepNight, weekend }
}

/** 分片缓存的键：talker 名来自 contact.db + session.db，它们变了就必须换键。 */
function shardCacheKey (file: string, self: string, dec: string): string {
  return file + '#' + self + '#' + fileSigOf(join(dec, 'contact', 'contact.db')) + '|' + fileSigOf(join(dec, 'session', 'session.db'))
}

/** 拍快照（map/数组都复制一份）。 */
function snapshotTotals (t: InsightsTotals, b: InsightsBounds): { snap: InsightsTotals; bounds: InsightsBounds } {
  return {
    snap: {
      total: { ...t.total },
      buckets: { ...t.buckets },
      hourDist: [...t.hourDist],
      dayCounts: new Map(t.dayCounts),
      talkerCount: new Map(t.talkerCount),
    },
    bounds: { ...b },
  }
}

/** 把分片的部分聚合逐字段加回总量（**不碰数据库** ⇒ 连接纪律棘轮看不见它）。 */
function mergeInsightsShard (t: InsightsTotals, agg: InsightsShardAgg): void {
  t.total.n += agg.n
  t.total.sent += agg.sent
  for (const [k, v] of Object.entries(agg.buckets)) t.buckets[k] = (t.buckets[k] ?? 0) + v
  for (let i = 0; i < 24; i++) t.hourDist[i] = (t.hourDist[i] ?? 0) + (agg.hourDist[i] ?? 0)
  for (const [d, n] of agg.dayCounts) t.dayCounts.set(d, (t.dayCounts.get(d) ?? 0) + n)
  for (const [k, n] of agg.talker) t.talkerCount.set(k, (t.talkerCount.get(k) ?? 0) + n)
}

/** 缓存命中就合并并返回新极值；未命中返回 `null`。**命中路径连数据库都不打开**（省时的来源）。 */
function applyCachedShard (key: string, sig: string, t: InsightsTotals, b: InsightsBounds): InsightsBounds | null {
  const hit = insightsShardCache.get(key)
  if (!hit || hit.sig !== sig) return null
  mergeInsightsShard(t, hit.agg)
  return {
    minDay: hit.agg.minDay >= 0 && (b.minDay < 0 || hit.agg.minDay < b.minDay) ? hit.agg.minDay : b.minDay,
    maxDay: hit.agg.maxDay >= 0 && hit.agg.maxDay > b.maxDay ? hit.agg.maxDay : b.maxDay,
    lastActive: Math.max(b.lastActive, hit.agg.lastActive),
  }
}

/** 未命中路径的收尾：由"跑完之后 − 快照"得到本分片增量并入缓存。 */
function recordShard (
  key: string,
  sig: string,
  t: InsightsTotals,
  b: InsightsBounds,
  before: { snap: InsightsTotals; bounds: InsightsBounds },
): void {
  const agg: InsightsShardAgg = {
    n: t.total.n - before.snap.total.n,
    sent: t.total.sent - before.snap.total.sent,
    buckets: diffRecord(before.snap.buckets, t.buckets),
    hourDist: t.hourDist.map((v, i) => (v ?? 0) - (before.snap.hourDist[i] ?? 0)),
    dayCounts: diffMapNums(before.snap.dayCounts, t.dayCounts),
    talker: diffMapNums(before.snap.talkerCount, t.talkerCount),
    minDay: b.minDay >= 0 && b.minDay !== before.bounds.minDay ? b.minDay : -1,
    maxDay: b.maxDay > before.bounds.maxDay ? b.maxDay : -1,
    lastActive: b.lastActive > before.bounds.lastActive ? b.lastActive : 0,
  }
  insightsShardCache.set(key, { sig, agg })
  if (insightsShardCache.size > INSIGHTS_SHARD_CACHE_MAX) {
    const oldest = insightsShardCache.keys().next().value
    if (oldest !== undefined) insightsShardCache.delete(oldest)
  }
}

function diffRecord (before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0)
    if (d !== 0) out[k] = d
  }
  return out
}

function diffMapNums<K> (before: Map<K, number>, after: Map<K, number>): Array<[K, number]> {
  const out: Array<[K, number]> = []
  for (const [k, v] of after) {
    const d = v - (before.get(k) ?? 0)
    if (d !== 0) out.push([k, d])
  }
  return out
}

async function computeOverviewInsights(decryptedDir: string, self = ''): Promise<OverviewInsights> {
  const dec = decryptedDir
  const names = contactMeta(dec).names

  // 反向映射 md5(table suffix) -> 联系人。真实账号来自 contactMeta 与
  // SessionTable（下方合并），不再注入硬编码示例账号。
  const md5ToUser = new Map<string, string>()
  for (const u of names.keys()) md5ToUser.set(createHash('md5').update(u, 'utf8').digest('hex'), u)
  try {
    const sp = join(dec, 'session', 'session.db')
    if (existsSync(sp)) {
      const db = new DatabaseSync(sp, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined
      if (has) {
        // 会话量级（N8 评估：随会话数增长，不随消息数），保留一次性取回
        const rows = db.prepare('SELECT username FROM SessionTable').all() as Array<Record<string, unknown>>
        for (const r of rows) {
          const u = cellStr(r['username'])
          if (u) md5ToUser.set(createHash('md5').update(u, 'utf8').digest('hex'), u)
        }
      }
      db.close()
    }
  } catch { /* ignore */ }

  const total = { n: 0, sent: 0 }
  const buckets: Record<string, number> = { text: 0, image: 0, voice: 0, video: 0, rich: 0, system: 0, revoked: 0, other: 0 }
  const hourDist = new Array<number>(24).fill(0)
  const dayCounts = new Map<number, number>()
  const talkerCount = new Map<string, number>()
  let minDay = -1
  let maxDay = -1
  let lastActive = 0

  // 累计量容器：与循环**共享同一批对象**（引用共享 ⇒ 循环体一个字都不用改）
  const t: InsightsTotals = { total, buckets, hourDist, dayCounts, talkerCount }
  for (const sh of shardCatalogDirs(dec, ['message', 'bizchat'])) {
    // P1-2：每个分片要对它的全部 Msg_ 表各跑一次 GROUP BY 扫描（实测机器上 239 张表）。
    // 分片之间让出一次，排在这个查询后面的请求才有插进来的机会 ——
    // 不透明地"跑完再说"就是「某块一直转圈」的那笔账（：
    // 世界板块自身 13ms，排在 15 秒的词云后面等到 17,008ms）。
    await yieldToLoop()
    const shardKey = shardCacheKey(sh.file, self, dec)
    const shardSig = fileSigOf(sh.file)
    const hitBounds = applyCachedShard(shardKey, shardSig, t, { minDay, maxDay, lastActive })
    if (hitBounds) {
      minDay = hitBounds.minDay
      maxDay = hitBounds.maxDay
      lastActive = hitBounds.lastActive
      continue
    }
    const before = snapshotTotals(t, { minDay, maxDay, lastActive })
    try {
      const db = new DatabaseSync(sh.file, { readOnly: true })
      try {
        // 「自己发了多少条」必须用 `real_sender_id` 经**本分片**的 Name2Id 解析：
        // 每个分片的 Name2Id 是它自己的 id 空间（实测 239 张表的 Name2Id 都能解析出自己）。
        // 旧实现读的是 `is_sender` 列 —— WeChat 4.x 的 Msg_ 表**没有这一列**
        // （0/239 张表有），于是 `SUM('0')` 恒为 0：导出报告里写的是「发出 0 / 收到 139,362」。
        let selfRowId: number | undefined
        if (self) {
          const first = sh.tables.values().next().value
          if (first) {
            for (const [id, name] of first.name2id) {
              if (name === self) { selfRowId = id; break }
            }
          }
        }
        for (const [table, meta] of sh.tables) {
          if (!meta.cols.has('create_time') || !meta.cols.has('local_type')) continue
          const sentExpr = meta.cols.has('real_sender_id') && selfRowId !== undefined
            ? 'SUM(CASE WHEN real_sender_id = ' + selfRowId + ' THEN 1 ELSE 0 END)'
            : '0'
          const grouped = db.prepare(
            'SELECT (local_type & 4294967295) AS t, (create_time / 3600) % 24 AS h, create_time / 86400 AS d, COUNT(*) AS n, ' + sentExpr + ' AS s, MAX(create_time) AS m FROM ' + table + ' GROUP BY t, h, d',
          ).all() as Array<{ t: number; h: number; d: number; n: number; s: number; m: number | null }>
          let tn = 0
          for (const g of grouped) {
            const b = typeBucket(g.t)
            buckets[b] = (buckets[b] ?? 0) + g.n
            total.sent += g.s
            tn += g.n
            hourDist[((g.h % 24) + 24) % 24] = (hourDist[((g.h % 24) + 24) % 24] ?? 0) + g.n
            const d = g.d
            dayCounts.set(d, (dayCounts.get(d) ?? 0) + g.n)
            if (minDay < 0 || d < minDay) minDay = d
            if (d > maxDay) maxDay = d
            if (g.m) lastActive = Math.max(lastActive, g.m)
          }
          total.n += tn
          const talker = md5ToUser.get(table.slice(4)) ?? table.slice(4)
          talkerCount.set(talker, (talkerCount.get(talker) ?? 0) + tn)
        }
      } finally {
        db.close()
      }
    } catch { /* skip shard */ }
    // 把本分片增量入缓存（极值只在"这次真的推动了它"时记入，见 recordShard）
    recordShard(shardKey, shardSig, t, { minDay, maxDay, lastActive }, before)
  }

  // 循环后的纯计算抽成模块级助手（单函数行数棘轮：这段搬走让本函数净变短）
  const { busyHour, busyCount, deepNight, weekend } = postProcessInsights(hourDist, dayCounts)
  const totalSafe = Math.max(1, total.n)

  // 关系浓度
  const contactRows: Array<{ username: string; isGroup: boolean; isGh: boolean }> = []
  const cp = join(dec, 'contact', 'contact.db')
  if (existsSync(cp)) {
    try {
      // withDb：原来 `new DatabaseSync` 与 `db.close()` 之间任何一句抛错（PRAGMA 读坏页、
      // SELECT 撞 SQLITE_BUSY）都会跳过 close，而外面的 catch 把它咽成「ignore」。
      withDb(cp, (db) => {
        const cols = new Set((db.prepare('PRAGMA table_info(contact)').all() as Array<{ name: string }>).map(r => r.name))
        if (!cols.has('username')) return
        const lt = cols.has('local_type') ? 'local_type' : '0'
        const df = cols.has('delete_flag') ? 'delete_flag' : '0'
        // 联系人量级（N8 评估）：随后面要建的 per-contact 统计一起用，取回后要遍历两遍
        const rows = db.prepare(`SELECT username, ${lt} AS lt, ${df} AS df FROM contact WHERE (${df} = 0 OR ${df} IS NULL)`).all() as Array<{ username: unknown; lt?: number; df?: number }>
        for (const r of rows) {
          const u = cellStr(r['username'])
          if (!u) continue
          if (u.startsWith('@')) continue
          contactRows.push({ username: u, isGroup: u.includes('@chatroom'), isGh: u.startsWith('gh_') })
        }
      })
    } catch { /* ignore */ }
  }
  const friendRows = contactRows.filter(r => !r.isGroup && !r.isGh)
  const activeFriends = friendRows.filter(r => talkerCount.has(r.username)).length
  const silentFriends = friendRows.length - activeFriends
  const groupsWithMsg = contactRows.filter(r => r.isGroup && talkerCount.has(r.username)).length
  const top = Array.from(talkerCount.entries())
    .filter(([u]) => !u.includes('@chatroom'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([u, count]) => {
      let name = names.get(u) ?? ''
      if (!name) {
        // 联系人或会话中没有该账号的可读名称；避免直接展示 hash/长用户名。
        name = /^[0-9a-f]{16,}$/i.test(u) ? '未知联系人' : u
      }
      return { username: u, name, count }
    })

  // 朋友圈
  const moments = { total: 0, images: 0, videos: 0, likes: 0, comments: 0 }
  const sp2 = existsSync(join(dec, 'sns', 'db_sns', 'sns.db')) ? join(dec, 'sns', 'db_sns', 'sns.db') : join(dec, 'sns', 'sns.db')
  if (existsSync(sp2)) {
    // withDbAsync 而不是「open … close」写在同一个 try 里：这里任何一句抛错
    // （半写的 sns.db、SQLITE_BUSY）都会跳过那句 `db.close()`，而 Windows 上
    // 一条泄漏的连接等于这个目录再也换不掉。游标跨 await 也必须用异步版（见 db-open 的说明）。
    try {
      await withDbAsync(sp2, async (db) => {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
        if (!has) return
        // 游标读（N8）：随朋友圈条数增长的整表扫，逐条累加即可，不需要先物化数组
        let scanned = 0
        for (const r of db.prepare('SELECT content AS c FROM SnsTimeLine').iterate() as Iterable<{ c?: unknown }>) {
          const xml = cellStr(r.c)
          moments.total += 1
          moments.images += xml.split('<media>').length - 1 + xml.split('<media ').length - 1
          if (xml.includes('<type>6</type>') || xml.includes('<type>4</type>') || xml.includes('<type>15</type>')) moments.videos += 1
          const le = xml.indexOf('<LocalExtraInfo>')
          if (le >= 0) {
            const block = xml.slice(le, xml.indexOf('</LocalExtraInfo>', le) || xml.length)
            const parts = block.split('<user_comment>').length - 1
            const likes = (block.match(/<type>1<\/type>/g) ?? []).length
            moments.likes += likes
            moments.comments += Math.max(0, parts - likes)
          }
          // 每 2000 条让出一次：这条循环是**单库内**最长的一段（朋友圈多的人有几万条），
          // 只在分片边界让出还不够。行数而不是时间，是为了让判据可复现（见 spec）。
          if (++scanned % SNS_YIELD_EVERY_ROWS === 0) await yieldToLoop()
        }
        if (scanned % SNS_YIELD_EVERY_ROWS !== 0) await yieldToLoop()
      })
    } catch { /* 读不到朋友圈计数：总览那格留空，不影响其它统计 */ }
  }

  // 资产
  const assets = { favorites: 0, emoticons: 0, files: 0, fileBytes: 0, mediaItems: 0, mediaBytes: 0 }
  assets.favorites = countRows(join(dec, 'favorite', 'favorite.db'), 'fav_db_item')
  assets.emoticons = countRows(join(dec, 'emoticon', 'emoticon.db'), 'kNonStoreEmoticonTable')
  for (const table of ['image_hardlink_info_v4', 'file_hardlink_info_v4', 'video_hardlink_info_v4']) {
    const hp = join(dec, 'hardlink', 'hardlink.db')
    if (!existsSync(hp)) break
    try {
      const db = new DatabaseSync(hp, { readOnly: true })
      const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() !== undefined
      if (has) {
        const c = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS s FROM ${table}`).get() as { n: number; s: number }
        assets.files += c.n
        assets.fileBytes += c.s
      }
      db.close()
    } catch { /* ignore */ }
  }
  const rp = join(dec, 'message', 'message_resource.db')
  if (existsSync(rp)) {
    try {
      const db = new DatabaseSync(rp, { readOnly: true })
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== undefined) {
        const c = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM MessageResourceDetail').get() as { n: number; s: number }
        assets.mediaItems = c.n
        assets.mediaBytes = c.s
      }
      db.close()
    } catch { /* ignore */ }
  }

  // 数据健康
  const dbs: Array<{ path: string; bytes: number }> = []
  walkDbFiles(dec, dbs, 0)
  const dbBytes = dbs.reduce((a, r) => a + r.bytes, 0)

  return {
    messages: {
      total: total.n,
      sent: total.sent,
      received: Math.max(0, total.n - total.sent),
      text: buckets.text ?? 0,
      image: buckets.image ?? 0,
      voice: buckets.voice ?? 0,
      video: buckets.video ?? 0,
      rich: buckets.rich ?? 0,
      system: buckets.system ?? 0,
      revoked: buckets.revoked ?? 0,
    },
    time: {
      activeDays: dayCounts.size,
      spanDays: maxDay >= 0 && minDay >= 0 ? maxDay - minDay + 1 : 0,
      busyHour,
      busyCount,
      hourDist,
      deepNightPct: Math.round((deepNight / totalSafe) * 1000) / 10,
      weekendPct: Math.round((weekend / totalSafe) * 1000) / 10,
      lastActive: lastActive ? new Date(lastActive * 1000).toLocaleString('zh-CN') : '',
    },
    relations: {
      total: friendRows.length,
      active: activeFriends,
      silent: silentFriends,
      groupsWithMsg,
      top,
    },
    moments,
    assets,
    health: { dbFiles: dbs.length, dbBytes, ok: total.n > 0 || contactRows.length > 0 },
    extras: queryOverviewExtras(decryptedDir),
  }
}

function countRows(path: string, table: string): number {
  if (!existsSync(path)) return 0
  try {
    return withDb(path, (db) => {
      const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() !== undefined
      if (!has) return 0
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    })
  } catch { return 0 }
}

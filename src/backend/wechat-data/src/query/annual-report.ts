/**
 * Annual report: local-only yearly WeChat chat story, rewritten from
 * st_control AnnualSummary + utils/annual.ts. Scans all message shards for
 * one year and computes hero stats, heatmap, monthly, types, phrases, emoji,
 * top contacts/groups, and first/last sentences.
 */
import { DatabaseSync } from './db-open.ts'
import { withDb } from './db-open.ts'
import { decompress } from 'fzstd'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ANNUAL_TTL_MS, cachedBySigAsync, contactMeta, shardCatalogSig } from './meta.ts'
import { YIELD_EVERY_CHARS, YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import { throwIfCancelled, type StreamControl, type StreamProgress } from './zip.ts'

/** Msg_<md5(username)> table name. */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress(data: Buffer): Buffer | null {
  if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(data)) } catch { return null }
  }
  return null
}

/** Decode bytes as UTF-8, falling back to GBK when UTF-8 leaves replacement chars. */
function decodeUtfOrGbk(bytes: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes)
    const utf8Bad = (utf8.match(/\uFFFD/g) ?? []).length
    const gbkBad = (gbk.match(/\uFFFD/g) ?? []).length
    return gbkBad < utf8Bad ? gbk : utf8
  } catch { return utf8 }
}

/** Decode a message cell (TEXT or BLOB): zstd-decompress, then UTF-8/GBK. */
function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = tryDecompress(raw)
  return decodeUtfOrGbk(decompressed ?? raw)
}

/** Strip XML tags for text. */
function stripXml(x: string): string {
  return x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Extract group sender from content prefix (wxid:\n). */
function senderFromContent(content: string): string | null {
  const m = content.match(/([A-Za-z0-9_@.\-]{3,64}):\n/)
  return m ? (m[1] ?? null) : null
}

/** Clean a message preview: strip binary header + group sender prefix + XML. */
function cleanMessage(text: string): string {
  let t = text
  // group-chat content is '<binary>wxid_xxx: <body>' (colon may be followed by
  // space or newline); keep only the body after the first username-like prefix
  const m = t.match(/(?:[A-Za-z0-9_@.\-]{3,64}:\s*)([\s\S]*)/)
  if (m && m[1] && !m[1].startsWith('<')) t = m[1]
  // strip leading binary/control bytes and XML tags
  t = t.replace(/^[\x00-\x1f\x7f-\x9f]*/, '')
  t = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return t.slice(0, 120)
}

/** Compute persona tags from shares. */
function personaTags(s: {
  nightShare: number
  morningShare: number
  weekendShare: number
  groupShare: number
  dailyAvg: number
}): string[] {
  const tags: string[] = []
  if (s.nightShare >= 0.2) tags.push('夜猫子')
  if (s.morningShare >= 0.15) tags.push('早起鸟')
  if (s.weekendShare >= 0.25) tags.push('周末达人')
  if (s.groupShare >= 0.6) tags.push('群聊之王')
  if (s.dailyAvg >= 50) tags.push('话痨')
  if (tags.length === 0) tags.push('稳健沟通者')
  return tags
}

/**
 * 年报（带**签名缓存**）。
 *
 * ## 为什么必须缓存（2026-09-29 第 79/80 轮实测）
 *
 * 这个接口**每次调用都真扫 ~200 万行**：实测冷跑 **2501ms**、紧接着再跑一次 **2496ms** ——
 * **冷热几乎一样，说明此前完全没有结果缓存**。
 * 它是"用户点开年报要等 2.5 秒"的直接原因（`exportAnnualReport` 走同一条路，所以约 3s）。
 *
 * 缓存键 = `年份 + message 目录的分片目录签名`：分片文件变了（实时同步落地新数据、
 * 或整库重解密）签名就变，缓存自然失效 —— 与 `asset-insights` / `moments-monthly`
 * 用的是同一套 `cachedBySigAsync` 机制，不引入新概念。
 *
 * @param decryptedDir - 解密数据根。
 * @param year - 自然年。
 * @returns 年报快照。
 */
export async function queryAnnualReport(decryptedDir: string, year: number, ctrl?: StreamControl): Promise<Record<string, unknown>> {
  const sig = [String(year), shardCatalogSig(decryptedDir, ['message'])].join('|')
  return cachedBySigAsync('annual-report:' + decryptedDir + ':' + String(year), sig,
    // ⚠ 取消是在 loader **内部**抛的 ⇒ `cachedBySigAsync` 什么都不会写；
    //   半张年报进缓存的话，接下来 60 秒里每次都拿到那份残缺的（与 9.4 词云同一条纪律）。
    () => computeAnnualReport(decryptedDir, year, ctrl), ANNUAL_TTL_MS)
}

/**
 * 真正算年报（无缓存）。
 * @param decryptedDir - decrypted data root.
 * @param year - calendar year.
 * @param ctrl - 可选的进度上报 + 取消令牌（W2-8.2）。取消在 loader 内抛出，缓存不会写。
 * @returns the annual report.
 */
async function computeAnnualReport(decryptedDir: string, year: number, ctrl?: StreamControl): Promise<Record<string, unknown>> {
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { year, total: 0 }
  const start = Math.floor(new Date(year, 0, 1, 0, 0, 0, 0).getTime() / 1000)
  const end = Math.floor(new Date(year + 1, 0, 1, 0, 0, 0, 0).getTime() / 1000)
  // gather sessions
  const usernames = loadUsernames(decryptedDir)
  const perSender = new Map<string, number>()
  const perChat = new Map<string, number>()
  const heat = new Array<number>(7 * 24).fill(0)
  const monthly = new Array<number>(12).fill(0)
  const kindCounts = new Map<string, number>()
  const emojiCount = new Map<string, number>()
  const phraseCount = new Map<string, number>()
  const activeDays = new Set<string>()
  let total = 0
  let textCount = 0
  let textChars = 0
  let nightCount = 0
  let morningCount = 0
  let weekendCount = 0
  let groupCount = 0
  let firstMsg: string | null = null
  let lastMsg: string | null = null
  let firstTs = Number.POSITIVE_INFINITY
  let lastTs = 0

  const files = readdirSync(msgDir).filter(f =>
    f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache')
    && !f.includes('media') && !f.includes('resource') && !f.includes('fts'))

  // File-first indexing: open each shard once and map its Msg_* tables to
  // session usernames, so the per-session loop never reopens a file.
  const tableToUser = new Map<string, string>()
  for (const username of usernames) tableToUser.set(msgTableName(username), username)
  const fileInfos: Array<{ path: string; tables: Array<[string, string]> }> = []
  for (const file of files) {
    let probe: DatabaseSync | null = null
    try { probe = new DatabaseSync(join(msgDir, file), { readOnly: true }) } catch { continue }
    try {
      const names = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      const tables: Array<[string, string]> = []
      for (const n of names) {
        const u = tableToUser.get(n)
        if (u) tables.push([n, u])
      }
      if (tables.length > 0) fileInfos.push({ path: join(msgDir, file), tables })
    } catch { /* skip */ } finally { probe.close() }
  }

  // Stats pass: one open per shard, one year-scoped query per session table.
  for (const fi of fileInfos) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(fi.path, { readOnly: true }) } catch { continue }
    try {
      for (const [table, username] of fi.tables) {
        try {
          // 这里曾经 `SELECT … is_sender …` 并在行里读成 `is_sender`，但**从未使用**；
          // 而 WeChat 4.x 的 Msg_ 表根本没有这一列（0/239 张有），所以那是个恒为 '0' 的死列。
          // 年报没有「发出/收到」口径（该口径在 overview-insights 里，用 real_sender_id 解析），
          // 因此直接去掉这个投影，避免下一个人误以为它有用。
          // 2026-09-28：`.all()` → 游标 + 行级让出。
          // 真实 @Remote 层探针实测（`working/probe-remote.txt`，用真实 username/year 播种后
          // 才测到）：`getAnnualReport` 冷跑 **2254ms 且一次都不让出**、`getAnnualReview`
          // **2150ms**、`exportAnnualReport` **4048ms** —— 三个都走这条同一段扫描。
          // 后端是串行 worker，整段独占期间**所有面板都动不了**。
          // 这里每行还要 `stripXml` + 逐字符生成 CJK bigram（下面），是纯 CPU 重活。
          const cur = db.prepare('SELECT create_time, local_type, message_content FROM "' + table + '" WHERE create_time >= ? AND create_time < ?').iterate(start, end) as Iterable<Record<string, unknown>>
          let scannedRows = 0
          let sinceYield = 0
          let charsSinceYield = 0
          for (const r of cur) {
            // 让出检查放在**循环最前面**：下面有 `continue`（二进制逗号列表那条），
            // 若把检查放在循环末尾，那种行会跳过让出计数 —— 数据里这种行成片出现时
            // 就等于整段不让出，正是本条要修的病。
            sinceYield += 1
            if (sinceYield >= YIELD_EVERY_ROWS || charsSinceYield >= YIELD_EVERY_CHARS) {
              sinceYield = 0
              charsSinceYield = 0
              await yieldToLoop()
              // W2-8.2：这段扫描是年报唯一的长耗时（实测整段 4048ms，见上面那段注释），
              // 进度与取消都挂在这个让出点上 —— 它本来就是「这一大坨 CPU 重活」的边界。
              throwIfCancelled(ctrl?.signal)
              ctrl?.onProgress?.({ phase: 'collect', done: scannedRows, total: 0 } satisfies StreamProgress)
            }
            scannedRows += 1
            const ts = Number(r['create_time'] ?? 0)
            const lt = Number(r['local_type'] ?? 0)
            const content = decodeCell(r['message_content'])
            charsSinceYield += content.length
            const text = stripXml(content)
            // skip binary comma-lists
            if (text && /^[0-9,]+$/.test(text.slice(0, 80))) continue
            total += 1
            if (username.endsWith('@chatroom')) {
              // group chat: attribute to the sender when the content carries a
              // wxid prefix; the chatroom itself never ranks as a person
              const sender = senderFromContent(content)
              if (sender && !sender.endsWith('@chatroom')) perSender.set(sender, (perSender.get(sender) ?? 0) + 1)
            } else {
              perSender.set(username, (perSender.get(username) ?? 0) + 1)
            }
            perChat.set(username, (perChat.get(username) ?? 0) + 1)
            if (username.endsWith('@chatroom')) groupCount += 1
            const d = new Date(ts * 1000)
            const h = d.getHours()
            const dow = d.getDay()
            heat[dow * 24 + h] = (heat[dow * 24 + h] ?? 0) + 1
            monthly[d.getMonth()] = (monthly[d.getMonth()] ?? 0) + 1
            const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
            activeDays.add(dayKey)
            if (h >= 23 || h <= 4) nightCount += 1
            if (h >= 5 && h <= 9) morningCount += 1
            if (dow === 0 || dow === 6) weekendCount += 1
            const normType = lt > 4294967296 ? lt % 4294967296 : lt
            if (normType === 1 && text) {
              textCount += 1
              textChars += text.length
              // phrases: CJK bigrams
              //
              // 2026-09-29（第 79 轮）：**先判码点、再 slice**。
              // 原写法是逐位 `text.slice(i, i+2)` 然后对那 2 个字符跑一次正则 ——
              // 每个字符位都要**分配一个新字符串**再交给正则，是本函数最贵的几步之一。
              // 微基准（`working/probe-bigram.ts`，1928 条真实文本、均 2561 字符）：
              //   原写法 **74 ms** → 现写法 **24 ms**（3.1×），且**结果完全一致**（唯一 bigram 30、总计 41）。
              // 只在两个字符**都**落在 CJK 区时才分配，绝大多数位置一次 `charCodeAt` 就排除掉了。
              for (let i = 0; i + 2 <= text.length; i += 1) {
                const ca = text.charCodeAt(i)
                const cb = text.charCodeAt(i + 1)
                if (ca >= 0x4e00 && ca <= 0x9fff && cb >= 0x4e00 && cb <= 0x9fff) {
                  const bi = text.slice(i, i + 2)
                  phraseCount.set(bi, (phraseCount.get(bi) ?? 0) + 1)
                }
              }
              // emoji: simple extraction of common emoji ranges
              const emo = text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []
              for (const e of emo) emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1)
            }
            kindCounts.set(typeLabel(normType), (kindCounts.get(typeLabel(normType)) ?? 0) + 1)
            if (ts > lastTs && text) { lastTs = ts; lastMsg = text.slice(0, 80) }
            if (ts < firstTs && text) { firstTs = ts; firstMsg = text.slice(0, 80) }
          }
        } catch { /* skip */ }
      }
    } finally { db.close() }
  }

  const activeDaysCount = activeDays.size
  const dailyAvg = activeDaysCount > 0 ? Math.round(total / activeDaysCount) : 0
  const textShare = total > 0 ? textCount / total : 0
  const nightShare = total > 0 ? nightCount / total : 0
  const morningShare = total > 0 ? morningCount / total : 0
  const weekendShare = total > 0 ? weekendCount / total : 0
  const groupShare = total > 0 ? groupCount / total : 0
  const nameMap = contactMeta(decryptedDir).names
  const topContacts = Array.from(perSender.entries()).filter(([u]) => !u.endsWith('@chatroom') && !u.startsWith('gh_')).map(([username, count]) => ({ username, name: nameMap.get(username) || username, count, share: total > 0 ? count / total : 0 })).sort((a, b) => b.count - a.count).slice(0, 10)
  const topGroups = Array.from(perChat.entries()).filter(([u]) => u.endsWith('@chatroom')).map(([username, count]) => ({ username, name: nameMap.get(username) || username, count, share: total > 0 ? count / total : 0 })).sort((a, b) => b.count - a.count).slice(0, 10)
  const topEmoji = Array.from(emojiCount.entries()).map(([e, n]) => ({ emoji: e, count: n })).sort((a, b) => b.count - a.count).slice(0, 8)
  const topPhrases = Array.from(phraseCount.entries())
    .map(([p, n]) => ({ phrase: p, count: n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
  const out: Record<string, unknown> = {
    year,
    total,
    active_days: activeDaysCount,
    text_chars: textChars,
    daily_avg: dailyAvg,
    text_share: Number(textShare.toFixed(4)),
    night_share: Number(nightShare.toFixed(4)),
    morning_share: Number(morningShare.toFixed(4)),
    weekend_share: Number(weekendShare.toFixed(4)),
    group_share: Number(groupShare.toFixed(4)),
    heat,
    monthly,
    kind_counts: Object.fromEntries(kindCounts),
    top_phrases: topPhrases,
    top_emoji: topEmoji,
    top_contacts: topContacts,
    top_groups: topGroups,
    persona_tags: personaTags({ nightShare, morningShare, weekendShare, groupShare, dailyAvg }),
  }
  if (firstMsg) out.first_message = cleanMessage(firstMsg)
  if (lastMsg) out.last_message = cleanMessage(lastMsg)
  return out
}

/** Load session usernames. */
function loadUsernames(decryptedDir: string): string[] {
  const p = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(p)) return []
  const out: string[] = []
  try {
    withDb(p, (db) => {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
      const table = tables.includes('SessionTable') ? 'SessionTable' : tables.includes('Session') ? 'Session' : ''
      if (table) {
        const rows = db.prepare('SELECT username FROM "' + table + '"').all() as Array<Record<string, unknown>>
        for (const r of rows) { const u = cellStr(r['username'] ?? '').trim(); if (u) out.push(u) }
      }
    })
  } catch { /* skip */ }
  return out
}

/** Human label for a message type. */
function typeLabel(t: number): string {
  if (t === 1) return '文本'
  if (t === 3) return '图片'
  if (t === 34) return '语音'
  if (t === 42) return '名片'
  if (t === 43) return '视频'
  if (t === 47) return '表情'
  if (t === 48) return '位置'
  if (t === 49) return '链接'
  if (t === 10000) return '系统消息'
  return '其他'
}

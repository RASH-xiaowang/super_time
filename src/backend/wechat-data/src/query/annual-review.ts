/**
 * 年度回顾（「年度总结」看板）聚合。
 *
 * 与已有的 `annual-report.ts` 的区别：那份是**总量口径**的简版，靠 GROUP BY 汇总；
 * 这份要支撑 15 张卡片的完整看板，因此必须逐条读消息，才能算「连续天数 / 回复速度 /
 * 谁先开口 / 搭子 / 深夜里的那一条 / 首尾句」这类**序列相关**指标。
 *
 * 口径（与需求确认一致）：
 *   · **人物类指标只算「我发出的」**（全年发出 / 发给几个人 / 排行 / 搭子 / 口头禅 /
 *     回复速度 / 谁先开口）——「我」用 `real_sender_id` 经**本分片** Name2Id 解析，
 *     与 overview-insights 同源；
 *   · **规模类指标算全部消息**（日历热力图 / 最疯的一天 / 作息切片）——两类若混用口径，
 *     就会出现「日均 28 条、但最疯的一天 2,218 条」这种读者无法解释的数字。
 */
import { DatabaseSync } from 'node:sqlite'
import { decompress } from 'fzstd'
import { createHash } from 'node:crypto'
import { contactMeta, shardCatalogDirs } from './meta.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 会话内「新一次对话」的间隔阈值（秒）：超过视为新一轮，用于「谁先开口」。 */
const CONV_GAP_S = 6 * 3600
/** 回复间隔上限（秒）：超过一天的不算「回复」（多为隔天另起话题）。 */
const REPLY_MAX_S = 86400
/** 短表达长度区间（「口头禅」候选）。 */
const PHRASE_MIN = 2
const PHRASE_MAX = 8
/** 出现次数下限（「成了口头禅」的判据）。 */
const CATCH_MIN_COUNT = 3

/* ────────────── 解码 ────────────── */

function tryDecompress(data: Buffer): Buffer | null {
  if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(data)) } catch { return null }
  }
  return null
}

function decodeUtfOrGbk(bytes: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes)
    const u = (utf8.match(/\uFFFD/g) ?? []).length
    const g = (gbk.match(/\uFFFD/g) ?? []).length
    return g < u ? gbk : utf8
  } catch { return utf8 }
}

function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  return decodeUtfOrGbk(tryDecompress(raw) ?? raw)
}

/** 群聊正文前缀 `wxid_xxx:` 剥离。 */
function splitSender(content: string): { sender: string; body: string } {
  const m = content.match(/^([A-Za-z0-9_@.\-]{4,64}):[\s]/)
  // 匹配成功就一定有捕获组 1；兜回的空串正是「没有发言人前缀」这条分支本来的取值。
  return m ? { sender: m[1] ?? '', body: content.slice(m[0].length) } : { sender: '', body: content }
}

/** 去掉 XML 标签与压缩二进制逗号表，得到可读短句。 */
function readableText(raw: string): string {
  if (/^[0-9,]{20,}$/.test(raw.slice(0, 60))) return ''
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function xmlAttr(text: string, tag: string, attr: string): string {
  const m = text.match(new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '="([^"]*)"', 'i'))
  // 取不到属性与「属性是空串」在调用方是同一件事（下面 `|| 缺省` 会接手），所以兜空串不改变口径。
  return m ? (m[1] ?? '') : ''
}

function tagText(text: string, tag: string): string {
  const m = text.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'))
  return m ? (m[1] ?? '').trim() : ''
}

function normType(lt: number): number {
  return lt > 4294967296 ? lt % 4294967296 : lt
}

/** `<msg>` 里的通话时长/是否接通（与 calls.ts 同源语义）。 */
const RE_ANSWERED_ELSEWHERE = /已在其它设备接听|已在其他设备接听/
function parseCall(text: string): { sec: number; connected: boolean } {
  const status = tagText(text, 'msg')
  const m = status.match(/(\d+):(\d+)/)
  const sec = m ? Number(m[1]) * 60 + Number(m[2]) : 0
  return { sec, connected: sec > 0 || RE_ANSWERED_ELSEWHERE.test(status) }
}

/* ────────────── 结果结构 ────────────── */

/** 榜单条目。 */
export interface AnnualRankRow { username: string; name: string; total: number; mine: number; theirs: number }

/** 最疯的一天。 */
export interface AnnualBusiestDay {
  date: string; n: number; ratio: number; share: number
  topName: string; topCount: number
  firstAt: string; firstText: string; lastAt: string; lastText: string; spanMin: number
}

/** 年度搭子（单聊里双方合计最多的一位）。 */
export interface AnnualBuddy {
  username: string; name: string; total: number; mine: number; theirs: number
  streakDays: number; commonHour: number
  replyBacks: number; fastestSec: number; slowestSec: number
}

/** 十二个月的主演。 */
export interface AnnualMonthlyStar { month: number; username: string; name: string; count: number }

/** 深夜卡。 */
export interface AnnualNight {
  share: number; mine: number; theirs: number
  topName: string; topCount: number; sampleAt: string; sampleText: string
}

/** 作息切片。 */
export interface AnnualRhythm {
  heat: number[]
  brightestDow: number; brightestHour: number; brightestCount: number
  quietestHour: number; quietestCount: number
  nightShare: number; workWeekendRatio: number
}

/** 你说的话。 */
export interface AnnualWords {
  mineChars: number; receivedChars: number; keystrokes: number
  voiceSentCount: number; voiceSentSec: number; voiceRecvCount: number; voiceRecvSec: number
  callSec: number; callCount: number; callConnected: number; callMissed: number
  videoSent: number; voiceMsgSent: number
  longestVoiceSec: number; longestVoiceFrom: string
}

/** 年度口头禅。 */
export interface AnnualCatchphrase {
  phrase: string; count: number
  top: Array<{ phrase: string; count: number }>
  /** 出现过的短表达（去重）数量。 */
  shortTotal: number
  /** 其中够格当「口头禅」的（出现 >= CATCH_MIN_COUNT 次）。 */
  catchTotal: number
}

/** 回复速度。 */
export interface AnnualReply {
  medianSec: number; p90Sec: number
  avgPartnerName: string; avgPartnerSec: number
  fastestName: string; fastestSec: number
  slowestName: string; slowestSec: number
}

/** 谁先开口。 */
export interface AnnualOpener {
  mine: number; theirs: number; share: number
  mostInitiatedByMe: Array<{ name: string; count: number }>
  mostInitiatedByThem: Array<{ name: string; count: number }>
}

/** 表情宇宙。 */
export interface AnnualEmoji {
  /** 贴纸：甩出张数 / 攒下种数。 */
  threw: number; kept: number; perDay: number; days: number
  peakDow: number; peakHour: number; peakCount: number
  top: Array<{ emoji: string; count: number }>
}

/** 「还有这些人」横向卡片。 */
export interface AnnualHighlight { label: string; name: string; username: string; value: string }

/** 完整结果。 */
export interface AnnualReview {
  year: number
  // ① Hero（我发出的）
  sent: number; sentTo: number; sentDailyAvg: number; activeDaysMine: number
  longestStreak: number; newFriends: number; mediaSent: number
  longestSpanFrom: string; longestSpanTo: string
  // ② 日历（全部消息）
  calendar: Array<{ d: string; n: number }>; activeDaysAll: number; maxDayAll: number
  // ③~⑮
  busiest: AnnualBusiestDay | null
  buddy: AnnualBuddy | null
  monthlyStar: AnnualMonthlyStar[]
  starName: string; starUsername: string; starMonths: number
  hottestMonth: number; hottestMonthCount: number
  night: AnnualNight
  rhythm: AnnualRhythm
  words: AnnualWords
  catchphrase: AnnualCatchphrase
  reply: AnnualReply
  opener: AnnualOpener
  ranking: AnnualRankRow[]
  emoji: AnnualEmoji
  highlights: AnnualHighlight[]
  firstAt: string; firstText: string; lastAt: string; lastText: string
}

/* ────────────── 小工具 ────────────── */

function clock(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
function ymd(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function ymdCn(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
function median(list: number[]): number {
  if (list.length === 0) return 0
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  // 中位数：奇数取正中那一个，偶数取中间两个的平均（偶数分支才四舍五入 —— 与抽出下面这两行之前一致）。
  // 用 slice + reduce 而不是 `s[mid]`：后者的类型是 `number | undefined`，而这里没有任何合法的兜底数值 ——
  // 兜 0 等于在年报里凭空造一个「0 秒」，跟真实统计值完全无法区分。
  const even = s.length % 2 === 0
  const middle = even ? s.slice(mid - 1, mid + 1) : s.slice(mid, mid + 1)
  const avg = middle.reduce((a, x) => a + x, 0) / middle.length
  return even ? Math.round(avg) : avg
}
function percentile(list: number[], q: number): number {
  if (list.length === 0) return 0
  const s = [...list].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))
  // 同上：取那一个元素走 slice，不按下标读。`q` 现在恒在 [0,1]（唯一的调用方传 0.9），
  // 加上 `Math.max(0, …)` 只是把「越界 ⇒ 旧代码返回 undefined」这条静默路径堵掉。
  return s.slice(i, i + 1).reduce((a, x) => a + x, 0)
}
/** 最长连续日期段。 */
function longestRun(days: Set<string> | Iterable<string>): { from: string; to: string; days: number } {
  const sorted = [...days].sort()
  const [firstDay] = sorted
  // 空集合（含「首格读不到」这条类型上的分支）都是同一个答案：没有连续段。
  if (firstDay === undefined) return { from: '', to: '', days: 0 }
  let best = { from: firstDay, to: firstDay, days: 1 }
  let curFrom = firstDay
  let curLen = 1
  for (let i = 1; i < sorted.length; i += 1) {
    const prevDay = sorted[i - 1]
    const day = sorted[i]
    // 相邻两天都取得到才比较（`i < length` 已保证）；宁可跳过一天，也不拿 `undefined` 拼出一个
    // `Invalid DateT00:00:00` 的时间戳 —— 那会被当成一个真实的日期边界。
    if (prevDay === undefined || day === undefined) continue
    const prev = new Date(prevDay + 'T00:00:00').getTime()
    const now = new Date(day + 'T00:00:00').getTime()
    if (now - prev === 86400000) curLen += 1
    else { curFrom = day; curLen = 1 }
    if (curLen > best.days) best = { from: curFrom, to: day, days: curLen }
  }
  return best
}
/** 秒 → 可读时长。 */
export function humanDur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.round(sec)}秒`
  if (sec < 3600) return `${Math.round(sec / 60)}分钟`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}小时`
  return `${Math.round(sec / 86400)}天`
}
/** 数组最大值的下标。 */
function argmax(arr: number[]): number {
  let idx = 0
  let best = -1
  for (let i = 0; i < arr.length; i += 1) if ((arr[i] ?? 0) > best) { best = arr[i] ?? 0; idx = i }
  return idx
}

/* ────────────── 扫描期累加桶 ────────────── */

interface Seq { ts: number; mine: boolean }

interface ChatAgg {
  username: string
  total: number
  mine: number
  theirs: number
  seq: Seq[]
  days: Set<string>
  byMonth: number[]
  /** 我/对方主动开口（按 CONV_GAP_S 切分对话轮）。 */
  openMine: number
  openTheirs: number
  /** 我接话的间隔（对方说 → 我回）。 */
  replyGaps: number[]
  /** 深夜（0-6 点）。 */
  nightMine: number
  nightTheirs: number
  nightSampleTs: number
  nightSampleText: string
  hourMine: number[]
  stickerMine: number
  stickerTheirs: number
  calls: number
  callConnected: number
  callSec: number
}

function chatOf(map: Map<string, ChatAgg>, username: string): ChatAgg {
  let c = map.get(username)
  if (!c) {
    c = {
      username, total: 0, mine: 0, theirs: 0, seq: [], days: new Set(), byMonth: new Array(12).fill(0),
      openMine: 0, openTheirs: 0, replyGaps: [], nightMine: 0, nightTheirs: 0,
      nightSampleTs: 0, nightSampleText: '', hourMine: new Array(24).fill(0),
      stickerMine: 0, stickerTheirs: 0, calls: 0, callConnected: 0, callSec: 0,
    }
    map.set(username, c)
  }
  return c
}

/** 是否为「一个人」（单聊）：排除群、公众号、服务号。 */
function isPersonChat(u: string): boolean {
  return !!u && !u.endsWith('@chatroom') && !u.startsWith('gh_') && !u.endsWith('@openim')
}

/* ────────────── 主聚合 ────────────── */

/**
 * 计算某年的完整年度回顾。
 * @param decryptedDir - 解密数据根。
 * @param year - 自然年。
 * @param selfUsername - 登录账号 wxid（「我发出的」归属判据）。
 * @returns 年度回顾结果。
 */
export function queryAnnualReview(decryptedDir: string, year: number, selfUsername = ''): AnnualReview {
  const self = (selfUsername ?? '').trim()
  const names = contactMeta(decryptedDir).names
  const start = Math.floor(new Date(year, 0, 1, 0, 0, 0, 0).getTime() / 1000)
  const end = Math.floor(new Date(year + 1, 0, 1, 0, 0, 0, 0).getTime() / 1000)

  // 会话归属：md5(username) → username。一次建表，避免每张 Msg_ 表都反查（O(N²)）。
  const md5ToUser = new Map<string, string>()
  const noteUser = (u: string): void => { if (u) md5ToUser.set(createHash('md5').update(u, 'utf8').digest('hex'), u) }
  for (const u of names.keys()) noteUser(u)

  let sent = 0
  let totalAll = 0
  const sentDays = new Set<string>()
  const allDays = new Set<string>()
  const perDayAll = new Map<string, number>()
  const heat = new Array<number>(7 * 24).fill(0)
  const hourAll = new Array<number>(24).fill(0)
  let workdayCount = 0
  let weekendCount = 0
  const monthly = new Array<number>(12).fill(0)
  let mineChars = 0
  let recvChars = 0
  const phraseCount = new Map<string, number>()
  const emojiCount = new Map<string, number>()
  const emojiDays = new Set<string>()
  const emojiHeat = new Array<number>(7 * 24).fill(0)
  let threwStickers = 0
  const stickerHashes = new Set<string>()
  let mediaSent = 0
  let videoSent = 0
  let voiceMsgSent = 0
  let voiceSentCount = 0
  let voiceSentSec = 0
  let voiceRecvCount = 0
  let voiceRecvSec = 0
  let callSec = 0
  let callCount = 0
  let callConnected = 0
  let longestVoiceSec = 0
  let longestVoiceFrom = ''
  let firstTs = Number.POSITIVE_INFINITY
  let firstText = ''
  let lastTs = 0
  let lastText = ''
  const chats = new Map<string, ChatAgg>()
  const dayChat = new Map<string, Map<string, number>>()
  const dayBounds = new Map<string, { first: number; firstText: string; last: number; lastText: string }>()
  const chatEarliest = new Map<string, number>()

  for (const sh of shardCatalogDirs(decryptedDir, ['message', 'bizchat'])) {
    // 「我」在本分片的 rowid（每个分片有自己的 Name2Id 空间）
    let selfRowId: number | undefined
    if (self) {
      const first = sh.tables.values().next().value
      if (first) {
        for (const [id, name] of first.name2id) if (name === self) { selfRowId = id; break }
        if (selfRowId === undefined) for (const [id, name] of first.name2id) if (name === '') { selfRowId = id; break }
        // 顺手补齐 md5→用户名（分片 Name2Id 里有会话名）
        for (const name of first.name2id.values()) if (name) noteUser(name)
      }
    }
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(sh.file, { readOnly: true }) } catch { continue }
    try {
      for (const [table, meta] of sh.tables) {
        if (!meta.cols.has('create_time') || !meta.cols.has('local_type')) continue
        const username = md5ToUser.get(table.slice(4)) ?? ''
        if (!username) continue
        try {
          const minRow = db.prepare('SELECT MIN(create_time) AS m FROM "' + table + '"').get() as { m: number | null } | undefined
          if (minRow?.m) chatEarliest.set(username, minRow.m)
          const hasSender = meta.cols.has('real_sender_id')
          const cols = 'create_time, local_type, message_content' + (hasSender ? ', real_sender_id' : '')
          const rows = db.prepare(
            'SELECT ' + cols + ' FROM "' + table + '" WHERE create_time >= ? AND create_time < ? ORDER BY create_time ASC',
          ).all(start, end) as Array<Record<string, unknown>>
          const chat = chatOf(chats, username)
          const isRoom = username.endsWith('@chatroom')
          for (const r of rows) {
            const ts = Number(r['create_time'] ?? 0)
            if (!ts) continue
            const lt = normType(Number(r['local_type'] ?? 0))
            const raw = decodeCell(r['message_content'])
            const mine = hasSender && selfRowId !== undefined && Number(r['real_sender_id'] ?? -1) === selfRowId
            const d = new Date(ts * 1000)
            const hour = d.getHours()
            const dow = d.getDay()
            const dk = ymd(ts)

            allDays.add(dk)
            perDayAll.set(dk, (perDayAll.get(dk) ?? 0) + 1)
            heat[dow * 24 + hour] = (heat[dow * 24 + hour] ?? 0) + 1
            hourAll[hour] = (hourAll[hour] ?? 0) + 1
            if (dow === 0 || dow === 6) weekendCount += 1
            else workdayCount += 1
            monthly[d.getMonth()] = (monthly[d.getMonth()] ?? 0) + 1
            totalAll += 1
            chat.total += 1
            chat.byMonth[d.getMonth()] = (chat.byMonth[d.getMonth()] ?? 0) + 1
            chat.days.add(dk)
            chat.seq.push({ ts, mine })
            if (mine) {
              chat.mine += 1
              sent += 1
              sentDays.add(dk)
              chat.hourMine[hour] = (chat.hourMine[hour] ?? 0) + 1
            } else {
              chat.theirs += 1
            }

            const body0 = isRoom ? splitSender(raw).body : raw
            const text = readableText(body0)
            // 当日首尾
            const b = dayBounds.get(dk)
            if (!b) dayBounds.set(dk, { first: ts, firstText: text, last: ts, lastText: text })
            else {
              if (ts < b.first) { b.first = ts; b.firstText = text }
              if (ts >= b.last) { b.last = ts; b.lastText = text }
            }
            let dc = dayChat.get(dk)
            if (!dc) { dc = new Map(); dayChat.set(dk, dc) }
            dc.set(username, (dc.get(username) ?? 0) + 1)
            if (text) {
              if (ts < firstTs) { firstTs = ts; firstText = text }
              if (ts >= lastTs) { lastTs = ts; lastText = text }
            }
            if (hour <= 5) {
              if (mine) {
                chat.nightMine += 1
                if (ts >= chat.nightSampleTs && text) { chat.nightSampleTs = ts; chat.nightSampleText = text }
              } else chat.nightTheirs += 1
            }

            if (lt === 1 && text) {
              if (mine) {
                mineChars += text.length
                if (text.length >= PHRASE_MIN && text.length <= PHRASE_MAX) {
                  phraseCount.set(text, (phraseCount.get(text) ?? 0) + 1)
                }
                const emo = text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu) ?? []
                for (const e of emo) emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1)
                if (emo.length > 0) {
                  emojiDays.add(dk)
                  emojiHeat[dow * 24 + hour] = (emojiHeat[dow * 24 + hour] ?? 0) + emo.length
                }
              } else recvChars += text.length
            } else if (lt === 3) {
              if (mine) mediaSent += 1
            } else if (lt === 43) {
              if (mine) { mediaSent += 1; videoSent += 1 }
            } else if (lt === 34) {
              const sec = Math.round((Number(xmlAttr(raw, 'voicemsg', 'voicelength')) || 0) / 1000)
              if (mine) {
                voiceSentCount += 1
                voiceMsgSent += 1
                voiceSentSec += sec
                if (sec > longestVoiceSec) { longestVoiceSec = sec; longestVoiceFrom = names.get(username) ?? username }
              } else { voiceRecvCount += 1; voiceRecvSec += sec }
            } else if (lt === 47) {
              if (mine) {
                threwStickers += 1
                const h = xmlAttr(raw, 'emoji', 'md5') || xmlAttr(raw, 'emoji', 'cdnurl')
                if (h) stickerHashes.add(h)
                chat.stickerMine += 1
              } else chat.stickerTheirs += 1
            } else if (lt === 50) {
              const c = parseCall(raw)
              if (mine) {
                callCount += 1
                callSec += c.sec
                if (c.connected) callConnected += 1
                chat.calls += 1
                chat.callSec += c.sec
                if (c.connected) chat.callConnected += 1
              }
            }
          }
        } catch { /* 单表失败不影响整体 */ }
      }
    } finally { db.close() }
  }

  return assemble({
    year, sent, totalAll, sentDays, allDays, perDayAll, heat, hourAll, workdayCount, weekendCount,
    monthly, mineChars, recvChars, phraseCount, emojiCount, emojiDays, emojiHeat,
    threwStickers, stickerHashes, mediaSent, videoSent, voiceMsgSent, voiceSentCount, voiceSentSec,
    voiceRecvCount, voiceRecvSec, callSec, callCount, callConnected, longestVoiceSec, longestVoiceFrom,
    firstTs, firstText, lastTs, lastText, chats, dayChat, dayBounds, chatEarliest, names,
  })
}

/* ────────────── 扫描后组装 ────────────── */

interface Bucket {
  year: number
  sent: number
  totalAll: number
  sentDays: Set<string>
  allDays: Set<string>
  perDayAll: Map<string, number>
  heat: number[]
  hourAll: number[]
  workdayCount: number
  weekendCount: number
  monthly: number[]
  mineChars: number
  recvChars: number
  phraseCount: Map<string, number>
  emojiCount: Map<string, number>
  emojiDays: Set<string>
  emojiHeat: number[]
  threwStickers: number
  stickerHashes: Set<string>
  mediaSent: number
  videoSent: number
  voiceMsgSent: number
  voiceSentCount: number
  voiceSentSec: number
  voiceRecvCount: number
  voiceRecvSec: number
  callSec: number
  callCount: number
  callConnected: number
  longestVoiceSec: number
  longestVoiceFrom: string
  firstTs: number
  firstText: string
  lastTs: number
  lastText: string
  chats: Map<string, ChatAgg>
  dayChat: Map<string, Map<string, number>>
  dayBounds: Map<string, { first: number; firstText: string; last: number; lastText: string }>
  chatEarliest: Map<string, number>
  names: Map<string, string>
}

/** 扫描期累加桶 → 完整看板结果。 */
function assemble(b: Bucket): AnnualReview {
  const { year, names, chats } = b
  const nameOf = (u: string): string => names.get(u) ?? u

  // ── 序列类指标：逐会话走一次有序消息（谁先开口 / 接话间隔）──
  for (const c of chats.values()) {
    let prev: Seq | null = null
    let pendingTheirs: number | null = null
    for (const s of c.seq) {
      if (!prev || s.ts - prev.ts > CONV_GAP_S) {
        if (s.mine) c.openMine += 1
        else c.openTheirs += 1
        pendingTheirs = null
      }
      if (!s.mine) pendingTheirs = s.ts
      else if (pendingTheirs !== null) {
        const gap = s.ts - pendingTheirs
        if (gap >= 0 && gap <= REPLY_MAX_S) c.replyGaps.push(gap)
        pendingTheirs = null
      }
      prev = s
    }
  }

  const personChats = [...chats.values()].filter(c => isPersonChat(c.username))
  const roomChats = [...chats.values()].filter(c => c.username.endsWith('@chatroom'))

  // ① Hero（我发出的）
  const runMine = longestRun(b.sentDays)
  const activeDaysMine = b.sentDays.size
  const yearStart = Math.floor(new Date(year, 0, 1).getTime() / 1000)
  const newFriends = personChats.filter(c => {
    const e = b.chatEarliest.get(c.username)
    return e !== undefined && e >= yearStart
  }).length

  // ② 日历（全年逐日补 0）
  const calendar: Array<{ d: string; n: number }> = []
  for (let t = new Date(year, 0, 1); t.getFullYear() === year; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) {
    const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    calendar.push({ d: key, n: b.perDayAll.get(key) ?? 0 })
  }
  const activeDaysAll = b.allDays.size
  const maxDayAll = calendar.reduce((m, x) => Math.max(m, x.n), 0)

  // ③ 最疯的一天（全部消息口径）
  let busiest: AnnualBusiestDay | null = null
  {
    let bestDay = ''
    let bestN = 0
    for (const [d, n] of b.perDayAll) if (n > bestN) { bestN = n; bestDay = d }
    if (bestDay) {
      const bounds = b.dayBounds.get(bestDay)
      const dc = b.dayChat.get(bestDay)
      let topName = ''
      let topCount = 0
      if (dc) for (const [u, n] of dc) if (n > topCount) { topCount = n; topName = nameOf(u) }
      const dAvg = activeDaysAll > 0 ? b.totalAll / activeDaysAll : 0
      busiest = {
        date: bestDay,
        n: bestN,
        ratio: dAvg > 0 ? Number((bestN / dAvg).toFixed(1)) : 0,
        share: b.totalAll > 0 ? bestN / b.totalAll : 0,
        topName,
        topCount,
        firstAt: bounds ? clock(bounds.first) : '',
        firstText: bounds?.firstText ?? '',
        lastAt: bounds ? clock(bounds.last) : '',
        lastText: bounds?.lastText ?? '',
        spanMin: bounds ? Math.max(0, Math.round((bounds.last - bounds.first) / 60)) : 0,
      }
    }
  }

  // ④ 年度搭子（单聊里双方合计最多）
  let buddy: AnnualBuddy | null = null
  {
    const top = [...personChats].sort((x, y) => y.total - x.total)[0]
    if (top && top.total > 0) {
      const gaps = top.replyGaps
      buddy = {
        username: top.username,
        name: nameOf(top.username),
        total: top.total,
        mine: top.mine,
        theirs: top.theirs,
        streakDays: longestRun(top.days).days,
        commonHour: argmax(top.hourMine),
        replyBacks: gaps.length,
        fastestSec: gaps.length > 0 ? Math.min(...gaps) : 0,
        slowestSec: gaps.length > 0 ? Math.max(...gaps) : 0,
      }
    }
  }

  // ⑤ 十二个月的主演
  const monthlyStar: AnnualMonthlyStar[] = []
  const starMonths = new Map<string, number>()
  for (let m = 0; m < 12; m += 1) {
    const top = [...personChats].filter(c => (c.byMonth[m] ?? 0) > 0).sort((x, y) => (y.byMonth[m] ?? 0) - (x.byMonth[m] ?? 0))[0]
    if (top) {
      monthlyStar.push({ month: m + 1, username: top.username, name: nameOf(top.username), count: top.byMonth[m] ?? 0 })
      starMonths.set(top.username, (starMonths.get(top.username) ?? 0) + 1)
    }
  }
  const starEntry = [...starMonths.entries()].sort((a, c) => c[1] - a[1])[0]
  const hottestMonthCount = b.monthly.length > 0 ? Math.max(...b.monthly, 0) : 0
  const hottestMonth = b.monthly.indexOf(hottestMonthCount) + 1

  // ⑥ 深夜（0-6 点）
  let night: AnnualNight = { share: 0, mine: 0, theirs: 0, topName: '', topCount: 0, sampleAt: '', sampleText: '' }
  {
    const myNight = [...chats.values()].reduce((a, c) => a + c.nightMine, 0)
    night.share = b.sent > 0 ? myNight / b.sent : 0
    // 「陪你熬夜的那位」取**我发言最多**的深夜会话，而不是深夜总量最多的 ——
    // 总量最多的常常是我一条没发的群，卡片会变成「你发出 0 条」，与卡面语义相反。
    const topMine = [...chats.values()].filter(c => c.nightMine > 0).sort((x, y) => y.nightMine - x.nightMine)[0]
    const top = topMine ?? [...chats.values()].sort((x, y) => (y.nightMine + y.nightTheirs) - (x.nightMine + x.nightTheirs))[0]
    if (top && (top.nightMine + top.nightTheirs) > 0) {
      const t = top.nightSampleTs
      night = {
        ...night,
        mine: top.nightMine,
        theirs: top.nightTheirs,
        topName: nameOf(top.username),
        topCount: top.nightMine + top.nightTheirs,
        sampleAt: t ? `${new Date(t * 1000).getMonth() + 1}月${new Date(t * 1000).getDate()}日 ${clock(t)}` : '',
        sampleText: top.nightSampleText,
      }
    }
  }

  // ⑦ 作息切片
  let brightestDow = 0
  let brightestHour = 0
  let brightestCount = 0
  for (let i = 0; i < b.heat.length; i += 1) {
    if ((b.heat[i] ?? 0) > brightestCount) { brightestCount = b.heat[i] ?? 0; brightestDow = Math.floor(i / 24); brightestHour = i % 24 }
  }
  let quietestHour = 0
  let quietestCount = Number.POSITIVE_INFINITY
  for (let h = 0; h < 24; h += 1) {
    if ((b.hourAll[h] ?? 0) < quietestCount) { quietestCount = b.hourAll[h] ?? 0; quietestHour = h }
  }
  const nightAll = b.heat.reduce((a, n, i) => ((i % 24) >= 23 || (i % 24) <= 4 ? a + n : a), 0)
  const rhythm: AnnualRhythm = {
    heat: b.heat,
    brightestDow,
    brightestHour,
    brightestCount,
    quietestHour,
    quietestCount: Number.isFinite(quietestCount) ? quietestCount : 0,
    nightShare: b.totalAll > 0 ? nightAll / b.totalAll : 0,
    workWeekendRatio: b.weekendCount > 0 ? Number((b.workdayCount / b.weekendCount).toFixed(2)) : 0,
  }

  // ⑧ 你说的话
  const words: AnnualWords = {
    mineChars: b.mineChars,
    receivedChars: b.recvChars,
    keystrokes: b.mineChars,
    voiceSentCount: b.voiceSentCount,
    voiceSentSec: b.voiceSentSec,
    voiceRecvCount: b.voiceRecvCount,
    voiceRecvSec: b.voiceRecvSec,
    callSec: b.callSec,
    callCount: b.callCount,
    callConnected: b.callConnected,
    callMissed: Math.max(0, b.callCount - b.callConnected),
    videoSent: b.videoSent,
    voiceMsgSent: b.voiceMsgSent,
    longestVoiceSec: b.longestVoiceSec,
    longestVoiceFrom: b.longestVoiceFrom,
  }

  // ⑨ 口头禅（我发出的 2-8 字整句）
  const phraseRows = [...b.phraseCount.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((x, y) => y.count - x.count)
  const catchphrase: AnnualCatchphrase = {
    phrase: phraseRows[0]?.phrase ?? '',
    count: phraseRows[0]?.count ?? 0,
    top: phraseRows.slice(0, 8),
    shortTotal: phraseRows.length,
    catchTotal: phraseRows.filter(p => p.count >= CATCH_MIN_COUNT).length,
  }

  // ⑩ 回复速度（单聊）
  const replyGapRows = personChats
    .filter(c => c.replyGaps.length > 0)
    .map(c => ({ name: nameOf(c.username), gaps: c.replyGaps }))
  const allGaps = replyGapRows.flatMap(r => r.gaps)
  // 每人一条汇总：接话次数 / 平均 / 最快 / 最慢。
  // 「平均 X 分钟」取**接话最多**的那位（= 主要对话对象），与需求语义一致。
  const replyRows = replyGapRows.map(r => ({
    name: r.name,
    n: r.gaps.length,
    sec: Math.round(r.gaps.reduce((a, x) => a + x, 0) / r.gaps.length),
    min: Math.min(...r.gaps),
    max: Math.max(...r.gaps),
  }))
  const mainPartner = [...replyRows].sort((x, y) => y.n - x.n)[0]
  const reply: AnnualReply = {
    medianSec: median(allGaps),
    p90Sec: percentile(allGaps, 0.9),
    avgPartnerName: mainPartner?.name ?? '',
    avgPartnerSec: mainPartner?.sec ?? 0,
    fastestName: [...replyRows].sort((x, y) => x.min - y.min)[0]?.name ?? '',
    fastestSec: allGaps.length > 0 ? Math.min(...allGaps) : 0,
    slowestName: [...replyRows].sort((x, y) => y.max - x.max)[0]?.name ?? '',
    slowestSec: allGaps.length > 0 ? Math.max(...allGaps) : 0,
  }

  // ⑪ 谁先开口（单聊）
  const openMineTotal = personChats.reduce((a, c) => a + c.openMine, 0)
  const openTheirsTotal = personChats.reduce((a, c) => a + c.openTheirs, 0)
  const opener: AnnualOpener = {
    mine: openMineTotal,
    theirs: openTheirsTotal,
    share: (openMineTotal + openTheirsTotal) > 0 ? openMineTotal / (openMineTotal + openTheirsTotal) : 0,
    mostInitiatedByMe: personChats.map(c => ({ name: nameOf(c.username), count: c.openMine })).sort((x, y) => y.count - x.count).slice(0, 3),
    mostInitiatedByThem: personChats.map(c => ({ name: nameOf(c.username), count: c.openTheirs })).sort((x, y) => y.count - x.count).slice(0, 3),
  }

  // ⑫ 年度聊天排行（单聊）
  const ranking: AnnualRankRow[] = personChats
    .map(c => ({ username: c.username, name: nameOf(c.username), total: c.total, mine: c.mine, theirs: c.theirs }))
    .sort((x, y) => y.total - x.total)
    .slice(0, 10)

  // ⑬ 表情宇宙
  let peakDow = 0
  let peakHour = 0
  let peakCount = 0
  for (let i = 0; i < b.emojiHeat.length; i += 1) {
    if ((b.emojiHeat[i] ?? 0) > peakCount) { peakCount = b.emojiHeat[i] ?? 0; peakDow = Math.floor(i / 24); peakHour = i % 24 }
  }
  const emoji: AnnualEmoji = {
    threw: b.threwStickers,
    kept: b.stickerHashes.size,
    perDay: b.emojiDays.size > 0 ? Number((b.threwStickers / b.emojiDays.size).toFixed(1)) : 0,
    days: b.emojiDays.size,
    peakDow,
    peakHour,
    peakCount,
    top: [...b.emojiCount.entries()].map(([e, count]) => ({ emoji: e, count })).sort((x, y) => y.count - x.count).slice(0, 6),
  }

  // ⑭ 还有这些人（每项都是「某一维度的第一名」）
  const highlights: AnnualHighlight[] = []
  const topPerson = ranking[0]
  if (topPerson) highlights.push({ label: '最常联系', name: topPerson.name, username: topPerson.username, value: `${topPerson.total} 条` })
  const topRoom = [...roomChats].sort((x, y) => y.total - x.total)[0]
  if (topRoom) highlights.push({ label: '最活跃群聊', name: nameOf(topRoom.username), username: topRoom.username, value: `${topRoom.total} 条` })
  const topCall = [...chats.values()].filter(c => c.calls > 0).sort((x, y) => y.callSec - x.callSec)[0]
  if (topCall) highlights.push({ label: '最常连线', name: nameOf(topCall.username), username: topCall.username, value: `${topCall.calls} 通 · ${humanDur(topCall.callSec)}` })
  const topListen = [...personChats].sort((x, y) => y.mine - x.mine)[0]
  if (topListen) highlights.push({ label: '最常说给 TA 听', name: nameOf(topListen.username), username: topListen.username, value: `${topListen.mine} 条` })
  const topHeard = [...personChats].sort((x, y) => y.theirs - x.theirs)[0]
  if (topHeard) highlights.push({ label: '最常听 TA 说', name: nameOf(topHeard.username), username: topHeard.username, value: `${topHeard.theirs} 条` })
  const topSticker = [...chats.values()].filter(c => (c.stickerMine + c.stickerTheirs) > 0).sort((x, y) => (y.stickerMine + y.stickerTheirs) - (x.stickerMine + x.stickerTheirs))[0]
  if (topSticker) highlights.push({ label: '斗图对手', name: nameOf(topSticker.username), username: topSticker.username, value: `${topSticker.stickerMine + topSticker.stickerTheirs} 张` })
  const balanced = [...personChats]
    .filter(c => c.mine >= 20 && c.theirs >= 20)
    .sort((x, y) => {
      const rx = Math.min(x.mine, x.theirs) / Math.max(x.mine, x.theirs)
      const ry = Math.min(y.mine, y.theirs) / Math.max(y.mine, y.theirs)
      return ry - rx
    })[0]
  if (balanced) highlights.push({ label: '势均力敌', name: nameOf(balanced.username), username: balanced.username, value: `${balanced.mine} : ${balanced.theirs}` })

  return {
    year,
    sent: b.sent,
    sentTo: [...chats.values()].filter(c => c.mine > 0).length,
    sentDailyAvg: activeDaysMine > 0 ? Number((b.sent / activeDaysMine).toFixed(1)) : 0,
    activeDaysMine,
    longestStreak: runMine.days,
    newFriends,
    mediaSent: b.mediaSent,
    longestSpanFrom: runMine.from,
    longestSpanTo: runMine.to,
    calendar,
    activeDaysAll,
    maxDayAll,
    busiest,
    buddy,
    monthlyStar,
    starName: starEntry ? nameOf(starEntry[0]) : '',
    starUsername: starEntry ? starEntry[0] : '',
    starMonths: starEntry ? starEntry[1] : 0,
    hottestMonth,
    hottestMonthCount,
    night,
    rhythm,
    words,
    catchphrase,
    reply,
    opener,
    ranking,
    emoji,
    highlights,
    firstAt: Number.isFinite(b.firstTs) ? `${ymdCn(b.firstTs)} ${clock(b.firstTs)}` : '',
    firstText: b.firstText,
    lastAt: b.lastTs ? `${ymdCn(b.lastTs)} ${clock(b.lastTs)}` : '',
    lastText: b.lastText,
  }
}


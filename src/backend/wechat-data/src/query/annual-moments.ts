/**
 * 年度报告 · 朋友圈年度统计。
 *
 * ## 数据来源（照 `moments-insights.ts` 的既有口径，不另立一套）
 *
 * 朋友圈正文住在解密库 `sns/db_sns/sns.db`（备用位置 `sns/sns.db`）的 `SnsTimeLine` 表：
 * 一行 = 一条动态，`content` 是那段 `<TimelineObject>…</TimelineObject>` XML，
 * 正文在 `<contentDesc>`（CDATA）、发布时间在 `<createTime>`、互动在 `<LocalExtraInfo>`。
 * 年份判据因此**只能从 XML 的 `createTime` 取** —— 本表没有一个可靠的独立时间列
 * （`moments-insights.ts` 也是这么读的，见其 `parseSnsXml(xml).createTime`）。
 *
 * ## 「没数据」与「真的是 0」必须分得开
 *
 * 没有 `sns.db`、库里没有 `SnsTimeLine`、或整张表在这个年份一条都没有 —— 这三种情况
 * 对界面的含义完全不同：前两种是**数据源不可用**（卡片该写「未读取到朋友圈数据」），
 * 后一种是**这一年真的没发**（卡片该老老实实写 0）。所以：
 *   · 库不存在 / 表不存在 ⇒ `available: false`，各计数保持 0；
 *   · 库和表都在，只是这一年没有条目 ⇒ `available: true`，计数是真实的 0。
 *
 * ## 出错一律降级，不抛给调用方
 *
 * 库损坏、`node:sqlite` 物化行报错（`SnsTimeLine.tid` 在本机 100% 超出 JS 安全整数范围，
 * 未 CAST 时读它会抛 `ERR_OUT_OF_RANGE` —— 本模块因此**不读 `tid`**）、列名对不上……
 * 全部在 `try/catch` 里收成 `available: false`。年度看板是一屏卡片，
 * 朋友圈这一块读不出来不该把整份年报炸掉。
 *
 * @module query/annual-moments
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withDbAsync } from './db-open.ts'
import { parseSnsXml, parseSnsLikesComments } from './moments.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'

/**
 * 字符级让出阈值（本模块专用，与 `moments-insights.ts` 的 `MOMENTS_YIELD_EVERY_CHARS` 同档）。
 *
 * 只按 `YIELD_EVERY_ROWS = 2000` 行让出在真实数据上不够：本机 `SnsTimeLine` 2341 行、
 * 每行都要跑一遍 `parseSnsXml` + `parseSnsLikesComments`，整段会独占事件循环几十毫秒。
 * 1 MiB 与朋友圈洞察用的是同一个量级（那里的取数理由见 `moments-insights.ts` 顶部注释）。
 */
const MOMENTS_YIELD_EVERY_CHARS = 1 << 20

/** 摘要上限（字符）：界面卡片只放一行，超出的截断加省略号。 */
const EXCERPT_MAX = 40

/**
 * 一条「算进本年度」的朋友圈在扫描期的中间形态。
 *
 * 导出它只为让 {@link summarizeAnnualMoments} 的签名在 `lib/types` 里自洽
 * （`tsc` 会把出现在导出签名里的类型一并写进 .d.ts）；业务上不需要自己构造它。
 */
export interface ScannedPost {
  /** 正文（已折成单行纯文本，见 {@link plainText}）。 */
  text: string
  /** `createTime`（unix 秒）；0 表示这条 XML 里读不到时间。 */
  ts: number
  likes: number
  comments: number
}

/** 年度朋友圈统计。 */
export interface AnnualMoments {
  /** 全年朋友圈条数。 */
  count: number
  /** 最热一条：点赞+评论总数最多（并列取更早的那条）；没有则 null。 */
  topPost: { at: string; likes: number; comments: number; excerpt: string } | null
  /** 发得最多的月份（1..12）与条数；没有则 null。 */
  topMonth: { month: number; count: number } | null
  /** 0..6 点发的条数。 */
  lateNight: number
  /** 数据来源是否可用（没有朋友圈库时为 false —— 界面据此显示"未读取到朋友圈数据"，不许显示 0 当真实值）。 */
  available: boolean
}

/** 字符串化一个 SQLite 单元格（TEXT/NUMBER/BLOB → string），与 `moments.ts#cellString` 同形。 */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/**
 * 定位 `sns.db`：`sns/db_sns/sns.db` 优先，退回 `sns/sns.db`。
 *
 * 两个候选与 `moments.ts` / `moments-insights.ts` 逐字一致 —— 朋友圈的读法在本仓已有两处，
 * 不再发明第三种路径写法（真机上前者是主形态，后者见于部分版本）。
 * @param decryptedDir - 解密库根目录。
 * @returns 数据库绝对路径；两处都不存在时为 null。
 */
function snsDbPath(decryptedDir: string): string | null {
  for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 把一段 XML/HTML 折成**单行纯文本**。
 *
 * 三件事缺一不可（都是界面上真会看到的）：
 *   ① 去掉标签 —— `<contentDesc>` 里可能夹 `<a href="…">`（分享链接形态），不去就是一片尖括号；
 *   ② HTML 换行（`<br>` / `&#10;`）折成空格 —— 摘要是卡片上的一行文字，正文里的换行带进去
 *      会把卡片撑成多行、把后面的统计数字挤下去；
 *   ③ 折叠连续空白（含制表符）并 trim。
 * @param raw - 原始正文（未解码的 XML 文本）。
 * @returns 单行纯文本；没有任何可读内容时为空串。
 */
function plainText(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&#x0A;|&#10;|&#x0D;|&#13;/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 取摘要：去标签、折单行、截到 40 字以内。
 * @param text - 已折成单行的正文。
 * @returns 摘要；正文为空时为空串（不返回 `'…'` 这种看着像有内容的占位）。
 */
function excerptOf(text: string): string {
  if (text.length <= EXCERPT_MAX) return text
  return text.slice(0, EXCERPT_MAX) + '…'
}

/** 「本地时间」的 `M月D日 HH:mm`（与 `annual-review.ts#ymdCn` 的表达一致地按月日呈现）。 */
function localStamp(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 纯函数：把「本年度的条目」折成卡片数据。**不碰数据库**，便于用例直接钉口径。
 *
 * 口径：
 *   · `count` 就是传进来的条数；
 *   · `topPost` = 点赞+评论总数最多的一条，**并列取更早的那条**（`ts` 小的胜；
 *     `ts` 都是 0 时保持扫描顺序里的第一条，因为无法比较先后）；
 *   · `topMonth` = 条数最多的月份，**并列取更小的月份**（读者预期是「年初那个」）；
 *   · `lateNight` = 0..6 点（含 6 点整）的条数；`ts` 为 0 的条目**不计入**，
 *     因为它没有时刻可言，凭空算进任一小时都是编数。
 * @param posts - 本年度条目（扫描顺序）。
 * @returns 年度朋友圈统计（`available` 由调用方按数据源情况覆盖）。
 */
export function summarizeAnnualMoments(posts: ScannedPost[]): Omit<AnnualMoments, 'available'> {
  let topPost: AnnualMoments['topPost'] = null
  let bestScore = -1
  let bestTs = Number.POSITIVE_INFINITY
  const monthCount = new Array<number>(12).fill(0)
  let lateNight = 0
  for (const p of posts) {
    const score = p.likes + p.comments
    // 「并列取更早」：分数更高直接替换；分数相同则只有时间更早的才替换。
    if (score > bestScore || (score === bestScore && p.ts > 0 && p.ts < bestTs)) {
      bestScore = score
      bestTs = p.ts
      topPost = { at: localStamp(p.ts), likes: p.likes, comments: p.comments, excerpt: excerptOf(p.text) }
    }
    if (p.ts > 0) {
      const d = new Date(p.ts * 1000)
      const h = d.getHours()
      // 0..6 点：与 annual-review 的深夜口径不同（那里是 hour <= 5）——
      // 卡片文案写的是「0-6 点」，就按 0..6 算，别让文案与数字对不上。
      if (h <= 6) lateNight += 1
      monthCount[d.getMonth()] = (monthCount[d.getMonth()] ?? 0) + 1
    }
  }
  let topMonth: AnnualMoments['topMonth'] = null
  for (let m = 0; m < 12; m += 1) {
    const n = monthCount[m] ?? 0
    if (n > 0 && (topMonth === null || n > topMonth.count)) topMonth = { month: m + 1, count: n }
  }
  return { count: posts.length, topPost, topMonth, lateNight }
}

/**
 * 扫描库内属于 `year` 的朋友圈条目（本地时区判年，与 `moments-insights.ts` 的月度分桶一致）。
 * @param dbPath - `sns.db` 绝对路径。
 * @param year - 自然年。
 * @returns 本年度条目；**库/表不可用时返回 null**（调用方据此置 `available: false`）。
 */
async function scanYear(dbPath: string, year: number): Promise<ScannedPost[] | null> {
  return withDbAsync(dbPath, async (db) => {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
    if (!has) return null
    const cols = new Set((db.prepare('PRAGMA table_info(SnsTimeLine)').all() as Array<{ name: string }>).map(r => r.name))
    const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
    if (!contentCol) return null
    const posts: ScannedPost[] = []
    // 游标读 + 双阈值让出：`SnsTimeLine` 随朋友圈条数增长，这里逐条解析 XML（本模块最重的一段），
    // 先物化成数组只会把整段独占再拉长一次。让出判据与朋友圈洞察同档（行 + 字符）。
    const cur = db.prepare(`SELECT ${contentCol} AS c FROM SnsTimeLine`).iterate() as Iterable<{ c?: unknown }>
    let sinceYield = 0
    let charsSinceYield = 0
    for (const r of cur) {
      const xml = cellString(r.c)
      charsSinceYield += xml.length
      // 让出检查放在**解析之前**：解析是这段循环里唯一的 CPU 重活，放在后面等于让它整段跑完。
      sinceYield += 1
      if (sinceYield >= YIELD_EVERY_ROWS || charsSinceYield >= MOMENTS_YIELD_EVERY_CHARS) {
        sinceYield = 0
        charsSinceYield = 0
        await yieldToLoop()
      }
      const parsed = parseSnsXml(xml)
      // 时间读不出来（ts === 0）的条目**不能**算进某一年：凭空归到 0 年或"最早那一年"
      // 都会让年报出现一个不存在的年份。与 annual.ts 的 `create_time > 0` 过滤同一条理由。
      if (parsed.createTime <= 0) continue
      const d = new Date(parsed.createTime * 1000)
      if (d.getFullYear() !== year) continue
      const social = parseSnsLikesComments(xml)
      posts.push({
        text: plainText(parsed.text),
        ts: parsed.createTime,
        likes: social.likes.length,
        comments: social.comments.length,
      })
    }
    return posts
  })
}

/**
 * 年度报告 · 朋友圈年度统计。
 * @param decryptedDir - 解密库根目录。
 * @param year - 年份。
 * @returns 全年条数 / 最热一条 / 发得最多的月份 / 深夜条数，以及数据源是否可用。
 */
export async function queryAnnualMoments(decryptedDir: string, year: number): Promise<AnnualMoments> {
  /** 数据源不可用时的形态：`available: false`，各计数为 0（界面据此区分「没数据」与「真的是 0」）。 */
  const unavailable: AnnualMoments = { count: 0, topPost: null, topMonth: null, lateNight: 0, available: false }
  const dbPath = snsDbPath(decryptedDir)
  if (dbPath === null) return unavailable
  try {
    const posts = await scanYear(dbPath, year)
    // null = 表或关键列不在：与「库不存在」同类，交 `available: false`
    if (posts === null) return unavailable
    return { ...summarizeAnnualMoments(posts), available: true }
  } catch (e) {
    // 不静默吞错：曾因「朋友圈洞察」长期显示全 0 而无人察觉（见 `moments-insights.ts` 的同名注释）。
    // 但这里**只降级不抛**：年度看板是一屏卡片，朋友圈读不出来不该带走整份年报。
    console.warn('[annual-moments] 朋友圈年度统计失败，返回不可用:', (e as Error)?.message ?? e)
    return unavailable
  }
}

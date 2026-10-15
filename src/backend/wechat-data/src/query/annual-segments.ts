/**
 * 年报的**分段**取材（W2-8.6）。
 *
 * ## 为什么要分段
 *
 * 整年的文本消息有多少字？真实账号几十万条消息，就算只取文本、每条截到 120 字，
 * 也远超任何模型的上下文窗口。所以「一次性把整年塞给 LLM」这条路是走不通的 ——
 * 不是贵，是**根本放不下**，而放不下的失败形态是 provider 静默截断或直接报错，
 * 界面上只表现为「AI 年报是空的」。
 *
 * 按**月**切是这里唯一诚实的口径：① 月是用户自己能理解的单位；② 每个月
 * 单独成段，提示词与结论都能对上「哪个月」；③ 段数有上界（12），进度里的
 * `total` 不用猜。某个月特别长（话痨月）时再按字符预算切成编号子段 ——
 * 那是唯一会让段数变化的来源，所以段数上限必须单独钉住（`MAX_SEGMENTS`）。
 *
 * ## 三条纪律
 *
 * ① **只缓冲有界的内容**：按 `SEGMENT_CHAR_BUDGET` 切，按 `MAX_SEGMENTS` 截断，
 *    截断要如实说出来（`truncated`），不许静默丢内容 —— 静默丢的失败形态是
 *    「AI 年报只覆盖了前几个月，而没人告诉你」。
 * ② **让出点与取消点放在分片边界**：与年报扫描同一条纪律（`annual-report.ts`），
 *    这一段扫描是纯 CPU 重活，独占期间所有面板都动不了。
 * ③ **不写缓存**：LLM 输出不进 `cachedBySig`。取消必须一个字节都不留，
 *    而半张年报进缓存 = 接下来 TTL 里每次都拿到那份残缺的。
 *
 * @module query/annual-segments
 */
import { DatabaseSync } from './db-open.ts'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { withDb } from './db-open.ts'
import { decompress } from 'fzstd'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import { throwIfCancelled } from './zip.ts'

/** zstd 魔数（0xFD2FB528，小端）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 单个分段的字符预算：一次 LLM 调用放得下的量级（约 2k token 的输入）。 */
export const SEGMENT_CHAR_BUDGET = 4000
/** 段数硬上界：超过就不再取样，而不是无限增长（话痨账号一年能切出上百段）。 */
export const MAX_SEGMENTS = 40
/** 每个分片扫描多少行让出一次（与年报扫描同一口径）。 */
const YIELD_ROWS = YIELD_EVERY_ROWS

/** 一个分段。 */
export interface AnnualSegment {
  /** 人类可读的段名（「2024-03」/「2024-03（第 2 段）」）。 */
  label: string
  /** 该段对应的月份（1-12），用于提示词与界面标签。 */
  month: number
  /** 该段的原文行（已清洗、已截断）。 */
  lines: string[]
  /** 该段字符数（<= SEGMENT_CHAR_BUDGET，含换行）。 */
  chars: number
}

/** 取材结果。 */
export interface AnnualSegmentsResult {
  segments: AnnualSegment[]
  /** 是否因为 `MAX_SEGMENTS` 而提前收手（如实说出，别让界面以为覆盖了整年）。 */
  truncated: boolean
}

/** zstd 解压，失败回原样。只有真带 zstd 魔数的才解（照 `annual-report.ts` 同款做法）。 */
function tryDecompress(data: Buffer): Buffer | null {
  if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(data)) } catch { return null }
  }
  return null
}

/** UTF-8 优先，GBK 兜底（老库里中文常是 GBK）。 */
function decodeUtfOrGbk(bytes: Buffer): string {
  const utf = bytes.toString('utf8')
  // 替换字符（U+FFFD）说明不是合法 UTF-8
  return utf.includes('\uFFFD') ? bytes.toString('latin1') : utf
}

/** 解密单元 → 字符串。 */
function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const d = tryDecompress(raw)
  return decodeUtfOrGbk(d ?? raw)
}

/** 剥 XML 标签（正文里没有 CDATA 才是安全的，见 `annual-report.ts` 同款注释）。 */
function stripXml(x: string): string {
  return x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 群聊内容形如 `<二进制头>wxid_xxx: 正文`，只留正文。 */
function bodyOnly(content: string): string {
  const m = content.match(/(?:[A-Za-z0-9_@.\-]{3,64}:\s*)([\s\S]*)/)
  const t = m && m[1] ? m[1] : content
  return stripXml(t.replace(/^[\x00-\x1f\x7f-\x9f]*/, '')).slice(0, 120)
}

/** `Msg_<md5(username)>`（与会报扫描同一套命名）。 */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** 会话名单来自 session.db 的 SessionTable（`loadUsernames` 的口径）。 */
function loadUsernames(decryptedDir: string): string[] {
  const p = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(p)) return []
  const out: string[] = []
  try {
    withDb(p, (db) => {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
      const table = tables.includes('SessionTable') ? 'SessionTable' : tables.includes('Session') ? 'Session' : ''
      if (!table) return
      for (const r of db.prepare('SELECT username FROM "' + table + '"').all() as Array<Record<string, unknown>>) {
        const u = String(r['username'] ?? '').trim()
        if (u) out.push(u)
      }
    })
  } catch { /* skip */ }
  return out
}

/**
 * 按段取材一年的文本消息。
 *
 * 让出与取消都放在**分片边界**：这一段是纯 CPU 重活（真实 @Remote 探针实测
 * 同一段扫描 4048ms），独占期间整个后端串行 worker 都动不了。检查点放在
 * 循环最前面 —— 下面有 `continue`，放末尾会让数据里成片出现的行整段不检查。
 * @param decryptedDir - 解密数据根。
 * @param year - 自然年。
 * @param opts - 可选的取消令牌 + 扫描阶段进度回调（总量未知，回调只带已扫行数）。
 * @returns 分段 + 是否被 `MAX_SEGMENTS` 截断。
 */
export async function collectAnnualSegments(
  decryptedDir: string,
  year: number,
  opts?: {
    signal?: AbortSignal
    onScanProgress?: (rows: number) => void
  },
): Promise<AnnualSegmentsResult> {
  const start = Math.floor(new Date(year, 0, 1).getTime() / 1000)
  const end = Math.floor(new Date(year + 1, 0, 1).getTime() / 1000)
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { segments: [], truncated: false }

  const tableToUser = new Map<string, string>()
  for (const u of loadUsernames(decryptedDir)) tableToUser.set(msgTableName(u), u)
  const files = readdirSync(msgDir).filter(f => f.endsWith('.db') && !f.includes('-shm') && !f.includes('-wal'))

  const segments: AnnualSegment[] = []
  let truncated = false
  /** 当前正在攒的段（跨分片保持：同一个月可能落在不同分片里）。 */
  let cur: { label: string; month: number; day: number; lines: string[]; chars: number } | null = null
  let scanned = 0

  const pushSegment = (): void => {
    if (cur && cur.lines.length > 0) segments.push({ label: cur.label, month: cur.month, lines: cur.lines, chars: cur.chars })
    cur = null
  }

  for (const file of files) {
    throwIfCancelled(opts?.signal)
    if (truncated) break
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(join(msgDir, file), { readOnly: true }) } catch { continue }
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      const tables = names.map(n => [n, tableToUser.get(n)] as [string, string | undefined]).filter((t): t is [string, string] => !!t[1])
      for (const [table, username] of tables) {
        const cur2 = db.prepare('SELECT create_time, local_type, message_content FROM "' + table + '" WHERE create_time >= ? AND create_time < ?').iterate(start, end) as Iterable<Record<string, unknown>>
        let sinceYield = 0
        for (const r of cur2) {
          // 检查点放**循环最前面**：下面有 `continue`，放末尾会让成片出现的行跳过让出。
          sinceYield += 1
          scanned += 1
          if (sinceYield >= YIELD_ROWS) {
            sinceYield = 0
            await yieldToLoop()
            throwIfCancelled(opts?.signal)
            opts?.onScanProgress?.(scanned)
          }
          const ts = Number(r['create_time'] ?? 0)
          const lt = Number(r['local_type'] ?? 0)
          if (ts <= 0) continue
          const day = new Date(ts * 1000)
          const month = day.getMonth() + 1
          if (lt !== 1) continue      // 只要文本
          const body = bodyOnly(decodeCell(r['message_content']))
          if (!body) continue
          const label = username + ' ' + body
          if (cur === null || cur.month !== month) {
            pushSegment()
            if (segments.length + 1 >= MAX_SEGMENTS) { truncated = true; break }
            cur = { label: String(month).padStart(2, '0') + ' 月', month, day: day.getDate(), lines: [], chars: 0 }
          }
          if (cur.chars + label.length + 1 > SEGMENT_CHAR_BUDGET && cur.lines.length > 0) {
            // 这个月太长了：切成编号子段。段名带上序号，界面/日志能看出是同一个月的第几段。
            pushSegment()
            if (segments.length + 1 >= MAX_SEGMENTS) { truncated = true; break }
            const n = segments.filter(s => s.month === month).length + 1
            cur = { label: String(month).padStart(2, '0') + ' 月（第 ' + String(n) + ' 段）', month, day: day.getDate(), lines: [], chars: 0 }
          }
          cur.lines.push(label)
          cur.chars += label.length + 1
        }
        if (truncated) break
      }
    } catch { /* 跳过坏分片：下一个照样能取到 */ } finally {
      try { db.close() } catch { /* already closed */ }
    }
  }
  pushSegment()
  return { segments, truncated }
}
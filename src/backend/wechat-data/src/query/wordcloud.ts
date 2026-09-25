
/**
 * 词云词频统计（2026-09-25，界面优化阶段 4）。
 *
 * 口径：CJK bigram 计数（与 annual-report 的 top_phrases 同一套生产先例），外加两道过滤——
 * ① 单字虚词过滤：bigram 任一字符命中 STOP_CHARS 即丢弃（「我说」「的消」类跨词噪音）；
 * ② 显式停用词兜底：STOP_WORDS 收录单字过滤抓不到的高频泛词（「时候」「可以」「知道」）。
 * 实体保护：contactMeta 的昵称/备注名单（2-8 字）在 bigram 之前整词计数并从文本中遮罩，
 * 人名/群名不会被切成碎片、也不与 bigram 重复上榜。
 *
 * 三种 scope：global（全部消息，可带年份）/ chat（单会话）/ moments（朋友圈帖子正文）。
 * 本地计算、零出网、不落库（每次现算，单群实测成本见 spec 提交记录）。
 */
import { DatabaseSync } from 'node:sqlite'
import { decompress } from 'fzstd'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { contactMeta } from './meta.ts'

/** 高频单字虚词（命中任一即丢弃整个 bigram）。词云要的是主题词，少量误杀可接受。 */
const STOP_CHARS = new Set('的了是有在不我没很太这那个们就也还又再和与或但而为被把让给跟从到去来上中下里么什谁哪怎是否吧啊哦嗯呀哈嘿嘛呗啦咯呢吗说我你他她它'.split(''))

/** 单字过滤抓不到的高频泛词组合（bigram 整词停用）。 */
const STOP_WORDS = new Set([
  '时候', '什么', '可以', '就是', '还是', '但是', '因为', '所以', '如果', '现在',
  '已经', '觉得', '知道', '然后', '这个', '那个', '这么', '那么', '怎么', '这样',
  '那样', '一些', '一下', '一样', '感觉', '其实', '可能', '应该', '不会', '出来',
  '起来', '过去', '回来', '很多', '开始', '最后', '直接', '真的', '好的', '好吧',
  '是的', '对的', '哈哈', '嘿嘿', '呵呵', '东西', '问题', '事情', '地方', '样子',
  '一下', '你们', '我们', '他们', '自己', '大家', '老师', '同学', '朋友', '谢谢',
  '没事', '行吧', '好吧', 'ok了', '不了', '要不', '要不', '反正', '肯定', '原来',
])

export interface WordCloudOptions {
  scope?: 'global' | 'chat' | 'moments'
  username?: string
  year?: number
  limit?: number
}

export interface WordCloudWord {
  text: string
  count: number
}

export interface WordCloudResult {
  words: WordCloudWord[]
  scanned: number
}

/** Msg_<md5(username)> table name（与 annual-report 同式）。 */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  if (raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(raw)).toString('utf8') } catch { return '' }
  }
  return raw.toString('utf8')
}

function stripXml(x: string): string {
  return x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 实体名单：昵称/备注去重（2-8 字、非纯数字），长名优先匹配（遮罩时先长后短防碎片）。 */
function entityNames(decryptedDir: string): string[] {
  const names = new Set<string>()
  for (const n of contactMeta(decryptedDir).names.values()) {
    const t = n.trim()
    if (t.length >= 2 && t.length <= 8 && !/^[0-9]+$/.test(t)) names.add(t)
  }
  return Array.from(names).sort((a, b) => b.length - a.length)
}

/**
 * 把一条正文计入词频：实体先整词计数并遮罩，剩余文本走 bigram + 双重停用过滤。
 * @param text 剥掉 XML 后的正文。
 * @param counts 词频累加器。
 * @param entities 实体名单（已按长度降序）。
 */
function countText(text: string, counts: Map<string, number>, entities: string[]): void {
  if (!text) return
  let rest = text
  for (const e of entities) {
    if (rest.includes(e)) {
      counts.set(e, (counts.get(e) ?? 0) + 1)
      rest = rest.split(e).join(' ')
    }
  }
  for (let i = 0; i + 2 <= rest.length; i += 1) {
    const bi = rest.slice(i, i + 2)
    if (!/[\u4e00-\u9fff]{2}/.test(bi)) continue
    if (STOP_WORDS.has(bi)) continue
    if (STOP_CHARS.has(bi[0]!) || STOP_CHARS.has(bi[1]!)) continue
    counts.set(bi, (counts.get(bi) ?? 0) + 1)
  }
}

/** 消息扫描（file-first，一次开一个分片；scope='chat' 时只扫目标表）。 */
function scanMessages(decryptedDir: string, opts: { username?: string; year?: number }, counts: Map<string, number>, entities: string[]): number {
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return 0
  const start = opts.year ? Math.floor(new Date(opts.year, 0, 1).getTime() / 1000) : 0
  const end = opts.year ? Math.floor(new Date(opts.year + 1, 0, 1).getTime() / 1000) : Number.MAX_SAFE_INTEGER
  const wanted = opts.username ? msgTableName(opts.username) : null
  const files = readdirSync(msgDir).filter(f =>
    f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache')
    && !f.includes('media') && !f.includes('resource') && !f.includes('fts'))
  let scanned = 0
  for (const file of files) {
    const path = join(msgDir, file)
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(path, { readOnly: true }) } catch { continue }
    try {
      let names: string[]
      if (wanted) {
        const hit = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(wanted) as { name: string } | undefined
        names = hit ? [hit.name] : []
      } else {
        names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      }
      for (const table of names) {
        try {
          const rows = db.prepare('SELECT create_time, local_type, message_content FROM "' + table + '" WHERE create_time >= ? AND create_time < ?').all(start, end) as Array<Record<string, unknown>>
          for (const r of rows) {
            const lt = Number(r['local_type'] ?? 0)
            const normType = lt > 4294967296 ? lt % 4294967296 : lt
            if (normType !== 1) continue // 只统计纯文本消息
            const text = stripXml(decodeCell(r['message_content']))
            if (!text || /^[0-9,]+$/.test(text.slice(0, 80))) continue
            scanned += 1
            countText(text, counts, entities)
          }
        } catch { /* skip table */ }
      }
    } finally { db.close() }
  }
  return scanned
}

/** 朋友圈扫描：sns.db 的 SnsTimeLine.content（帖子正文，剥 XML 后计词）。 */
function scanMoments(decryptedDir: string, counts: Map<string, number>, entities: string[]): number {
  for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
    if (!existsSync(p)) continue
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(p, { readOnly: true }) } catch { continue }
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() === undefined) return 0
      const cols = new Set((db.prepare('PRAGMA table_info(SnsTimeLine)').all() as Array<{ name: string }>).map(r => r.name))
      const contentCol = cols.has('content') ? 'content' : (cols.has('Content') ? 'Content' : null)
      if (!contentCol) return 0
      let scanned = 0
      for (const r of db.prepare(`SELECT ${contentCol} AS c FROM SnsTimeLine`).iterate() as Iterable<{ c: unknown }>) {
        const text = stripXml(decodeCell(r.c))
        if (!text) continue
        scanned += 1
        countText(text, counts, entities)
      }
      return scanned
    } finally { db.close() }
  }
  return 0
}

/**
 * 计算词云词频。
 * @param decryptedDir 解密数据根。
 * @param options scope/username/year/limit。
 */
export function queryWordCloud(decryptedDir: string, options?: WordCloudOptions): WordCloudResult {
  const scope = options?.scope ?? 'global'
  const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 60)))
  if (scope === 'chat' && !(options?.username ?? '').trim()) {
    throw new Error('scope=chat 需要 username（会话的 talker）')
  }
  const counts = new Map<string, number>()
  const entities = entityNames(decryptedDir)
  let scanned = 0
  if (scope === 'moments') {
    scanned = scanMoments(decryptedDir, counts, entities)
  } else {
    scanned = scanMessages(decryptedDir, { username: options?.username, year: options?.year }, counts, entities)
  }
  const words = Array.from(counts.entries())
    .filter(([, n]) => n >= 2) // 只出现 1 次的词对词云没有统计意义
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
  return { words, scanned }
}

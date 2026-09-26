
/**
 * 词云词频统计（2026-09-25，界面优化阶段 4）。
 *
 * 口径：CJK bigram 计数（与 annual-report 的 top_phrases 同一套生产先例），外加两道过滤——
 * 逐条正文的**实体遮罩 + 停用词过滤 + bigram 统计**都在 `word-match.ts`
 * （本文件只负责取数与组装：分片遍历、zstd 解码、剥 XML、排序取前 N）。
 * 实体保护：contactMeta 的昵称/备注名单（2-8 字）在 bigram 之前整词计数并从文本中遮罩，
 * 人名/群名不会被切成碎片、也不与 bigram 重复上榜。
 *
 * 三种 scope：global（全部消息，可带年份）/ chat（单会话）/ moments（朋友圈帖子正文）。
 * 本地计算、零出网、不落库（按数据指纹缓存 30 秒；词频统计的热路径在 `word-match.ts`）。
 */
import { DatabaseSync } from 'node:sqlite'
import { decompress } from 'fzstd'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { cachedBySig, fileSigOf, shardCatalogSig } from './meta.ts'
import { buildEntityMatcher, countText, entityNamesOf, type EntityMatcher } from './word-match.ts'

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

/** 消息扫描（file-first，一次开一个分片；scope='chat' 时只扫目标表）。 */
function scanMessages(decryptedDir: string, opts: { username?: string; year?: number }, counts: Map<string, number>, matcher: EntityMatcher): number {
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
            countText(text, counts, matcher)
          }
        } catch { /* skip table */ }
      }
    } finally { db.close() }
  }
  return scanned
}

/** 朋友圈 db 的候选路径（与 {@link scanMoments} 同一份清单，缓存签名要用）。 */
const MOMENTS_DB_PATHS = ['sns/db_sns/sns.db', 'sns/sns.db'] as const

/** 朋友圈扫描：sns.db 的 SnsTimeLine.content（帖子正文，剥 XML 后计词）。 */
function scanMoments(decryptedDir: string, counts: Map<string, number>, matcher: EntityMatcher): number {
  for (const rel of MOMENTS_DB_PATHS) {
    const p = join(decryptedDir, ...rel.split('/'))
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
        countText(text, counts, matcher)
      }
      return scanned
    } finally { db.close() }
  }
  return 0
}

/** 缓存里保留的词数上界（大到远超前端的 limit，小到不会把内存撑起来）。 */
const MAX_CACHED_WORDS = 2000

/** 真正算一遍（不缓存）。`words` 是**全量排序后的前 MAX_CACHED_WORDS**，由调用方按 limit 切片。 */
function computeWordCloud(decryptedDir: string, scope: 'global' | 'chat' | 'moments', username: string, year: number | undefined): WordCloudResult {
  const counts = new Map<string, number>()
  const matcher = buildEntityMatcher(entityNamesOf(decryptedDir))
  let scanned = 0
  if (scope === 'moments') {
    scanned = scanMoments(decryptedDir, counts, matcher)
  } else {
    scanned = scanMessages(decryptedDir, { username: username || undefined, year }, counts, matcher)
  }
  const words = Array.from(counts.entries())
    .filter(([, n]) => n >= 2) // 只出现 1 次的词对词云没有统计意义
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CACHED_WORDS)
  return { words, scanned }
}

/**
 * 计算词云词频（带进程内缓存）。
 *
 * 实测（2026-09-26，本机 163,647 条正文 / 349 张会话表）：不加缓存时 global 一次 **15.3 秒**，
 * 且每次切回总览页都重算。它是**同步**返回 ⇒ 跑的这十几秒里后端 RPC 队列被整条堵住，
 * 同屏的「世界板块」（自身只要 13ms）实测被推迟到 **17,008ms** 才拿到数据 ——
 * 用户看到的就是「世界板块和全部热词都卡住」。
 *
 * 两道修：① 实体遮罩改 Aho-Corasick（见 `EntityMatcher`），把 15 秒压到 ~2 秒；
 * ② 按数据指纹缓存 30 秒，切回来 0ms。
 * @param decryptedDir 解密数据根。
 * @param options scope/username/year/limit。
 */
export function queryWordCloud(decryptedDir: string, options?: WordCloudOptions): WordCloudResult {
  const scope = options?.scope ?? 'global'
  const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 60)))
  const username = (options?.username ?? '').trim()
  if (scope === 'chat' && username === '') {
    throw new Error('scope=chat 需要 username（会话的 talker）')
  }
  const year = options?.year
  // 缓存签名：消息侧用分片目录的 mtime+size（新消息落库即失效）；朋友圈用 sns.db。
  const sig = scope === 'moments'
    ? MOMENTS_DB_PATHS.map((rel) => rel + ':' + fileSigOf(join(decryptedDir, ...rel.split('/')))).join('|')
    : shardCatalogSig(decryptedDir, ['message'])
  const full = cachedBySig(
    `wordcloud:${scope}:${username}:${year ?? 'all'}:${decryptedDir}`,
    sig,
    () => computeWordCloud(decryptedDir, scope, username, year),
    30_000,
  )
  return { words: full.words.slice(0, limit), scanned: full.scanned }
}

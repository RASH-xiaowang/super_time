/**
 * 朋友圈整表只扫一遍。作者榜和内容计数都从这份结果里取，
 * 按 `sns.db` 签名缓存，总览和洞察在同一次打开里共用。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withDbAsync } from './db-open.ts'
import { cachedBySigAsync, contactMeta, fileSigOf } from './meta.ts'
import { displayNameForUsername } from './message-identity.ts'
import { yieldToLoop } from './search-build.ts'

/** 朋友圈表每多少行让出一次。洞察的让出测试按这个数造数据。 */
export const SNS_YIELD_EVERY_ROWS = 2000

export interface MomentsScanStats {
  total: number
  images: number
  videos: number
  likes: number
  comments: number
}

export interface MomentsAuthorDraft {
  username: string
  name: string
  enterpriseName?: string
  posts: number
}

export interface MomentsScan {
  stats: MomentsScanStats
  authors: MomentsAuthorDraft[]
}

const EMPTY_STATS: MomentsScanStats = { total: 0, images: 0, videos: 0, likes: 0, comments: 0 }

function snsPathOf(dec: string): string {
  const nested = join(dec, 'sns', 'db_sns', 'sns.db')
  return existsSync(nested) ? nested : join(dec, 'sns', 'sns.db')
}

function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

function countSubstr(hay: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = hay.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = hay.indexOf(needle, idx + needle.length)
  }
  return count
}

function xmlNickname(xml: string): string {
  const m = xml.match(/<nickname>([^<]*)<\/nickname>/)
  return m ? (m[1] ?? '').replace(/&amp;/g, '&') : ''
}

function tallyContent(xml: string, stats: MomentsScanStats): void {
  stats.total += 1
  stats.images += countSubstr(xml, '<media>') + countSubstr(xml, '<media ')
  if (xml.includes('<type>6</type>') || xml.includes('<type>4</type>') || xml.includes('<type>15</type>')) stats.videos += 1
  const le = xml.indexOf('<LocalExtraInfo>')
  if (le < 0) return
  const block = xml.slice(le, xml.indexOf('</LocalExtraInfo>', le) || xml.length)
  const parts = countSubstr(block, '<user_comment>')
  const likes = countSubstr(block, '<type>1</type>')
  stats.likes += likes
  stats.comments += Math.max(0, parts - likes)
}

async function readMomentsScan(path: string): Promise<MomentsScan> {
  const stats: MomentsScanStats = { total: 0, images: 0, videos: 0, likes: 0, comments: 0 }
  const posts = new Map<string, { nickname: string; posts: number }>()
  await withDbAsync(path, async (db) => {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
    if (!has) return
    const cols = new Set(db.prepare('PRAGMA table_info(SnsTimeLine)').all().map(r => String(r.name)))
    const uname = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
    const cname = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
    if (cname === '') return
    const userSql = uname === '' ? "''" : uname
    const sql = `SELECT ${userSql} AS u, ${cname} AS c FROM SnsTimeLine`
    let scanned = 0
    for (const row of db.prepare(sql).iterate() as Iterable<{ u?: unknown; c?: unknown }>) {
      const xml = cellStr(row.c)
      tallyContent(xml, stats)
      const username = cellStr(row.u)
      if (username) {
        const cur = posts.get(username)
        if (cur) cur.posts += 1
        else posts.set(username, { nickname: xmlNickname(xml), posts: 1 })
      }
      if (++scanned % SNS_YIELD_EVERY_ROWS === 0) await yieldToLoop()
    }
    if (scanned % SNS_YIELD_EVERY_ROWS !== 0) await yieldToLoop()
  })
  const authors: MomentsAuthorDraft[] = []
  for (const [username, v] of posts) authors.push({ username, name: v.nickname, posts: v.posts })
  return { stats, authors }
}

/**
 * 读一次朋友圈表。签名是 `sns.db` 文件指纹；库不存在时返回空结果且不写入缓存。
 * @param dec - 已解密数据根。
 */
export async function scanMomentsShared(dec: string): Promise<MomentsScan> {
  const path = snsPathOf(dec)
  if (!existsSync(path)) return { stats: { ...EMPTY_STATS }, authors: [] }
  const sig = fileSigOf(path)
  return cachedBySigAsync('moments-scan:' + path, sig, () => readMomentsScan(path), 30_000)
}

/** 作者 Top 20。显示名在这里解析，所以通讯录变化不必让朋友圈扫描缓存失效。 */
export function momentAuthorsFromScan(scan: MomentsScan, dec: string): MomentsAuthorDraft[] {
  const meta = contactMeta(dec)
  return scan.authors
    .map((author) => {
      const enterpriseName = meta.enterpriseNames.get(author.username)?.trim()
      return {
        username: author.username,
        name: displayNameForUsername(author.username, meta.names, author.name),
        ...(enterpriseName ? { enterpriseName } : {}),
        posts: author.posts,
      }
    })
    .sort((a, b) => b.posts - a.posts)
    .slice(0, 20)
}

/**
 * 批量统计联系人的本机内容量，供好友目录按信息量排序。
 *
 * 一次打开每个消息分片，只数请求里那些人的 `Msg_<md5>` 表；朋友圈用已有的作者汇总。
 * 不按人逐次打开 360，避免目录变成几百次查询。
 */
import { messageTableName } from './message-identity.ts'
import { queryMomentsAuthors } from './moments.ts'
import { shardCatalog, shardCatalogSig } from './meta.ts'
import { withDb } from './db-open.ts'
import type { PortraitVolume } from '../types.ts'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../config/atomic-json.ts'

const MAX_USERNAMES = 5000

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function addCount(
  totals: Map<string, { messages: number; images: number }>,
  username: string,
  messages: number,
  images: number,
): void {
  const prev = totals.get(username) ?? { messages: 0, images: 0 }
  totals.set(username, {
    messages: prev.messages + messages,
    images: prev.images + images,
  })
}

function collectWanted(usernames: readonly string[]): Map<string, string> {
  const wanted = new Map<string, string>()
  for (const raw of usernames.slice(0, MAX_USERNAMES)) {
    const username = raw.trim()
    if (username === '' || username.endsWith('@chatroom')) continue
    wanted.set(messageTableName(username), username)
  }
  return wanted
}

function accumulateShard(
  shard: ReturnType<typeof shardCatalog>[number],
  wanted: Map<string, string>,
  totals: Map<string, { messages: number; images: number }>,
): void {
  const tables = [...wanted.keys()].filter((table) => shard.tables.has(table))
  if (tables.length === 0) return
  try {
    withDb(shard.file, (db) => {
      for (const table of tables) {
        const username = wanted.get(table)
        if (username === undefined) continue
        const cols = shard.tables.get(table)?.cols
        const quoted = quoteIdent(table)
        try {
          if (cols?.has('local_type') === true) {
            const row = db.prepare(
              `SELECT COUNT(*) AS n, SUM(CASE WHEN (local_type & 4294967295) = 3 THEN 1 ELSE 0 END) AS images FROM ${quoted}`,
            ).get() as { n?: number; images?: number | null } | undefined
            addCount(totals, username, Number(row?.n ?? 0), Number(row?.images ?? 0))
          } else {
            const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n?: number } | undefined
            addCount(totals, username, Number(row?.n ?? 0), 0)
          }
        } catch { /* 这张表读不到就当这一片是 0 */ }
      }
    })
  } catch { /* 分片打不开就跳过 */ }
}

function finishVolumes(
  decryptedDir: string,
  wanted: Map<string, string>,
  totals: Map<string, { messages: number; images: number }>,
): PortraitVolume[] {
  const moments = new Map<string, number>()
  try {
    for (const author of queryMomentsAuthors(decryptedDir)) moments.set(author.username, author.count)
  } catch { /* 朋友圈库不可用时只按聊天排序 */ }
  return [...wanted.values()].map((username) => ({
    username,
    messages: totals.get(username)?.messages ?? 0,
    images: totals.get(username)?.images ?? 0,
    moments: moments.get(username) ?? 0,
  }))
}

/**
 * 统计这些 username 的聊天条数、图片条数和朋友圈条数。
 * @param decryptedDir - 解密数据根。
 * @param usernames - 要统计的联系人。空串和群 id 会被跳过。
 * @returns 与请求对应的内容量；没有记录的人三项都是 0。
 */
export function queryPortraitVolumes(decryptedDir: string, usernames: readonly string[]): PortraitVolume[] {
  const wanted = collectWanted(usernames)
  const totals = new Map<string, { messages: number; images: number }>()
  for (const shard of shardCatalog(decryptedDir)) accumulateShard(shard, wanted, totals)
  return finishVolumes(decryptedDir, wanted, totals)
}

/** 先读缓存。没有缓存时按分片统计，每片让出一次事件循环，避免堵住性格存档的读取。 */
export async function queryPortraitVolumesCached(
  decryptedDir: string,
  usernames: readonly string[],
): Promise<PortraitVolume[]> {
  const cached = readPortraitVolumeCache(decryptedDir, usernames)
  if (cached !== undefined) return cached
  const wanted = collectWanted(usernames)
  const totals = new Map<string, { messages: number; images: number }>()
  for (const shard of shardCatalog(decryptedDir)) {
    accumulateShard(shard, wanted, totals)
    await new Promise((resolve) => setImmediate(resolve))
  }
  const rows = finishVolumes(decryptedDir, wanted, totals)
  writePortraitVolumeCache(decryptedDir, rows)
  return rows
}

interface VolumeCacheFile {
  sig: string
  rows: PortraitVolume[]
}

const volumeMemory = new Map<string, VolumeCacheFile>()

function volumeCachePath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'portrait-volumes.json')
}

function volumeKey(usernames: readonly string[]): string {
  return usernames.map((name) => name.trim()).filter((name) => name !== '').sort().join('\n')
}

/**
 * 信息量排序的缓存读取。分片签名没变、请求的人都在缓存里时不再扫消息库。
 * 签名变了或缓存损坏时返回 undefined，调用方再全量统计。
 */
export function readPortraitVolumeCache(decryptedDir: string, usernames: readonly string[]): PortraitVolume[] | undefined {
  const sig = shardCatalogSig(decryptedDir, ['message'])
  const key = volumeKey(usernames)
  const remembered = volumeMemory.get(decryptedDir)
  const file = remembered?.sig === sig
    ? remembered
    : readVolumeFile(decryptedDir, sig)
  if (file === undefined) return undefined
  const byUser = new Map(file.rows.map((row) => [row.username, row]))
  const wanted = key === '' ? [] : key.split('\n')
  if (wanted.some((username) => !byUser.has(username))) return undefined
  volumeMemory.set(decryptedDir, file)
  return wanted.map((username) => byUser.get(username) ?? { username, messages: 0, images: 0, moments: 0 })
}

function readVolumeFile(decryptedDir: string, sig: string): VolumeCacheFile | undefined {
  const path = volumeCachePath(decryptedDir)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VolumeCacheFile>
    if (parsed.sig !== sig || !Array.isArray(parsed.rows)) return undefined
    return { sig, rows: parsed.rows }
  } catch {
    return undefined
  }
}

/** 把刚统计完的信息量写到内存和硬盘。写失败不影响本次返回。 */
export function writePortraitVolumeCache(decryptedDir: string, rows: readonly PortraitVolume[]): void {
  const sig = shardCatalogSig(decryptedDir, ['message'])
  const previous = volumeMemory.get(decryptedDir)
  const merged = new Map<string, PortraitVolume>()
  if (previous?.sig === sig) {
    for (const row of previous.rows) merged.set(row.username, row)
  }
  for (const row of rows) merged.set(row.username, row)
  const file = { sig, rows: [...merged.values()] }
  volumeMemory.set(decryptedDir, file)
  try {
    const path = volumeCachePath(decryptedDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, JSON.stringify(file))
  } catch { /* 缓存写不进仍可继续用内存 */ }
}

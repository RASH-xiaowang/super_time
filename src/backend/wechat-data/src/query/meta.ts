/**
 * Shared in-process metadata caches for the WeChat read path.
 *
 * The decrypted snapshot is an external read-only DB tree that the realtime
 * sync loop rewrites in place (atomic rename). Every cache here keys on the
 * owning file's mtime+size fingerprint, so a rewritten file invalidates the
 * entry naturally; callers never see data older than the file that produced
 * it. A short max-age bounds fingerprint drift on the same file.
 */

import { DatabaseSync } from 'node:sqlite'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_AGE_MS = 5_000

interface Entry {
  at: number
  sig: string
  value: unknown
}

const entries = new Map<string, Entry>()

/**
 * 按 key 前缀的**按需限界**（N16）。
 *
 * 为什么不给整张表设一个全局上限：`contact-meta:` / `sender-names:` / `shard-meta:` /
 * `shard-catalog:` 这些条目的**条数由数据目录决定**（几十条），却是最贵的（每条要开库 +
 * 读 Name2Id + 逐表 PRAGMA）。给它们设上限，就等于「用户狂点聊天时把最贵的条目挤掉」——
 * 省下几百字节换一次全量重载，方向反了。
 *
 * 真正会涨的是 `msg-by-sid:`：key 里带 serverId，条数由「用户点过哪些消息」驱动、
 * 没有天然上限（M11 复审实测负条目 ~740B，命中条目还可能含整份 rich）。
 * 所以只钉这一族，其余照旧。
 *
 * 淘汰语义与 `boundedSet` 一致（FIFO —— Map 的插入序就是写入序；命中只刷新 TTL、
 * 不改变插入序，因此**不是**严格 LRU）：目的是「内存有上界」，不是「命中率最优」。
 * 新增一族只需要在这里加一行。
 */
export const METADATA_KEY_FAMILY_LIMITS: ReadonlyArray<{ prefix: string; cap: number }> = [
  { prefix: 'msg-by-sid:', cap: 200 },
]

/**
 * 超出该族上限时按 FIFO 淘汰最老的 key。
 * @param key - 刚刚写入的 key。
 */
function enforceKeyFamilyLimit(key: string): void {
  for (const { prefix, cap } of METADATA_KEY_FAMILY_LIMITS) {
    if (!key.startsWith(prefix)) continue
    let count = 0
    for (const k of entries.keys()) if (k.startsWith(prefix)) count += 1
    if (count <= cap) return
    for (const k of entries.keys()) {
      if (!k.startsWith(prefix)) continue
      entries.delete(k)
      count -= 1
      if (count <= cap) return
    }
    return
  }
}

function decode(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

function fileSig(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function dirSig(dir: string): string {
  try {
    const st = statSync(dir)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function get<T>(key: string, sig: string, loader: () => T, maxAgeMs = MAX_AGE_MS): T {
  const hit = entries.get(key)
  if (hit && hit.sig === sig && hit.at + maxAgeMs > Date.now()) return hit.value as T
  const value = loader()
  entries.set(key, { at: Date.now(), sig, value })
  enforceKeyFamilyLimit(key)
  return value
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map(r => r.name))
  } catch {
    return new Set()
  }
}

/** Contact meta: display names, pinned usernames, official-account types. */
export interface ContactMeta {
  names: Map<string, string>
  pinned: Set<string>
  bizTypes: Map<string, number>
}

/**
 * `biz_info.type` 是否为**服务号**（否则该 `gh_` 账号是订阅号/公众号）。
 *
 * 这个判据必须**全局唯一**：聊天列表（`sessions.ts`）与通讯录（`contacts.ts`）
 * 各自写一份就会出现「同一个账号在聊天里算服务号、在通讯录里算公众号」，
 * 也就是同一个账号出现在两个类目下、或两边都看不到它。
 * 实测本机 `biz_info.type` 只有 0（订阅号）与 1（服务号）；1/3/5 是微信
 * 文档里服务号用过的取值，2/4 属订阅号，因此不能简化成 `type > 0`。
 * @param t - `biz_info.type`（缺失时为 undefined）。
 * @returns 是服务号时为 true。
 */
export function isServiceBizType(t: number | undefined): boolean {
  return t === 1 || t === 3 || t === 5
}

/**
 * Read contact.db once and derive all contact metadata.
 * @param decryptedDir - decrypted data root.
 * @returns contact names (remark > nick > username), pinned set, biz types.
 */
export function contactMeta(decryptedDir: string): ContactMeta {
  const p = join(decryptedDir, 'contact', 'contact.db')
  const sig = fileSig(p)
  return get<ContactMeta>('contact-meta:' + decryptedDir, sig, () => {
    const names = new Map<string, string>()
    const pinned = new Set<string>()
    const bizTypes = new Map<string, number>()
    if (!sig) return { names, pinned, bizTypes }
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      try {
        const cols = tableColumns(db, 'contact')
        const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : ''
        const remarkCol = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : ''
        const nickCol = cols.has('nick_name') ? 'nick_name' : cols.has('NickName') ? 'NickName' : 'nickName'
        const flagCol = cols.has('flag') ? 'flag' : cols.has('Flag') ? 'Flag' : ''
        if (userCol) {
          const remarkSel = remarkCol || "''"
          const nickSel = nickCol
          const rows = db.prepare(
            `SELECT ${userCol} AS u, ${remarkSel} AS r, ${nickSel} AS n, ${flagCol || '0'} AS f FROM contact`,
          ).all() as Array<Record<string, unknown>>
          for (const row of rows) {
            const u = decode(row.u)
            if (!u) continue
            const remark = decode(row.r).trim()
            const nick = decode(row.n).trim()
            names.set(u, remark || nick || u)
            const flag = Number(row.f ?? 0)
            if ((flag & 0x800) !== 0) pinned.add(u)
          }
        }
        const biCols = tableColumns(db, 'biz_info')
        if (biCols.has('username') && biCols.has('type')) {
          const rows = db.prepare('SELECT username AS u, type AS t FROM biz_info').all() as Array<{ u: unknown; t: unknown }>
          for (const row of rows) {
            const u = decode(row.u)
            if (u) bizTypes.set(u, Number(row.t ?? 0))
          }
        }
      } finally {
        db.close()
      }
    } catch { /* contact.db unavailable: keep empty maps */ }
    return { names, pinned, bizTypes }
  })
}

/** SenderName2Id fallback (message_resource.db rowid -> wxid). */
export function senderNameMap(decryptedDir: string): Map<number, string> {
  const p = join(decryptedDir, 'message', 'message_resource.db')
  const sig = fileSig(p)
  return get<Map<number, string>>('sender-names:' + decryptedDir, sig, () => {
    const map = new Map<number, string>()
    if (!sig) return map
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      try {
        const rows = db.prepare('SELECT rowid AS id, user_name AS u FROM SenderName2Id').all() as Array<{ id: number; u: unknown }>
        for (const row of rows) {
          const u = decode(row.u).trim()
          if (u) map.set(row.id, u)
        }
      } catch { /* table absent */ } finally {
        db.close()
      }
    } catch { /* resource db unavailable */ }
    return map
  })
}

/** One cached shard entry: which file holds a table and its columns/name map. */
export interface ShardMeta {
  file: string
  tables: Map<string, { cols: Set<string>; name2id: Map<number, string> }>
}

function loadShardMeta(dbFile: string): ShardMeta {
  const tables = new Map<string, { cols: Set<string>; name2id: Map<number, string> }>()
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const name2id = new Map<number, string>()
      for (const t of ['Name2Id', 'name2id']) {
        try {
          const rows = db.prepare('SELECT rowid AS id, user_name AS u FROM ' + t).all() as Array<{ id: number; u: unknown }>
          for (const row of rows) {
            // 空 user_name 必须写入：WeChat 4.x 用 Name2Id 空行代表「登录账号自己」
            // （实测每个分片恰好 1 行，被约 6% 的消息引用）。跳过空行会让这些消息
            // 解析不到 sender，isSelf 全部塌成 false —— 自己发的话全跑到对方气泡侧。
            const u = decode(row.u).trim()
            name2id.set(row.id, u)
          }
          if (name2id.size > 0) break
        } catch { /* try the other casing */ }
      }
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>
      for (const row of rows) {
        tables.set(row.name, { cols: tableColumns(db, row.name), name2id })
      }
    } finally {
      db.close()
    }
  } catch { /* skip file */ }
  return { file: dbFile, tables }
}

/**
 * 单个分片的元数据，**按文件粒度**缓存。
 *
 * 为什么要在目录级缓存之下再垫一层：`shardCatalogDirs` 的条目是「整份目录一条」，
 * 签名由**所有**分片的签名拼成 —— 于是任何一个分片变了都会让整条失效、把**全部分片**
 * 重新 `loadShardMeta`（每个都要开库、读 Name2Id、列 `Msg_%` 表、再逐表 PRAGMA）。
 * 实时同步活跃期约 10s 就有一次变更，没变的分片因此被反复重读。
 * 垫了这一层后，只有真正变了的那个分片会重新加载，其余直接复用同一个对象
 * （调用方拿到的 `ShardMeta` 因此是稳定的，见 `shardCatalogDirs` 的用例）。
 * @param dbFile - 分片数据库绝对路径。
 * @returns 该分片的元数据（按该文件的 mtime+size 失效）。
 */
function shardMetaOf(dbFile: string): ShardMeta {
  return get<ShardMeta>('shard-meta:' + dbFile, fileSig(dbFile), () => loadShardMeta(dbFile))
}

/**
 * Cached message shard catalog across one or more sub-directories (message,
 * bizchat, ...). Returns the Msg_% tables each file holds.
 * @param decryptedDir - decrypted data root.
 * @param dirs - sub-directory names to scan (default ['message']).
 * @returns shard metadata keyed by file path (cache invalidated by file sigs).
 */
export function shardCatalogDirs(decryptedDir: string, dirs: ReadonlyArray<string>): ShardMeta[] {
  const key = 'shard-catalog:' + decryptedDir + ':' + dirs.join('|')
  const sigParts: string[] = []
  const entries: Array<{ file: string }> = []
  for (const dirName of dirs) {
    const dir = join(decryptedDir, dirName)
    const dSig = dirSig(dir)
    if (!dSig) continue
    sigParts.push(`${dirName}:${dSig}`)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts') && !f.includes('resource') && !f.includes('media')).sort()
    } catch {
      continue
    }
    for (const f of files) {
      const full = join(dir, f)
      const fs = fileSig(full)
      sigParts.push(`${f}:${fs}`)
      entries.push({ file: full })
    }
  }
  // 外层只负责「文件清单与顺序」：真正逐分片的内容由 shardMetaOf 各自缓存，
  // 所以一个分片变了只会重载那一个（M8）。
  return get<ShardMeta[]>(key, sigParts.join('|'), () => entries.map(e => shardMetaOf(e.file)))
}

/** Convenience: message-directory-only catalog (the chat hot path). */
export function shardCatalog(decryptedDir: string): ShardMeta[] {
  return shardCatalogDirs(decryptedDir, ['message'])
}

/** Signature string for the directories a catalog covers (cache keys). */
export function shardCatalogSig(decryptedDir: string, dirs: ReadonlyArray<string>): string {
  const parts: string[] = []
  for (const dirName of dirs) {
    const dir = join(decryptedDir, dirName)
    parts.push(`${dirName}:${dirSig(dir)}`)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts') && !f.includes('resource') && !f.includes('media')).sort()
    } catch {
      continue
    }
    for (const f of files) parts.push(`${f}:${fileSig(join(dir, f))}`)
  }
  return parts.join('|')
}

/** Signature of one file (mtime+size); '' when absent. */
export function fileSigOf(path: string): string {
  return fileSig(path)
}

/** Generic mtime/fingerprint-bounded process cache (see {@link get}). */
export function cachedBySig<T>(key: string, sig: string, loader: () => T, maxAgeMs = MAX_AGE_MS): T {
  return get(key, sig, loader, maxAgeMs)
}

/** Insert with a simple FIFO capacity bound (evicts the oldest key). */
export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap = 300): void {
  if (!map.has(key) && map.size >= cap) {
    const first = map.keys().next()
    if (!first.done && first.value !== undefined) map.delete(first.value)
  }
  map.set(key, value)
}

/**
 * Drop every cached snapshot (called after a rewrite event when needed).
 */
export function invalidateWechatMeta(): void {
  entries.clear()
}

/**
 * 数据世代：每发生一次「解密快照被改写」就 +1（实时同步落地新数据）。
 *
 * 为什么需要它：有些条目依赖的是「**整棵树**都可能变了」，没法用某一个文件的签名表达
 * （例如 `status` / `db-health` 的整树文件统计、`overview-extras` 的整树 `walkDb`）。
 * 给它们一个廉价的显式失效信号，比两种替代方案都好：
 *   · 靠「整体清空 entries」刷新 —— 会把**签名完整**的条目一起丢掉，于是没变的分片也被
 *     重新加载（这正是 M8 的失效风暴）；
 *   · 给它们算「整树签名」—— 每次查询都要 stat 成千上万个文件，比这些缓存本身还贵。
 * 计数单调递增，所以不存在「数据变了但签名没变」的窗口。
 */
let dataGeneration = 0

/** 推进数据世代。实时同步落地新数据后调用（全树被替换的场合仍用 invalidateWechatMeta）。 */
export function bumpDataGeneration(): void {
  dataGeneration += 1
}

/** 数据世代签名：给「依赖整棵树」的缓存条目当 sig 用。 */
export function dataGenerationSig(): string {
  return 'datagen:' + dataGeneration
}

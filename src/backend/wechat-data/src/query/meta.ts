/**
 * Shared in-process metadata caches for the WeChat read path.
 *
 * The decrypted snapshot is an external read-only DB tree that the realtime
 * sync loop rewrites in place (atomic rename). Every cache here keys on the
 * owning file's mtime+size fingerprint, so a rewritten file invalidates the
 * entry naturally; callers never see data older than the file that produced
 * it. A short max-age bounds fingerprint drift on the same file.
 */

import { DatabaseSync } from './db-open.ts'
import { readdirSync, statSync } from 'node:fs'
import { sqliteChangeCounter } from './file-sig.ts'
import { join } from 'node:path'

const MAX_AGE_MS = 5_000

/**
 * W3-9.2：insights 一族的显式 TTL（30 秒）。
 *
 * 为什么要显式写出来：不写第 4 个参数就等于用 {@link MAX_AGE_MS} 的 5 秒，
 * 而那个默认值是给**交互类**查询定的（列表页翻一下就刷新）。insights 是
 * 一次要扫几个分片的聚合：5 秒内重复算一遍纯属浪费，用户在两块面板之间来回
 * 切一次就把省下的又吐回去。写出来还让守卫看得见它（`w3-insights-ttl.spec.ts`）——
 * 没人看见的默认值，改动时也不会有人来对账。
 *
 * 30 秒而不是更长：它仍然受**数据签名**管着（分片/库文件一变立刻重算），
 * TTL 只是「签名没变时的最短重复间隔」，不是陈旧窗口的上界。
 */
export const INSIGHTS_TTL_MS = 30_000

/**
 * W3-9.2：年度一族的显式 TTL（60 秒）。
 *
 * 与 {@link INSIGHTS_TTL_MS} 同族不同档：年报按月/年看，用户不会在几秒内
 * 反复切回去；而它扫的是**全年**消息，比 insights 更贵。
 * 同样受数据签名管着（分片一变立刻重算），TTL 只是最短重复间隔。
 */
export const ANNUAL_TTL_MS = 60_000

interface Entry {
  at: number
  /**
   * 最近一次**被读到**的时刻（W3-3.1：访问计时 LRU）。
   *
   * 为什么与 `at`（写入时刻）分开：TTL 按写入算，而淘汰顺序要按**用没用过**算。
   * 只用 `at` 的话，淘汰退化成 FIFO —— 「用户一直在看的第 201 条」会被
   * 「写进去就再没人碰过的第 1 条」之后的某一条挤掉，而那一条本来还有用。
   */
  hitAt: number
  sig: string
  value: unknown
}

/**
 * 签名缓存本体。**导出只为门禁与测试能看见命中时刻**（`group-insights-swr.spec.ts` 用它断言
 * 「命中时 `at` 没被重写」—— 那条断言在外部观察不到缓存，就只能靠读这一份）。
 * 生产代码一律走 {@link cachedBySig} / {@link cachedBySigAsync}，不要直接动这个 Map。
 */
export const entries = new Map<string, Entry>()

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
 * 淘汰语义（W3-3.1 由 FIFO 改成**访问计时 LRU**）：按 `hitAt`（最近一次被读到）排序，
 * 最久没用的先走。`hitAt` 在**写入与命中时都会刷新**，所以「用户一直在看的那几条」
 * 不会排在「写进去就没人碰」的前面。目的既是「内存有上界」，也是命中率不退步。
 * 新增一族只需要在这里加一行。
 */
export const METADATA_KEY_FAMILY_LIMITS: ReadonlyArray<{ prefix: string; cap: number }> = [
  { prefix: 'msg-by-sid:', cap: 200 },
  // `contacts:` 的键空间 = (页偏移 × 分类) 且**没有任何上界**：每个键存整页联系人对象
  // （至多 pageSize 条）。分类过滤下沉到后端后（修复「页签有数据却空白」），键从
  // 「约 total/pageSize」变成「再乘 9 个类目」——更需要一个上界。96 ≈ 9 个类目各约 11 页，
  // 足以让「来回切类目 / 上下滚动」都命中，同时给内存一个明确上界。
  // 条目是纯数据，淘汰后重算即安全。
  { prefix: 'contacts:', cap: 96 },
]

/**
 * 超出该族上限时按**访问计时 LRU** 淘汰最久没用的 key（W3-3.1）。
 *
 * 与改前的 FIFO 只差一个动作：命中时刷新 `hitAt`。而那一个动作正是
 * 「用户一直在看的那一条」与「写进去就没再碰过的那一条」的区别 ——
 * 200 条额度给谁，该由使用情况决定，不该由写入顺序决定。
 * @param key - 刚刚写入的 key。
 */
function enforceKeyFamilyLimit(key: string): void {
  for (const { prefix, cap } of METADATA_KEY_FAMILY_LIMITS) {
    if (!key.startsWith(prefix)) continue
    let count = 0
    for (const k of entries.keys()) if (k.startsWith(prefix)) count += 1
    if (count <= cap) return
    // 同族条目按 hitAt 升序：最久没用的排最前，先删它们。
    const family = [...entries.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort((a, b) => a[1].hitAt - b[1].hitAt)
    for (const [k] of family) {
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

/**
 * 文件签名 = **mtimeNs : size**（2026-09-29 由 `mtimeMs` 改）。
 *
 * ## 为什么必须用纳秒
 *
 * `mtimeMs` 只有毫秒精度，而 SQLite 写入**常常只改内容、不改大小**（文件页对齐）——
 * 同一毫秒内发生的写入会让签名**看起来没变**，缓存于是心安理得地继续回旧值。
 * 真机上这以"数据变了却回旧值"的形式在本仓三处各咬过一次：
 * `wordcloud` 分片签名、`kb-vectors` 粗筛表指纹、`storage-stats` 文件签名。
 * `statSync(path, { bigint: true }).mtimeNs` 给的是 **NTFS 的 100ns 精度**，
 * 实测开销与普通 `statSync` **无差别**（各 2 万次：**8.30µs vs 8.35µs**，约 0.6%），
 * 所以在热路径上用它没有代价。
 */
function fileSig(path: string): string {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.mtimeNs}:${st.size}${sqliteChangeCounter(path)}${walSig(path)}`
  } catch {
    return ''
  }
}

/**
 * SQLite 的 **WAL 尾巴**（`<库>-wal`）也要进签名（2026-09-29 加）。
 *
 * 为什么：SQLite 默认 WAL 模式下，**写入先进 `-wal`**，主库文件的 mtime/size 可能**一直不变**
 * （直到 checkpoint）。于是只看主库的签名会漏掉"刚写进去的那条"——
 * 表现就是那条断言偶发 `expected 12006 not to be 12006`：数据确实变了，签名却"没变"
 * （与 mtimeMs→mtimeNs 那次是**同一类问题的两个面**：前者是精度不够，后者是**看错了文件**）。
 * 没有 `-wal` 时（已 checkpoint / 非 WAL）回落成空串，行为与之前一致。
 * @param path - 主库路径。
 * @returns 形如 `:<mtimeNs>:<size>` 的尾巴；没有 WAL 时为空串。
 */
function walSig(path: string): string {
  try {
    const w = statSync(path + '-wal', { bigint: true })
    return `:${w.mtimeNs}:${w.size}`
  } catch {
    return ''
  }
}

function dirSig(dir: string): string {
  try {
    const st = statSync(dir, { bigint: true })
    return `${st.mtimeNs}:${st.size}`
  } catch {
    return ''
  }
}

function get<T>(key: string, sig: string, loader: () => T, maxAgeMs = MAX_AGE_MS): T {
  const hit = entries.get(key)
  if (hit && hit.sig === sig && hit.at + maxAgeMs > Date.now()) {
    // W3-3.1：命中也要刷新 `hitAt` —— 否则淘汰顺序仍等价于 FIFO（只认写入序）。
    hit.hitAt = Date.now()
    return hit.value as T
  }
  const now = Date.now()
  entries.set(key, { at: now, hitAt: now, sig, value: loader() })
  enforceKeyFamilyLimit(key)
  return entries.get(key)?.value as T
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

/**
 * 异步版的签名缓存（P1-2：让出型查询的必经入口）。
 *
 * ## 为什么不能直接 `await cachedBySig(k, s, async () => …)`
 *
 * 同步的 `get` 会把 loader 的返回值（一个 Promise）原样塞进 `entries`，
 * 于是第二次命中拿到的是**同一个已 settle 的 Promise** —— 看着能跑，实际把
 * 「数据变了」这一维整个丢掉：签名重算是同步的，值却永远是第一次那份。
 *
 * ## 合流（同键并发只跑一份）
 *
 * 让出之后两次冷算真的可以同时在跑（面板切来切去、事件重放）。没有合流的话，
 * 54 秒的概览会被并发跑成两份，事件循环反而更堵。所以同键的后来者**等同一份** Promise。
 *
 * 但「等同一份」有个前提要处理：后来者可能带着**更新的签名**。处理办法是
 * 「只由最新那份写回」—— 完成时若自己已经不是在飞的那一份，就把结果丢掉
 * （让新的 loader 去写），避免出现「旧签名后完成、把新数据盖掉」。
 * @param key - 缓存键（含数据根与参数）。
 * @param sig - 数据签名；变了就必须重算。
 * @param loader - 异步装载器。
 * @param maxAgeMs - 保质期。
 * @returns 计算好的值（或复用同键正在跑的那一份）。
 */
export async function cachedBySigAsync<T>(
  key: string,
  sig: string,
  loader: () => Promise<T>,
  maxAgeMs = MAX_AGE_MS,
  /**
   * 要不要把这一次的**结果**写进缓存（W2-9.4）。缺省一律缓存。
   *
   * 为什么需要：可取消的计算会返回**算了一半**的结果。把它缓存 30 秒，
   * 用户就会在接下来的 30 秒里一直看到那份半成品，而且没有任何东西告诉他「这是半的」。
   * 「不缓存」不是丢数据 —— 下一次请求会重算，而重算时已经没人取消它了。
   *
   * 只影响**写回**，不影响在飞去重（同一个 key+sig 的并发调用仍共享同一份计算）。
   * @param value - 这次算出来的值。
   * @returns `false` 表示别写进缓存。
   */
  shouldCache: (value: T) => boolean = () => true,
): Promise<T> {
  const hit = entries.get(key)
  if (hit && hit.sig === sig && hit.at + maxAgeMs > Date.now()) {
    if (process.env.SUPERTIME_CACHE_TRACE === '1') console.log(`[cache-trace] hit  ${key} sig=${sig}`)
    // W3-3.1：命中也要刷新 `hitAt`。异步路径与同步路径各有一处命中判定，
    // 只改一处的话「读过的条目」在另一条路上仍会被当成没用过 —— 本族（msg-by-sid）
    // 走的正是**这一条**，所以漏了它 LRU 就整族失效。
    hit.hitAt = Date.now()
    return hit.value as T
  }
  if (process.env.SUPERTIME_CACHE_TRACE === '1') console.log(`[cache-trace] miss ${key} sig=${sig}${hit ? `（旧 sig=${hit.sig}）` : '（无旧值）'}`)
  /**
   * ⚠️ **在飞表按 `key + 签名` 去重**（2026-09-29 由只用 `key` 改）。
   *
   * 只用 `key` 时有一个真实的错值通道：数据变了（签名 B）之后新调用进来，
   * 若此时**旧签名 A 的那一次计算还没跑完**，新调用会 `return running.value` ——
   * 直接拿到 **A 的结果**，也就是"刚变过的数据，返回的却是旧值"。
   * 这与之前几轮踩的签名口径是**另一条独立的错值通道**（前几轮修的是"变化看不见"，
   * 这条是"看见了变化却被在飞的旧计算顶掉"）。
   * 按签名分桶后：同签名共享一次计算（原有的省重复价值不变），签名不同则各算各的。
   */
  const flightKey = key + '\u0000' + sig
  const running = inFlight.get(flightKey)
  if (running) return running.value as Promise<T>
  // 用一个小盒子存 Promise，靠**盒子本身的身份**判断「我还是不是最新的那一份」——
  // 直接写 `const mine = (async () => … mine …)()` 会让 TS 报「赋值前使用」（闭包里读到
  // 的是还没完成赋值的变量），而这个判断恰恰不能靠 `!` 咽掉。
  const rec: { value: Promise<unknown> } = { value: null as unknown as Promise<unknown> }
  rec.value = (async () => {
    const value = await loader()
    // 只有「仍然是在飞的那一份」才写回：避免被更新的签名算完后又被旧的盖一次。
    if (inFlight.get(flightKey) === rec && shouldCache(value)) {
      const now = Date.now()
      entries.set(key, { at: now, hitAt: now, sig, value })
      enforceKeyFamilyLimit(key)
    }
    return value
  })()
  inFlight.set(flightKey, rec)
  try {
    return await (rec.value as Promise<T>)
  } finally {
    if (inFlight.get(flightKey) === rec) inFlight.delete(flightKey)
  }
}

/** 在飞的异步冷算：同键只允许有一份（见 {@link cachedBySigAsync}）。 */
const inFlight = new Map<string, { value: Promise<unknown> }>()

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

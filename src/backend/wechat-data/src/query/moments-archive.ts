/**
 * 朋友圈**防撤回归档**（2026-10-19 用户：「已经拿到的朋友圈各种信息请保留在本地，
 * 不能因为好友删除了就看不到了」）。
 *
 * ## 为什么需要它
 *
 * 朋友圈列表原先**只读** `sns.db` 的 `SnsTimeLine`：好友删动态、设为私密、清理缓存后，
 * 那一行就没了 —— 我们只是「当时看见过」，什么都没有留下。这跟消息撤回是同一类问题，
 * 所以沿用 `anti-revoke-archive.ts` / `revoke-retain.ts` 的做法：
 *
 *   · 每次读取朋友圈时，把线上行**幂等导入我们自己的库**（`<数据根>/moments-archive.db`）；
 *   · 列表、作者统计、月度分布都从**我们的库**出（它是线上表的超集：见过的不会消失）；
 *   · 作者展示名 / 点赞评论 / 图片视频元数据都随 payload 一起快照，好友被删也能还原。
 *
 * ## 保留语义（关键）
 *
 * `tid` 主键 + `ON CONFLICT DO UPDATE`：同一 tid 的**首次归档时间**（`archived_at`）
 * 永不改；线上行还在时更新内容与 `last_seen_at`（评论/点赞会增长）；线上行消失后
 * 归档行原样保留 —— 这正是「不让删除成功」。
 *
 * ## 边界
 *
 *   · 这里只存**文本/JSON 快照**，不存图片原图字节（原图在 `sns-media-store` 的
 *     `moments-media` 落盘目录，按 md5 存，见该模块）；
 *   · 写失败不致命：读不到/写不进时静默降级（`queryMoments` 回退线上表），
 *     绝不让归档把朋友圈本身搞挂；
 *   · 连接纪律：一律走 `withDb` / `withWritableDb`（`query-db-lifetime.spec.ts`）。
 *
 * @module query/moments-archive
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { withDb, withWritableDb } from './db-open.ts'

/** 归档库文件名（数据根下，与 `decoded_images`、`message-archive.db` 同级）。 */
const DB_FILE = 'moments-archive.db'

/**
 * 归档库路径。
 *
 * 生产布局是 `<数据根>/decrypted`，所以归档放 `<数据根>/moments-archive.db`（与
 * `decoded_images` 同级，不随解密目录被重写）。显式 pin 的解密目录（`DSH_WECHAT_DECRYPTED_DIR`）
 * 或测试里直接把数据根当 `decryptedDir` 传进来时，放在该目录**里面**：
 * 共享 `%TEMP%` 上写同名库会让并行用例互相污染，那比「目录里多一个自建库」更坏。
 * @param decryptedDir - 解密数据根。
 * @returns 归档库路径。
 */
export function momentsArchivePath(decryptedDir: string): string {
  if (basename(decryptedDir) === 'decrypted') return join(dirname(decryptedDir), DB_FILE)
  return join(decryptedDir, DB_FILE)
}

const DDL = [
  'CREATE TABLE IF NOT EXISTS moments_archive (',
  '  tid TEXT PRIMARY KEY,',
  '  username TEXT NOT NULL,',
  '  author TEXT NOT NULL,',
  '  ts INTEGER NOT NULL,',
  '  month TEXT NOT NULL,',
  '  content TEXT NOT NULL,',
  '  content_hash TEXT NOT NULL,',
  '  payload TEXT NOT NULL,',
  '  archived_at INTEGER NOT NULL,',
  '  last_seen_at INTEGER NOT NULL',,
  ');',
  'CREATE INDEX IF NOT EXISTS idx_moments_archive_ts ON moments_archive(ts DESC);',
  'CREATE INDEX IF NOT EXISTS idx_moments_archive_user ON moments_archive(username);',
  'CREATE INDEX IF NOT EXISTS idx_moments_archive_month ON moments_archive(month);',
  'CREATE TABLE IF NOT EXISTS moment_profiles (',
  '  username TEXT PRIMARY KEY,',
  '  name TEXT NOT NULL DEFAULT \'\',',
  '  avatar TEXT NOT NULL DEFAULT \'\',',
  '  updated_at INTEGER NOT NULL',
  ');',
].join('\n')

/** 一条待归档的朋友圈（payload 已由 `moments.ts` 解析好）。 */
export interface ArchivedMomentInput {
  tid: string
  username: string
  /** 展示名快照（备注 → 昵称 → ID），好友删了也还能显示。 */
  author: string
  /** 创建时间（秒）。 */
  ts: number
  /** 原始 content XML；parser 升级后可重放。 */
  content: string
  /** content 的 sha1（省略时由 SQL 不去重，只用于判断「内容变没变」）。 */
  contentHash: string
  /** `JSON.stringify(MomentEntry)`；包含文本/图片/视频/位置/点赞/评论。 */
  payload: string
}

/** 归档行（读出来交给 `moments.ts` 反序列化）。 */
export interface ArchivedMomentRow {
  tid: string
  username: string
  author: string
  ts: number
  content: string
  contentHash: string
  payload: string
  archivedAt: number
  lastSeenAt: number
}

/** 本地月份键（与前端月度分布同口径：本地时区 `YYYY-MM`；无 createTime 的条目记空串，不计入月度）。 */
function monthOf(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(Math.trunc(ts) * 1000)
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function ensureDir(file: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * 归档库是否存在（读路径不建库：没有归档时由调用方回退线上表）。
 * @param decryptedDir - 解密数据根。
 * @returns 存在且是普通文件时为 true。
 */
export function hasMomentsArchive(decryptedDir: string): boolean {
  return existsSync(momentsArchivePath(decryptedDir))
}

/**
 * 读已归档的 `tid → contentHash` 索引，用于只解析「内容变了」的行。
 * @param decryptedDir - 解密数据根。
 * @returns 索引；归档库不存在/不可读时为 `null`（调用方应按「全部未归档」处理）。
 */
export function readArchivedMomentHashes(decryptedDir: string): Map<string, string> | null {
  const p = momentsArchivePath(decryptedDir)
  if (!existsSync(p)) return null
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moments_archive'").get()
      if (has === undefined) return new Map<string, string>()
      const rows = db.prepare('SELECT tid AS t, content_hash AS h FROM moments_archive').all() as Array<{ t?: unknown; h?: unknown }>
      const map = new Map<string, string>()
      for (const r of rows) {
        if (typeof r.t === 'string' && typeof r.h === 'string') map.set(r.t, r.h)
      }
      return map
    })
  } catch {
    return null
  }
}

/**
 * 读归档里的洞察明细（含已被删除的帖子）。
 * @param decryptedDir - 解密数据根。
 * @param author - 可选作者 username。
 * @returns `{tid, username, ts, payload}`；归档库不存在时为空数组。
 */
export interface ArchivedInsightRow {
  tid: string
  username: string
  ts: number
  payload: string
}

export function readArchivedInsightRows(decryptedDir: string, author?: string): ArchivedInsightRow[] {
  const p = momentsArchivePath(decryptedDir)
  if (!existsSync(p)) return []
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moments_archive'").get()
      if (has === undefined) return []
      const where = author ? ' WHERE username = ?' : ''
      const rows = db.prepare(
        'SELECT tid AS t, username AS u, ts AS s, payload AS p FROM moments_archive' + where,
      ).all(...(author ? [author] : [])) as Array<{ t?: unknown; u?: unknown; s?: unknown; p?: unknown }>
      return rows.flatMap((r) => (typeof r.t === 'string' && typeof r.p === 'string'
        ? [{ tid: r.t, username: String(r.u ?? ''), ts: Number(r.s ?? 0), payload: r.p }]
        : []))
    })
  } catch {
    return []
  }
}

/**
 * 读一批 `tid → payload`（用于「好友删了评论/点赞/图片后，归档仍保留旧条目」的合并）。
 * @param decryptedDir - 解密数据根。
 * @param tids - 需要读的 tid。
 * @returns map；归档库不存在时为空 map。
 */
export function readArchivedPayloads(decryptedDir: string, tids: readonly string[]): Map<string, string> {
  const keys = Array.from(new Set(tids.filter((t) => t !== '')))
  const out = new Map<string, string>()
  if (keys.length === 0) return out
  const p = momentsArchivePath(decryptedDir)
  if (!existsSync(p)) return out
  try {
    withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moments_archive'").get()
      if (has === undefined) return
      // SQLite 的绑定变量上限通常是 999；分块查，避免一次同步几千行时整段失败。
      for (let i = 0; i < keys.length; i += 400) {
        const chunk = keys.slice(i, i + 400)
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db.prepare(`SELECT tid AS t, payload AS p FROM moments_archive WHERE tid IN (${placeholders})`)
          .all(...chunk) as Array<{ t?: unknown; p?: unknown }>
        for (const r of rows) {
          if (typeof r.t === 'string' && typeof r.p === 'string') out.set(r.t, r.p)
        }
      }
    })
  } catch { /* 读不到就不做合并，按新内容覆盖 */ }
  return out
}

/**
 * 幂等写入一批归档行（`INSERT` 或更新内容/展示名/最后可见时间）。
 *
 * 为什么更新而不是 `INSERT OR IGNORE`：好友还在的帖子会新增评论/点赞，只增不改会把
 * 社交信息永远停在第一次看到的时刻；但「删帖后保留」不需要更新 —— 线上行消失后
 * 根本不会再有输入行，所以更新只发生在「仍存在」的 tid 上。
 * @param decryptedDir - 解密数据根。
 * @param records - 已解析的记录。
 * @returns 新插入/更新条数；库不可写时返回 `{added:0, updated:0}`。
 */
export function upsertArchivedMoments(
  decryptedDir: string,
  records: readonly ArchivedMomentInput[],
): { added: number; updated: number } {
  if (records.length === 0) return { added: 0, updated: 0 }
  const p = momentsArchivePath(decryptedDir)
  try {
    ensureDir(p)
    return withWritableDb(p, (db) => {
      db.exec(DDL)
      const now = Math.floor(Date.now() / 1000)
      const ins = db.prepare(
        'INSERT INTO moments_archive (tid, username, author, ts, month, content, content_hash, payload, archived_at, last_seen_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(tid) DO UPDATE SET ' +
        'username=excluded.username, author=excluded.author, ts=excluded.ts, month=excluded.month, ' +
        'content=excluded.content, content_hash=excluded.content_hash, payload=excluded.payload, ' +
        'last_seen_at=excluded.last_seen_at',
      )
      const exists = db.prepare('SELECT tid AS t FROM moments_archive WHERE tid = ?')
      let added = 0
      let updated = 0
      db.exec('BEGIN')
      try {
        for (const r of records) {
          const had = exists.get(r.tid) !== undefined
          ins.run(r.tid, r.username, r.author, Math.trunc(r.ts), monthOf(r.ts), r.content, r.contentHash, r.payload, now, now)
          if (had) updated += 1
          else added += 1
        }
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错误 */ }
        throw e
      }
      return { added, updated }
    })
  } catch (e) {
    console.warn('[moments-archive] 写入失败：' + (e instanceof Error ? e.message : String(e)))
    return { added: 0, updated: 0 }
  }
}

/**
 * 从归档库读一页朋友圈（按 tid 数值倒序：新动态在前）。
 * @param decryptedDir - 解密数据根。
 * @param opts - 分页与可选作者（username，不是展示名）。
 * @returns 行与总数；归档库不存在时为 `null`（调用方回退线上表）。
 */
export function readArchivedMoments(
  decryptedDir: string,
  opts: { offset: number; limit: number; authorUsername?: string },
): { rows: ArchivedMomentRow[]; total: number } | null {
  const p = momentsArchivePath(decryptedDir)
  if (!existsSync(p)) return null
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moments_archive'").get()
      if (has === undefined) return { rows: [], total: 0 }
      const where = opts.authorUsername ? ' WHERE username = ?' : ''
      const params = opts.authorUsername ? [opts.authorUsername] : []
      const totalRow = db.prepare('SELECT COUNT(*) AS n FROM moments_archive' + where).get(...params) as { n?: number } | undefined
      const rows = db.prepare(
        'SELECT tid, username, author, ts, content, content_hash AS contentHash, payload, ' +
        'archived_at AS archivedAt, last_seen_at AS lastSeenAt FROM moments_archive' + where +
        // tid 在真机是**有符号 64 位整数**（实测大量是 `-3410996087506914705` 这类负数），
        // 不能按文本长度/字典序排 —— `-6…` 会排到 `-3…` 前面，最新动态反而沉底。
        // CAST 回 INTEGER（SQLite 的 64 位整型）才是与线上 `ORDER BY tid DESC` 同口径。
        ' ORDER BY CAST(tid AS INTEGER) DESC LIMIT ? OFFSET ?',
      ).all(...params, Math.max(0, Math.trunc(opts.limit)), Math.max(0, Math.trunc(opts.offset))) as unknown as ArchivedMomentRow[]
      return { rows, total: Math.trunc(Number(totalRow?.n ?? 0)) }
    })
  } catch (e) {
    console.warn('[moments-archive] 读取失败：' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}

/**
 * 全量作者条数（来自归档库）。
 * @param decryptedDir - 解密数据根。
 * @returns 作者 username / 最近展示名 / 条数；归档库不存在时为 `null`。
 */
export function readArchivedAuthors(
  decryptedDir: string,
): Array<{ username: string; author: string; count: number }> | null {
  const p = momentsArchivePath(decryptedDir)
  if (!existsSync(p)) return null
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moments_archive'").get()
      if (has === undefined) return []
      return db.prepare(
        'SELECT m.username AS username, ' +
        '(SELECT author FROM moments_archive m2 WHERE m2.username = m.username ORDER BY m2.last_seen_at DESC LIMIT 1) AS author, ' +
        'COUNT(*) AS count FROM moments_archive m GROUP BY m.username ORDER BY count DESC',
      ).all() as Array<{ username: string; author: string; count: number }>
    })
  } catch {
    return null
  }
}

/**
 * 全量月度分布（来自归档库，含已被删除的帖子）。
 *
 * 展示名可能被改（备注变化），而归档里存的是**归档当时**的名字；所以作者牌过滤
 * 不能直接拿 `author = ?` 去比。传 `names`（当前 contact 名表）时按 username 映射后
 * 在 JS 里过滤，这样「改了备注」和「好友已删」都不会漏/多算。
 * @param decryptedDir - 解密数据根。
 * @param opts - 可选 username / 展示名过滤与当前展示名映射。
 * @returns `YYYY-MM → count`；归档库不存在时为 `null`。
 */
export function readArchivedMonthly(
  decryptedDir: string,
  opts?: { authorUsername?: string; authorName?: string; names?: ReadonlyMap<string, string> },
): Array<{ month: string; count: number }> | null {
  const p = momentsArchivePath(decryptedDir)
  if (!existsSync(p)) return null
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moments_archive'").get()
      if (has === undefined) return []
      const clauses: string[] = ["month <> ''"]
      const params: string[] = []
      if (opts?.authorUsername) { clauses.push('username = ?'); params.push(opts.authorUsername) }
      const where = ' WHERE ' + clauses.join(' AND ')
      const rows = db.prepare(
        'SELECT month AS m, username AS u, author AS a, COUNT(*) AS n FROM moments_archive' + where +
        ' GROUP BY month, username, author ORDER BY month',
      ).all(...params) as Array<{ m?: unknown; u?: unknown; a?: unknown; n?: number }>
      const byMonth = new Map<string, number>()
      for (const r of rows) {
        const month = String(r.m ?? '')
        const username = String(r.u ?? '')
        const author = String(r.a ?? '')
        if (opts?.authorName !== undefined) {
          const display = opts.names?.get(username) ?? author
          if (display !== opts.authorName) continue
        }
        byMonth.set(month, (byMonth.get(month) ?? 0) + Math.trunc(Number(r.n ?? 0)))
      }
      return Array.from(byMonth.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, count]) => ({ month, count }))
    })
  } catch {
    return null
  }
}

/**
 * 归档一张头像（本地已解出的 data URL）。只在数据非空时写入；
 * `name` 也一起快照，好友被删后仍有展示名。
 * @param decryptedDir - 解密数据根。
 * @param username - 微信 username（稳定键，不能用展示名）。
 * @param name - 展示名（可为空）。
 * @param avatar - `data:image/...;base64,...`（可为空）。
 */
export function saveArchivedAvatar(decryptedDir: string, username: string, name: string, avatar: string): void {
  saveArchivedAvatars(decryptedDir, [{ username, name, avatar }])
}

/** 批量归档头像的输入。 */
export interface ArchivedAvatarInput {
  username: string
  name: string
  avatar: string
}

/**
 * 批量归档头像（一个事务，避免一屏 30 个头像开 30 次库）。
 * @param decryptedDir - 解密数据根。
 * @param records - 头像记录；空记录/空 username 的项会被跳过。
 */
export function saveArchivedAvatars(decryptedDir: string, records: readonly ArchivedAvatarInput[]): void {
  const rows = records
    .map((r) => ({ username: r.username.trim(), name: r.name, avatar: r.avatar }))
    .filter((r) => r.username !== '' && (r.name !== '' || r.avatar !== ''))
  if (rows.length === 0) return
  const p = momentsArchivePath(decryptedDir)
  try {
    ensureDir(p)
    withWritableDb(p, (db) => {
      db.exec(DDL)
      const stmt = db.prepare(
        'INSERT INTO moment_profiles (username, name, avatar, updated_at) VALUES (?,?,?,?) ' +
        'ON CONFLICT(username) DO UPDATE SET ' +
        'name = CASE WHEN excluded.name <> \'\' THEN excluded.name ELSE moment_profiles.name END, ' +
        'avatar = CASE WHEN excluded.avatar <> \'\' THEN excluded.avatar ELSE moment_profiles.avatar END, ' +
        'updated_at = excluded.updated_at',
      )
      const now = Math.floor(Date.now() / 1000)
      db.exec('BEGIN')
      try {
        for (const r of rows) stmt.run(r.username, r.name, r.avatar, now)
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错误 */ }
        throw e
      }
    })
  } catch { /* 头像快照尽力而为：失败只影响「好友被删后有没有头像」 */ }
}

/**
 * 读归档头像（好友已删 / 本机 head_image.db 没有时的兜底）。
 * @param decryptedDir - 解密数据根。
 * @param username - 微信 username。
 * @returns data URL；没有归档/没有头像时为 null。
 */
export function readArchivedAvatar(decryptedDir: string, username: string): string | null {
  return readArchivedAvatars(decryptedDir, [username])[username] ?? null
}

/**
 * 批量读归档头像。
 * @param decryptedDir - 解密数据根。
 * @param usernames - 微信 username 列表。
 * @returns username → data URL（只含有头像的项）。
 */
export function readArchivedAvatars(decryptedDir: string, usernames: readonly string[]): Record<string, string> {
  const keys = Array.from(new Set(usernames.map((u) => u.trim()).filter((u) => u !== '')))
  if (keys.length === 0) return {}
  const p = momentsArchivePath(decryptedDir)
  if (!existsSync(p)) return {}
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moment_profiles'").get()
      if (has === undefined) return {}
      const placeholders = keys.map(() => '?').join(',')
      const rows = db.prepare(
        `SELECT username AS u, avatar AS a FROM moment_profiles WHERE username IN (${placeholders}) AND avatar <> ''`,
      ).all(...keys) as Array<{ u?: unknown; a?: unknown }>
      const out: Record<string, string> = {}
      for (const r of rows) {
        if (typeof r.u === 'string' && typeof r.a === 'string' && r.a !== '') out[r.u] = r.a
      }
      return out
    })
  } catch {
    return {}
  }
}

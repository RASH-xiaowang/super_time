/**
 * Files queries over st_control's decrypted hardlink.db (v4 tables).
 * File source chat is resolved best-effort from message_resource.db (packed_info)
 * joined to contact.db display names, so the read-only file grid can show where a
 * media asset came from instead of only a hash name.
 */
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { contactMeta } from './meta.ts'

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

interface FileItem {
  md5: string
  fileName: string
  fileSize: number
  modifyTime: number
  category: string
  /** Source chat display name resolved from message resource, when available. */
  sessionName?: string
  /** Source message create time, when available. */
  sourceTime?: number
  /**
   * 来源月份（第 84 轮新增）：`dir1`/`dir2` → `dir2id` 里 `YYYY-MM` 形态的值。
   * 实测三表 100% 可解析（图片 2717、视频 131、文件 579 全部有值）。
   */
  sourceMonth?: string
  /**
   * 来源会话显示名（第 84 轮新增）：`dir2id` 的值实测是 **md5(username)**
   * （80 个十六进制值里 79 个能反查到 username），据此可直接给出「这张图来自哪个会话」——
   * 与 message_resource 口径的 `sessionName` 独立，且对**视频/文件**同样可用。
   */
  sourceTalker?: string
}

const FILE_TABLES: ReadonlyArray<[string, string]> = [
  ['image_hardlink_info_v4', 'image'],
  ['file_hardlink_info_v4', 'file'],
  ['video_hardlink_info_v4', 'video'],
]

/** Read a byte array from a packed_info cell (object of index->byte, or Uint8Array). */
function packedBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (Array.isArray(v)) return new Uint8Array(v.map(Number))
  if (v && typeof v === 'object') {
    const vals = Object.values(v as Record<string, unknown>)
    if (vals.every(x => typeof x === 'number')) return new Uint8Array(vals.map(Number))
  }
  return new Uint8Array(0)
}

/** Extract a 32-char lowercase hex file key from packed_info. */
function fileKeyFromPacked(packed: unknown): string | null {
  const latin = Buffer.from(packedBytes(packed)).toString('latin1')
  const m = /[0-9a-f]{32}/.exec(latin)
  return m ? m[0] : null
}

/**
 * Best-effort map from file key to { source session display name, create time }.
 * Joins MessageResourceInfo.packed_info (file key) -> chat_id -> contact name.
 * @param decryptedDir - decrypted data root.
 * @returns map keyed by the stripped file name.
 */
function loadFileSources(decryptedDir: string): Map<string, { session: string; time: number }> {
  const map = new Map<string, { session: string; time: number }>()
  let resDb: DatabaseSync | null = null
  try { resDb = new DatabaseSync(join(decryptedDir, 'message', 'message_resource.db'), { readOnly: true }) } catch { return map }
  try {
    const chatMap = new Map<number, string>()
    const chatRows = resDb.prepare('SELECT rowid, user_name FROM ChatName2Id').all() as Array<Record<string, unknown>>
    for (const r of chatRows) chatMap.set(Number(r.rowid), cellStr(r.user_name))

    const nameMap = contactMeta(decryptedDir).names

    const infos = resDb.prepare('SELECT chat_id, message_create_time, packed_info FROM MessageResourceInfo ORDER BY message_create_time DESC LIMIT 3000').all() as Array<Record<string, unknown>>
    for (const row of infos) {
      const key = fileKeyFromPacked(row.packed_info)
      if (!key || map.has(key)) continue
      const user = chatMap.get(Number(row.chat_id)) ?? ''
      map.set(key, { session: nameMap.get(user) || user, time: Number(row.message_create_time) || 0 })
    }
  } catch {
    // source resolution is best-effort; absence is not an error.
  } finally {
    resDb.close()
  }
  return map
}

/** 文件来源映射的缓存（30s TTL，按 message_resource.db 签名失效）。 */
const FILE_SOURCES_TTL_MS = 30_000
let fileSourcesCache: { sig: string; at: number; map: Map<string, { session: string; time: number }> } | null = null

function fileSourcesSig(decryptedDir: string): string {
  try {
    const st = statSync(join(decryptedDir, 'message', 'message_resource.db'))
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function fileSourcesCached(decryptedDir: string): Map<string, { session: string; time: number }> {
  const sig = fileSourcesSig(decryptedDir)
  if (fileSourcesCache && fileSourcesCache.sig === sig && Date.now() - fileSourcesCache.at < FILE_SOURCES_TTL_MS) {
    return fileSourcesCache.map
  }
  const map = loadFileSources(decryptedDir)
  fileSourcesCache = { sig, at: Date.now(), map }
  return map
}

/**
 * 附件目录 → 来源。实测（本机 hardlink.db）：
 *   · `dir2id` 共 88 行，值是 8 个月份串（`2026-02`…`2026-09`）与 80 个 32 位十六进制串；
 *   · 那 80 个十六进制串里 **79 个等于 md5(某个 username)**（2011 个 username 反查），
 *     即微信用 `md5(talker)` 给附件目录命名；
 *   · 图片表 2717 行的 `dir1` 全是 talker 哈希、`dir2` 是月份；
 *     文件 579 / 视频 131 行则 `dir1` 是月份、`dir2`=0。
 * 于是仅凭 `dir1`/`dir2` + `dir2id` 就能给出**每一行**的来源月份，以及图片的来源会话 ——
 * 与 message_resource 口径（`sessionName`）互为独立来源。
 * @param decryptedDir - decrypted data root.
 * @returns rowid → 月份 / rowid → 会话显示名。
 */
const DIR_SOURCE_TTL_MS = 30_000
let dirSourceCache: { sig: string; at: number; month: Map<number, string>; talker: Map<number, string> } | null = null

function dirSourceCached(decryptedDir: string): { month: Map<number, string>; talker: Map<number, string> } {
  let sig = ''
  try {
    const st = statSync(join(decryptedDir, 'hardlink', 'hardlink.db'))
    sig = `${st.mtimeMs}:${st.size}`
  } catch { /* sig 为空时每次都重算 */ }
  if (dirSourceCache && sig !== '' && dirSourceCache.sig === sig && Date.now() - dirSourceCache.at < DIR_SOURCE_TTL_MS) {
    return dirSourceCache
  }
  const month = new Map<number, string>()
  const talker = new Map<number, string>()
  try {
    const db = new DatabaseSync(join(decryptedDir, 'hardlink', 'hardlink.db'), { readOnly: true })
    try {
      const names = contactMeta(decryptedDir).names
      const md5ToName = new Map<string, string>()
      for (const [user, display] of names) {
        if (!user) continue
        const h = createHash('md5').update(user, 'utf8').digest('hex')
        if (!md5ToName.has(h)) md5ToName.set(h, display || user)
      }
      const rows = db.prepare('SELECT rowid AS rid, username FROM dir2id').all() as Array<{ rid?: number; username?: unknown }>
      for (const r of rows) {
        const rid = Number(r.rid)
        const v = cellStr(r.username)
        if (!rid || !v) continue
        if (/^\d{4}-\d{2}$/.test(v)) { month.set(rid, v); continue }
        if (/^[0-9a-f]{32}$/i.test(v)) {
          // 与既有 sessionName 口径一致：没有显示名时退回 username 本身
          const name = md5ToName.get(v.toLowerCase())
          if (name) talker.set(rid, name)
        }
      }    } finally {
      db.close()
    }
  } catch { /* 来源解析是 best-effort，缺失不算错误 */ }
  dirSourceCache = { sig, at: Date.now(), month, talker }
  return dirSourceCache
}

/**
 * Read resource files.
 *
 * 第 83 轮重写：原先按「每张表各取 cap 行 → 拼接 → 再 slice(offset, offset+limit)」做分页，
 * 这不是分页 —— 第 2 页拿到的是「拼接后第 30~60 行」，即**另一张表的前 30 行**，
 * 于是客户端翻页会跨类目跳、并且永远翻不到第三张表（图片 2717 行 > 任何一页的容量）。
 * 实测后果：「文件资产」页签只显示图片（2717），视频 131 与文件 579 **全库都打不开**。
 *
 * 现在改为一条 `UNION ALL` + 全局 `ORDER BY modify_time DESC LIMIT ? OFFSET ?`：
 * 分页跨类目按时间正确排序、也不会重叠；并新增 `category` 过滤与 `counts` 分类计数，
 * 让界面能给出「全部 / 图片 / 视频 / 文件」四个带真实条目的入口。
 *
 * @param decryptedDir - decrypted data root.
 * @param limit - page size (default 100).
 * @param offset - page offset (default 0).
 * @param category - optional category filter: 'image' | 'file' | 'video' (其它值/空 = 全部).
 * @returns the files snapshot: page rows, the filtered total and per-category counts.
 */
export function queryFiles(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  category?: string,
): { files: FileItem[]; total: number; counts: Record<string, number> } {
  const db = new DatabaseSync(join(decryptedDir, 'hardlink', 'hardlink.db'), { readOnly: true })
  try {
    const want = category && category !== 'all' ? category : ''
    const parts: string[] = []
    const counts: Record<string, number> = {}
    let total = 0
    for (const [table, cat] of FILE_TABLES) {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!has) { counts[cat] = 0; continue }
      let n = 0
      try { n = (db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n } catch { n = 0 }
      counts[cat] = n
      if (want !== '' && cat !== want) continue
      total += n
      const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name))
      const sel = (c: string, dft: string) => (cols.has(c) ? c : dft)
      parts.push([
        'SELECT',
        [
          sel('md5', "''") + ' AS md5',
          sel('file_name', "''") + ' AS file_name',
          sel('file_size', '0') + ' AS file_size',
          sel('modify_time', '_rowid_') + ' AS modify_time',
          sel('dir1', '0') + ' AS dir1',
          sel('dir2', '0') + ' AS dir2',
          `'${cat}' AS category`,
        ].join(', '),
        'FROM', table,
      ].join(' '))
    }

    const size = limit === undefined ? 100 : Math.max(0, limit)
    const page = Math.max(0, offset)
    const files: FileItem[] = []
    if (parts.length > 0) {
      try {
        const sql = `SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY modify_time DESC LIMIT ? OFFSET ?`
        const rows = db.prepare(sql).all(size, page) as Array<Record<string, unknown>>
        const dirSource = dirSourceCached(decryptedDir)
        for (const r of rows) {
          const dir1 = Number(r.dir1 ?? 0)
          const dir2 = Number(r.dir2 ?? 0)
          // dir1/dir2 哪一层是月份、哪一层是 talker 哈希随表而异（见 dirSourceCached 注释），
          // 所以两层都试，取能解析出来的那个。
          const item: FileItem = {
            md5: cellStr(r.md5 ?? ''),
            fileName: cellStr(r.file_name ?? ''),
            fileSize: Number(r.file_size ?? 0),
            modifyTime: Number(r.modify_time ?? 0),
            category: cellStr(r.category ?? ''),
            sourceMonth: dirSource.month.get(dir1) ?? dirSource.month.get(dir2),
            sourceTalker: dirSource.talker.get(dir1) ?? dirSource.talker.get(dir2),
          }
          files.push(item)
        }
      } catch { /* 保持空页：与旧实现的「跳过该表」一致，不抛给界面 */ }
    }

    const sources = fileSourcesCached(decryptedDir)
    for (const f of files) {
      const key = f.fileName.replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '')
      const src = sources.get(key)
      if (src) {
        f.sessionName = src.session
        f.sourceTime = src.time
      }
    }
    return { files, total, counts }
  } finally {
    db.close()
  }
}

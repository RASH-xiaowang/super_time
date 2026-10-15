/**
 * 撤回消息**原文归档**（2026-09-29 用户："撤回的原文消息要一直保留，不让用户撤回成功"）。
 *
 * ## 为什么需要它
 *
 * 现在「撤回消息」面板的数据来自一张**第三方反撤回插件**留在微信库里的缓存表
 * （`*_weflow_anti_revoke_deleted_cache`，见 `records.ts` 的 `findRevokeTable`）——
 * 我们只是**读它、自己什么都不留**。后果：那张缓存一旦被插件清理、轮转、或用户换机/重装，
 * **原文就永久消失**，"撤回"对使用者而言就等于成功了。
 *
 * ## 做法
 *
 * 每次读取撤回列表时，先把插件缓存里的记录**幂等导入我们自己的库**
 * （`<数据根>/anti-revoke-archive.db`），再从**我们的库**出列表。于是：
 *   · 只要被我们看见过一次，原文就**永久保留**（插件缓存清掉也不影响）；
 *   · 写入是 `INSERT OR IGNORE` + 复合主键去重 ⇒ **只增不改**，重复导入不会覆盖原文；
 *   · 归档库与插件解耦：将来插件不在、缓存被清，历史原文仍然可查。
 *
 * ## 边界（有意为之）
 *
 * · **只归档、不推断**：存的 `content` 就是插件缓存里那一列原文（含首行发送者），
 *   解析仍交给 `records.ts` 的 `parseRevokeContent`，避免两处各自解释格式。
 * · **失败不致命**：归档是"尽力而为"，读不到/写不进时静默降级为"直接读插件缓存"，
 *   绝不让归档把撤回列表本身搞挂。
 * · 连接纪律：一律走 `withDb` / `withWritableDb`（见 `query-db-lifetime.spec.ts`）。
 *
 * @module query/anti-revoke-archive
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from './db-open.ts'
import { withDb, withWritableDb } from './db-open.ts'

/** 归档库路径：数据根下、与 `decoded_images` 同级（不进解密目录，避免被同步覆盖）。 */
export function revokeArchivePath(decryptedDir: string): string {
  return join(decryptedDir, '..', 'anti-revoke-archive.db')
}

/** 归档表结构（首次使用时建）。 */
const ARCHIVE_DDL = [
  'CREATE TABLE IF NOT EXISTS revoked_archive (',
  '  ct INTEGER NOT NULL,',
  '  rid INTEGER NOT NULL,',
  '  kind INTEGER NOT NULL,',
  '  content TEXT NOT NULL,',
  '  archived_at INTEGER NOT NULL,',
  '  PRIMARY KEY (ct, rid, kind, content)',
  ')',
].join('\n')

const ARCHIVE_INDEX_DDL = 'CREATE INDEX IF NOT EXISTS idx_revoked_archive_ct ON revoked_archive(ct DESC)'

/** 打开（必要时创建）归档库。 */
function openArchive(decryptedDir: string): string {
  const p = revokeArchivePath(decryptedDir)
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return p
}

/**
 * 读一列（缺失时给默认值）——与 `records.ts` 里同款防御：插件表各版本列名不一致。
 * @param cols - 该表实际拥有的列名集合。
 * @param cand - 期望的列名。
 * @param dft - 缺失时的默认值（SQL 片段）。
 * @returns 可安全拼进 SQL 的列引用。
 */
function pick (cols: Set<string>, cand: string, dft: string): string {
  return cols.has(cand) ? cand : dft
}

/**
 * 把插件缓存里的撤回记录**幂等归档**到我们自己的库。
 *
 * @param decryptedDir - 解密数据根。
 * @param srcFile - 插件缓存所在的库文件。
 * @param srcTable - 插件缓存表名。
 * @returns 本次新归档的条数（已存在的不会重复计数）。
 */
export function archiveRevokeCache(decryptedDir: string, srcFile: string, srcTable: string): number {
  if (!srcFile || !srcTable || !existsSync(srcFile)) return 0
  const rows = withDb(srcFile, (db) => {
    const cols = new Set((db.prepare(`PRAGMA table_info(${srcTable})`).all() as Array<{ name: string }>).map((r) => r.name))
    const sql = `SELECT ${pick(cols, 'create_time', '0')} AS ct, ${pick(cols, 'real_sender_id', '0')} AS rid, ` +
      `${pick(cols, 'local_type', '0')} AS lt, ${pick(cols, 'message_content', "''")} AS mc FROM ${srcTable}`
    return db.prepare(sql).all() as Array<{ ct?: number; rid?: number; lt?: number; mc?: string | Uint8Array | null }>
  })

  const archive = openArchive(decryptedDir)
  return withWritableDb(archive, (db) => {
    db.exec(ARCHIVE_DDL)
    db.exec(ARCHIVE_INDEX_DDL)
    const ins = db.prepare('INSERT OR IGNORE INTO revoked_archive (ct, rid, kind, content, archived_at) VALUES (?,?,?,?,?)')
    const now = Math.floor(Date.now() / 1000)
    let added = 0
    db.exec('BEGIN')
    try {
      for (const r of rows) {
        const content = r.mc == null ? '' : (typeof r.mc === 'string' ? r.mc : new TextDecoder('utf-8', { fatal: false }).decode(r.mc))
        if (content === '') continue
        const res = ins.run(Math.trunc(Number(r.ct ?? 0)), Math.trunc(Number(r.rid ?? 0)), Math.trunc(Number(r.lt ?? 0)), content, now)
        added += Number((res as { changes?: number }).changes ?? 0)
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错误 */ }
      throw e
    }
    return added
  })
}

/**
 * 从**我们自己的归档库**读撤回记录（形状与插件缓存一致，交给上层同一套解析）。
 *
 * @param decryptedDir - 解密数据根。
 * @param limit - 上限（已由调用方裁剪）。
 * @param offset - 偏移。
 * @param q - 关键词（匹配原文或发送者 id）。
 * @returns 记录与总数；归档库不存在时返回空。
 */
export function readArchivedRevoke (
  decryptedDir: string,
  limit: number,
  offset: number,
  q?: string,
): { rows: Array<{ lt?: number; rid?: number; ct?: number; mc?: string | Uint8Array | null }>; total: number } {
  const p = revokeArchivePath(decryptedDir)
  if (!existsSync(p)) return { rows: [], total: 0 }
  const kw = (q ?? '').trim()
  const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
  return withDb(p, (db: DatabaseSync) => {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revoked_archive'").get()
    if (has === undefined) return { rows: [], total: 0 }
    const where = kw ? " WHERE content LIKE ? ESCAPE '\\' OR CAST(rid AS TEXT) LIKE ? ESCAPE '\\'" : ''
    const params: Array<string | number> = kw ? [like, like] : []
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM revoked_archive' + where).get(...params) as { n?: number } | undefined
    const rows = db.prepare('SELECT kind AS lt, rid, ct, content AS mc FROM revoked_archive' + where + ' ORDER BY ct DESC LIMIT ? OFFSET ?')
      .all(...params, limit, offset) as Array<{ lt?: number; rid?: number; ct?: number; mc?: string | Uint8Array | null }>
    return { rows, total: Math.trunc(Number(totalRow?.n ?? 0)) }
  })
}

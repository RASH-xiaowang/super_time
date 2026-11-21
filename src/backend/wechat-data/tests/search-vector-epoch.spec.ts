// @vitest-environment node
/**
 * 「重建搜索索引 ⇒ 消息域向量必须作废」（2026-11-19 修）。
 *
 * ## 这是一个静默错答的洞
 *
 * `message_meta` 全量重建时被 DROP 再建，`rowid` 从 1 重新分配；而消息域向量表
 * （`wechat_rag_vectors.db` 的 `vectors`）以 `fts_rowid` 为主键：
 *
 * ```
 * 重建前：rowid 42 → 消息 A   向量(42) = embed(A)
 * 重建后：rowid 42 → 消息 B   向量(42) 仍是 embed(A)
 * ```
 *
 * `searchDense` 用 `JOIN message_meta ON rowid` 取正文、用向量算分数，于是返回
 * **分数正常但内容不是它**的消息。这比"搜不到"更糟：用户无法自证，还会污染引用与总结。
 *
 * 守两件事：
 * 1. 重建完成后向量表必须消失（`resetMessageVectorIndex` 被接线）；
 * 2. 即使作废失败，构建向量时也会按 `src_epoch` 整份重算（兜底）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vectorDbPath } from '../src/query/retrieval/embedding.ts'
import { resetMessageVectorIndex } from '../src/query/retrieval/vector-reset.ts'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vec-reset-'))
  mkdirSync(join(root, 'decrypted'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 造一份「已建好」的向量库（表结构照 `openVectorDb` 的 DDL）。 */
function makeVectorDb(decryptedDir: string): void {
  const db = new DatabaseSync(vectorDbPath(decryptedDir))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS vectors ('
      + 'fts_rowid INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, username TEXT NOT NULL, '
      + 'local_id INTEGER NOT NULL, create_time INTEGER NOT NULL, dim INTEGER NOT NULL, '
      + 'vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL)')
    const ins = db.prepare('INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?)')
    for (const rid of [1, 2, 3]) ins.run(rid, 'u:' + String(rid), 'u', rid, 1, 4, Buffer.alloc(16), 7, 9)
    const m = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
    const metaRows: Array<[string, string]> = [
      ['rows', '3'], ['dim', '4'], ['schema_version', '1'], ['model', 'bge-m3'], ['src_epoch', 'old-epoch'],
    ]
    for (const [k, v] of metaRows) m.run(k, v)
  } finally { db.close() }
}

/** 读向量库里的表名与 meta 键。 */
function inspect(decryptedDir: string): { tables: string[]; metaKeys: string[] } {
  const db = new DatabaseSync(vectorDbPath(decryptedDir), { readOnly: true })
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => String(r.name))
    let metaKeys: string[] = []
    try {
      metaKeys = (db.prepare('SELECT key FROM meta').all() as Array<{ key: string }>).map(r => String(r.key))
    } catch { /* meta 不存在 */ }
    return { tables, metaKeys }
  } finally { db.close() }
}

describe('resetMessageVectorIndex：作废必须彻底', () => {
  it('删掉 vectors 表与全部 meta（含 src_epoch，否则会以为还是同代）', () => {
    const decrypted = join(root, 'decrypted')
    makeVectorDb(decrypted)
    expect(inspect(decrypted).tables).toContain('vectors')
    expect(inspect(decrypted).metaKeys).toContain('src_epoch')

    expect(resetMessageVectorIndex(decrypted)).toBe(true)

    const after = inspect(decrypted)
    expect(after.tables).not.toContain('vectors')
    expect(after.metaKeys, 'meta 没清干净 ⇒ 读侧会继续认为同代且就绪').toEqual([])
  })

  it('向量库本来不存在：视为成功（幂等，不抛错）', () => {
    expect(resetMessageVectorIndex(join(root, 'decrypted'))).toBe(true)
  })

  it('作废之后状态必然「未就绪」而不是「3 行就绪」', async () => {
    const decrypted = join(root, 'decrypted')
    makeVectorDb(decrypted)
    resetMessageVectorIndex(decrypted)
    const { vectorIndexStatus } = await import('../src/query/retrieval/embedding.ts')
    const st = vectorIndexStatus(decrypted)
    expect(st.ready, '作废后仍报就绪 ⇒ 下次提问不会重建，且会拿空表检索').toBe(false)
  })
})

describe('接线：重建搜索索引时必须调用作废', () => {
  it('search-build.ts 在 COMMIT 之后调用 resetMessageVectorIndex', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'src', 'query', 'search-build.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const commitAt = code.indexOf("insKv.run(REFRESHED_KEY, String(Date.now()))")
    const resetAt = code.indexOf('resetMessageVectorIndex(decryptedDir)')
    const resultAt = code.indexOf('const result: BuildResult')
    expect(commitAt, '找不到全量重建的提交点').toBeGreaterThan(-1)
    expect(resetAt, '重建路径没有作废向量（会静默错答）').toBeGreaterThan(-1)
    // 必须在 COMMIT 之后（跨库无事务，索引本身不能因作废失败而回滚），且在返回结果之前。
    expect(resetAt).toBeGreaterThan(commitAt)
    expect(resetAt).toBeLessThan(resultAt)
  })

  it('作废失败不许让重建整体失败（best-effort）', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'src', 'query', 'search-build.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const at = code.indexOf('resetMessageVectorIndex(decryptedDir)')
    const window = code.slice(Math.max(0, at - 200), at + 200)
    expect(window, '作废没有 try/catch：向量库被占用时会把重建一起搞挂').toContain('try')
  })
})

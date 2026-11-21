// @vitest-environment node
/**
 * 消息域向量索引的**溯源守卫**（2026-11-20）。
 *
 * ## 守的是一个躺了两个月的静默错配
 *
 * 真机发现：`wechat_rag_vectors.db` 里 80,000 行的 `meta.model` 是 `'default'`、
 * `meta.dim` 是 **64**，建于 2026-09-15。而当前嵌入模型（`Qwen3-VL-Embedding-8B`）
 * 是 **4096** 维。
 *
 * 旧判据 `ready: rows > 0 && dim > 0 && schema 版本对` 对它**报了整整两个月的就绪**。
 * 危害不是"少召回"而是"错召回"：`dotProduct` 按 `min(len)` 截断，4096 维查询只会与
 * 这 64 维向量的前 64 个分量做点积 —— 分数看似正常、语义是随机的。
 *
 * `'default'` 是本项目历史上「记账名没跟发送名对齐」时写死的占位值（§7 F1），
 * 空串同理。两者都等于"不知道这份向量是谁算的"，只能按不可用处理并触发重建。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vectorDbPath, vectorIndexStatus } from '../src/query/retrieval/embedding.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vec-trace-'))
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* 占用时留待系统清理 */ }
})

/** 造一份指定 meta 的向量库（表结构照 `openVectorDb` 的 DDL）。 */
function makeVectorDb(meta: Record<string, string>, rows: number, dim: number): void {
  const db = new DatabaseSync(vectorDbPath(decrypted))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS vectors ('
      + 'fts_rowid INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, username TEXT NOT NULL, '
      + 'local_id INTEGER NOT NULL, create_time INTEGER NOT NULL, dim INTEGER NOT NULL, '
      + 'vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL)')
    const ins = db.prepare('INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?)')
    for (let i = 1; i <= rows; i += 1) {
      ins.run(i, 'u:' + String(i), 'u', i, 1, dim, Buffer.alloc(dim * 4), i, i)
    }
    const m = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
    for (const [k, v] of Object.entries(meta)) m.run(k, v)
  } finally { db.close() }
}

const BASE_META = { rows: '3', dim: '4', schema_version: '1', built_at: '2026-09-15 08:30:39' }

describe('消息域向量：没有模型溯源的索引不算就绪', () => {
  it(`meta.model = 'default'（真机实测的形态）⇒ ready=false`, () => {
    makeVectorDb({ ...BASE_META, model: 'default' }, 3, 4)
    const st = vectorIndexStatus(decrypted)
    expect(st.model).toBe('default')
    expect(st.ready, "'default' 是占位值，不知道这份向量是谁算的").toBe(false)
  })

  it('meta.model 为空 ⇒ ready=false', () => {
    makeVectorDb(BASE_META, 3, 4)
    const st = vectorIndexStatus(decrypted)
    expect(st.model).toBe('')
    expect(st.ready).toBe(false)
  })

  it('记了真实模型名 ⇒ ready=true（不误伤正常索引）', () => {
    makeVectorDb({ ...BASE_META, model: 'Qwen/Qwen3-VL-Embedding-8B' }, 3, 4)
    const st = vectorIndexStatus(decrypted)
    expect(st.ready).toBe(true)
  })

  it('维度为 0 ⇒ 仍未就绪（原有判据不许被放宽）', () => {
    makeVectorDb({ ...BASE_META, model: 'm', dim: '0' }, 3, 4)
    expect(vectorIndexStatus(decrypted).ready).toBe(false)
  })

  it('行数为 0 ⇒ 仍未就绪', () => {
    makeVectorDb({ ...BASE_META, rows: '0', model: 'm' }, 0, 4)
    expect(vectorIndexStatus(decrypted).ready).toBe(false)
  })

  it('结构版本不符 ⇒ 仍未就绪', () => {
    makeVectorDb({ ...BASE_META, schema_version: '0', model: 'm' }, 3, 4)
    expect(vectorIndexStatus(decrypted).ready).toBe(false)
  })

  it('只建了一部分（rows < expected）⇒ 未就绪（真机实测过「建 2 万就报就绪」）', () => {
    // 构建受 maxDocsPerBuild 截断；不判覆盖度的话剩下 20 多万条永远不会再补。
    makeVectorDb({ ...BASE_META, model: 'm', expected: '100' }, 3, 4)
    expect(vectorIndexStatus(decrypted).ready).toBe(false)
  })

  it('rows >= expected ⇒ 就绪（不误伤已建全的库）', () => {
    makeVectorDb({ ...BASE_META, model: 'm', expected: '3' }, 3, 4)
    expect(vectorIndexStatus(decrypted).ready).toBe(true)
  })
})

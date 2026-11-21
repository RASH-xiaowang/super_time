// @vitest-environment node
/**
 * 「分块截断策略变更 ⇒ 索引用完整正文重算」（2026-11-20）。
 *
 * ## 为什么这条值得单独一个文件
 *
 * 真机实测：5,143 个分块**全部**超过 200 字（中位数 489、最大 500），而当时的
 * 向量只用了每块前 `maxCharsPerDoc = 200` 字 —— **约 148 万字正文对语义检索不可见**。
 * 这是「关键词搜得到、换个说法搜不到」的直接来源，但界面上一切正常（`rows` 对得上、
 * 模型对得上），所以是个**静默的质量损失**。
 *
 * 光改取值只影响今后的构建；既有向量必须能被判定为 stale 并整份重算。守三件事：
 * 1. 状态判定：meta 里 `max_chars` 与当前策略不等（含老库没这个键）⇒ `truncation-changed`；
 * 2. 构建行为：判定 stale 之后必须**整库重算**，不能因为「这些块已存在」就跳过；
 * 3. 自动索引会接手（不需要用户点按钮）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHUNK_MAX_CHARS } from '../src/query/kb/chunk.ts'
import { buildKbVectorIndex, kbVectorIndexStatus } from '../src/query/kb-vectors.ts'
import { kbEmbedChars } from '../src/query/kb-vectors-status.ts'
import { kbFilesDbPath, kbVectorsDbPath } from '../src/query/kb-paths.ts'
import type { EmbedFn } from '../src/query/vector-math.ts'

const MODEL = 'test-embed'
let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-trunc-'))
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* Windows 上可能被占用 */ }
})

/** 造文件库：`chunks` 个块，每块 `len` 字。**块内容各不相同**（否则 embedding 会按文本去重）。 */
function makeFilesDb(kbId: number, chunks: number, len: number): void {
  mkdirSync(join(decrypted), { recursive: true })
  const db = new DatabaseSync(kbFilesDbPath(decrypted))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS kb_files (id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id INTEGER NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, src_path TEXT NOT NULL, blob_path TEXT NOT NULL, parse_state TEXT NOT NULL, parser TEXT NOT NULL DEFAULT \'\', parse_error TEXT NOT NULL DEFAULT \'\', chunk_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0, include_in_rag INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS kb_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id INTEGER NOT NULL, file_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, page INTEGER NOT NULL DEFAULT 0, heading TEXT NOT NULL DEFAULT \'\', text TEXT NOT NULL)')
    db.prepare("INSERT INTO kb_files(kb_id,name,ext,size_bytes,sha256,src_path,blob_path,parse_state,include_in_rag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1,1)")
      .run(kbId, 'a.txt', 'txt', 10, 'h', '/a.txt', '/b', 'ready')
    const ic = db.prepare('INSERT INTO kb_chunks(kb_id,file_id,ordinal,text) VALUES(?,1,?,?)')
    for (let i = 0; i < chunks; i += 1) {
      // 前缀唯一 ⇒ 每块是不同文本，不会被 embedding 的「同文本去重」合并。
      ic.run(kbId, i, String(i) + '-' + 'x'.repeat(Math.max(0, len - 2)))
    }
  } finally { db.close() }
}

/** 简单确定性 embed：只记「喂进来多长的文本」，用来证明截断生效与否。 */
function makeEmbed(): { fn: EmbedFn; seenChars: number[] } {
  const seenChars: number[] = []
  const fn = (async (texts: string[]) => {
    for (const t of texts) seenChars.push(t.length)
    return texts.map(() => [1, 0, 0, 0])
  }) as unknown as EmbedFn
  return { fn, seenChars }
}

const buildOpts = (maxCharsPerDoc: number): Parameters<typeof buildKbVectorIndex>[3] => ({
  model: MODEL,
  batchSize: 16,
  maxCharsPerDoc,
  maxDocsPerBuild: 100_000,
})

describe('kbEmbedChars：分块不能被历史默认值截断', () => {
  it('始终返回分块上限（与 maxCharsPerDoc 无关）', () => {
    expect(kbEmbedChars()).toBe(CHUNK_MAX_CHARS)
  })

  it('分块上限就是 500（保证这条断言本身有意义）', () => {
    expect(CHUNK_MAX_CHARS).toBe(500)
  })
})

describe('构建时整块参与向量', () => {
  it('500 字的分块喂给 embedding 的是完整 500 字（不是 200）', async () => {
    makeFilesDb(1, 3, CHUNK_MAX_CHARS)
    const { fn, seenChars } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, buildOpts(200))
    expect(Math.max(...seenChars), '仍被 200 截断 ⇒ 每块六成正文对语义检索不可见').toBe(CHUNK_MAX_CHARS)
  })
})

describe('状态判定：截断策略变了要整份重算', () => {
  it('老库没记 max_chars ⇒ 判 truncation-changed（它一定是旧策略建的）', async () => {
    makeFilesDb(1, 3, CHUNK_MAX_CHARS)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, buildOpts(200))
    // 模拟改前建的库：把策略记录删掉
    const db = new DatabaseSync(kbVectorsDbPath(decrypted))
    try { db.exec("DELETE FROM meta WHERE key = 'max_chars'") } finally { db.close() }
    const st = kbVectorIndexStatus(decrypted, 1, MODEL)
    expect(st.staleReason).toBe('truncation-changed')
    expect(st.ready, '被截断过的索引不能算就绪').toBe(false)
  })

  it('记录了当前策略 ⇒ 判就绪（不误重建）', async () => {
    makeFilesDb(1, 3, CHUNK_MAX_CHARS)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, buildOpts(200))
    const st = kbVectorIndexStatus(decrypted, 1, MODEL)
    expect(st.staleReason).toBe('')
    expect(st.ready).toBe(true)
  })

  it('策略变化后构建会**重算全部块**（不能因为块已存在就跳过）', async () => {
    makeFilesDb(1, 4, CHUNK_MAX_CHARS)
    const first = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, first.fn, buildOpts(200))
    expect(first.seenChars).toHaveLength(4)

    // 把策略记录改成一个不同的值，模拟"这批向量是旧策略的产物"
    const db = new DatabaseSync(kbVectorsDbPath(decrypted))
    try { db.prepare("UPDATE meta SET value = ? WHERE key = 'max_chars'").run('200') } finally { db.close() }

    const second = makeEmbed()
    const r = await buildKbVectorIndex(decrypted, 1, second.fn, buildOpts(200))
    expect(r.status, '应该真的重算，而不是报 up-to-date').toBe('ok')
    expect(r.embedded, '4 块都该重算').toBe(4)
    expect(second.seenChars, '重算时喂的仍是完整正文').toHaveLength(4)
  })
})

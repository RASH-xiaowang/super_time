// @vitest-environment node
/**
 * 知识库**自动语义索引**的判定契约（2026-11-20）。
 *
 * ## 守的是什么
 *
 * 改前「语义索引」是手动按钮：不点它，向量库为空，`searchKbDense` 拿不到候选 ——
 * 用户体感就是「换个说法就搜不到」。现在改成导入后自动触发。
 *
 * 这一族最怕的不是"不触发"，而是**误触发**：
 * · 没配向量模型却在后台狂调 embedding（每次失败都写一条操作日志，界面永远在报错）；
 * · 每次翻页/重进面板都重建一遍（几万块重新出网）。
 *
 * 所以判据集中在 `shouldAutoIndex` 的三个条件上：模型可用、索引不完整、不在节流窗内。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  afterKbFilesAdded,
  AUTO_INDEX_MIN_GAP_MS,
  resetAutoIndexThrottle,
  scheduleKbAutoIndex,
  shouldAutoIndex,
} from '../src/remotes/kb-auto-index.ts'
import { kbFilesDbPath, kbVectorsDbPath } from '../src/query/kb-paths.ts'
import { CHUNK_MAX_CHARS } from '../src/query/kb/chunk.ts'
import type { EmbedFn } from '../src/query/vector-math.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-auto-'))
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  resetAutoIndexThrottle()
})
afterEach(async () => {
  /*
   * 后台构建可能仍在飞（它持有 db 文件），Windows 上直接删会 `EPERM`。
   * 先等一拍再带重试删；删不掉也不该让用例红 —— 那与本次判据无关。
   */
  await new Promise(r => setTimeout(r, 50))
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* 临时目录清不掉不影响判据 */ }
})

/** 造一份**已就绪且覆盖完整**的向量库（这样默认不该再建）。 */
function makeReadyVectorDb(kbId: number, model: string, rows = 3, expected = 3): void {
  const p = kbVectorsDbPath(decrypted)
  const db = new DatabaseSync(p)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS kb_vectors ('
      + 'chunk_id INTEGER PRIMARY KEY, kb_id INTEGER NOT NULL, file_id INTEGER NOT NULL, '
      + 'dim INTEGER NOT NULL, vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL, model TEXT NOT NULL)')
    const ins = db.prepare('INSERT OR REPLACE INTO kb_vectors VALUES (?,?,?,?,?,?,?,?)')
    for (let i = 1; i <= rows; i += 1) ins.run(i, kbId, 1, 4, Buffer.alloc(16), i, i, model)
    const m = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
    /*
     * `max_chars` 必须写成**当前策略值**，否则会被判 `truncation-changed` 而要求重建 ——
     * 这正是 2026-11-20 新增的判据：没记这个键的老库一律重算（它们只嵌了前 200 字）。
     */
    const metaRows: Array<[string, string]> = [
      ['rows', String(rows)], ['dim', '4'], ['schema_version', '1'], ['model', model],
      ['expected', String(expected)], ['max_chars', String(CHUNK_MAX_CHARS)],
    ]
    for (const [k, v] of metaRows) m.run(k, v)
  } finally { db.close() }
}

/** 造一个文件库（`kbVectorIndexStatus` 的指纹与 expected 都依赖它）。 */
function makeFilesDb(kbId: number, chunks: number): void {
  const p = kbFilesDbPath(decrypted)
  const db = new DatabaseSync(p)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS kb_files (id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id INTEGER NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, src_path TEXT NOT NULL, blob_path TEXT NOT NULL, parse_state TEXT NOT NULL, parser TEXT NOT NULL DEFAULT \'\', parse_error TEXT NOT NULL DEFAULT \'\', chunk_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0, include_in_rag INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS kb_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id INTEGER NOT NULL, file_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, page INTEGER NOT NULL DEFAULT 0, heading TEXT NOT NULL DEFAULT \'\', text TEXT NOT NULL)')
    db.prepare("INSERT INTO kb_files(kb_id,name,ext,size_bytes,sha256,src_path,blob_path,parse_state,include_in_rag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1,1)")
      .run(kbId, 'a.txt', 'txt', 10, 'h', '/a.txt', '/b', 'ready')
    const ic = db.prepare('INSERT INTO kb_chunks(kb_id,file_id,ordinal,text) VALUES(?,1,?,?)')
    for (let i = 0; i < chunks; i += 1) ic.run(kbId, i, 'x'.repeat(10))
  } finally { db.close() }
}

/** 最小 `KbRemoteCtx`：只实现 `shouldAutoIndex` / `scheduleKbAutoIndex` 用到的部分。 */
function makeRc(opts: { model?: string; embeddable?: boolean }): {
  rc: Parameters<typeof shouldAutoIndex>[0]
  ops: string[]
  builds: number[]
} {
  const ops: string[] = []
  const builds: number[] = []
  const model = opts.model ?? ''
  const rc = {
    dirs: () => ({ decrypted }),
    kbModel: () => ({ model, source: 'global' as const }),
    makeEmbedFn: () => (opts.embeddable === false ? undefined : (async (texts: string[]) => texts.map(() => [1, 0, 0, 0])) as unknown as EmbedFn),
    op: (_c: string, _a: string, _s: string, target?: string) => { ops.push(String(target ?? '')) },
    // `scheduleKbAutoIndex` 会调 `kbBuildIndexIn`；这里不测真实构建，只记录调用。
    kbIndexJobs: new Map(),
    kbIndexSignal: () => undefined,
    cancelKbIndexJob: () => false,
    privacyGate: (x: unknown) => x,
    globalModelName: () => model,
    ctx: { emit: () => undefined },
    makeChatAsker: () => undefined,
  } as unknown as Parameters<typeof shouldAutoIndex>[0]
  return { rc, ops, builds }
}

describe('shouldAutoIndex：三个条件缺一不可', () => {
  it('没配向量模型 ⇒ 不建（用户仍有关键词检索，不该被"索引失败"打扰）', () => {
    makeFilesDb(1, 3)
    const { rc } = makeRc({ model: '' })
    expect(shouldAutoIndex(rc, 1)).toBe(false)
  })

  it('模型名在但当不出 embed 函数 ⇒ 不建（端点/Key 没配好）', () => {
    makeFilesDb(1, 3)
    const { rc } = makeRc({ model: 'bge-m3', embeddable: false })
    expect(shouldAutoIndex(rc, 1)).toBe(false)
  })

  it('索引已就绪且覆盖完整 ⇒ 不建（避免每次进面板都重建）', () => {
    makeFilesDb(1, 3)
    makeReadyVectorDb(1, 'bge-m3', 3, 3)
    const { rc } = makeRc({ model: 'bge-m3' })
    expect(shouldAutoIndex(rc, 1, Date.now())).toBe(false)
  })

  it('有块但还没索引 ⇒ 要建', () => {
    makeFilesDb(1, 4)
    const { rc } = makeRc({ model: 'bge-m3' })
    expect(shouldAutoIndex(rc, 1)).toBe(true)
  })

  it('索引只覆盖了一部分（旧库无 expected 时按 rows 判定）⇒ 要建', () => {
    makeFilesDb(1, 5)
    makeReadyVectorDb(1, 'bge-m3', 2, 5)
    const { rc } = makeRc({ model: 'bge-m3' })
    expect(shouldAutoIndex(rc, 1)).toBe(true)
  })

  it('节流窗口内不重复建', () => {
    makeFilesDb(1, 4)
    const { rc } = makeRc({ model: 'bge-m3' })
    const now = 1_800_000_000_000
    expect(shouldAutoIndex(rc, 1, now)).toBe(true)
    // 占用节流窗口（不真的等构建完成：构建自身在飞时也会被 inflight 合并）
    scheduleKbAutoIndex(rc, 1, '测试', now)
    expect(shouldAutoIndex(rc, 1, now + 1000)).toBe(false)
    // 过了窗口又允许
    expect(shouldAutoIndex(rc, 1, now + AUTO_INDEX_MIN_GAP_MS + 1000)).toBe(true)
  })

  it('非法 kbId 直接 false（不抛错）', () => {
    const { rc } = makeRc({ model: 'bge-m3' })
    for (const bad of [0, -1, Number.NaN]) expect(shouldAutoIndex(rc, bad)).toBe(false)
  })
})

describe('afterKbFilesAdded：有队列先等解析，纯文本直接建', () => {
  it('纯文本（无队列）⇒ 直接安排索引', () => {
    makeFilesDb(1, 4)
    const { rc } = makeRc({ model: 'bge-m3' })
    afterKbFilesAdded(rc, 1, false)
    // 占用节流窗口即可证明它走到了 schedule（shouldAutoIndex 从 true 变 false）
    expect(shouldAutoIndex(rc, 1, Date.now() + AUTO_INDEX_MIN_GAP_MS + 1)).toBe(true)
  })

  it('有队列 ⇒ 不阻塞调用方（返回即刻，不等解析）', () => {
    makeFilesDb(1, 4)
    const { rc } = makeRc({ model: 'bge-m3' })
    // 这条只守"是同步返回"：`afterKbFilesAdded` 是 void 函数，队列在后台跑。
    const t = Date.now()
    afterKbFilesAdded(rc, 1, true)
    expect(Date.now() - t, 'afterKbFilesAdded 阻塞了上传回执').toBeLessThan(1000)
  })
})

describe('scheduleKbAutoIndex：后台执行且不冒泡', () => {
  it('不满足条件时一次都不发起构建', async () => {
    makeFilesDb(1, 3)
    makeReadyVectorDb(1, 'bge-m3', 3, 3)
    const { rc, ops } = makeRc({ model: 'bge-m3' })
    scheduleKbAutoIndex(rc, 1, '测试')
    await new Promise(r => setTimeout(r, 20))
    expect(ops, '已就绪还去构建 ⇒ 每次进面板都重跑一遍').toEqual([])
  })

  it('模型缺失时不写操作日志（静默，不制造焦虑）', async () => {
    makeFilesDb(1, 3)
    const { rc, ops } = makeRc({ model: '' })
    scheduleKbAutoIndex(rc, 1, '测试')
    await new Promise(r => setTimeout(r, 20))
    expect(ops).toEqual([])
  })
})

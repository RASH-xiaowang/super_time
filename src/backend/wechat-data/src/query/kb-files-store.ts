/**
 * `kb-files.ts` 的「存储底座：迁移、开库/事务、行→元数据、blob 读写、分块写入」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-store
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  KbFileChunkPage,
  KbFileListSnapshot,
  KbFileMeta,
  KbFileMutationResult,
  KbFileParseState,
  KbFileRecoveryReport,
  KbFileRegisterInput,
  KbFileRegisterResult,
  KbFilesDeleteReport,
} from '../types.ts'
import { bigramTokens } from './search.ts'
import { MAX_CHUNKS_PER_FILE, chunkBlocks } from './kb/chunk.ts'
import { kbBlobsDir, kbFilesDbPath } from './kb-paths.ts'

// 三个产物的路径真源在 `kb-paths.ts`（理由见其头注：避免 kb-vectors 反向引用构成环）。
// 这里**再导出**一次，既有导入点（`tests/kb-files-store.spec.ts`）不必改。
export { kbBlobsDir, kbFilesDbPath } from './kb-paths.ts'

/**
 * 单文件字节上限。
 *
 * 32MB：纯文本 32MB 已是千万字级别，远超「一次上传能被读完」的量级；
 * 再大只会线性拉长解析耗时与副本占用，而多出来的内容几乎不可能被检索到。
 * 拒绝发生在**读入之前**（先 `statSync` 看大小），所以超限文件不会先把内存吃掉。
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024

/** 单库文件数上限（与设计稿 §12.3 的分页口径一致：分页，不做虚拟滚动）。 */
export const MAX_FILES_PER_KB = 5000

/** 列表默认页大小。 */
export const DEFAULT_FILE_PAGE = 200

/**
 * 崩溃恢复要重置的中间态。
 *
 * 这三个态**物理上不可续跑**：进程没了，解析/分块的中间结果也跟着没了，
 * 没有任何机制能从一半继续。不重置就会永久停在「正在解析」转圈（设计稿 §10 边界 4）。
 */
export const INTERRUPTED_STATES = ['parsing', 'chunking', 'embedding'] as const

/**
 * 删除一个文件的级联顺序。**唯一真源**：实现按此数组逐条执行，spec 断言数组本身。
 *
 * 顺序不是随意的，两条都是「反了就静默出错」：
 *   · `chunks` 必须早于 `fts` —— FTS 行的 rowid 就是 chunk 的 id，先把 chunk 行删了
 *     就再也问不出该删哪些 rowid（所以这一步会**先取出 id 列表**再删表）；
 *   · `blob` 必须早于 `file` —— 判断「还有没有别的行引用这个 sha256」要趁登记行还在，
 *     删完再问永远是 0，于是**共享的副本会被误删**（另一个库的文件从此读不出内容）。
 */
export const KB_FILE_DELETE_ORDER = ['chunks', 'fts', 'vectors', 'blob', 'file'] as const
export type KbFileDeleteStep = (typeof KB_FILE_DELETE_ORDER)[number]

/**
 * 建表 / 建索引 / 加列，全部幂等。
 *
 * `openStore` 每次开库都会走到这里，所以这段必须能跑一百次结果一致 —— 建表一律
 * `IF NOT EXISTS`；加列必须先 `PRAGMA table_info` 查这一列在不在，不在才 `ALTER TABLE`
 * （SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重跑一次就报 duplicate column）。
 * 原来这里写着「不写加列分支（本库是新增的，没有历史版本要兼容）」—— 摘要功能落地之后
 * 那句话已经不成立，已经发出去的库里确实有不含 `summary` 列的 `kb_files`，
 * 所以加列口径改成与 `notes.ts:migrate` 一致。
 */
export function migrate(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS kb_files ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, '
    // 默认 1 = `DEFAULT_KB_ID`（与笔记同口径）。本库不与 `kbs` 表做外键：
    // 两个文件里的表之间没有 FK 可言，硬加只会让删库顺序变成一个陷阱。
    + 'kb_id INTEGER NOT NULL DEFAULT 1, '
    + "name TEXT NOT NULL DEFAULT '', "
    + "ext TEXT NOT NULL DEFAULT '', "
    + "src_path TEXT NOT NULL DEFAULT '', "
    + "sha256 TEXT NOT NULL DEFAULT '', "
    + "blob_name TEXT NOT NULL DEFAULT '', "
    + 'size_bytes INTEGER NOT NULL DEFAULT 0, '
    + "parse_state TEXT NOT NULL DEFAULT 'queued', "
    + "parser TEXT NOT NULL DEFAULT '', "
    + "parse_error TEXT NOT NULL DEFAULT '', "
    + 'chunk_count INTEGER NOT NULL DEFAULT 0, '
    + 'char_count INTEGER NOT NULL DEFAULT 0, '
    + 'include_in_rag INTEGER NOT NULL DEFAULT 1, '
    + 'created_at INTEGER NOT NULL, '
    + 'updated_at INTEGER NOT NULL)',
  )
  // 去重按**内容**而不是文件名：同一份文件改名重传不该产生两份。
  // 作用域是**库内** —— 同一个文件在两个库各留一份是合法用法。
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_files_sha ON kb_files(kb_id, sha256)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_kb_files_kb ON kb_files(kb_id, created_at DESC)')

  db.exec(
    'CREATE TABLE IF NOT EXISTS kb_chunks ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, '
    + 'file_id INTEGER NOT NULL, '
    + 'kb_id INTEGER NOT NULL, '
    + 'ordinal INTEGER NOT NULL, '
    + 'text TEXT NOT NULL, '
    + 'tokens TEXT NOT NULL, '
    + 'char_count INTEGER NOT NULL DEFAULT 0, '
    + 'page INTEGER NOT NULL DEFAULT 0, '
    + "heading TEXT NOT NULL DEFAULT '')",
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_file ON kb_chunks(file_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id)')

  // 中文必须走 bigram：`node:sqlite` 只带 `unicode61`，它把一整串汉字当成**一个**
  // token，于是「转账」在「微信转账收到转账」里永远搜不到（`search.ts` 里已有一份
  // 完整的踩坑记录）。口径与 `message_fts` 完全一致：**存切分后的 tokens**，
  // 原文不进索引（它在 `kb_chunks.text` 里，回显时从那里取，不重复存）。
  //
  // 本表**不放** kb_id / file_id：作用域过滤一律 `JOIN kb_chunks c ON c.id = fts.rowid`
  // 走 c 的列。多存一份冗余列就多一个「两处不一致」的机会，而它并不加速到值得。
  db.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts '
    + "USING fts5(tokens, heading_tokens, tokenize='unicode61')",
  )

  // ── 摘要三列（模型生成，见 gateway 的 summarizeKbFile）────────────────
  // 三个一起加，且都带 DEFAULT：`NOT NULL DEFAULT ''` 会把既有行一次性置空串，
  // 语义正好是「这份文件还没生成过摘要」，不需要额外的逐行 UPDATE。
  // `summary_at = 0` 与「空摘要」同义，所以界面判「有没有摘要」只看 `summary` 本身。
  const cols = columnNames(db, 'kb_files')
  if (!cols.includes('summary')) {
    db.exec("ALTER TABLE kb_files ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
  }
  if (!cols.includes('summary_model')) {
    // 记下是哪个模型写的：换模型之后用户要能看出这条摘要不是当前模型给的。
    db.exec("ALTER TABLE kb_files ADD COLUMN summary_model TEXT NOT NULL DEFAULT ''")
  }
  if (!cols.includes('summary_at')) {
    db.exec('ALTER TABLE kb_files ADD COLUMN summary_at INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.includes('summary_covered_chars')) {
    // 「这条摘要覆盖了前多少字」必须存下来 —— 不存就没法在事后诚实标注
    // 「这只是前 8,000 字的摘要，不是整份文件的概括」。
    db.exec('ALTER TABLE kb_files ADD COLUMN summary_covered_chars INTEGER NOT NULL DEFAULT 0')
  }
}

/** 表的列名（`PRAGMA table_info` 是唯一可靠的「有没有这一列」判据）。 */
export function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<Record<string, unknown>>
  return rows.map(r => cellStr(r['name']))
}

/**
 * 打开文件库（必要时建目录）。
 *
 * 与 `notes.ts` 同一套理由：用户可能在还没解密任何微信库时就想先整理文件，
 * 那时数据根还不存在，SQLite 会直接报 `unable to open database file`。
 * 建目录失败**不吞掉**（留痕即可）—— 真正的失败语义交给 `DatabaseSync`，
 * 免得「数据根的父路径是个文件」这种情形被报成『目录已存在』。
 */
export function openStore(decryptedDir: string): DatabaseSync {
  const file = kbFilesDbPath(decryptedDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (e) {
    console.warn('[kb-files] 数据根目录创建失败，继续尝试打开库：' + errorText(e))
  }
  const db = new DatabaseSync(file)
  migrate(db)
  return db
}

/**
 * 在一个事务里跑一段写操作。
 *
 * `BEGIN IMMEDIATE` 而不是裸 `BEGIN`：登记文件时「写 kb_files 行 + 写 N 条 chunk +
 * 写 N 条 FTS」必须同生共死。用延迟事务的话，两个进程同时写入会在 COMMIT 时才冲突，
 * 而那时解析已经白跑了一遍。
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚本身也失败：原始错误更有价值，往上抛 */
    }
    throw e
  }
}

export function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

export function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/**
 * 「写库时被别的进程占着」的识别 —— 这一类是**可以重试**的，不是「这份文件坏了」。
 *
 * 为什么需要它：`wechat_kb_files.db` 是 **rollback journal**（不是 WAL），写侧要拿到排他锁
 * 才能 `COMMIT`。只要**另一个进程**此刻还握着读锁（它的读事务没结束），写就会以
 * `errcode = 5`（`SQLITE_BUSY`）失败。真机复现（`working/kb-busy-repro.mjs`）看得很清楚：
 * `BEGIN IMMEDIATE` 与事务内的 `UPDATE` 都能过，**只有 `COMMIT` 抛**
 * `database is locked`；对端一放开，同一个写法立刻成功 —— 所以它是**暂态**的。
 *
 * 判据取 `errcode` 而不是文案：`errstr` 随 SQLite 构建与 locale 变（本机是
 * `database is locked`），拿它当判据会在换了构建之后静默失效。末行的文案兜底留给
 * 「拿不到 errcode」的极少数情形 —— 那时宁可多试几次，也不要把暂态当永久。
 * @param e - 捕获到的错误。
 * @returns 是不是「锁被占用」这一类可重试的失败。
 */
export function isBusyError(e: unknown): boolean {
  const err = e as { errcode?: unknown; errstr?: unknown; message?: unknown } | null | undefined
  const code = Number(err?.errcode)
  if (code === 5 || code === 6) return true // SQLITE_BUSY / SQLITE_LOCKED
  const text = String(err?.errstr ?? err?.message ?? '')
  return text.includes('database is locked') || text.includes('database table is locked')
}

/**
 * 撞锁时给用户看的那句话。
 *
 * 原样透出 `database is locked` 是一句他**没法行动**的话（英文，而且会让人以为数据坏了）——
 * 事实是「什么都没改动，等一下再来就好」。注册路径是同步的（重试不了），
 * 与队列路径共用这一句，免得两处各说各的。
 */
export const BUSY_TEXT = '知识库的数据文件正被占用（另一个程序在读写它），请稍后重试：这次没有改动任何文件'

export function warn(msg: string): void {
  console.warn('[kb-files] ' + msg)
}

/**
 * 把来自 Remote 边界（未受类型保护的 JSON）的标识收敛成正整数，或判为无效。
 *
 * 与 `notes.ts` 的同名函数同一口径。这里**故意不复用**它：`notes.ts` 的边界是
 * 「一行不改」，而为了共用这 3 行去动它，代价远大于收益。逻辑本身极稳定，
 * 两边都不会演化。
 */
export function normalizePositive(value: unknown): number | undefined {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 解析状态的白名单收敛。
 *
 * 库里出现预料之外的值时**不猜**（不当作 `ready`）—— 猜成 ready 会让界面把一个
 * 从没解析成功的文件显示成「可检索」，而那种错误没有任何症状。
 */
export function asParseState(s: string): KbFileParseState {
  const all: readonly string[] = [
    'queued', 'parsing', 'chunking', 'embedding', 'ready', 'unsupported', 'failed', 'sparse_only',
  ]
  return all.includes(s) ? (s as KbFileParseState) : 'queued'
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/** blob 副本的文件名：`<sha256>.<ext>`；无扩展名时只有指纹。 */
export function blobFileName(sha256: string, ext: string): string {
  return ext ? sha256 + '.' + ext : sha256
}

export function rowToFileMeta(r: Record<string, unknown>): KbFileMeta {
  return {
    id: Number(r['id'] ?? 0),
    kbId: Number(r['kb_id'] ?? 0),
    name: cellStr(r['name']),
    ext: cellStr(r['ext']),
    srcPath: cellStr(r['src_path']),
    sha256: cellStr(r['sha256']),
    blobName: cellStr(r['blob_name']),
    sizeBytes: Number(r['size_bytes'] ?? 0),
    parseState: asParseState(cellStr(r['parse_state'])),
    parser: cellStr(r['parser']),
    parseError: cellStr(r['parse_error']),
    chunkCount: Number(r['chunk_count'] ?? 0),
    charCount: Number(r['char_count'] ?? 0),
    includeInRag: Number(r['include_in_rag'] ?? 1) !== 0,
    // 摘要三列：老库里可能还没有这几列（`SELECT *` 拿不到 → cellStr 给空串），
    // 所以这里不能假设它们一定存在。
    summary: cellStr(r['summary']),
    summaryModel: cellStr(r['summary_model']),
    summaryAt: Number(r['summary_at'] ?? 0),
    summaryCoveredChars: Number(r['summary_covered_chars'] ?? 0),
    createdAt: Number(r['created_at'] ?? 0),
    updatedAt: Number(r['updated_at'] ?? 0),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// blob 副本
// ────────────────────────────────────────────────────────────────────────────

/**
 * 写 blob 副本。内容寻址 ⇒ 同名即同内容，已存在就**不重写**
 * （重写会把 mtime 刷新，让「这个副本是什么时候来的」失去意义）。
 *
 * ⚠ 副本先于事务落盘，所以「登记中途失败」会留下一个没有登记行指向它的副本。
 * 这不是泄漏：内容寻址意味着同一份内容下次登记会**直接复用它**，
 * 只有「这份内容再也不会被登记」时才白占空间，而那种情况下重复计算指纹
 * 也没有任何收益。
 */
export function writeBlob(decryptedDir: string, blobName: string, bytes: Buffer): void {
  const dir = kbBlobsDir(decryptedDir)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, blobName)
  if (existsSync(dest)) return
  writeFileSync(dest, bytes)
}

/**
 * 删除 blob 副本 —— **只在没有任何登记行还引用这个指纹时**。
 *
 * 必须在删 `kb_files` 行**之前**调用（见 `KB_FILE_DELETE_ORDER` 的说明）：
 * 自己的那一行也算在 COUNT 里，所以「> 1」表示还有别人。
 * 删不掉只留痕不报错：副本可能已被用户手动清理，而登记行该删还是要删。
 * @returns 是否真的删掉了文件。
 */
export function removeBlobIfUnreferenced(db: DatabaseSync, decryptedDir: string, sha256: string, blobName: string): boolean {
  if (!blobName || !sha256) return false
  const row = db.prepare('SELECT COUNT(*) AS n FROM kb_files WHERE sha256 = ?').get(sha256) as Record<string, unknown> | undefined
  if (Number(row?.['n'] ?? 0) > 1) return false
  const dest = join(kbBlobsDir(decryptedDir), blobName)
  try {
    unlinkSync(dest)
    return true
  } catch (e) {
    warn('副本删除失败（登记行照常删除）：' + dest + ': ' + errorText(e))
    return false
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 登记：读字节 → 解析 → 分块 → 落库
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把解析结果与截断说明合成写进 `parse_error` 的一句话。
 *
 * `unsupported` 时 `note` 必须非空（T1 的契约），而**文案纪律**是：不许把
 * 「本机没有对应解析器」写成「文件损坏」—— 前者等版本升级，后者要用户换文件。
 */
export function composeParseNote(note: string, truncated: boolean): string {
  const parts: string[] = []
  if (note) parts.push(note)
  if (truncated) parts.push('已截断至 ' + MAX_CHUNKS_PER_FILE + ' 块，其余内容不参与检索')
  return parts.join('；')
}

/** 逐块写入 `kb_chunks` 与其 FTS 索引行（rowid 与 chunk id 一一对应）。 */
export function insertChunks(db: DatabaseSync, fileId: number, kbId: number, chunks: readonly { ordinal: number; text: string; charCount: number; page: number; heading: string }[]): void {
  if (chunks.length === 0) return
  const insChunk = db.prepare(
    'INSERT INTO kb_chunks(file_id, kb_id, ordinal, text, tokens, char_count, page, heading) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insFts = db.prepare('INSERT INTO kb_chunks_fts(rowid, tokens, heading_tokens) VALUES (?, ?, ?)')
  for (const c of chunks) {
    const tokens = bigramTokens(c.text)
    const r = insChunk.run(fileId, kbId, c.ordinal, c.text, tokens, c.charCount, c.page, c.heading)
    insFts.run(Number(r.lastInsertRowid), tokens, bigramTokens(c.heading))
  }
}

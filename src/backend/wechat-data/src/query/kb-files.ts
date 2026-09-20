/**
 * 知识库「文件」存储层：登记（上传）/ 列表 / 删除 / 崩溃恢复，以及
 * 「读字节 → 解析 → 分块 → 落库」这条唯一写入路径。
 *
 * ── 与 `notes.ts` 的边界（刻意写在最显眼处）────────────────────────────
 *   · `notes.ts` 的文件头写着「本模块只读写本地库，不出网、不调用模型」，
 *     且它是**笔记**的真源。文件功能一律落在本模块，`notes.ts` **一行不改**；
 *   · 两者共用同一个数据根，但**各自一个库文件**：`wechat_notes.db` /
 *     `wechat_kb_files.db`。分成两个文件而不是「一个库里两组表」，是为了让
 *     「文件功能整体回退」= 删一个文件 + 摘掉 Remote 注册（计划 §三 可独立回退点）。
 *     代价是**没有跨库事务** —— 下文所有涉及两侧的写操作都必须按「先文件、后笔记」
 *     的顺序设计成可重入的（见 `kbFilesOnKbDelete`）。
 *
 * ── 两条不可违反的不变量 ─────────────────────────────────────────────
 *   ① **`src_path` 只登记，永不写、永不删、永不移。** 解析的输入是 blob 副本
 *      （`<data-root>/kb-blobs/<sha256>.<ext>`），所以用户改名 / 移动 / 删除原文件
 *      都不影响已经入库的内容（设计稿 §10 边界 3）。真机探针的第 9 步专门咬这一条。
 *   ② **`ready` 状态与它的 chunk 行必须在同一个事务里。** 否则中断会留下
 *      「状态说解析好了、但一条块都没有」的假成功，而这种行在界面上看起来最正常。
 *
 * ── 为什么 blob 用内容寻址而不是自增 id ───────────────────────────────
 *   ① 同一份内容在**不同库**里各存一行是合理的（库是作用域），但副本只该有一份；
 *   ② 「删掉这个文件时，还有没有别人在用它」于是就是一条 COUNT，不需要引用计数表，
 *      也就不会出现计数漂移导致「删掉别人还在用的 blob」。
 *   副本名只存**文件名**不存绝对路径：数据根搬家后旧路径会失效，而相对名不会。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
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
import type { ChunkResult } from './kb/types.ts'
import { isAsyncParsableExt } from './kb/parse-async.ts'
import { parseFileByExt } from './kb/parse-plain.ts'
import { extOf, isAcceptedExt } from './kb/types.ts'
// 三个产物的路径真源在 `kb-paths.ts`（理由见其头注：避免 kb-vectors 反向引用构成环）。
// 这里**再导出**一次，既有导入点（`tests/kb-files-store.spec.ts`）不必改。
import { kbBlobsDir, kbFilesDbPath } from './kb-paths.ts'
import { deleteKbVectorsForFile, reassignKbVectors } from './kb-vectors.ts'
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
const INTERRUPTED_STATES = ['parsing', 'chunking', 'embedding'] as const

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
function migrate(db: DatabaseSync): void {
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
function columnNames(db: DatabaseSync, table: string): string[] {
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

function warn(msg: string): void {
  console.warn('[kb-files] ' + msg)
}

/**
 * 把来自 Remote 边界（未受类型保护的 JSON）的标识收敛成正整数，或判为无效。
 *
 * 与 `notes.ts` 的同名函数同一口径。这里**故意不复用**它：`notes.ts` 的边界是
 * 「一行不改」，而为了共用这 3 行去动它，代价远大于收益。逻辑本身极稳定，
 * 两边都不会演化。
 */
function normalizePositive(value: unknown): number | undefined {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 解析状态的白名单收敛。
 *
 * 库里出现预料之外的值时**不猜**（不当作 `ready`）—— 猜成 ready 会让界面把一个
 * 从没解析成功的文件显示成「可检索」，而那种错误没有任何症状。
 */
function asParseState(s: string): KbFileParseState {
  const all: readonly string[] = [
    'queued', 'parsing', 'chunking', 'embedding', 'ready', 'unsupported', 'failed', 'sparse_only',
  ]
  return all.includes(s) ? (s as KbFileParseState) : 'queued'
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/** blob 副本的文件名：`<sha256>.<ext>`；无扩展名时只有指纹。 */
function blobFileName(sha256: string, ext: string): string {
  return ext ? sha256 + '.' + ext : sha256
}

function rowToFileMeta(r: Record<string, unknown>): KbFileMeta {
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
function writeBlob(decryptedDir: string, blobName: string, bytes: Buffer): void {
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
function removeBlobIfUnreferenced(db: DatabaseSync, decryptedDir: string, sha256: string, blobName: string): boolean {
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

/**
 * 登记一个文件：读原文件字节 → 算指纹 → 查重 → 落 blob 副本 → 解析 → 分块 → 入库。
 *
 * 为什么**分两档**而不是一刀切：
 *   · A / A' 档（纯文本 / HTML / CSV）一步做完 —— 解析是**同步毫秒级**的，拆成两步
 *     只会凭空造出一个中途态，用户看到「正在解析」闪一下又没了；
 *   · B 档（pdf / docx / xlsx / xls）只落一行 `queued`，正文由 `kb-queue.ts` 的执行器
 *     稍后填（那三个库要几百毫秒到几秒，见 `kb/parse-async.ts`）。
 *
 * ⚠ 用户点下「添加」到正文可检索，B 档中间有一段等待。触发执行器的**不是**这里
 * （那会让存储层反向依赖队列），而是 `gateway.addKbFiles` 与网关启动时的清扫
 * —— 两个入口都在 `gateway.ts` 里，一处不漏地看得见。
 *
 * 失败一律**返回**而不是抛：调用方是 `@Remote`，抛出去会变成一句无从下手的
 * 「调用失败」，而这里的每一种失败都能说清楚（重复 / 太大 / 类型不支持 / 读不到）。
 * @param decryptedDir - 解密数据根（库与 blob 都在它的父目录下）。
 * @param input - 目标库、原文件路径、是否参与向量化。
 * @returns 成功时带上落地的那一行；失败时带 `code` 与人话原因。
 */
export function registerKbFile(decryptedDir: string, input: KbFileRegisterInput): KbFileRegisterResult {
  const kbId = normalizePositive(input?.kbId)
  if (kbId === undefined) return { ok: false, code: 'bad-kb', error: '没有指定知识库（可能界面漏传了库标识）' }
  const srcPath = typeof input?.srcPath === 'string' ? input.srcPath.trim() : ''
  if (!srcPath) return { ok: false, code: 'bad-path', error: '没有拿到文件路径' }
  const includeInRag = input?.includeInRag === false ? false : true

  const name = basename(srcPath)
  const ext = extOf(name)

  let bytes: Buffer
  try {
    const st = statSync(srcPath)
    // 「它是不是文件」必须**先于**「类型认不认得」判定：给一个目录报「不支持的类型」
    // 是归因错误（目录根本没有类型），而这两种情况的排查方向完全不同 ——
    // 与「文件损坏」那句同理，属于本模块的文案纪律。
    if (!st.isFile()) return { ok: false, code: 'read-failed', error: '这个路径不是文件：' + name }
    // 对话框的 filters 是白名单，正常路径下选不到别的类型；这一层挡的是绕过对话框的
    // 调用（拖拽 / 直接调 RPC），并且要说清楚是**类型**不支持。
    if (!isAcceptedExt(ext)) {
      return {
        ok: false,
        code: 'not-accepted',
        error: '不支持的类型：' + (ext ? '.' + ext : '（没有扩展名）'),
      }
    }
    if (st.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        code: 'too-large',
        error: '文件过大（' + formatBytes(st.size) + '），上限 ' + formatBytes(MAX_FILE_BYTES),
      }
    }
    bytes = readFileSync(srcPath)
  } catch (e) {
    return { ok: false, code: 'read-failed', error: '读不到这个文件：' + errorText(e) }
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')

  let db: DatabaseSync
  try {
    db = openStore(decryptedDir)
  } catch (e) {
    // 打不开也可能是「别人正拿着锁」—— `openStore` 里的 `migrate` 要写 PRAGMA。
    // 那一类说成「写库失败」会把人引去查磁盘，而真正的动作只是等一下再来。
    return { ok: false, code: 'store-failed', error: isBusyError(e) ? BUSY_TEXT : errorText(e) }
  }

  try {
    const dup = db.prepare('SELECT id, name FROM kb_files WHERE kb_id = ? AND sha256 = ?').get(kbId, sha256) as Record<string, unknown> | undefined
    if (dup !== undefined) {
      const existing = { id: Number(dup['id'] ?? 0), name: cellStr(dup['name']) }
      return {
        ok: false,
        code: 'duplicate',
        duplicateOf: existing,
        // 按**内容**判定：改名重传不会被当成新文件。
        error: '该文件已在当前库中（按内容判定）：' + (existing.name || '未命名'),
      }
    }

    const cntRow = db.prepare('SELECT COUNT(*) AS n FROM kb_files WHERE kb_id = ?').get(kbId) as Record<string, unknown> | undefined
    if (Number(cntRow?.['n'] ?? 0) >= MAX_FILES_PER_KB) {
      return { ok: false, code: 'too-many', error: '当前库的文件数已达上限 ' + MAX_FILES_PER_KB + ' 个' }
    }

    // 副本先落盘：解析失败也要有副本，否则「重新解析」得让用户再找一次原文件。
    let blobName = ''
    let blobNote = ''
    try {
      blobName = blobFileName(sha256, ext)
      writeBlob(decryptedDir, blobName, bytes)
    } catch (e) {
      blobName = ''
      // 不因此拒绝入库：磁盘满 / 权限受限时用户仍然应该能用「读取原文件」的这条路，
      // 只是要知道代价 —— 原文件一旦被移动或删除，这份内容就需要重新上传。
      blobNote = '无法保存内容副本（' + errorText(e) + '），原文件被移动或删除后需要重新上传'
      warn(blobNote)
    }

    /**
     * B 档 ⇒ **不在这里解析**，只落一行 `queued`。
     *
     * 为什么不 `await` 到底：本函数是 `@Remote('addKbFiles')` 的同步实现，而 PDF / Word /
     * Excel 的解析要几百毫秒到几秒。在这里等，用户点下「确定」之后界面整个冻住，
     * 而且 IPC 期间**所有**其它接口都会被一起挡住（计划 H4 的验收就是这一条）。
     * 立刻返回还有一个好处：多选 10 个 PDF 时回执当场就能给「10 个都进来了」，
     * 而不是等十几秒才弹一次结果。
     *
     * 代价是「登记成功」与「能被检索到」之间多了一段等待 —— 这由 `parse_state`
     * 如实呈现（界面上是「等待解析 → 正在解析 → 已就绪」），而不是假装已经好了。
     */
    const asyncParsed = isAsyncParsableExt(ext)
    let parseState: KbFileParseState = 'queued'
    let parser = ''
    let parseError = blobNote
    let chunked: ChunkResult = { chunks: [], truncated: false, chunkCount: 0, charCount: 0 }

    if (!asyncParsed) {
      const outcome = parseFileByExt(ext, new Uint8Array(bytes))
      parser = outcome.parser
      parseState = outcome.state === 'ready' ? 'ready' : 'unsupported'
      if (outcome.state === 'ready') chunked = chunkBlocks(outcome.blocks)
      parseError = [blobNote, composeParseNote(outcome.note, chunked.truncated)].filter(Boolean).join('；')
    }

    const now = Date.now()
    let fileId = 0
    // 不变量 ②：`ready` 与它的 chunk 行在同一个事务里。
    inTransaction(db, () => {
      const res = db.prepare(
        'INSERT INTO kb_files(kb_id, name, ext, src_path, sha256, blob_name, size_bytes, parse_state, parser, parse_error, chunk_count, char_count, include_in_rag, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        kbId, name, ext, srcPath, sha256, blobName, bytes.length,
        parseState, parser, parseError, chunked.chunkCount, chunked.charCount,
        includeInRag ? 1 : 0, now, now,
      )
      fileId = Number(res.lastInsertRowid)
      insertChunks(db, fileId, kbId, chunked.chunks)
    })

    const row = db.prepare('SELECT * FROM kb_files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined
    return { ok: true, file: rowToFileMeta(row ?? {}) }
  } catch (e) {
    return { ok: false, code: 'store-failed', error: isBusyError(e) ? BUSY_TEXT : errorText(e) }
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 列表
// ────────────────────────────────────────────────────────────────────────────

/** 列表分页参数。 */
export interface KbFileListOptions {
  limit?: number
  offset?: number
}

/**
 * 列出一个库里的文件（新上传的在前）。
 *
 * ⚠ **每一处查询都带 `WHERE kb_id = ?`** —— 少一处，单库测试全绿、多库才串数据，
 * 而那时已经很难归因了（这是计划里点名的「静默失效」之一，变异测试第 1 条咬的就是它）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param opts - 分页。
 * @returns 列表；库读不到时给 `readError`，而不是把空列表伪装成「一个文件都没有」。
 */
export function listKbFiles(decryptedDir: string, kbId: number, opts: KbFileListOptions = {}): KbFileListSnapshot {
  const kb = normalizePositive(kbId) ?? 0
  const rawLimit = Math.trunc(Number(opts.limit ?? DEFAULT_FILE_PAGE))
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_FILE_PAGE, 1), MAX_FILES_PER_KB)
  const rawOffset = Math.trunc(Number(opts.offset ?? 0))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare('SELECT * FROM kb_files WHERE kb_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(kb, limit, offset) as Array<Record<string, unknown>>
      const cntRow = db.prepare('SELECT COUNT(*) AS n FROM kb_files WHERE kb_id = ?').get(kb) as Record<string, unknown> | undefined
      return { kbId: kb, items: rows.map(rowToFileMeta), total: Number(cntRow?.['n'] ?? 0) }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[kb-files] 文件列表读取失败：' + kbFilesDbPath(decryptedDir) + ': ' + readError)
    return { kbId: kb, items: [], total: 0, readError }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 读某个文件的正文（分块）
// ────────────────────────────────────────────────────────────────────────────

/** 一次最多回多少个块。 */
export const MAX_CHUNK_PAGE = 200
/** 默认每页块数（一屏读得完的量）。 */
const DEFAULT_CHUNK_PAGE = 60

/**
 * 列出一个文件解析出来的正文块。
 *
 * 这是「读这篇文档」的唯一出口：界面上原先只有登记台账（大小 / 块数 / 指纹 / 路径），
 * 正文虽然确实进了 `kb_chunks.text`，却只在**搜索命中**时以摘要片段的形式露出来 ——
 * 不输入关键词就读不到内容。
 *
 * ⚠ **两个作用域条件都要**：`file_id` 定位文件，`kb_id` 确认它属于当前库。
 * 只卡 `file_id` 的话，传一个别的库的 fileId 就能读到那个库的正文 ——
 * 单库测试全绿，多库才串，而且这条串的是**内容**不是计数，比 `listKbFiles` 那边更严重。
 *
 * 返回的是**解析出来的文本**，不是原文件的排版：PDF/DOCX 的表格、图片、页眉页脚
 * 在解析阶段就已经丢了。所以界面上必须说清「这是检索与问答实际看到的正文」，
 * 不能让用户以为在看原稿 —— 那两种读法得到的结论可以不一样。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库（必填，没有「所有库」模式）。
 * @param fileId - 目标文件。
 * @param opts - 分页（按 `ordinal` 升序，即文档原有顺序）。
 * @returns 块列表与总数；读不到或文件不在本库时给 `readError`。
 */
export function listKbFileChunks(
  decryptedDir: string, kbId: number, fileId: number, opts: { limit?: number; offset?: number } = {},
): KbFileChunkPage {
  const kb = normalizePositive(kbId) ?? 0
  const file = normalizePositive(fileId) ?? 0
  const empty: KbFileChunkPage = { kbId: kb, fileId: file, items: [], total: 0, totalChars: 0 }
  if (kb === 0 || file === 0) return { ...empty, readError: '参数无效：kbId 与 fileId 都必须是正整数' }
  const rawLimit = Math.trunc(Number(opts.limit ?? DEFAULT_CHUNK_PAGE))
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_CHUNK_PAGE, 1), MAX_CHUNK_PAGE)
  const rawOffset = Math.trunc(Number(opts.offset ?? 0))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
  try {
    const db = openStore(decryptedDir)
    try {
      // 先确认这个文件在**当前库**里：不在就直接返回，一条正文都不读。
      const owner = db.prepare('SELECT id FROM kb_files WHERE id = ? AND kb_id = ?').get(file, kb) as Record<string, unknown> | undefined
      if (owner === undefined) {
        return { ...empty, readError: '文件不存在，或不属于当前知识库' }
      }
      const rows = db.prepare(
        'SELECT ordinal, page, heading, text, char_count FROM kb_chunks '
        + 'WHERE file_id = ? AND kb_id = ? ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?',
      ).all(file, kb, limit, offset) as Array<Record<string, unknown>>
      const cnt = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(char_count), 0) AS c FROM kb_chunks WHERE file_id = ? AND kb_id = ?')
        .get(file, kb) as Record<string, unknown> | undefined
      return {
        kbId: kb,
        fileId: file,
        items: rows.map(r => ({
          ordinal: Number(r['ordinal'] ?? 0),
          page: Number(r['page'] ?? 0),
          heading: cellStr(r['heading']),
          text: cellStr(r['text']),
          charCount: Number(r['char_count'] ?? 0),
        })),
        total: Number(cnt?.['n'] ?? 0),
        totalChars: Number(cnt?.['c'] ?? 0),
      }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[kb-files] 文件正文读取失败：' + kbFilesDbPath(decryptedDir) + ': ' + readError)
    return { ...empty, readError }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 崩溃恢复
// ────────────────────────────────────────────────────────────────────────────

/**
 * 已经做过崩溃恢复的数据根（按库文件路径记）。
 *
 * **只在进程启动时重置一次**，而不是每次读列表时判断 —— 后者是这类功能最常见的
 * 走捷径写法，它的 bug 是：用户正在上传一个大文件（状态 = `parsing`），
 * 此时任何一次列表刷新都会把它判成「崩溃残留」并打回 `queued`，
 * 于是一次正常的解析被自己的读操作打断（计划 R7）。
 */
const recoveredRoots = new Set<string>()

/**
 * 把上次进程留下的中间态重置为 `queued`。
 *
 * **调用点是网关启动时一次**，不要在读路径里调。
 * 同一个数据根在本进程内只做一次：第二次返回 `{ reset: 0, skipped: true }`，
 * 好让「只做一次」这件事可被断言，而不是只能靠读代码相信。
 * @param decryptedDir - 解密数据根。
 * @returns 本次重置的行数与是否被跳过。
 */
export function recoverInterrupted(decryptedDir: string): KbFileRecoveryReport {
  const key = kbFilesDbPath(decryptedDir)
  if (recoveredRoots.has(key)) return { reset: 0, skipped: true }
  // 先登记再干活：万一这次失败，也不该在每次读列表时重试同一件大概率仍会失败的事
  // （失败原因通过 readError 暴露给启动日志）。
  recoveredRoots.add(key)
  try {
    const db = openStore(decryptedDir)
    try {
      const placeholders = INTERRUPTED_STATES.map(() => '?').join(', ')
      const res = db.prepare('UPDATE kb_files SET parse_state = \'queued\', updated_at = ? WHERE parse_state IN (' + placeholders + ')')
        .run(Date.now(), ...INTERRUPTED_STATES)
      return { reset: Number(res.changes ?? 0), skipped: false }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    const readError = errorText(e)
    warn('崩溃恢复失败：' + readError)
    return { reset: 0, skipped: false, readError }
  }
}

/** 仅供用例清掉「只做一次」的进程内记忆（`recoverInterrupted` 的守卫本身不被绕过）。 */
export function resetRecoveryGuardForTest(): void {
  recoveredRoots.clear()
}

// ────────────────────────────────────────────────────────────────────────────
// 删除
// ────────────────────────────────────────────────────────────────────────────

/** 级联删除的上下文：字段在步骤之间传递（`chunks` 填 `chunkIds`，`fts` 用）。 */
interface CascadeContext {
  db: DatabaseSync
  decryptedDir: string
  fileId: number
  sha256: string
  blobName: string
  chunkIds: number[]
  removedChunks: number
  removedBlob: boolean
}

/**
 * 五个删除步骤的实现表。**键就是 `KB_FILE_DELETE_ORDER` 的元素** ——
 * 顺序由那个数组决定，这里只管每一步做什么，不重复表达次序。
 */
const CASCADE_STEPS: Record<KbFileDeleteStep, (c: CascadeContext) => void> = {
  chunks: (c) => {
    // 先取 id 再删表：FTS 行的 rowid 就是 chunk id，删完表就问不出来了。
    const rows = c.db.prepare('SELECT id FROM kb_chunks WHERE file_id = ?').all(c.fileId) as Array<Record<string, unknown>>
    c.chunkIds = rows.map((r) => Number(r['id'] ?? 0))
    c.removedChunks = c.chunkIds.length
    c.db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(c.fileId)
  },
  fts: (c) => {
    if (c.chunkIds.length === 0) return
    const del = c.db.prepare('DELETE FROM kb_chunks_fts WHERE rowid = ?')
    for (const id of c.chunkIds) del.run(id)
  },
  vectors: (c) => {
    /**
     * 向量在**另一个库文件**里（`wechat_kb_vectors.db`）—— 跨库在 SQLite 里就是两个连接、
     * 两次独立提交，**没有事务可依赖**。这正是 `KB_FILE_DELETE_ORDER` 把这一步排在 `blob`
     * 之前的另一半理由：它无论如何都不是原子的，那就让它在「还拿得到 chunkIds」之后尽早做完。
     *
     * best-effort 为什么站得住：`searchKbDense` 回读时会重新 JOIN `kb_chunks` / `kb_files`
     * 并**再判一次** `include_in_rag`，残留的派生行既进不了结果、也绕不过隐私开关。
     * 删不掉由 `deleteKbVectorsForFile` 自己留痕（不抛）—— 登记行该删还是要删。
     */
    deleteKbVectorsForFile(c.decryptedDir, c.fileId)
  },
  blob: (c) => {
    c.removedBlob = removeBlobIfUnreferenced(c.db, c.decryptedDir, c.sha256, c.blobName)
  },
  file: (c) => {
    c.db.prepare('DELETE FROM kb_files WHERE id = ?').run(c.fileId)
  },
}

/** 按 `KB_FILE_DELETE_ORDER` 逐条执行级联。 */
function cascadeDeleteFile(ctx: CascadeContext): void {
  for (const step of KB_FILE_DELETE_ORDER) CASCADE_STEPS[step](ctx)
}

/** 读出一行的 sha256 / blob_name，造一个级联上下文。 */
function contextFor(db: DatabaseSync, decryptedDir: string, fileId: number): CascadeContext {
  const row = db.prepare('SELECT sha256, blob_name FROM kb_files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined
  return {
    db,
    decryptedDir,
    fileId,
    sha256: cellStr(row?.['sha256']),
    blobName: cellStr(row?.['blob_name']),
    chunkIds: [],
    removedChunks: 0,
    removedBlob: false,
  }
}

/**
 * 删除一个文件，连带它的分块 / FTS 行 / 向量 / blob 副本。
 *
 * **不碰 `src_path`** —— 这是本模块最重要的对外承诺：删的是「知识库里的这一份」，
 * 不是用户电脑上的那个文件。真机探针第 9 步咬这一条。
 * @param decryptedDir - 解密数据根。
 * @param kbId - **守卫**（不是附加信息）：归属不符时拒绝删除。文件 id 全局自增，
 *   少了这一步，拿着甲库的 id 调乙库会把甲库那一条连分块与副本一起删掉且无法撤销。
 * @param fileId - 要删的文件行 id。
 * @returns 回执（连带清掉的分块数、副本是否被删）。
 */
export function deleteKbFile(decryptedDir: string, kbId: number, fileId: number): KbFileMutationResult {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined) return { ok: false, error: '知识库标识无效' }
  if (id === undefined) return { ok: false, error: '文件标识无效' }
  try {
    const db = openStore(decryptedDir)
    try {
      // 归属不符时报「不存在」——与文件真的不在时同一句话：不向调用方暴露
      // 「这个 id 在别的库里存在」这一事实。
      const exists = db.prepare('SELECT id FROM kb_files WHERE id = ? AND kb_id = ?').get(id, kb)
      if (exists === undefined) return { ok: false, error: '文件不存在（可能已被删除）' }
      const ctx = contextFor(db, decryptedDir, id)
      inTransaction(db, () => cascadeDeleteFile(ctx))
      return { ok: true, removedChunks: ctx.removedChunks, removedBlob: ctx.removedBlob }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * 读单个文件行（`kb_id` 与 `id` 双条件）。
 *
 * 为什么单独一个而不是让调用方去 `listKbFiles` 里找：后者是分页的，
 * 「按 limit 拉一大页再线性找」既浪费又会在文件数超过 limit 时**静默找不到** ——
 * 而找不到会被调用方解释成「这个文件不存在」，那是个假结论。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库（守卫）。
 * @param fileId - 目标文件。
 * @returns 文件元信息；不存在或不属于该库时 `null`。
 */
export function getKbFile(decryptedDir: string, kbId: number, fileId: number): KbFileMeta | null {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined || id === undefined) return null
  try {
    const db = openStore(decryptedDir)
    try {
      const row = db.prepare('SELECT * FROM kb_files WHERE id = ? AND kb_id = ?').get(id, kb) as Record<string, unknown> | undefined
      return row === undefined ? null : rowToFileMeta(row)
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    console.warn('[kb-files] 单文件读取失败：' + errorText(e))
    return null
  }
}

/**
 * 写入（或清空）一个文件的模型摘要。
 *
 * 摘要是**派生物**而不是用户输入，所以它单独占三列而不是塞进 `parse_error` 之类的
 * 现成字段，并且要连模型名与时间一起存：换了配置模型之后，用户得能看出眼前这条
 * 摘要不是当前这个模型给的。
 *
 * `kbId` 是守卫而不是附加信息（与 `deleteKbFile` / `setKbFileRagFlag` 同一条纪律）：
 * 只按 `id` 更新的话，拿甲库的 id 会写进乙库那一行。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param fileId - 目标文件。
 * @param summary - 摘要正文；传空串表示清空。
 * @param model - 生成它的模型标识（`provider/model` 那种写法）。
 * @param coveredChars - 本次真正喂给模型的字符数（清空时传 0）。
 * @returns `{ ok }` 或 `{ ok: false, error }`。
 */
export function setKbFileSummary(
  decryptedDir: string, kbId: number, fileId: number, summary: string, model: string, coveredChars: number,
): KbFileMutationResult {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined) return { ok: false, error: '知识库标识无效' }
  if (id === undefined) return { ok: false, error: '文件标识无效' }
  try {
    const db = openStore(decryptedDir)
    try {
      const text = summary.trim()
      const res = db.prepare(
        'UPDATE kb_files SET summary = ?, summary_model = ?, summary_at = ?, summary_covered_chars = ?, updated_at = ? '
        + 'WHERE id = ? AND kb_id = ?',
      ).run(
        text, text === '' ? '' : model, text === '' ? 0 : Date.now(),
        text === '' ? 0 : Math.max(0, Math.trunc(coveredChars)), Date.now(), id, kb,
      )
      if (Number(res.changes ?? 0) === 0) return { ok: false, error: '文件不存在（可能已被删除）' }
      return { ok: true }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * 切换一个文件是否参与向量化（出网）。
 *
 * 有这一档是为了让「库里有合同，但我还想搜到它」成立：关掉之后该文件**完全不出网**，
 * 但仍然留在 FTS 索引里可被关键词搜到（设计稿 §9.2）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - **守卫**，与 `deleteKbFile` 同口径。
 * @param fileId - 目标文件。
 * @param includeInRag - 是否参与。
 * @returns `{ ok }` 或 `{ ok: false, error }`。
 */
export function setKbFileRagFlag(decryptedDir: string, kbId: number, fileId: number, includeInRag: boolean): KbFileMutationResult {
  const kb = normalizePositive(kbId)
  const id = normalizePositive(fileId)
  if (kb === undefined) return { ok: false, error: '知识库标识无效' }
  if (id === undefined) return { ok: false, error: '文件标识无效' }
  try {
    const db = openStore(decryptedDir)
    try {
      const res = db.prepare('UPDATE kb_files SET include_in_rag = ?, updated_at = ? WHERE id = ? AND kb_id = ?')
        .run(includeInRag ? 1 : 0, Date.now(), id, kb)
      if (Number(res.changes ?? 0) === 0) return { ok: false, error: '文件不存在（可能已被删除）' }
      /**
       * 关掉开关时**必须连已有向量一起清掉**。
       *
       * 只改标志位挡不住**已经躺在向量库里的那一份**：粗筛照样会把它选出来
       *（回读时的 `include_in_rag=1` 会把它过滤掉，但那意味着「不许出网的文件每次都在参与粗筛」，
       * 而且它的向量已经落在磁盘上了）。用户关开关的意思是「别再算了、也别再留着」，两件都要做。
       *
       * 重新打开**不**顺手重建：重建要出网，出网必须由用户显式触发（或下一次提问的既有路径去补）。
       * 这里只做减法、不做加法。
       */
      if (!includeInRag) deleteKbVectorsForFile(decryptedDir, id)
      return { ok: true }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * 删库时处理该库的文件：`purge` 全部删掉，`reassign` 迁给目标库。
 *
 * ⚠ **调用顺序是「先文件、后笔记」**（两个库文件之间没有跨库事务）。
 * 反过来的话，中间失败会留下「库行没了、文件还在、kb_id 指向一个不存在的库」，
 * 界面上就是文件彻底消失且无法归因；按现在的顺序失败，最坏是「文件已迁走、库还在」，
 * 用户重试一次即可，两边都能收敛。
 *
 * `reassign` 撞上目标库已有同内容文件时，该文件**不迁移**并计入 `removedFiles`：
 * 唯一索引不允许两行同 sha256，而静默合并会让用户以为文件丢了（设计稿 §10 边界 7）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 被删的库。
 * @param targetKbId - `reassign` 的目标库；不给表示 `purge`。
 * @returns 迁移 / 删除的条数。**文件为空的库也返回 `ok:true`**（没什么可做不是失败）。
 */
export function kbFilesOnKbDelete(decryptedDir: string, kbId: number, targetKbId?: number): KbFilesDeleteReport {
  const kb = normalizePositive(kbId)
  if (kb === undefined) return { ok: false, movedFiles: 0, removedFiles: 0, error: '知识库标识无效' }
  const target = normalizePositive(targetKbId)
  const reassign = target !== undefined && target !== kb
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare('SELECT id FROM kb_files WHERE kb_id = ?').all(kb) as Array<Record<string, unknown>>
      const ids = rows.map((r) => Number(r['id'] ?? 0)).filter((n) => n > 0)
      if (ids.length === 0) return { ok: true, movedFiles: 0, removedFiles: 0 }

      let moved = 0
      let removed = 0
      inTransaction(db, () => {
        for (const id of ids) {
          if (!reassign) {
            cascadeDeleteFile(contextFor(db, decryptedDir, id))
            removed += 1
            continue
          }
          const row = db.prepare('SELECT sha256 FROM kb_files WHERE id = ?').get(id) as Record<string, unknown> | undefined
          const sha = cellStr(row?.['sha256'])
          const clash = sha !== ''
            && db.prepare('SELECT id FROM kb_files WHERE kb_id = ? AND sha256 = ?').get(target, sha) !== undefined
          if (clash) {
            cascadeDeleteFile(contextFor(db, decryptedDir, id))
            removed += 1
            continue
          }
          const now = Date.now()
          db.prepare('UPDATE kb_files SET kb_id = ?, updated_at = ? WHERE id = ?').run(target, now, id)
          // 分块也要跟着换归属，否则新库检索不到它、旧库又能搜到（隔离被破坏）。
          // FTS 表里没有 kb_id（作用域一律走 JOIN），所以不需要同步。
          db.prepare('UPDATE kb_chunks SET kb_id = ? WHERE file_id = ?').run(target, id)
          /**
           * 向量行的归属**也要跟着换**（跨库，所以进不了这个事务）。
           * 漏了它的后果是静默的：向量行还在，但 `kb_id` 指向那个即将消失的库 ⇒ 目标库的
           * 稠密检索按 `WHERE kb_id = ?` 把它挡掉、源库也没了 ⇒ 这些块在稠密通道里「凭空消失」，
           * 而稀疏通道照样搜得到。表现为「关键词搜得到、换个说法就搜不到」，极难归因。
           */
          reassignKbVectors(decryptedDir, id, target)
          moved += 1
        }
      })
      return { ok: true, movedFiles: moved, removedFiles: removed }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    return { ok: false, movedFiles: 0, removedFiles: 0, error: errorText(e) }
  }
}

/**
 * 每个库各有多少条登记 —— **一次 GROUP BY** 拿全。
 *
 * 给 `gateway.getKbs` 用：库列表要显示 / 说明「库里有多少文件」（删库弹层不数文件就会说
 * 「这个库是空的」）。按库逐个调 `countKbFiles()` 也能得到同样的数，但那是 N 次开库 ——
 * 与 `notes.ts` 的 `listKbs` 同一条纪律：别在循环里对每个库各查一次。
 *
 * 读不到文件库时返回**空表**（调用方按「没有文件」呈现）。这是列表页的附属信息，
 * 不该因为文件库读失败就整天不显示；文件库自己的读失败有「文件」分段的 `readError` 负责。
 * @param decryptedDir - 解密数据根。
 * @returns `kb_id → 条数`；没有文件的库**不出现在表里**（调用方用 `?? 0` 兜）。
 */
export function countKbFilesByKb(decryptedDir: string): Map<number, number> {
  const map = new Map<number, number>()
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare('SELECT kb_id, COUNT(*) AS n FROM kb_files GROUP BY kb_id').all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const kb = normalizePositive(r['kb_id'])
        if (kb !== undefined) map.set(kb, Number(r['n'] ?? 0))
      }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch {
    /* 读不到就按「没有文件」呈现；见上面的头注 */
  }
  return map
}

/** 诊断用：某个库现有多少条登记（探针第 8 步断言「该 file_id 在库里为 0 行」时用得上）。 */
export function countKbFiles(decryptedDir: string, kbId: number): number {
  const kb = normalizePositive(kbId)
  if (kb === undefined) return 0
  try {
    const db = openStore(decryptedDir)
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM kb_files WHERE kb_id = ?').get(kb) as Record<string, unknown> | undefined
      return Number(row?.['n'] ?? 0)
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch {
    return 0
  }
}

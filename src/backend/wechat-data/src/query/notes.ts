/**
 * Knowledge notes: local-only knowledge assets (user-authored, or distilled
 * from a WeChat Q&A answer), persisted at `<data-root>/wechat_notes.db`
 * alongside the other write stores (`wechat_tasks.db`, `message_edits.db`…).
 *
 * Notes interlink with `[[target]]` / `[[target|display]]` wiki links. A target
 * resolving to an existing note title (case-insensitive, whitespace-collapsed)
 * becomes an edge between two note nodes; a target with no matching note is
 * kept as a **stub** so the "write the link first, the note later" workflow
 * neither loses information nor errors out.
 *
 * 标题在**库内**唯一（同一归一化规则），否则 [[链接]] 的解析会产生歧义。
 * 本模块只读写本地库，不出网、不调用模型。
 *
 * ── 多知识库（2026-09-18）──────────────────────────────────────────────
 * 「库」是这份存储的**作用域**，不是一个视图。一个库 = 一批笔记 + 一个
 * `[[链接]]` 解析域 + 一张由这批笔记构成的图谱，三者不可分离。因此：
 *   · `kbs` 表登记库（名字唯一性用 normalizeTitle，与笔记标题同一套口径）；
 *   · `notes.kb_id` 划归属，`DEFAULT_KB_ID`（=1）承接所有历史数据；
 *   · 标题唯一性、`[[链接]]` 解析域、图谱取数**一律带 `kb_id`**。
 *
 * 为什么仍然只用一个库文件而不是「一库一个 db」：跨文件移动笔记没有事务
 * （`DatabaseSync` 没有跨库事务），中途失败会留下**两份副本或两份丢失**；
 * 而单文件里「把这批笔记移进另一个库」是一条 UPDATE，可以放在一个事务里。
 * 代价是单库不能单独备份/删除 —— 那个需求应当做成「导出」（只读），不是拆文件。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult, KnowledgeNote, KnowledgeSnapshot, NoteMutationResult, NotesSnapshot } from '../types.ts'

/**
 * 默认知识库的 id。**只在这里定义一处。**
 *
 * 它同时承担两个职责：① 历史数据（`ALTER TABLE … DEFAULT 1`）的落点；
 * ② 保证「任何时刻至少有一个库」的兜底 —— 迁移末尾若 `kbs` 为空就建它。
 * 因此它**不可删除**（可重命名）：删掉之后下一次开库会复活一个空库盖住现场。
 */
export const DEFAULT_KB_ID = 1
/** 默认库的显示名。 */
export const DEFAULT_KB_NAME = '默认知识库'
/** 库名长度上限。超限**拒绝**而不是截断 —— 截断会让用户看到的名字与他输入的不一致。 */
export const KB_NAME_MAX = 40

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_notes.db')
}

/**
 * 建表 / 加列 / 补默认库，全部幂等。
 *
 * `openStore` 每次开库都会走到这里，所以这段必须能跑一百次而结果一致：
 * 加列前先查 `PRAGMA table_info`，建东西一律 `IF NOT EXISTS`，默认库按主键判存在。
 *
 * ⚠ 这里抛出的错误会一路传到 `listNotes` / `listKbs` 的 catch 变成 `readError`。
 * 这是刻意的：**迁移失败绝不能伪装成「库是空的」** —— 那会让用户照「还没写过东西」
 * 去排查，方向全错（与 N1 同一条纪律）。
 */
function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT \'\', tags TEXT NOT NULL DEFAULT \'\', source_kind TEXT NOT NULL DEFAULT \'manual\', source_username TEXT NOT NULL DEFAULT \'\', source_question TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS kbs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
  if (!columnNames(db, 'notes').includes('kb_id')) {
    // `NOT NULL DEFAULT 1` 会把既有行一次性置为 1 —— 「老笔记全部落进默认库」就是这一步，
    // 不需要额外的逐行 UPDATE。下面那条兜的是历史脏值（正常查不到行）。
    db.exec('ALTER TABLE notes ADD COLUMN kb_id INTEGER NOT NULL DEFAULT 1')
  }
  db.exec('UPDATE notes SET kb_id = ' + DEFAULT_KB_ID + ' WHERE kb_id IS NULL')
  // 列表按 (库, 更新时间) 取；建图也是同一个键。
  db.exec('CREATE INDEX IF NOT EXISTS idx_notes_kb ON notes(kb_id, updated_at DESC)')
  if (db.prepare('SELECT id FROM kbs WHERE id = ?').get(DEFAULT_KB_ID) === undefined) {
    // **无论有没有笔记都要建**：新用户第一次打开就必须有一个「当前库」，
    // 否则界面要面对「没有作用域」这个不该存在的状态。
    const ts = Date.now()
    db.prepare('INSERT INTO kbs(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(DEFAULT_KB_ID, DEFAULT_KB_NAME, ts, ts)
  }
}

/** 表的列名（`PRAGMA table_info` 是唯一可靠的「有没有这一列」，SQLite 不支持 ADD COLUMN IF NOT EXISTS）。 */
function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<Record<string, unknown>>
  return rows.map(r => cellStr(r['name']))
}

function openStore(decryptedDir: string): DatabaseSync {
  const file = dbPath(decryptedDir)
  // 笔记是「与解密数据无关」的本地资产：用户可能在还没解密任何库时就先写笔记，
  // 那时数据根目录还不存在，SQLite 会直接报 unable to open database file。
  // `wechat_tasks.db` 等既有 store 同样建在数据根下，但它们只被「已解密」后的
  // 链路调用，靠 try/catch 退化成空列表就掩盖了这个前提，这里必须显式建目录。
  //
  // N1：建目录失败**不许成为报告的病因**（吞掉并留痕）。改前这里是裸的 mkdirSync，
  // 于是「数据根的父路径是个文件」这种情形下，`listNotes` 的 catch 收到的是 EEXIST，
  // 用户按「目录已存在」去排查 —— 而真正的问题是库打不开。失败语义交给下面的
  // DatabaseSync（与改动前一样会失败），只是错误文本回到了它本该是的那一句。
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (e) {
    console.warn('[notes] 数据根目录创建失败，继续尝试打开库：' + errorText(e))
  }
  const db = new DatabaseSync(file)
  migrate(db)
  return db
}

/**
 * 在一个事务里跑一段写操作。
 *
 * 用 `BEGIN IMMEDIATE` 而不是裸 `BEGIN`：删除库时「迁移笔记」与「删库行」必须同生共死，
 * 否则中断会留下一个「库没了、笔记还在，但没人认领」的孤儿状态（kb_id 指向不存在的库，
 * 界面上就是「笔记消失了」）。
 */
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
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

function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** 错误文本（Error.message 优先，非 Error 一律 String()）。 */
function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/**
 * 把来自 Remote 边界（未受类型保护的 JSON）的库标识收敛成正整数，或判为无效。
 *
 * 为什么运行期还要挡一次：TypeScript 只能拦住**本仓库内**的调用点，
 * 而 `@Remote` 收到的是序列化过来的对象 —— 前端漏传时这里是 `undefined`。
 * 少了这一步，「漏传 kbId」会静默退化成「操作某个 id 为 NaN 的库」，
 * 症状是「保存成功但列表里没有」。
 */
function normalizeKbId(value: unknown): number | undefined {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 库是否存在。读路径靠它把「库没了」与「库是空的」分开。 */
function kbExists(db: DatabaseSync, kbId: number): boolean {
  return db.prepare('SELECT id FROM kbs WHERE id = ?').get(kbId) !== undefined
}

/**
 * Resolution key for note titles, knowledge-base names and `[[target]]` values.
 *
 * 归一化只做三件事：去首尾空白、内部连续空白折叠成一个空格、转小写。
 * 标题唯一性与链接解析必须共用这一个函数 —— 两处若各写一套，会出现
 * 「保存时任为同名、链接时却解析不到」这类只在特定空白/大小写下复现的怪问题。
 * 库名的唯一性也走它，于是「项目 组」与「项目组」也算同名。
 * @param s - raw title / kb name / link target.
 * @returns the comparable key ('' for blank input).
 */
export function normalizeTitle(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

const WIKI_LINK_RE = /\[\[([^[\]\n]+)\]\]/g
const WIKI_LINK_STRIP_RE = /\[\[([^[\]\n]+)\]\]/g

/**
 * Extract wiki links in source order.
 * `[[target|display]]` keeps both parts; a bare `[[target]]` is its own display.
 * @param body - note body.
 * @returns `{ target, display }` pairs; duplicates preserved (edge weight = uses).
 */
export function parseWikiLinks(body: string): Array<{ target: string; display: string }> {
  const out: Array<{ target: string; display: string }> = []
  if (!body) return out
  // 全局正则有 lastIndex 状态，逐次调用前必须复位，否则第二次调用会从上次位置续扫。
  WIKI_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null = WIKI_LINK_RE.exec(body)
  while (m !== null) {
    const inner = m[1] ?? ''
    const bar = inner.indexOf('|')
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
    const display = (bar >= 0 ? inner.slice(bar + 1) : inner).trim()
    if (target) out.push({ target, display: display || target })
    m = WIKI_LINK_RE.exec(body)
  }
  return out
}

/** Deduplicated link targets (by resolution key), original casing preserved. */
function uniqueTargets(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of parseWikiLinks(body)) {
    const k = normalizeTitle(l.target)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(l.target)
  }
  return out
}

/** Single-line excerpt with wiki markup flattened to its display text. */
function excerptOf(body: string, limit = 140): string {
  const flat = body
    .replace(WIKI_LINK_STRIP_RE, (_all, inner: unknown) => {
      const s = String(inner)
      const bar = s.indexOf('|')
      return (bar >= 0 ? s.slice(bar + 1) : s).trim()
    })
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** Comma-separated tag cell → trimmed, deduplicated list. */
function parseTags(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const t = part.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function rowToNote(r: Record<string, unknown>): KnowledgeNote {
  const body = cellStr(r['body'] ?? '')
  const note: KnowledgeNote = {
    id: Number(r['id'] ?? 0),
    kbId: Number(r['kb_id'] ?? DEFAULT_KB_ID),
    title: cellStr(r['title'] ?? ''),
    body,
    tags: parseTags(cellStr(r['tags'] ?? '')),
    sourceKind: cellStr(r['source_kind'] ?? 'manual') === 'ask' ? 'ask' : 'manual',
    links: uniqueTargets(body),
    createdAt: Number(r['created_at'] ?? 0),
    updatedAt: Number(r['updated_at'] ?? 0),
  }
  const username = cellStr(r['source_username'] ?? '')
  if (username) note.sourceUsername = username
  const question = cellStr(r['source_question'] ?? '')
  if (question) note.sourceQuestion = question
  return note
}

/**
 * Find one note id by its resolution key **within one knowledge base**.
 *
 * 刻意不在 SQL 里做 lower(trim(title)) 比较：SQLite 的 trim() 只去空格、不会折叠
 * 内部连续空白，与 normalizeTitle 语义不完全一致。笔记量级是「几十到几百」，
 * 全量取回在 JS 里比一次更可靠。
 *
 * `WHERE kb_id = ?` 这条限定就是「多知识库」的全部：两个库各有一篇《项目组》是允许的，
 * 而同一库内仍必须唯一（否则 `[[链接]]` 不知道指向哪一篇）。
 */
function findIdByTitleKey(db: DatabaseSync, kbId: number, key: string): number | undefined {
  if (!key) return undefined
  const rows = db.prepare('SELECT id, title FROM notes WHERE kb_id = ?').all(kbId) as Array<{ id: number; title: string }>
  for (const r of rows) {
    if (normalizeTitle(cellStr(r.title)) === key) return Number(r.id)
  }
  return undefined
}

/** 库名归一化键 → id（`exceptId` 用于改名时排除自己）。 */
function findKbIdByNameKey(db: DatabaseSync, key: string, exceptId?: number): number | undefined {
  const rows = db.prepare('SELECT id, name FROM kbs').all() as Array<Record<string, unknown>>
  for (const r of rows) {
    const id = Number(r['id'] ?? 0)
    if (exceptId !== undefined && id === exceptId) continue
    if (normalizeTitle(cellStr(r['name'])) === key) return id
  }
  return undefined
}

/** 库名校验：空 / 超长都**拒绝**，不静默修正。 */
function validateKbName(raw: string): { name: string } | { error: string } {
  const name = String(raw ?? '').trim()
  if (!name) return { error: '知识库名不能为空' }
  if (name.length > KB_NAME_MAX) return { error: `知识库名最多 ${KB_NAME_MAX} 个字符（当前 ${name.length}）` }
  return { name }
}

/**
 * 把「删 A 库、笔记移到 B 库」时会撞名的条目找出来。
 *
 * 为什么必须拦：合并两个库会让同一归一化标题在**一个库内**出现两次，
 * 而 `findIdByTitleKey` 是「首个命中者胜」——于是 `[[链接]]` 会静默指向其中一篇，
 * 用户看到的是一张「找不到哪里错了」的怪图。宁可拒绝这次合并并列出冲突标题。
 */
function conflictingTitles(db: DatabaseSync, fromKbId: number, toKbId: number): string[] {
  const inTarget = new Set<string>()
  for (const r of db.prepare('SELECT title FROM notes WHERE kb_id = ?').all(toKbId) as Array<Record<string, unknown>>) {
    inTarget.add(normalizeTitle(cellStr(r['title'])))
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of db.prepare('SELECT title FROM notes WHERE kb_id = ?').all(fromKbId) as Array<Record<string, unknown>>) {
    const title = cellStr(r['title'])
    const key = normalizeTitle(title)
    if (!key || seen.has(key)) continue
    if (inTarget.has(key)) {
      seen.add(key)
      out.push(title)
    }
  }
  return out.sort()
}

/**
 * Read result: 既有调用方按 items/total 用不受影响，额外带一个**只在读失败时出现**的
 * `readError` —— 「笔记库读不到」与「确实一条笔记都没有」必须可区分（N1）。
 */
export interface NotesSnapshotRead extends NotesSnapshot {
  /** 读不到库时非空（此时 items 恒为 []）；确无笔记时为 undefined。 */
  readError?: string
}

/** 知识库列表 + 只在读失败时出现的 `readError`（同 `NotesSnapshotRead`）。 */
export interface KbListSnapshotRead extends KbListSnapshot {
  /**
   * 读不到库时非空（此时 items 恒为 []）。
   *
   * ⚠ 调用方**不能**把空列表当成「一个库都没有」而去新建默认库 —— 那会用一个新的空库
   * 盖住真正的问题（库打不开）。`readError` 非空时应当保留上一次的列表并提示可重试。
   */
  readError?: string
}

/**
 * List every knowledge base, oldest id first, with each one's note count.
 *
 * ⚠ `fileCount` 在这里恒为 `0`：文件登记在**另一个** db 文件（`wechat_kb_files.db`）里，
 * 而这一层只打开笔记库。真值由 `gateway.getKbs` 合并 —— 只有那一层同时看得见两个库。
 * 直接拿本函数的返回值渲染删库文案，就会对一个有 5 个文件的库说「这个库是空的」。
 * @param decryptedDir - decrypted data root (locates the note store).
 * @returns the kb list; an empty list plus `readError` only when the store is unreadable.
 */
export function listKbs(decryptedDir: string): KbListSnapshotRead {
  try {
    const db = openStore(decryptedDir)
    const rows = db.prepare('SELECT id, name, created_at, updated_at FROM kbs ORDER BY id ASC').all() as Array<Record<string, unknown>>
    // 一次 GROUP BY 拿全，别在循环里对每个库各查一次
    const counts = db.prepare('SELECT kb_id, COUNT(*) AS n FROM notes GROUP BY kb_id').all() as Array<Record<string, unknown>>
    db.close()
    const byKb = new Map<number, number>()
    for (const c of counts) byKb.set(Number(c['kb_id'] ?? 0), Number(c['n'] ?? 0))
    const items: KbMeta[] = rows.map((r) => {
      const id = Number(r['id'] ?? 0)
      return {
        id,
        name: cellStr(r['name'] ?? ''),
        noteCount: byKb.get(id) ?? 0,
        // 恒为 0：文件库是**另一个** db 文件，这一层看不到它（见函数头注）。
        // 真值由 gateway.getKbs 用 countKbFilesByKb() 覆盖。
        fileCount: 0,
        // 同上：模型设置住在 wechat_kb_models.db，由 gateway.getKbs 合流覆盖。
        // 这里给 0 而不是省略，是为了让「笔记层看不到别的库文件」这件事在类型上留痕。
        modelOverrides: 0,
        createdAt: Number(r['created_at'] ?? 0),
        updatedAt: Number(r['updated_at'] ?? 0),
      }
    })
    return { items, total: items.length }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[notes] 知识库列表读取失败：' + dbPath(decryptedDir) + ': ' + readError)
    return { items: [], total: 0, readError }
  }
}

/**
 * Create one knowledge base.
 * @param name - display name; blank / over-long / duplicate (normalized) are rejected.
 * @returns `{ ok, id }`, or `{ ok: false, error }`.
 */
export function createKb(decryptedDir: string, name: string): KbMutationResult {
  const v = validateKbName(name)
  if ('error' in v) return { ok: false, error: v.error }
  try {
    const db = openStore(decryptedDir)
    if (findKbIdByNameKey(db, normalizeTitle(v.name)) !== undefined) {
      db.close()
      return { ok: false, error: `已存在同名知识库「${v.name}」` }
    }
    const ts = Date.now()
    const r = db.prepare('INSERT INTO kbs(name, created_at, updated_at) VALUES (?, ?, ?)').run(v.name, ts, ts)
    db.close()
    return { ok: true, id: Number(r.lastInsertRowid) }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * Rename one knowledge base.
 *
 * 改名**不动任何笔记**：笔记存的是 `kb_id`，不是库名。用库名当外键的话，
 * 「改名」就变成「迁移全部笔记」，还要处理迁移到一半崩掉。
 * @param id - kb id.
 * @param name - new display name.
 * @returns `{ ok, id }`, or `{ ok: false, error }`.
 */
export function renameKb(decryptedDir: string, id: number, name: string): KbMutationResult {
  const kbId = normalizeKbId(id)
  if (kbId === undefined) return { ok: false, error: '知识库标识无效' }
  const v = validateKbName(name)
  if ('error' in v) return { ok: false, error: v.error }
  try {
    const db = openStore(decryptedDir)
    if (!kbExists(db, kbId)) {
      db.close()
      return { ok: false, error: '知识库不存在' }
    }
    if (findKbIdByNameKey(db, normalizeTitle(v.name), kbId) !== undefined) {
      db.close()
      return { ok: false, error: `已存在同名知识库「${v.name}」` }
    }
    db.prepare('UPDATE kbs SET name = ?, updated_at = ? WHERE id = ?').run(v.name, Date.now(), kbId)
    db.close()
    return { ok: true, id: kbId }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * Delete one knowledge base.
 *
 * `action` **必填**：库里有笔记时删掉它，是「移走」还是「一起删」必须由调用方明说。
 * 后端不提供缺省动作 —— 默认值在这里最危险，它会让一次「我以为只是删个空壳库」
 * 直接把 37 条笔记带走。
 * @param id - kb id; the default kb is refused.
 * @param action - `{kind:'reassign', targetKbId}` or `{kind:'purge'}`.
 * @returns `{ ok, id, movedNotes | removedNotes }`, or `{ ok: false, error }`.
 */
export function deleteKb(decryptedDir: string, id: number, action: KbDeleteAction): KbMutationResult {
  const kbId = normalizeKbId(id)
  if (kbId === undefined) return { ok: false, error: '知识库标识无效' }
  // 默认库同时是「迁移兜底」：删掉它，下一次开库会复活一个空库，用户会以为数据丢了。
  if (kbId === DEFAULT_KB_ID) return { ok: false, error: `「${DEFAULT_KB_NAME}」不可删除，可以重命名` }
  // 类型保证到不了这里，但 Remote 边界是 JSON：漏传 action 最危险的退化恰好是「笔记一起没了」。
  if (action === null || typeof action !== 'object') {
    return { ok: false, error: '删除方式未指定（需明确「移到别的库」还是「一并删除」）' }
  }
  try {
    const db = openStore(decryptedDir)
    if (!kbExists(db, kbId)) {
      db.close()
      return { ok: false, error: '知识库不存在' }
    }
    if (action.kind === 'reassign') {
      const target = normalizeKbId(action.targetKbId)
      if (target === undefined) { db.close(); return { ok: false, error: '目标知识库标识无效' } }
      if (target === kbId) { db.close(); return { ok: false, error: '不能把笔记移到正在删除的库' } }
      if (!kbExists(db, target)) { db.close(); return { ok: false, error: '目标知识库不存在' } }
      const clashes = conflictingTitles(db, kbId, target)
      if (clashes.length > 0) {
        db.close()
        const head = clashes.slice(0, 3).join('、')
        const more = clashes.length > 3 ? ` 等 ${clashes.length} 条` : ''
        return { ok: false, error: `目标库已有同名条目：${head}${more}。请先改名，或改用「一并删除」` }
      }
      let moved = 0
      inTransaction(db, () => {
        moved = Number(db.prepare('UPDATE notes SET kb_id = ? WHERE kb_id = ?').run(target, kbId).changes)
        db.prepare('DELETE FROM kbs WHERE id = ?').run(kbId)
      })
      db.close()
      return { ok: true, id: kbId, movedNotes: moved }
    }
    if (action.kind === 'purge') {
      let removed = 0
      inTransaction(db, () => {
        removed = Number(db.prepare('DELETE FROM notes WHERE kb_id = ?').run(kbId).changes)
        db.prepare('DELETE FROM kbs WHERE id = ?').run(kbId)
      })
      db.close()
      return { ok: true, id: kbId, removedNotes: removed }
    }
    db.close()
    return { ok: false, error: '删除方式无法识别' }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * List notes of one knowledge base, most recently updated first.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param kbId - knowledge base to read; the list, the keyword filter and `total` are all scoped to it.
 * @param options - `query` filters title/body/tags; `limit` caps rows.
 * @returns the note list plus the **same-kb** unpaged total.
 */
export function listNotes(decryptedDir: string, kbId: number, options?: { query?: string; limit?: number }): NotesSnapshotRead {
  const id = normalizeKbId(kbId)
  if (id === undefined) return { items: [], total: 0, readError: '知识库标识无效（kbId 必须是正整数）' }
  try {
    const db = openStore(decryptedDir)
    // 库不存在与库是空的必须分开说：界面上的「知识库还是空的」会让用户去写笔记，
    // 而真正要做的其实是「重新选一个库」。
    if (!kbExists(db, id)) {
      db.close()
      return { items: [], total: 0, readError: '知识库不存在（可能已被删除），请重新选择' }
    }
    const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 500), 1), 2000)
    const q = (options?.query ?? '').trim()
    let rows: Array<Record<string, unknown>>
    if (q) {
      const like = '%' + q + '%'
      rows = db.prepare('SELECT * FROM notes WHERE kb_id = ? AND (title LIKE ? OR body LIKE ? OR tags LIKE ?) ORDER BY updated_at DESC, id DESC LIMIT ?').all(id, like, like, like, limit) as Array<Record<string, unknown>>
    } else {
      rows = db.prepare('SELECT * FROM notes WHERE kb_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(id, limit) as Array<Record<string, unknown>>
    }
    const items = rows.map(rowToNote)
    // total 必须是**本库**的总数：改前是 `COUNT(*)`，多库之后会显示成「12 / 37」这种跨库数。
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM notes WHERE kb_id = ?').get(id) as { n?: number } | undefined
    db.close()
    return { items, total: Number(totalRow?.n ?? items.length) }
  } catch (e) {
    // 库不可读时仍返回空列表而不是抛错（面板不该整块崩掉），但要留痕 + 带上 readError：
    // 改前这里的空列表与「确实没有笔记」在界面上完全一样。
    const readError = errorText(e)
    console.warn('[notes] 笔记库读取失败（与「确无笔记」不同）：' + dbPath(decryptedDir) + ': ' + readError)
    return { items: [], total: 0, readError }
  }
}

/**
 * Create (no `id`) or update (`id` given) one note in one knowledge base.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param kbId - owning knowledge base (new) / expected owner (update).
 * @param input - note fields.
 * @returns the note id, or an error for a blank/duplicate title or a foreign note.
 */
export function saveNote(
  decryptedDir: string,
  kbId: number,
  input: {
    id?: number
    title: string
    body?: string
    tags?: string[] | string
    sourceKind?: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
  },
): NoteMutationResult {
  const id = normalizeKbId(kbId)
  if (id === undefined) return { ok: false, error: '知识库标识无效（kbId 必须是正整数）' }
  const title = String(input.title ?? '').trim()
  if (!title) return { ok: false, error: '标题不能为空' }
  const body = String(input.body ?? '')
  const tags = Array.isArray(input.tags) ? parseTags(input.tags.join(',')) : parseTags(String(input.tags ?? ''))
  const sourceKind = input.sourceKind === 'ask' ? 'ask' : 'manual'
  const noteId = input.id === undefined ? undefined : Math.trunc(Number(input.id))
  try {
    const db = openStore(decryptedDir)
    if (!kbExists(db, id)) {
      db.close()
      return { ok: false, error: '知识库不存在（可能已被删除），请重新选择' }
    }
    const dupId = findIdByTitleKey(db, id, normalizeTitle(title))
    if (dupId !== undefined && dupId !== noteId) {
      db.close()
      return { ok: false, error: `已存在同名笔记「${title}」` }
    }
    const ts = Date.now()
    if (noteId !== undefined && Number.isFinite(noteId)) {
      // 更新走「未提供即保持原值」的合并语义。
      // 否则前端只改个标题就会把没传的 source_kind 打回 'manual' ——
      // 一条「问答沉淀」的笔记会静默降级，笔记详情里的「跳回来源聊天」入口随之消失。
      //
      // `AND kb_id = ?` 是防串库的最后一道：拿着甲库的 id 在乙库里改，
      // 会静默改掉甲库那篇（id 是全局自增的）。加上它之后这种情况返回「笔记不存在」。
      const raw = db.prepare('SELECT * FROM notes WHERE id = ? AND kb_id = ?').get(noteId, id) as Record<string, unknown> | undefined
      if (raw === undefined) { db.close(); return { ok: false, error: '笔记不存在' } }
      const prev = rowToNote(raw)
      const r = db.prepare('UPDATE notes SET title = ?, body = ?, tags = ?, source_kind = ?, source_username = ?, source_question = ?, updated_at = ? WHERE id = ? AND kb_id = ?')
        .run(
          title,
          input.body === undefined ? prev.body : body,
          input.tags === undefined ? prev.tags.join(',') : tags.join(','),
          input.sourceKind === undefined ? prev.sourceKind : sourceKind,
          input.sourceUsername === undefined ? (prev.sourceUsername ?? '') : String(input.sourceUsername),
          input.sourceQuestion === undefined ? (prev.sourceQuestion ?? '') : String(input.sourceQuestion),
          ts,
          noteId,
          id,
        )
      db.close()
      if (r.changes === 0) return { ok: false, error: '笔记不存在' }
      return { ok: true, id: noteId }
    }
    const r = db.prepare('INSERT INTO notes(kb_id, title, body, tags, source_kind, source_username, source_question, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, body, tags.join(','), sourceKind, input.sourceUsername ?? '', input.sourceQuestion ?? '', ts, ts)
    db.close()
    return { ok: true, id: Number(r.lastInsertRowid) }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * Delete one note of one knowledge base (links pointing at it become stubs next build).
 * @param decryptedDir - decrypted data root.
 * @param kbId - expected owner; a row belonging to another kb is **not** deleted.
 * @param id - note id.
 */
export function deleteNote(decryptedDir: string, kbId: number, id: number): NoteMutationResult {
  const kb = normalizeKbId(kbId)
  if (kb === undefined) return { ok: false, error: '知识库标识无效（kbId 必须是正整数）' }
  // 笔记 id 同样来自 Remote 的 JSON 边界。不挡的话 `run(undefined)` 会抛 SQLite 绑定错误，
  // 用户看到的是一句和「删哪一篇」毫无关系的报错 —— 与 kbId 同一个理由。
  const noteId = Math.trunc(Number(id))
  if (!Number.isFinite(noteId) || noteId <= 0) return { ok: false, error: '笔记标识无效' }
  try {
    const db = openStore(decryptedDir)
    // `AND kb_id = ?`：删掉别的库的同 id 笔记是最坏的一种串库（数据直接没了）。
    const r = db.prepare('DELETE FROM notes WHERE id = ? AND kb_id = ?').run(noteId, kb)
    db.close()
    return { ok: r.changes > 0, id: noteId }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/** KnowledgeSnapshot + 只在读失败时出现的 `readError`（同 `NotesSnapshotRead`）。 */
export interface KnowledgeSnapshotRead extends KnowledgeSnapshot {
  /** 读不到库时非空（此时整张图都是空的）；确无笔记时为 undefined。 */
  readError?: string
}

/**
 * Build the knowledge graph snapshot of **one** knowledge base: note nodes,
 * `[[…]]` edges and stubs.
 *
 * 一库一图：`idByKey` 只由本库的笔记构成，因此 `[[链接]]` 永远解析不到别的库去。
 * 跨库同名既不合并、也不报错 —— 它们在各自库里是两条无关的笔记。
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param kbId - the knowledge base to build from.
 * @param names - chat username → display name, for source-chat labels.
 * @returns notes + stubs + edges + summary; an empty graph plus `readError` when unreadable.
 */
export function buildKnowledgeGraph(decryptedDir: string, kbId: number, names: Map<string, string>): KnowledgeSnapshotRead {
  const empty: KnowledgeSnapshotRead = {
    notes: [],
    stubs: [],
    // 文档实体层恒为空：文件登记在**另一个** db 文件里（`wechat_kb_files.db`），
    // 这一层只打开笔记库。合并发生在 gateway 的 getKnowledgeGraph，不在这里。
    docFiles: [],
    docSections: [],
    // 推断层同理：实体是 gateway 从文件库合流进来的，这一层看不见。
    docEntities: [],
    edges: [],
    sessionNames: {},
    summary: { noteCount: 0, linkCount: 0, stubCount: 0, orphanCount: 0, askCount: 0, manualCount: 0, fileCount: 0, sectionCount: 0, entityCount: 0 },
  }
  const id = normalizeKbId(kbId)
  if (id === undefined) return { ...empty, readError: '知识库标识无效（kbId 必须是正整数）' }
  let rows: Array<Record<string, unknown>>
  try {
    const db = openStore(decryptedDir)
    if (!kbExists(db, id)) {
      db.close()
      return { ...empty, readError: '知识库不存在（可能已被删除），请重新选择' }
    }
    rows = db.prepare('SELECT * FROM notes WHERE kb_id = ? ORDER BY updated_at DESC, id DESC').all(id) as Array<Record<string, unknown>>
    db.close()
  } catch (e) {
    // 「知识库为空」与「笔记库读不到」必须可区分：后者整张图都是空的，用户会以为是数据丢了。
    const readError = errorText(e)
    console.warn('[notes] 知识图谱读取失败（与「确无笔记」不同）：' + dbPath(decryptedDir) + ': ' + readError)
    return { ...empty, readError }
  }
  const all = rows.map(rowToNote)
  const idByKey = new Map<string, number>()
  for (const n of all) {
    const key = normalizeTitle(n.title)
    if (key && !idByKey.has(key)) idByKey.set(key, n.id)
  }

  const edges: KnowledgeSnapshot['edges'] = []
  const stubMeta = new Map<string, { label: string; refCount: number; referencedBy: Set<number> }>()
  const outKeys = new Map<number, Set<string>>()
  const backLinks = new Map<number, number>()

  for (const n of all) {
    const seen = new Set<string>()
    const uses = new Map<string, number>()
    const labelByKey = new Map<string, string>()
    for (const l of parseWikiLinks(n.body)) {
      const key = normalizeTitle(l.target)
      if (!key) continue
      seen.add(key)
      uses.set(key, (uses.get(key) ?? 0) + 1)
      // stub 标签用「正文里第一次出现的原始写法」；归一化只用于匹配，不用于展示。
      if (!labelByKey.has(key)) labelByKey.set(key, l.target)
    }
    outKeys.set(n.id, seen)
    for (const [key, weight] of uses) {
      const targetId = idByKey.get(key)
      if (targetId !== undefined) {
        // 自引用不建边（会形成自环），但计入出链数。
        if (targetId === n.id) continue
        edges.push({ source: 'note:' + n.id, target: 'note:' + targetId, weight, kind: 'wiki' })
        backLinks.set(targetId, (backLinks.get(targetId) ?? 0) + 1)
      } else {
        edges.push({ source: 'note:' + n.id, target: 'kb:' + key, weight, kind: 'stub' })
        let s = stubMeta.get(key)
        if (!s) {
          s = { label: labelByKey.get(key) ?? key, refCount: 0, referencedBy: new Set<number>() }
          stubMeta.set(key, s)
        }
        s.refCount += weight
        s.referencedBy.add(n.id)
      }
    }
  }

  const notes: KnowledgeSnapshot['notes'] = all.map(n => ({
    id: n.id,
    title: n.title,
    excerpt: excerptOf(n.body),
    tags: n.tags,
    sourceKind: n.sourceKind,
    ...(n.sourceUsername ? { sourceUsername: n.sourceUsername } : {}),
    ...(n.sourceQuestion ? { sourceQuestion: n.sourceQuestion } : {}),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    outLinks: outKeys.get(n.id)?.size ?? 0,
    backLinks: backLinks.get(n.id) ?? 0,
  }))

  const stubs = [...stubMeta.entries()]
    .map(([key, s]) => ({ key, label: s.label, refCount: s.refCount, referencedBy: [...s.referencedBy].sort((a, b) => a - b) }))
    .sort((a, b) => b.refCount - a.refCount || a.label.localeCompare(b.label))

  const sessionNames: Record<string, string> = {}
  for (const n of all) {
    if (!n.sourceUsername || sessionNames[n.sourceUsername] !== undefined) continue
    sessionNames[n.sourceUsername] = names.get(n.sourceUsername) || n.sourceUsername
  }

  edges.sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target))

  return {
    notes,
    stubs,
    docFiles: [],
    docSections: [],
    docEntities: [],
    edges,
    sessionNames,
    summary: {
      noteCount: notes.length,
      linkCount: edges.filter(e => e.kind === 'wiki').length,
      stubCount: stubs.length,
      // 「孤立」只数笔记：加了文档实体层之后，一个没有任何 wiki 链接的笔记仍然叫孤立，
      // 而一份没有章节、也没被提到的文件是不是「孤立」是另一回事，交给界面表达。
      orphanCount: notes.filter(n => n.outLinks === 0 && n.backLinks === 0).length,
      askCount: notes.filter(n => n.sourceKind === 'ask').length,
      manualCount: notes.filter(n => n.sourceKind === 'manual').length,
      fileCount: 0,
      sectionCount: 0,
      entityCount: 0,
    },
  }
}

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
 * 标题在库内唯一（同一归一化规则），否则 [[链接]] 的解析会产生歧义。
 * 本模块只读写本地库，不出网、不调用模型。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { KnowledgeNote, KnowledgeSnapshot, NoteMutationResult, NotesSnapshot } from '../types.ts'

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_notes.db')
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
  db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT \'\', tags TEXT NOT NULL DEFAULT \'\', source_kind TEXT NOT NULL DEFAULT \'manual\', source_username TEXT NOT NULL DEFAULT \'\', source_question TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
  return db
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
 * Resolution key for note titles and `[[target]]` values.
 *
 * 归一化只做三件事：去首尾空白、内部连续空白折叠成一个空格、转小写。
 * 标题唯一性与链接解析必须共用这一个函数 —— 两处若各写一套，会出现
 * 「保存时任为同名、链接时却解析不到」这类只在特定空白/大小写下复现的怪问题。
 * @param s - raw title or link target.
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
 * Find one note id by its resolution key.
 *
 * 刻意不在 SQL 里做 lower(trim(title)) 比较：SQLite 的 trim() 只去空格、不会折叠
 * 内部连续空白，与 normalizeTitle 语义不完全一致。笔记量级是「几十到几百」，
 * 全量取回在 JS 里比一次更可靠。
 */
function findIdByTitleKey(db: DatabaseSync, key: string): number | undefined {
  if (!key) return undefined
  const rows = db.prepare('SELECT id, title FROM notes').all() as Array<{ id: number; title: string }>
  for (const r of rows) {
    if (normalizeTitle(cellStr(r.title)) === key) return Number(r.id)
  }
  return undefined
}

/**
 * Read result: 既有调用方按 items/total 用不受影响，额外带一个**只在读失败时出现**的
 * `readError` —— 「笔记库读不到」与「确实一条笔记都没有」必须可区分（N1）。
 */
export interface NotesSnapshotRead extends NotesSnapshot {
  /** 读不到库时非空（此时 items 恒为 []）；确无笔记时为 undefined。 */
  readError?: string
}

/**
 * List notes, most recently updated first.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param options - `query` filters title/body/tags; `limit` caps rows.
 * @returns the note list plus the unpaged total.
 */
export function listNotes(decryptedDir: string, options?: { query?: string; limit?: number }): NotesSnapshotRead {
  try {
    const db = openStore(decryptedDir)
    const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 500), 1), 2000)
    const q = (options?.query ?? '').trim()
    let rows: Array<Record<string, unknown>>
    if (q) {
      const like = '%' + q + '%'
      rows = db.prepare('SELECT * FROM notes WHERE title LIKE ? OR body LIKE ? OR tags LIKE ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(like, like, like, limit) as Array<Record<string, unknown>>
    } else {
      rows = db.prepare('SELECT * FROM notes ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
    }
    const items = rows.map(rowToNote)
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n?: number } | undefined
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
 * Create (no `id`) or update (`id` given) one note.
 * @returns the note id, or an error for a blank/duplicate title.
 */
export function saveNote(
  decryptedDir: string,
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
  const title = String(input.title ?? '').trim()
  if (!title) return { ok: false, error: '标题不能为空' }
  const body = String(input.body ?? '')
  const tags = Array.isArray(input.tags) ? parseTags(input.tags.join(',')) : parseTags(String(input.tags ?? ''))
  const sourceKind = input.sourceKind === 'ask' ? 'ask' : 'manual'
  const id = input.id === undefined ? undefined : Math.trunc(Number(input.id))
  try {
    const db = openStore(decryptedDir)
    const dupId = findIdByTitleKey(db, normalizeTitle(title))
    if (dupId !== undefined && dupId !== id) {
      db.close()
      return { ok: false, error: `已存在同名笔记「${title}」` }
    }
    const ts = Date.now()
    if (id !== undefined && Number.isFinite(id)) {
      // 更新走「未提供即保持原值」的合并语义。
      // 否则前端只改个标题就会把没传的 source_kind 打回 'manual' ——
      // 一条「问答沉淀」的笔记会静默降级，融合视图里连到来源会话的那条边随之消失。
      const raw = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (raw === undefined) { db.close(); return { ok: false, error: '笔记不存在' } }
      const prev = rowToNote(raw)
      const r = db.prepare('UPDATE notes SET title = ?, body = ?, tags = ?, source_kind = ?, source_username = ?, source_question = ?, updated_at = ? WHERE id = ?')
        .run(
          title,
          input.body === undefined ? prev.body : body,
          input.tags === undefined ? prev.tags.join(',') : tags.join(','),
          input.sourceKind === undefined ? prev.sourceKind : sourceKind,
          input.sourceUsername === undefined ? (prev.sourceUsername ?? '') : String(input.sourceUsername),
          input.sourceQuestion === undefined ? (prev.sourceQuestion ?? '') : String(input.sourceQuestion),
          ts,
          id,
        )
      db.close()
      if (r.changes === 0) return { ok: false, error: '笔记不存在' }
      return { ok: true, id }
    }
    const r = db.prepare('INSERT INTO notes(title, body, tags, source_kind, source_username, source_question, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(title, body, tags.join(','), sourceKind, input.sourceUsername ?? '', input.sourceQuestion ?? '', ts, ts)
    db.close()
    return { ok: true, id: Number(r.lastInsertRowid) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Delete one note (links pointing at it become stubs on the next build). */
export function deleteNote(decryptedDir: string, id: number): NoteMutationResult {
  try {
    const db = openStore(decryptedDir)
    const r = db.prepare('DELETE FROM notes WHERE id = ?').run(id)
    db.close()
    return { ok: r.changes > 0, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** KnowledgeSnapshot + 只在读失败时出现的 `readError`（同 `NotesSnapshotRead`）。 */
export interface KnowledgeSnapshotRead extends KnowledgeSnapshot {
  /** 读不到库时非空（此时整张图都是空的）；确无笔记时为 undefined。 */
  readError?: string
}

/**
 * Build the knowledge graph snapshot: note nodes, `[[…]]` edges and stubs.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param names - chat username → display name, for source-chat labels.
 * @returns notes + stubs + edges + summary; an empty graph plus `readError` when the store is unreadable.
 */
export function buildKnowledgeGraph(decryptedDir: string, names: Map<string, string>): KnowledgeSnapshotRead {
  const empty: KnowledgeSnapshotRead = {
    notes: [],
    stubs: [],
    edges: [],
    sessionNames: {},
    summary: { noteCount: 0, linkCount: 0, stubCount: 0, orphanCount: 0, askCount: 0, manualCount: 0 },
  }
  let rows: Array<Record<string, unknown>>
  try {
    const db = openStore(decryptedDir)
    rows = db.prepare('SELECT * FROM notes ORDER BY updated_at DESC, id DESC').all() as Array<Record<string, unknown>>
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
    edges,
    sessionNames,
    summary: {
      noteCount: notes.length,
      linkCount: edges.filter(e => e.kind === 'wiki').length,
      stubCount: stubs.length,
      orphanCount: notes.filter(n => n.outLinks === 0 && n.backLinks === 0).length,
      askCount: notes.filter(n => n.sourceKind === 'ask').length,
      manualCount: notes.filter(n => n.sourceKind === 'manual').length,
    },
  }
}

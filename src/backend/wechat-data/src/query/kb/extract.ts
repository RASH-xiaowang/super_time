/**
 * 文档实体抽取 —— 知识图谱的**推断层**。
 *
 * ── 与 `entities.ts` 的关系：并列、互不引用 ─────────────────────────────
 *   `entities.ts` 是**观测层**：全部本地、确定性、不出网、不调模型，产出的是
 *   「文档里确实存在的章节」与「确实提到了某个名字的边」。那三条规矩原样保留。
 *   本模块是**推断层**：让模型读一遍文件，说出它认为里面有哪些实体。
 *   两者必须分开，因为**可信度不同**：观测到的东西可以当事实引用，
 *   推断出来的东西必须标成推断（画布上是虚线），否则模型的一次幻觉就成了
 *   用户知识库里「确实有关系」的假证据。合流发生在 gateway 的 `getKnowledgeGraph`，
 *   边 kind 用 `suggest` 区分。
 *
 * ── 为什么按文件、不按 chunk（沿用 entities.ts 头注那条理由）─────────────
 *   一个 38 块的文件按块抽就是 38 次请求，成本与失败率都乘以块数，
 *   而产出（同一批主题词）高度重复。按文件一次出全篇，粒度够用。
 *
 * ── 为什么模型只「说名字」，不「建链接」────────────────────────────────
 *   本模块写的是 `kb_doc_entities` 这张**独立表**，绝不碰笔记正文、也不写 wiki 边。
 *   链接永远只由笔记正文里的 `[[目标]]` 派生（`notes.ts` 的 `parseWikiLinks`）。
 *   这样「模型建议过但用户没采纳」的东西不会出现在图上，
 *   撤销一个建议 = 删那几个字，不需要「回滚一次模型写入」。
 */
import { DatabaseSync } from 'node:sqlite'
import { kbFilesDbPath } from '../kb-paths.ts'

/** 实体表的表名（守卫用例按名字断言）。 */
export const KB_ENTITIES_TABLE = 'kb_doc_entities'

/** 允许的实体类别。模型给出别的值一律归到 `topic`（而不是照收）。 */
export const ENTITY_KINDS = ['person', 'org', 'product', 'place', 'topic'] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

/** 一条抽出来的实体。 */
export interface DocEntity {
  fileId: number
  fileName: string
  label: string
  kind: EntityKind
  /** 模型给的重要度（0-100）；缺失时按 50。 */
  weight: number
  /** 是哪个模型抽的（换模型后用户要能看出这批不是当前模型给的）。 */
  model: string
  /** 抽取时间（毫秒）。 */
  at: number
}

/** 一次抽取的落库结果。 */
export interface ExtractResult {
  ok: boolean
  fileId?: number
  /** 写进去的实体条数。 */
  saved?: number
  /** 模型返回但被丢弃的行数（格式不对 / 名字过长 / 重复）。 */
  dropped?: number
  error?: string
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/** 标签长度上下限：短到一个字基本是噪声，长到像一句话就不是实体名。 */
const MIN_LABEL = 2
const MAX_LABEL = 40
/** 单个文件最多留多少条实体（模型爱堆列表，不封顶会把图谱画成一团毛线）。 */
export const MAX_ENTITIES_PER_FILE = 24

/**
 * 解析模型返回的实体清单。
 *
 * 期望每行 `kind|label` 或 `kind<TAB>label`，可选第三段是重要度。
 * 实现上**极尽宽容**：Markdown 列表符号、引号、`-`/`*` 前缀、大小写、多余空格都吃掉；
 * 但**不猜**结构 —— 解析不出来的行直接丢，计入 `dropped`。
 * 为什么不做成抛错：一次格式跑偏就让整轮抽取失败，用户看到的是「又白发了一个请求」。
 * @param raw - 模型原文。
 * @returns 解析出的实体（已去重、已截断、已封顶）。
 */
export function parseEntityLines(raw: string): { items: Array<{ label: string; kind: EntityKind; weight: number }>; dropped: number } {
  const out: Array<{ label: string; kind: EntityKind; weight: number }> = []
  const seen = new Set<string>()
  let dropped = 0
  for (const line0 of String(raw ?? '').split(/\r?\n/)) {
    // 去掉列表符号与包裹引号：模型经常回 `- person | 张三` 或 `"org","某公司"`
    const line = line0.replace(/^\s*[-*•\d.、\s]+/, '').replace(/^["'`]+|["'`]+$/g, '').trim()
    if (line === '') continue
    const parts = line.split(/[|\t]/).map(p => p.replace(/^["'`]+|["'`]+$/g, '').trim()).filter(p => p !== '')
    // 先解构再判空：`parts[0]` 在这个开关下是 `string | undefined`，而下面每个分支用的都是
    // 「已经验过长度」的位置 —— 用解构把它们一次性钉成 `string`，比在每处兜缺省值更难读错。
    const [first, second, third] = parts
    if (first === undefined) { dropped += 1; continue }
    const last = parts.at(-1)
    // 允许两种顺序：`kind|label` 与 `label|kind`（前者是指定格式，后者是模型常犯的）
    let kindRaw = ''
    let label = ''
    let weightRaw = ''
    if (second !== undefined && (ENTITY_KINDS as readonly string[]).includes(first.toLowerCase())) {
      kindRaw = first.toLowerCase()
      label = second
      weightRaw = third ?? ''
    } else if (last !== undefined && (ENTITY_KINDS as readonly string[]).includes(last.toLowerCase())) {
      kindRaw = last.toLowerCase()
      label = first
      weightRaw = second ?? ''
    } else if (parts.length === 1) {
      // 只给了名字：类别归 topic，不猜别的
      label = first
    } else {
      dropped += 1
      continue
    }
    const kind: EntityKind = (ENTITY_KINDS as readonly string[]).includes(kindRaw) ? kindRaw as EntityKind : 'topic'
    const clean = label.replace(/^[\s:：,，]+|[\s.。;；,，]+$/g, '')
    if (clean.length < MIN_LABEL || clean.length > MAX_LABEL) { dropped += 1; continue }
    const key = kind + '\u0000' + clean.toLowerCase()
    if (seen.has(key)) { dropped += 1; continue }
    seen.add(key)
    const w = Number(weightRaw)
    // 空串会被 `Number('')` 变成 0，而 0 是合法分数（等于「不重要」）——
    // 没给重要度时必须落回 50，否则模型少写一列，这个实体在图上就直接隐形了。
    out.push({
      label: clean,
      kind,
      weight: weightRaw !== '' && Number.isFinite(w) ? Math.max(0, Math.min(100, Math.round(w))) : 50,
    })
    if (out.length >= MAX_ENTITIES_PER_FILE) break
  }
  return { items: out, dropped }
}

/**
 * 造一个文件的抽取提示词。
 *
 * 三条内容约束都写在这里而不是靠 system 提示：
 *   · 只写文档里出现过的名字（防「补全常识」）；
 *   · 宁少勿多（模型爱堆一串通用词，那些在图上没有信息量）；
 *   · 严格行格式（解析器已经尽量宽容，但格式跑偏的代价是丢行）。
 * @param fileName - 文件名（模型判断类别时很依赖它）。
 * @param digest - 已经按预算截断过的正文摘要串。
 * @param truncated - 是否被截断过：截断过就必须写明，否则模型会声称这是整份文件的实体。
 * @returns 提示词。
 */
export function buildExtractPrompt(fileName: string, digest: string, truncated: boolean): string {
  const scope = truncated ? '（以下只是文件开头部分，被截掉了）' : '（全文）'
  return `请从下面这份文档里抽出**明确的实体**，每行一条，格式：类别|名称|重要度0-100
类别只能是：person（人名）、org（机构/公司）、product（产品/系统）、place（地名）、topic（主题词）。
要求：
1. 只抽文档里**出现过名字**的实体，不要补全你已知的常识，不要推测；
2. 宁少勿多：通用词（如「项目」「数据」「方案」）不算实体；
3. 名称不超过 20 个字，不带标点与解释；
4. 文件名：${fileName} ${scope}
正文：
${digest}`
}

/** 确保实体表存在（在文件库里，与 `kb_files` 同库 —— 它数的是「这个库的文件里有什么」）。 */
function ensureEntitiesTable(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS ' + KB_ENTITIES_TABLE + ' ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id INTEGER NOT NULL, file_id INTEGER NOT NULL, '
    + 'label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT \'topic\', weight INTEGER NOT NULL DEFAULT 50, '
    + "model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, "
    + 'UNIQUE(kb_id, file_id, label))')
  db.exec('CREATE INDEX IF NOT EXISTS idx_kb_entities_kb ON ' + KB_ENTITIES_TABLE + '(kb_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_kb_entities_file ON ' + KB_ENTITIES_TABLE + '(file_id)')
}

/**
 * 读某个文件的正文摘要（**只取参与 RAG 的文件**）。
 *
 * 与向量语料同一条 SQL 口径：关掉出网开关的文件连一次抽取都不该有机会被发出去。
 * @param db - 已打开的文件库连接。
 * @param kbId - 库。
 * @param fileId - 文件。
 * @param budget - 字符预算。
 * @returns `{ text, totalChars, truncated }`；文件不属于该库时返回 null。
 */
export function readDigestForExtract(
  db: DatabaseSync, kbId: number, fileId: number, budget: number,
): { text: string; totalChars: number; truncated: boolean } | null {
  const owner = db.prepare('SELECT id, name, char_count FROM kb_files WHERE id = ? AND kb_id = ? AND include_in_rag = 1')
    .get(fileId, kbId) as Record<string, unknown> | undefined
  if (!owner) return null
  const rows = db.prepare('SELECT heading, text FROM kb_chunks WHERE file_id = ? AND kb_id = ? ORDER BY ordinal')
    .all(fileId, kbId) as Array<Record<string, unknown>>
  let text = ''
  let truncated = false
  const totalChars = Number(owner['char_count'] ?? 0)
  for (const r of rows) {
    const heading = String(r['heading'] ?? '')
    const body = String(r['text'] ?? '')
    const piece = (heading !== '' ? `【${heading}】\n` : '') + body
    if (text.length >= budget) { truncated = true; break }
    const room = budget - text.length
    if (room < piece.length) { text += piece.slice(0, room); truncated = true } else text += piece
    text += '\n\n'
  }
  return { text: text.trim(), totalChars, truncated }
}

/**
 * 写入一个文件的实体（**整批替换**该文件的上一次结果）。
 *
 * 为什么是替换而不是追加：同一个文件重跑一次抽取，旧结果不是「另一批事实」，
 * 而是「同一个问题的旧答案」。追加会让图谱里同一个文件挂出两套互相矛盾的主题词。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @param fileId - 文件。
 * @param items - 解析好的实体。
 * @param model - 用的模型名。
 * @returns `{ ok, saved }`。
 */
export function saveDocEntities(
  decryptedDir: string, kbId: number, fileId: number,
  items: ReadonlyArray<{ label: string; kind: EntityKind; weight: number }>, model: string,
): { ok: boolean; saved: number; error?: string } {
  const at = Date.now()
  try {
    const db = new DatabaseSync(kbFilesDbPath(decryptedDir))
    try {
      ensureEntitiesTable(db)
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM ' + KB_ENTITIES_TABLE + ' WHERE kb_id = ? AND file_id = ?').run(kbId, fileId)
        const ins = db.prepare('INSERT OR REPLACE INTO ' + KB_ENTITIES_TABLE
          + '(kb_id, file_id, label, kind, weight, model, created_at) VALUES(?,?,?,?,?,?,?)')
        for (const it of items) ins.run(kbId, fileId, it.label, it.kind, it.weight, model, at)
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 没有事务 */ }
        throw e
      }
    } finally {
      db.close()
    }
    return { ok: true, saved: items.length }
  } catch (e) {
    return { ok: false, saved: 0, error: errorText(e) }
  }
}

/**
 * 抽取一个文件的实体（模型调用由调用方注入 —— 隐私闸门与模型名解析都住在 gateway）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @param fileId - 文件。
 * @param ask - 「提示词 → 模型原文」的函数（已含出网闸门）。
 * @param model - 记账用的模型名。
 * @param budget - 送给模型的字符预算。
 * @returns 抽取结果。
 */
export async function extractFileEntities(
  decryptedDir: string, kbId: number, fileId: number,
  ask: (prompt: string) => Promise<string>, model: string, budget = 8000,
): Promise<ExtractResult> {
  const db = new DatabaseSync(kbFilesDbPath(decryptedDir))
  let digest: ReturnType<typeof readDigestForExtract>
  let name = ''
  try {
    ensureEntitiesTable(db)
    digest = readDigestForExtract(db, kbId, fileId, budget)
    const row = db.prepare('SELECT name FROM kb_files WHERE id = ? AND kb_id = ?').get(fileId, kbId) as { name?: string } | undefined
    name = String(row?.name ?? '')
  } finally {
    db.close()
  }
  if (digest === null) return { ok: false, error: '文件不存在、不属于当前知识库，或已关闭「参与语义检索」' }
  if (digest.text === '') return { ok: false, error: '这个文件没有可抽取的正文' }
  let raw = ''
  try {
    raw = await ask(buildExtractPrompt(name, digest.text, digest.truncated))
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
  const parsed = parseEntityLines(raw)
  const saved = saveDocEntities(decryptedDir, kbId, fileId, parsed.items, model)
  if (!saved.ok) return { ok: false, saved: 0, dropped: parsed.dropped, error: saved.error }
  return { ok: true, fileId, saved: saved.saved, dropped: parsed.dropped }
}

/**
 * 读某个库的全部实体（图谱合流用）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @returns 实体列表；读失败时返回空列表 + 原因（不抛错 —— 图谱不能因为推断层坏了就整页打不开）。
 */
export function readDocEntities(decryptedDir: string, kbId: number): { items: DocEntity[]; readError?: string } {
  try {
    const db = new DatabaseSync(kbFilesDbPath(decryptedDir), { readOnly: true })
    let rows: Array<Record<string, unknown>> = []
    try {
      ensureEntitiesTableReadOnly(db)
      rows = db.prepare(
        'SELECT e.file_id AS file_id, f.name AS file_name, e.label AS label, e.kind AS kind, '
        + 'e.weight AS weight, e.model AS model, e.created_at AS created_at '
        + 'FROM ' + KB_ENTITIES_TABLE + ' e JOIN kb_files f ON f.id = e.file_id '
        + 'WHERE e.kb_id = ? ORDER BY e.weight DESC, e.label ASC',
      ).all(kbId) as Array<Record<string, unknown>>
    } catch {
      // 表还不存在（这个库从没抽过实体）⇒ 空，不是错误
      rows = []
    } finally {
      db.close()
    }
    return {
      items: rows.map(r => ({
        fileId: Number(r['file_id'] ?? 0),
        fileName: String(r['file_name'] ?? ''),
        label: String(r['label'] ?? ''),
        kind: (ENTITY_KINDS as readonly string[]).includes(String(r['kind'])) ? String(r['kind']) as EntityKind : 'topic',
        weight: Number(r['weight'] ?? 50) || 0,
        model: String(r['model'] ?? ''),
        at: Number(r['created_at'] ?? 0) || 0,
      })),
    }
  } catch (e) {
    return { items: [], readError: errorText(e) }
  }
}

/** 只读连接上不能建表 —— 表不存在就让调用方按「没有实体」处理。 */
function ensureEntitiesTableReadOnly(db: DatabaseSync): void {
  const hit = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(KB_ENTITIES_TABLE)
  if (!hit) throw new Error('no-entities-table')
}

/** 弹层里「实体抽取」那一行的数据。 */
export interface KbEntitySummary {
  /** 开着「参与语义检索」的文件数 —— 只有这些能被抽取，也是按钮上该写的分母。 */
  ragFiles: number
  /** 里面还没抽过的有几个。 */
  pending: number
  /** 已存的实体条数。 */
  entities: number
  /** 这些实体是哪个模型抽的（多个时取最近一次）；空串 = 一条都没有。 */
  model: string
}

/**
 * 本库实体抽取的**进度概览**（给「模型」弹层那一行用，不给图谱用）。
 *
 * 与 `readDocEntities` 分开是因为两者要的粒度不同：图谱要每一条实体，这里只要四个数；
 * 而且读路径一样**不建表** —— 这个库从没抽过时答案就是「0 / 全都没抽」，不是报错。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @returns 概览（读失败给全零，让界面照常渲染，再由别的通道报错）。
 */
export function kbEntitySummary(decryptedDir: string, kbId: number): KbEntitySummary {
  const empty: KbEntitySummary = { ragFiles: 0, pending: 0, entities: 0, model: '' }
  const kb = Math.trunc(Number(kbId))
  if (!Number.isFinite(kb) || kb <= 0) return empty
  try {
    const db = new DatabaseSync(kbFilesDbPath(decryptedDir), { readOnly: true })
    try {
      const ragFiles = Number((db.prepare('SELECT COUNT(*) AS c FROM kb_files WHERE kb_id = ? AND include_in_rag = 1')
        .get(kb) as { c?: number }).c ?? 0)
      let entities = 0
      let pending = ragFiles
      let model = ''
      try {
        ensureEntitiesTableReadOnly(db)
        // LEFT JOIN 数「一个实体都没有的文件」：按钮要告诉用户还有几个没抽，
        // 而不是只报「已抽 N 条」—— 后者在「抽了 3 个文件各 20 条」时看起来像快做完了。
        const agg = db.prepare('SELECT COUNT(*) AS c FROM '
          + KB_ENTITIES_TABLE + ' WHERE kb_id = ?').get(kb) as { c?: number }
        entities = Number(agg?.c ?? 0)
        if (entities > 0) {
          // 「最近一次用的模型」按时间取，不能按 model 字符串取最大 —— 字母序会把
          // 「上个月换回去的旧模型」报成当前这批里最新的那个。
          const last = db.prepare('SELECT model FROM ' + KB_ENTITIES_TABLE
            + ' WHERE kb_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(kb) as { model?: string }
          model = String(last?.model ?? '')
        }
        pending = (db.prepare('SELECT COUNT(*) AS c FROM kb_files f '
          + 'LEFT JOIN (SELECT DISTINCT file_id FROM ' + KB_ENTITIES_TABLE + ' WHERE kb_id = ?) e ON e.file_id = f.id '
          + 'WHERE f.kb_id = ? AND f.include_in_rag = 1 AND e.file_id IS NULL').all(kb, kb) as Array<{ c?: number }>)[0]?.c ?? 0
      } catch {
        // 表还没建：一条都没抽过
      }
      return { ragFiles, pending: Number(pending) || 0, entities, model }
    } finally {
      db.close()
    }
  } catch {
    return empty
  }
}

/** 图谱要的那种实体节点形状（与 `types.ts` 的 `docEntities` 元素一致）。 */
export interface EntityNode {
  key: string
  label: string
  kind: string
  files: Array<{ id: number; weight: number }>
  occurrences: number
  model: string
  at: number
}

/** 归一化 key：与章节层同一口径（小写 + 压空格），否则「张三 」与「张三」会画成两个点。 */
function entityKey(label: string, kind: string): string {
  return kind + ':' + label.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * 把逐文件的实体合并成**图谱节点 + `suggest` 边**。
 *
 * 合并的是「同一个 label 在多个文件里被抽出」⇒ 一个节点、多条边，
 * 因为「三份文件都提到同一个人」正是跨文档结构里最有信息量的一件事。
 * 但**每个文件只留一条边**（权重取该文件里该实体的最高分）——
 * 同一文件重复出边只会把图变成毛线，而那份重复并不增加任何证据。
 * @param items - `readDocEntities` 的结果。
 * @returns 节点 + 边（边的 kind 恒为 `suggest`，画布据此画虚线）。
 */
export function mergeDocEntities(items: ReadonlyArray<DocEntity>): {
  nodes: EntityNode[]
  edges: Array<{ source: string; target: string; weight: number; kind: 'suggest' }>
} {
  const byKey = new Map<string, { node: EntityNode; perFile: Map<number, number> }>()
  for (const e of items) {
    const key = entityKey(e.label, e.kind)
    let slot = byKey.get(key)
    if (slot === undefined) {
      slot = { node: { key, label: e.label, kind: e.kind, files: [], occurrences: 0, model: e.model, at: e.at }, perFile: new Map() }
      byKey.set(key, slot)
    }
    slot.node.occurrences += 1
    // 同名实体在不同文件被不同模型抽出时，节点上记**最早那个**之外的信息没有意义 ——
    // 保留最近一次的时间与模型，界面上说「这批里最新一次是 X」。
    if (e.at > slot.node.at) { slot.node.at = e.at; slot.node.model = e.model }
    const prev = slot.perFile.get(e.fileId) ?? 0
    if (e.weight > prev) slot.perFile.set(e.fileId, e.weight)
  }
  const nodes: EntityNode[] = []
  const edges: Array<{ source: string; target: string; weight: number; kind: 'suggest' }> = []
  for (const slot of byKey.values()) {
    slot.node.files = [...slot.perFile.entries()].map(([id, weight]) => ({ id, weight })).sort((a, b) => b.weight - a.weight)
    nodes.push(slot.node)
    for (const f of slot.node.files) {
      edges.push({ source: `file:${f.id}`, target: `ent:${slot.node.key}`, weight: f.weight, kind: 'suggest' })
    }
  }
  nodes.sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label))
  return { nodes, edges }
}

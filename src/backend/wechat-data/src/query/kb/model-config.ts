/**
 * 每个知识库的**模型选择**（独立文件 `wechat_kb_models.db`）。
 *
 * ── 这张表只存「选择」，不存凭据 ────────────────────────────────────────
 *   API Key / base_url 永远只在 `llm.json` 里（那份文件在主进程侧读写、有原子写与损坏备份）。
 *   这里一行一个库，三个角色各存一个**引用串**：
 *     · `''`          继承全局（= 当前生效的那套配置）；
 *     · `m:<模型名>`  端点与凭据沿用全局，只把模型名换掉。
 *   为什么没有 `p:<profileId>`：一条 profile 是一套**同厂商的**连接参数（地址 + Key + 三个模型名），
 *   按库引用它意味着每次调用都要带着那条 profile 的地址与 Key 走 —— 而「A 家地址 + B 家 Key」
 *   正是 profile 这套东西当初要消灭的 401 陷阱。真要按库换厂商，正确的做法是换全局生效的那一条，
 *   而不是让每个库各自持有一份凭据引用。这一条是**有意的收窄**，理由记在
 *   `docs/KB-MODEL-CONFIG.md` §4.2 的落地备注里。
 *
 * ── 为什么不并进 `kbs` 表（C1）──────────────────────────────────────────
 *   `notes.ts` 的头注自述「只读写本地库，不出网、不调用模型」。把「本库用哪个模型出网」
 *   写进它的表，等于让笔记模块成为模型配置的载体之一。删库时由 gateway 反向清这一行
 *   （与 `kbFilesOnKbDelete` 同一个位置、同一种 best-effort 语义）。
 *
 * ── 为什么不与向量信息同处 ──────────────────────────────────────────────
 *   「本库向量是哪个模型算的」住在 `wechat_kb_vectors.db` 的**行**上
 *   （`kb_vectors.model`），因为那是派生数据的属性；这里存的是用户的**意愿**。
 *   两者一旦同处，就会出现「改了设置但向量还没重算」时不知道以谁为准。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { kbModelsDbPath } from '../kb-paths.ts'

/** 三个可分别配置的角色。 */
export type KbModelRole = 'chat' | 'embed' | 'rerank'

/** 一个角色的引用串能出现的三种形状。 */
export type ModelRef = string

/** 某个库的模型设置（三个引用 + 最后一次实体抽取时间）。 */
export interface KbModelSettings {
  kbId: number
  chatRef: ModelRef
  embedRef: ModelRef
  rerankRef: ModelRef
  /** 本库最后一次「模型抽实体」的时间（毫秒）；0 = 从未。 */
  entitiesAt: number
  updatedAt: number
}

/** 解析结果：最终模型名 + 它是从哪儿来的。 */
export interface ResolvedModel {
  /** 实际要用的模型名；空串 = 这个角色没配（调用方据此静默关闭能力）。 */
  model: string
  /** 名字来自库级覆盖还是全局。 */
  source: 'inherit' | 'inline'
  /** 原始引用串（界面要把它回填到下拉框里）。 */
  ref: ModelRef
}

/** 表名（守卫用例按名字断言，所以不写字面量在两处）。 */
export const KB_MODELS_TABLE = 'kb_models'

/** `m:` 前缀：只点名模型，端点与凭据沿用全局。 */
const INLINE_PREFIX = 'm:'

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/**
 * 校验一个引用串。
 *
 * 不合法的输入**不静默纠正成 `''`** —— 那会把用户刚打错的一个模型名变成「继承全局」，
 * 而界面上看起来保存成功了。这里返回 null 让写路径明确拒绝。
 * @param ref - 原始串。
 * @returns 规范化后的引用串；不合法时为 null。
 */
export function normalizeModelRef(ref: unknown): ModelRef | null {
  if (ref === undefined || ref === null) return ''
  if (typeof ref !== 'string') return null
  const s = ref.trim()
  if (s === '') return ''
  if (!s.startsWith(INLINE_PREFIX)) return null
  const name = s.slice(INLINE_PREFIX.length).trim()
  // 模型名上限 120：够写 `BAAI/bge-reranker-v2-m3`，又能挡住有人把整段文本粘进输入框
  // （这个值最终会出现在发给模型的请求体与审计里）。
  if (name === '' || name.length > 120) return null
  return INLINE_PREFIX + name
}

/** 打开（并建表）设置库。与 `kb-files.ts` 的 `openStore` 同一套目录兜底理由。 */
function openModelsDb(decryptedDir: string, readOnly = false): DatabaseSync {
  const file = kbModelsDbPath(decryptedDir)
  if (!readOnly) {
    try { mkdirSync(dirname(file), { recursive: true }) } catch (e) {
      console.warn('[kb-models] 数据根目录创建失败，继续尝试打开库：' + errorText(e))
    }
  }
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {})
  if (!readOnly) {
    db.exec('CREATE TABLE IF NOT EXISTS ' + KB_MODELS_TABLE + ' ('
      + 'kb_id INTEGER PRIMARY KEY, chat_ref TEXT NOT NULL DEFAULT \'\', '
      + 'embed_ref TEXT NOT NULL DEFAULT \'\', rerank_ref TEXT NOT NULL DEFAULT \'\', '
      + 'entities_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)')
  }
  return db
}

/** 文件不存在时给一份全继承的默认设置（不建文件：读路径不该有写副作用）。 */
function defaultSettings(kbId: number): KbModelSettings {
  return { kbId, chatRef: '', embedRef: '', rerankRef: '', entitiesAt: 0, updatedAt: 0 }
}

/**
 * 读某个库的模型设置。
 *
 * 读失败（文件损坏 / 被占用）时返回**全继承**而不是抛错：这三个字段的默认语义就是「跟随全局」，
 * 退到默认不会让任何一次调用变得比原来更出网 —— 与隐私侧「读不到设置就按未开启处理」同一取向。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @returns 设置行（不存在时是全继承的默认值）。
 */
export function readKbModelSettings(decryptedDir: string, kbId: number): KbModelSettings {
  const kb = Math.trunc(Number(kbId))
  if (!Number.isFinite(kb) || kb <= 0) return defaultSettings(0)
  const file = kbModelsDbPath(decryptedDir)
  if (!existsSync(file)) return defaultSettings(kb)
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT chat_ref, embed_ref, rerank_ref, entities_at, updated_at FROM '
        + KB_MODELS_TABLE + ' WHERE kb_id = ?').get(kb) as Record<string, unknown> | undefined
      if (!row) return defaultSettings(kb)
      return {
        kbId: kb,
        chatRef: String(row.chat_ref ?? ''),
        embedRef: String(row.embed_ref ?? ''),
        rerankRef: String(row.rerank_ref ?? ''),
        entitiesAt: Number(row.entities_at ?? 0) || 0,
        updatedAt: Number(row.updated_at ?? 0) || 0,
      }
    } finally {
      db.close()
    }
  } catch {
    return defaultSettings(kb)
  }
}

/** 写进去之前先归一化：`0`/空串这类「没覆盖」统一写成 `''`，避免同一件事有两种存法。 */
function cleanRef(v: unknown): string {
  const s = String(v ?? '').trim()
  return s === '0' || s === '-1' ? '' : s
}

/**
 * 写某个库的模型设置（部分更新：只改传进来的那几项）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param patch - 要改的字段（引用串）。非法的引用串会让整次写入被拒。
 * @returns `{ ok: true, settings }` 或 `{ ok: false, error }`。
 */
export function writeKbModelSettings(
  decryptedDir: string,
  kbId: number,
  patch: { chatRef?: unknown; embedRef?: unknown; rerankRef?: unknown },
): { ok: true; settings: KbModelSettings } | { ok: false; error: string } {
  const kb = Math.trunc(Number(kbId))
  if (!Number.isFinite(kb) || kb <= 0) return { ok: false, error: '没有指定知识库' }
  const next = readKbModelSettings(decryptedDir, kb)
  const picked: Array<[keyof typeof patch, keyof KbModelSettings]> = [
    ['chatRef', 'chatRef'], ['embedRef', 'embedRef'], ['rerankRef', 'rerankRef'],
  ]
  for (const [from, to] of picked) {
    if (patch[from] === undefined) continue
    const ref = normalizeModelRef(cleanRef(patch[from]))
    if (ref === null) {
      return { ok: false, error: '模型引用格式不对：要么是空（继承全局），要么是「m:<模型名>」' }
    }
    // as 是必要的：元组里两半的键型不同，而 TS 推不出 to 与 from 的对应关系
    (next[to] as string) = ref
  }
  next.updatedAt = Date.now()
  const db = openModelsDb(decryptedDir)
  try {
    db.prepare('INSERT OR REPLACE INTO ' + KB_MODELS_TABLE
      + '(kb_id, chat_ref, embed_ref, rerank_ref, entities_at, updated_at) VALUES(?,?,?,?,?,?)')
      .run(kb, next.chatRef, next.embedRef, next.rerankRef, next.entitiesAt, next.updatedAt)
    return { ok: true, settings: next }
  } finally {
    db.close()
  }
}

/**
 * 记一笔「本库最后一次模型抽实体」的时间。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param at - 时间（毫秒）。
 * @returns 是否写入成功（库还没建过设置行时也会建行）。
 */
export function touchKbEntitiesAt(decryptedDir: string, kbId: number, at: number): boolean {
  const kb = Math.trunc(Number(kbId))
  if (!Number.isFinite(kb) || kb <= 0) return false
  const cur = readKbModelSettings(decryptedDir, kb)
  const db = openModelsDb(decryptedDir)
  try {
    db.prepare('INSERT OR REPLACE INTO ' + KB_MODELS_TABLE
      + '(kb_id, chat_ref, embed_ref, rerank_ref, entities_at, updated_at) VALUES(?,?,?,?,?,?)')
      .run(kb, cur.chatRef, cur.embedRef, cur.rerankRef, Math.trunc(at) || Date.now(), cur.updatedAt)
    return true
  } finally {
    db.close()
  }
}

/**
 * 把一个引用串解析成实际要用的模型名。
 *
 * `globalModel` 由调用方从宿主桥取（那里才是「实际会发出去什么」的真源）——
 * 本模块**不去读 llm.json**：设置层与凭据层各管一段，避免出现第二个「我以为的模型名」。
 * @param ref - 库级引用串。
 * @param globalModel - 全局解析出来的模型名（可为空 = 这个角色没配）。
 * @returns 解析结果。
 */
export function resolveModelRef(ref: ModelRef, globalModel: string): ResolvedModel {
  const g = String(globalModel ?? '')
  const r = typeof ref === 'string' ? ref.trim() : ''
  if (r.startsWith(INLINE_PREFIX)) {
    const name = r.slice(INLINE_PREFIX.length).trim()
    if (name !== '') return { model: name, source: 'inline', ref: r }
  }
  return { model: g, source: 'inherit', ref: r }
}

/**
 * 所有库的「是否有任何自定义」标记，给库列表合流用。
 *
 * 只回布尔而不是整行：rail 的芯片只需要知道「继承 / N 项自定义」，
 * 而把三个引用串都塞进 `getKbs` 会让每次刷新多带一份没人用的数据。
 * @param decryptedDir - 解密数据根。
 * @returns kbId → 自定义了几个角色（0 = 全继承）。
 */
export function kbModelOverrideCounts(decryptedDir: string): Map<number, number> {
  const out = new Map<number, number>()
  const file = kbModelsDbPath(decryptedDir)
  if (!existsSync(file)) return out
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const rows = db.prepare('SELECT kb_id, chat_ref, embed_ref, rerank_ref FROM ' + KB_MODELS_TABLE)
        .all() as Array<Record<string, unknown>>
      for (const r of rows) {
        let n = 0
        for (const k of ['chat_ref', 'embed_ref', 'rerank_ref']) {
          const v = String(r[k] ?? '').trim()
          if (v !== '') n += 1
        }
        if (n > 0) out.set(Number(r['kb_id']), n)
      }
    } finally {
      db.close()
    }
    return out
  } catch {
    return out
  }
}

/**
 * 删库时清掉这一行（由 gateway 的删库级联调用）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 被删的库。
 * @returns 是否删掉了一行。
 */
export function kbModelsOnKbDelete(decryptedDir: string, kbId: number): boolean {
  const file = kbModelsDbPath(decryptedDir)
  if (!existsSync(file)) return false
  try {
    const db = new DatabaseSync(file)
    try {
      return db.prepare('DELETE FROM ' + KB_MODELS_TABLE + ' WHERE kb_id = ?').run(Math.trunc(kbId)).changes > 0
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

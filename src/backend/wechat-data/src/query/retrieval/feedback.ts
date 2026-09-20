/**
 * 反馈闭环（目标 5）。
 *
 * 用户对回答的两类信号：
 *   · 整体赞/踩（rating）—— 粗粒度，但量最大；
 *   · 指出哪几条引用有用/没用（citedUseful / citedUseless）—— 细粒度，直接定位到文档。
 *
 * 反馈的用途不是「在线学习一个模型」（本地优先、样本极少，不现实），而是**调权**：
 * 把「被判无用的引用里普遍偏高的特征」权重往下压，把「有用引用里偏高的特征」往上抬。
 * 因此每条反馈只存**特征名集合**，不存原始向量 —— 既省空间，也避免把消息正文写进反馈库。
 *
 * 存储：`<数据根>/wechat_rag_feedback.db`，与向量库同级，随数据目录删除。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FeedbackRecord, RerankWeights } from './types.ts'
import { retrievalRoot } from './config.ts'

/** 反馈库路径。 */
export function feedbackDbPath(decryptedDir: string): string {
  return join(retrievalRoot(decryptedDir), 'wechat_rag_feedback.db')
}

/** 打开（并初始化）反馈库。 */
function openDb(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(feedbackDbPath(decryptedDir))
  db.exec('CREATE TABLE IF NOT EXISTS feedback ('
    + 'id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, rating TEXT NOT NULL, '
    + 'cited_useful TEXT NOT NULL, cited_useless TEXT NOT NULL, intent TEXT NOT NULL, '
    + 'features TEXT NOT NULL, created_at INTEGER NOT NULL)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)')
  return db
}

/** 写入一条反馈（超出上限时淘汰最旧）。 */
export function recordFeedback(decryptedDir: string, rec: FeedbackRecord, maxRecords = 500): void {
  const db = openDb(decryptedDir)
  try {
    db.prepare('INSERT OR REPLACE INTO feedback(id, question, answer, rating, cited_useful, cited_useless, intent, features, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        rec.id, rec.question, rec.answer, rec.rating,
        JSON.stringify(rec.citedUseful ?? []), JSON.stringify(rec.citedUseless ?? []),
        rec.intent, JSON.stringify(rec.features ?? []), rec.createdAt,
      )
    const over = (db.prepare('SELECT COUNT(*) AS c FROM feedback').get() as { c: number }).c - maxRecords
    if (over > 0) {
      db.prepare('DELETE FROM feedback WHERE id IN (SELECT id FROM feedback ORDER BY created_at ASC LIMIT ?)').run(over)
    }
  } finally {
    db.close()
  }
}

/** 读取最近 N 条反馈（新→旧）。 */
export function listFeedback(decryptedDir: string, limit = 100): FeedbackRecord[] {
  if (!existsSync(feedbackDbPath(decryptedDir))) return []
  const db = openDb(decryptedDir)
  try {
    const rows = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
    return rows.map(r => ({
      id: String(r['id']),
      question: String(r['question']),
      answer: String(r['answer']),
      rating: String(r['rating']) === 'down' ? 'down' : 'up',
      citedUseful: safeJson(r['cited_useful']),
      citedUseless: safeJson(r['cited_useless']),
      intent: String(r['intent']) as FeedbackRecord['intent'],
      features: safeJsonKeys(r['features']) as FeedbackRecord['features'],
      createdAt: Number(r['created_at'] ?? 0),
    }))
  } finally {
    db.close()
  }
}

function safeJson(v: unknown): number[] {
  try {
    const p = JSON.parse(String(v ?? '[]'))
    return Array.isArray(p) ? p.map(Number).filter(n => Number.isFinite(n)) : []
  } catch {
    return []
  }
}

/**
 * 读回**字符串数组**（`features` 存的是 `RerankWeights` 的键名，不是数字）。
 *
 * 之前这里误用了 `safeJson`：它对每个元素做 `Number()` 再滤掉非有限值，于是
 * `["hasMedia","recency"]` → `[]` —— 读回来的 features 永远是空数组，`adaptWeights`
 * 里的循环一次都不执行，**反馈学习（点赞/点踩调权重）实际完全失效**。
 */
function safeJsonKeys(v: unknown): string[] {
  try {
    const p = JSON.parse(String(v ?? '[]'))
    return Array.isArray(p) ? p.map(String).filter(s => s.length > 0) : []
  } catch {
    return []
  }
}

/** 反馈统计（前端展示「已收集多少反馈」）。 */
export function feedbackStats(decryptedDir: string): { total: number; up: number; down: number } {
  if (!existsSync(feedbackDbPath(decryptedDir))) return { total: 0, up: 0, down: 0 }
  const db = openDb(decryptedDir)
  try {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM feedback').get() as { c: number }).c
    const up = (db.prepare("SELECT COUNT(*) AS c FROM feedback WHERE rating='up'").get() as { c: number }).c
    return { total, up, down: total - up }
  } finally {
    db.close()
  }
}

/** 权重上下界（防止调参把某个特征压到失效或放大到失衡）。 */
const W_MIN = 0.05
const W_MAX = 3.0

function clamp(x: number): number {
  return Math.max(W_MIN, Math.min(W_MAX, x))
}

/**
 * 用反馈微调权重。
 *
 * 规则：每条 'up' 反馈把其 `features` 里的特征权重 +lr；'down' 则 −lr。
 * 这是「相关性反馈（Rocchio 思想）」在权重空间上的最简形式 —— 因为特征本身
 * 已经是归一化到 0~1 的分数，直接调权重即可，不需要重新训练任何东西。
 * @param base - 基准权重（config 默认）。
 * @param recs - 反馈记录。
 * @param lr - 步长。
 * @returns 微调后的权重（已 clamp）。
 */
export function adaptWeights(base: RerankWeights, recs: FeedbackRecord[], lr: number): RerankWeights {
  const out: RerankWeights = { ...base }
  for (const r of recs) {
    const delta = r.rating === 'up' ? lr : -lr
    for (const f of r.features ?? []) {
      if (f in out) out[f] = (out[f] ?? 0) + delta
    }
  }
  for (const k of Object.keys(out) as Array<keyof RerankWeights>) out[k] = clamp(out[k])
  return out
}

/** 调参结果落盘（`<数据根>/rag-weights.json`），供 gateway 下次加载。 */
export function weightsPath(decryptedDir: string): string {
  return join(retrievalRoot(decryptedDir), 'rag-weights.json')
}

/** 读取已保存的调参权重（无则返回 null）。 */
export function loadAdaptedWeights(decryptedDir: string): RerankWeights | null {
  const p = weightsPath(decryptedDir)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<RerankWeights>
    return raw as RerankWeights
  } catch {
    return null
  }
}

/** 保存调参权重。 */
export function saveAdaptedWeights(decryptedDir: string, w: RerankWeights): void {
  const p = weightsPath(decryptedDir)
  mkdirSync(retrievalRoot(decryptedDir), { recursive: true })
  writeFileSync(p, JSON.stringify(w, null, 2) + '\n', 'utf8')
}

/**
 * 从「本轮引用是否被用户判为有用」反推特征归因。
 *
 * 用途：给每条反馈填 `features` —— 只保留「有用集合里显著高于无用集合」的特征，
 * 避免把噪声特征也带进调参。
 * @param usefulProfiles - 有用引用的特征向量。
 * @param uselessProfiles - 无用引用的特征向量。
 * @returns 归因到的特征名。
 */
export function attributeFeatures(
  usefulProfiles: Array<Record<keyof RerankWeights, number>>,
  uselessProfiles: Array<Record<keyof RerankWeights, number>>,
): Array<keyof RerankWeights> {
  const avg = (list: Array<Record<keyof RerankWeights, number>>, k: keyof RerankWeights): number =>
    list.length === 0 ? 0 : list.reduce((a, p) => a + (p[k] ?? 0), 0) / list.length
  // ⚠ 这里是**手写**的特征名列表，不是从 RerankWeights 推导的：`Record<keyof …>` 的
  // 穷尽性检查只保护对象字面量，数组漏一项不会编译报错。加新特征（如 'kb'）时必须同步这里，
  // 否则该特征永远归因不出来（表现为「反馈调参对知识库命中毫无反应」，且不报错）。
  const keys: Array<keyof RerankWeights> = ['sparse', 'dense', 'kb', 'entity', 'coverage', 'timePref', 'recency', 'agreement']
  const out: Array<keyof RerankWeights> = []
  for (const k of keys) {
    const u = avg(usefulProfiles, k)
    const b = avg(uselessProfiles, k)
    // 有用引用里该特征均值明显更高（差值 > 0.1）→ 归因给该特征。
    if (u - b > 0.1) out.push(k)
  }
  return out
}

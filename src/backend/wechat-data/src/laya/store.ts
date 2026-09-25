/**
 * 逐条分析结果的**本地缓存**（`<数据根>/laya_analysis.db`）。
 *
 * 为什么要落库而不是放内存：一次推理 0.4–0.7 s，而消息流是虚拟化的 —— 滚过去再滚回来、
 * 切会话再切回来都会重挂组件。缓存让「同一条消息在同一次安装里只算一次」。
 *
 * 键是 `(session_id, local_id, model_key)`：`model_key` 由模型文件的大小 + mtime 组成，
 * 换模型（或换成量化版）后旧结果自动不再命中，不需要手工清库。
 *
 * 库的形态照 `query/edit.ts` 的 `message_edits.db`：
 * 独立的兄弟文件（不放数据根的 decrypted 里，那是微信原始数据的目录）、
 * `CREATE TABLE IF NOT EXISTS` 惰性建表、`DatabaseSync` 同步 API。
 *
 * **写失败一律不影响主流程**：缓存是加速手段，读不到就当作未命中、写不进就下次再算。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LayaAnswer } from './runtime.ts'

/** 缓存库路径：`decrypted` 的兄弟文件（与 `message_edits.db` 同款）。 */
export function layaCachePath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'laya_analysis.db')
}

/** 打开（并按需建表）缓存库。调用方负责 close。 */
function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(layaCachePath(decryptedDir))
  db.exec(`CREATE TABLE IF NOT EXISTS laya_analysis (
    session_id TEXT NOT NULL,
    local_id INTEGER NOT NULL,
    model_key TEXT NOT NULL,
    analyzed_at INTEGER NOT NULL,
    source_text TEXT NOT NULL,
    from_voice INTEGER NOT NULL,
    answers_json TEXT NOT NULL,
    PRIMARY KEY (session_id, local_id, model_key)
  )`)
  return db
}

/** 模型指纹：换模型自动失效（大小 + mtime 秒）。取不到文件时退化为固定串。 */
export function layaModelKey(modelPath: string): string {
  try {
    const st = statSync(modelPath)
    return `${st.size}-${Math.floor(st.mtimeMs / 1000)}`
  } catch {
    return 'unknown'
  }
}

export interface CachedAnalysis {
  sourceText: string
  fromVoice: boolean
  answers: LayaAnswer[]
  analyzedAt: number
}

/** 批量读缓存（只取 `localIds` 里的）。读不到/解析失败一律跳过。 */
export function readAnalysisCache(
  decryptedDir: string,
  sessionId: string,
  modelKey: string,
  localIds: readonly number[],
): Map<number, CachedAnalysis> {
  const out = new Map<number, CachedAnalysis>()
  if (localIds.length === 0 || !existsSync(layaCachePath(decryptedDir))) return out
  let db: DatabaseSync | null = null
  try {
    db = openStore(decryptedDir)
    const stmt = db.prepare(
      'SELECT local_id, analyzed_at, source_text, from_voice, answers_json FROM laya_analysis WHERE session_id = ? AND model_key = ? AND local_id = ?',
    )
    for (const id of localIds) {
      const row = stmt.get(sessionId, modelKey, id) as {
        local_id: number; analyzed_at: number; source_text: string; from_voice: number; answers_json: string
      } | undefined
      if (!row) continue
      try {
        const answers = JSON.parse(row.answers_json) as LayaAnswer[]
        if (!Array.isArray(answers) || answers.length === 0) continue
        out.set(Number(row.local_id), {
          sourceText: String(row.source_text ?? ''),
          fromVoice: Number(row.from_voice) === 1,
          answers,
          analyzedAt: Number(row.analyzed_at) || 0,
        })
      } catch { /* 单条坏数据只丢它自己 */ }
    }
  } catch {
    return new Map()
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
  return out
}

/** 批量写缓存（UPSERT）。整批失败不抛。 */
export function writeAnalysisCache(
  decryptedDir: string,
  sessionId: string,
  modelKey: string,
  rows: ReadonlyArray<{ localId: number; sourceText: string; fromVoice: boolean; answers: LayaAnswer[] }>,
): void {
  if (rows.length === 0) return
  let db: DatabaseSync | null = null
  try {
    db = openStore(decryptedDir)
    const stmt = db.prepare(
      'INSERT INTO laya_analysis (session_id, local_id, model_key, analyzed_at, source_text, from_voice, answers_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, local_id, model_key) DO UPDATE SET analyzed_at = excluded.analyzed_at, source_text = excluded.source_text, from_voice = excluded.from_voice, answers_json = excluded.answers_json',
    )
    const now = Math.floor(Date.now() / 1000)
    for (const r of rows) {
      try {
        stmt.run(sessionId, r.localId, modelKey, now, r.sourceText, r.fromVoice ? 1 : 0, JSON.stringify(r.answers))
      } catch { /* 单条写失败不影响其余 */ }
    }
  } catch {
    /* 缓存写不进不算错误 */
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** 清缓存（按会话或全清）。返回删除条件命中的行数（拿不到时返回 -1）。 */
export function clearAnalysisCache(decryptedDir: string, sessionId?: string): number {
  const p = layaCachePath(decryptedDir)
  if (!existsSync(p)) return 0
  let db: DatabaseSync | null = null
  try {
    db = openStore(decryptedDir)
    const r = sessionId
      ? db.prepare('DELETE FROM laya_analysis WHERE session_id = ?').run(sessionId)
      : db.prepare('DELETE FROM laya_analysis').run()
    return Number(r.changes ?? -1)
  } catch {
    return -1
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

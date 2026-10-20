/**
 * ClawBot 实例的 **token 消耗统计**（2026-10-19）。
 *
 * 自动回复每次模型调用都会拿到供应商返回的 usage；这里按「实例 slot + 本地日期」聚合落库，
 * 实例轨显示「今日 / 累计」。表住在 `clawbot.db`（与实例、会话同一库，删实例时一并清）。
 *
 * 口径：
 *   · `total_tokens` 优先用供应商的 `total_tokens`（含缓存输入）；没有时按 dsh-llm 的
 *     `inputTokens + outputTokens + cacheRead + cacheWrite` 求和；
 *   · 没有 usage 的调用**不记 0 行**（供应商不报用量 ≠ 用量为 0），统计显示为 0 是「确实没记到」。
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { clawbotDbExists, clawbotDbPath, ensureClawbotSchema } from './clawbot-db.ts'
import { withDb, withWritableDb } from '../db-open.ts'

/** 某实例的 token 统计（今日 / 累计）。 */
export interface ClawbotTokenStats {
  todayTokens: number
  totalTokens: number
}

/** 本地日期键（`YYYY-MM-DD`，按运行机器的时区）。 */
export function clawbotDayKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 一次 usage 的 total（供应商给了 total 就用它；否则按口径求和）。 */
function usageTotal(usage: TokenUsage): number {
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
    return Math.round(usage.totalTokens)
  }
  return Math.round(usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
}

/**
 * 记一次模型调用的 token 用量（best-effort：写失败只告警，不影响自动回复）。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param usage - 模型返回的用量。
 */
export function addClawbotTokenUsage(decryptedDir: string, slot: number, usage: TokenUsage | undefined): void {
  if (usage === undefined) return
  const total = usageTotal(usage)
  if (total <= 0) return
  const s = Math.max(Math.floor(slot), 1)
  const day = clawbotDayKey()
  try {
    withWritableDb(clawbotDbPath(decryptedDir), (db) => {
      ensureClawbotSchema(db)
      db.prepare(`INSERT INTO clawbot_token_usage(slot, day, input_tokens, output_tokens, total_tokens, calls, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(slot, day) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          calls = calls + 1,
          updated_at = excluded.updated_at`)
        .run(s, day, Math.round(usage.inputTokens), Math.round(usage.outputTokens), total, Date.now())
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[clawbot] token 用量写入失败（best-effort，不影响自动回复）：' + message)
  }
}

/**
 * 读全部实例的 token 统计（按 slot 索引）。
 * @param decryptedDir - 解密数据根。
 * @param day - 本地日期键（`clawbotDayKey()`）。
 * @returns slot → { todayTokens, totalTokens }；读失败返回空 Map（与「没有消耗」区分不了，
 *   但统计是增强信息，不该让实例列表整体报错）。
 */
export function clawbotTokenStats(decryptedDir: string, day: string): Map<number, ClawbotTokenStats> {
  const out = new Map<number, ClawbotTokenStats>()
  if (!clawbotDbExists(decryptedDir)) return out
  try {
    withDb(clawbotDbPath(decryptedDir), (db) => {
      const totalRows = db.prepare('SELECT slot, SUM(total_tokens) AS n FROM clawbot_token_usage GROUP BY slot').all() as Array<Record<string, unknown>>
      const todayRows = db.prepare('SELECT slot, SUM(total_tokens) AS n FROM clawbot_token_usage WHERE day = ? GROUP BY slot').all(day) as Array<Record<string, unknown>>
      const total = new Map<number, number>()
      for (const r of totalRows) total.set(Number(r['slot']), Number(r['n'] ?? 0))
      const today = new Map<number, number>()
      for (const r of todayRows) today.set(Number(r['slot']), Number(r['n'] ?? 0))
      for (const slot of new Set([...total.keys(), ...today.keys()])) {
        out.set(slot, { todayTokens: today.get(slot) ?? 0, totalTokens: total.get(slot) ?? 0 })
      }
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[clawbot] token 统计读取失败（实例列表照常显示）：' + message)
  }
  return out
}

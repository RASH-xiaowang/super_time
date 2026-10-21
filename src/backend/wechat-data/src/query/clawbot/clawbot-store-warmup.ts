/**
 * ClawBot 存储的低优先级预热。
 *
 * 目标不是“把整库读进内存”，而是在启动后台用一次可写连接完成：
 *   · schema / 老库补列；
 *   · 已绑定实例的绑定、配置与最近一条消息查询；
 *   · 若未来 reply run/outbox 表已存在，顺带走一遍待处理计数查询。
 *
 * 预热是优化，不是功能：库不存在时**不能创建空库**；任何失败都只返回可读 error，
 * 不向启动流程抛异常。
 *
 * @module query/clawbot/clawbot-store-warmup
 */
import type { DatabaseSync } from '../db-open.ts'
import { withWritableDb } from '../db-open.ts'
import { clawbotDbExists, clawbotDbPath, ensureClawbotSchema } from './clawbot-db.ts'

/** 一次预热的结果（启动日志与单测共用）。 */
export interface ClawbotStoreWarmupResult {
  warmed: boolean
  slots: number
  recentMessages: number
  pendingRuns: number
  pendingParts: number
  durationMs: number
  error?: string
}

/**
 * 全链路 trace 的最小阶段事件契约。
 *
 * 这里只标准化字段，不落库、不输出操作日志。后续接线方可在每个阶段调用
 * {@link traceStage}，并自行决定写入 trace 表或内存采样。
 */
export interface ClawbotTraceStage {
  stage: string
  runId: string
  partId: string | null
  clientId: string | null
  elapsedMs: number
}

/** {@link traceStage} 的输入（可选字段统一收敛成 null）。 */
export interface ClawbotTraceStageInput {
  stage: string
  runId: string
  partId?: string | null
  clientId?: string | null
  elapsedMs: number
}

/**
 * 生成稳定的阶段 trace 字段。
 *
 * 纯函数：不读时钟、不写日志；elapsedMs 只做非负整数归一，便于后续聚合。
 * @param input - 阶段标识与关联键。
 * @returns 字段顺序与形状稳定的 trace 事件。
 */
export function traceStage(input: ClawbotTraceStageInput): ClawbotTraceStage {
  const elapsed = Number.isFinite(input.elapsedMs) ? Math.max(0, Math.round(input.elapsedMs)) : 0
  return {
    stage: input.stage,
    runId: input.runId,
    partId: input.partId ?? null,
    clientId: input.clientId ?? null,
    elapsedMs: elapsed,
  }
}

const RUN_TABLE = 'clawbot_reply_run'
const PART_TABLES = ['clawbot_reply_part', 'clawbot_reply_outbox'] as const
const PENDING_STATUSES = [
  'debouncing', 'queued', 'generating', 'ready', 'pending', 'running', 'sending',
  'retry', 'retrying', 'retry_wait', 'waiting', 'processing', 'unknown',
] as const

function errorText(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message !== '' ? message : String(e)
}

/** 表是否存在。表名来自本文件固定常量，不拼用户输入。 */
function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== undefined
}

/** 表的列集合（存在性已由调用方先判）。 */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'))
}

/**
 * 统计待处理行。
 *
 * 兼容未来存储实现的两种常见状态列名（`status` / `state`）；表存在但没有可识别列时
 * 返回 0，而不是猜一个列名把启动预热打挂。SQL 的表名来自固定候选，列名来自 PRAGMA 白名单。
 */
function countPending(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0
  const columns = tableColumns(db, table)
  const statusColumn = columns.has('status') ? 'status' : (columns.has('state') ? 'state' : null)
  if (statusColumn === null) return 0
  const placeholders = PENDING_STATUSES.map(() => '?').join(', ')
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ${table}
      WHERE lower(COALESCE(${statusColumn}, 'pending')) IN (${placeholders})`,
  ).get(...PENDING_STATUSES) as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

function emptyResult(started: number): ClawbotStoreWarmupResult {
  return {
    warmed: false,
    slots: 0,
    recentMessages: 0,
    pendingRuns: 0,
    pendingParts: 0,
    durationMs: Date.now() - started,
  }
}

/**
 * 预热 ClawBot 本机库。
 *
 * @param decryptedDir - 解密数据根；库位于它的父目录。
 * @returns 预热统计；库不存在或失败时 `warmed:false`，且不创建空库。
 */
export function warmClawbotStore(decryptedDir: string): ClawbotStoreWarmupResult {
  const started = Date.now()
  if (!clawbotDbExists(decryptedDir)) return emptyResult(started)

  try {
    const warmed = withWritableDb(clawbotDbPath(decryptedDir), (db) => {
      ensureClawbotSchema(db)

      const boundRows = db.prepare(
        "SELECT slot FROM clawbot_binding WHERE status = 'bound' ORDER BY slot ASC",
      ).all() as Array<{ slot?: number }>
      const slots = [...new Set(
        boundRows
          .map((row) => Number(row.slot ?? 0))
          .filter((slot) => Number.isFinite(slot) && slot > 0),
      )]

      const bindingStmt = db.prepare(
        'SELECT id, status FROM clawbot_binding WHERE slot = ? ORDER BY id DESC LIMIT 1',
      )
      const configStmt = db.prepare(
        'SELECT auto_reply, kb_enabled, kb_id, system_prompt, split_reply FROM clawbot_instance_config WHERE slot = ?',
      )
      const recentStmt = db.prepare(
        'SELECT id FROM clawbot_message WHERE slot = ? ORDER BY ts DESC LIMIT 1',
      )

      let recentMessages = 0
      for (const slot of slots) {
        bindingStmt.get(slot)
        configStmt.get(slot)
        if (recentStmt.get(slot) !== undefined) recentMessages += 1
      }

      const pendingRuns = countPending(db, RUN_TABLE)
      let pendingParts = 0
      for (const table of PART_TABLES) {
        if (tableExists(db, table)) {
          pendingParts = countPending(db, table)
          break
        }
      }

      return { slots: slots.length, recentMessages, pendingRuns, pendingParts }
    })

    return { warmed: true, ...warmed, durationMs: Date.now() - started }
  } catch (e) {
    return {
      ...emptyResult(started),
      error: 'ClawBot 存储预热失败：' + errorText(e),
    }
  }
}

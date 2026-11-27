/**
 * 「工具卡片」的可写注册表（2026-11-24）。
 *
 * ## 为什么单独两张表
 *
 * 工具分两种来源，可写性完全不同，混在一张表里迟早会把「代码里的工具」写成一行数据：
 *   · `tool_custom` —— **用户新建**的工具（`alias` / `answer`）。整行都是数据。
 *   · `tool_override` —— 对**代码内置工具**的覆盖：只允许改标题/说明/启停。
 *     内置工具的执行体在注册表里（`query/tools/*.ts`），这条记录永远不碰它。
 *
 * 之所以不把内置工具也 seed 成一堆行：那样「默认工具不可删」就只能靠一个布尔位保证，
 * 而 seed 失败/半成功会造出一批「看起来能删」的内置工具。现在内置工具**根本不在表里**，
 * 删除时对不上行 ⇒ 结构上就删不掉。
 *
 * 两表都住在任务库（`wechat_task_center.db`）：那里已经是「本机自建配置」的落点，
 * 且已有 WAL 与补列机制，不必再造一个库文件。
 *
 * @module query/tool-config-store
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { taskDbPath, taskStoreExists } from './task-db.ts'
import { taskCellNum, taskCellStr, taskErrorText } from './task-center-utils.ts'
import type { LocalToolFixedValue, LocalToolKind } from '../types-local-tools.ts'

/** 一条自定义工具（整行都是数据）。 */
export interface CustomToolRecord {
  name: string
  title: string
  description: string
  kind: Exclude<LocalToolKind, 'builtin'>
  target: string
  fixed: Record<string, LocalToolFixedValue>
  answer: string
  expose: string[]
  enabled: boolean
  updatedAt: number
}

/** 一条内置工具覆盖（只允许改标题/说明/启停）。 */
export interface ToolOverrideRecord {
  title: string
  description: string
  enabled: boolean
}

/** 读到的全部配置。 */
export interface ToolConfigSnapshot {
  custom: CustomToolRecord[]
  overrides: ReadonlyMap<string, ToolOverrideRecord>
}

/** 空快照（库还不存在时用；调用方不必判 null）。 */
export const EMPTY_TOOL_CONFIG: ToolConfigSnapshot = { custom: [], overrides: new Map() }

/** 建表（每个写连接都会执行一次；`IF NOT EXISTS` 幂等）。 */
export function ensureToolConfigSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_custom (
    name TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'answer',
    target TEXT NOT NULL DEFAULT '',
    fixed TEXT NOT NULL DEFAULT '{}',
    answer TEXT NOT NULL DEFAULT '',
    expose TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS tool_override (
    name TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`)
}

/** JSON 对象解析（坏值按空对象；收字符串/数字/布尔/**字符串数组**，其余丢弃）。 */
function parsePrimitiveMap(raw: unknown): Record<string, LocalToolFixedValue> {
  const text = taskCellStr(raw)
  if (text === '') return {}
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const out: Record<string, LocalToolFixedValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        out[key] = item
        continue
      }
      // 数组参数（如 `keywords`）必须还原成数组：目标工具用 `Array.isArray` 判，
      // 存成字符串会被静默当成「没传」。
      if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
        out[key] = item as string[]
      }
    }
    return out
  } catch {
    return {}
  }
}

/** JSON 字符串数组解析（坏值按空数组）。 */
function parseNameList(raw: unknown): string[] {
  const text = taskCellStr(raw)
  if (text === '') return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  } catch {
    return []
  }
}

/** 一次写连接的外壳（建目录 + 建表）。 */
function write<T>(decryptedDir: string, fn: (db: DatabaseSync) => T): T {
  mkdirSync(dirname(taskDbPath(decryptedDir)), { recursive: true })
  return withWritableDb(taskDbPath(decryptedDir), (db) => {
    ensureToolConfigSchema(db)
    return fn(db)
  })
}

/**
 * 读全部工具配置。
 *
 * 库不存在时返回空快照而**不建库**：只打开工具页不该凭空造出一个任务库文件。
 * @param decryptedDir - 解密数据根。
 * @returns 自定义工具 + 内置覆盖。
 */
export function readToolConfig(decryptedDir: string): ToolConfigSnapshot {
  if (!taskStoreExists(decryptedDir)) return EMPTY_TOOL_CONFIG
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureToolConfigSchema(db)
      const customRows = db.prepare('SELECT * FROM tool_custom ORDER BY updated_at DESC, name').all() as Array<Record<string, unknown>>
      const overrideRows = db.prepare('SELECT * FROM tool_override').all() as Array<Record<string, unknown>>
      const custom: CustomToolRecord[] = []
      for (const row of customRows) {
        const name = taskCellStr(row['name'])
        if (name === '') continue
        const kindText = taskCellStr(row['kind'])
        custom.push({
          name,
          title: taskCellStr(row['title']),
          description: taskCellStr(row['description']),
          kind: kindText === 'alias' ? 'alias' : 'answer',
          target: taskCellStr(row['target']),
          fixed: parsePrimitiveMap(row['fixed']),
          answer: taskCellStr(row['answer']),
          expose: parseNameList(row['expose']),
          enabled: taskCellNum(row['enabled']) === 1,
          updatedAt: taskCellNum(row['updated_at']),
        })
      }
      const overrides = new Map<string, ToolOverrideRecord>()
      for (const row of overrideRows) {
        const name = taskCellStr(row['name'])
        if (name === '') continue
        overrides.set(name, {
          title: taskCellStr(row['title']),
          description: taskCellStr(row['description']),
          enabled: taskCellNum(row['enabled']) === 1,
        })
      }
      return { custom, overrides }
    })
  } catch {
    return EMPTY_TOOL_CONFIG
  }
}

/**
 * 写入一条自定义工具（按 name upsert）。
 * @param decryptedDir - 解密数据根。
 * @param record - 已校验过的整行。
 */
export function upsertCustomTool(decryptedDir: string, record: CustomToolRecord): void {
  write(decryptedDir, (db) => {
    const now = Date.now()
    db.prepare(`INSERT INTO tool_custom
      (name, title, description, kind, target, fixed, answer, expose, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        title = excluded.title, description = excluded.description, kind = excluded.kind,
        target = excluded.target, fixed = excluded.fixed, answer = excluded.answer,
        expose = excluded.expose, enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(record.name, record.title, record.description, record.kind, record.target,
        JSON.stringify(record.fixed), record.answer, JSON.stringify(record.expose),
        record.enabled ? 1 : 0, now, now)
  })
}

/** 删除一条自定义工具；返回是否真的删掉了。 */
export function deleteCustomTool(decryptedDir: string, name: string): boolean {
  return write(decryptedDir, (db) => {
    const info = db.prepare('DELETE FROM tool_custom WHERE name = ?').run(name) as { changes?: number }
    return Number(info.changes ?? 0) > 0
  })
}

/**
 * 写入内置工具的覆盖（标题/说明/启停）。
 *
 * 只接受已存在的内置工具名 —— 否则这条覆盖会变成一条「看不见也删不掉」的幽灵行。
 * @param decryptedDir - 解密数据根。
 * @param name - 内置工具调用名。
 * @param patch - 要覆盖的字段。
 */
export function upsertToolOverride(
  decryptedDir: string,
  name: string,
  patch: { title: string; description: string; enabled: boolean },
): void {
  write(decryptedDir, (db) => {
    db.prepare(`INSERT INTO tool_override (name, title, description, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        title = excluded.title, description = excluded.description,
        enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(name, patch.title, patch.description, patch.enabled ? 1 : 0, Date.now())
  })
}

/** 把一条覆盖恢复成内置默认（删掉覆盖行）。 */
export function clearToolOverride(decryptedDir: string, name: string): void {
  write(decryptedDir, (db) => {
    db.prepare('DELETE FROM tool_override WHERE name = ?').run(name)
  })
}

/** 错误文本（与任务中心同口径，避免第二份实现）。 */
export const toolConfigErrorText = taskErrorText

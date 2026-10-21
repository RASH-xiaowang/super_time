/**
 * 「任务信息 / 任务触发记录」域的**存储与配置**（2026-10-19）。
 *
 * 这一域是用户显式创建的**触发式任务**：某会话（单聊/群聊 + 群内目标用户）的消息命中
 * 关键词时，记一条「触发记录」，已完善（`ready`）的任务再按**触发方式**送出：Webhook
 * （整条记录 JSON POST 到 `callbackUrl`）或八爪鱼 RPA（调启动流程接口，参数映射见
 * `TaskBazhuayuStartPayload`；FlowId / API Key 存在本文件负责建表的三列里）。
 * 与相邻三个 store 的分工（别混）：
 *  · `wechat-tasks.ts`：从聊天文本里本地规则提取的待办，没有目标/关键词/回调；
 *  · `chat-collect.ts`：创建任务时**快照**最近 N 条文本 + M 张图，没有触发语义；
 *  · `summary-tasks.ts`：按 HH:MM 定时生成总结，数据流是「拉取 → 交给模型」。
 *
 * 本文件负责：库路径 / 建表 / 行转换 / 校验 / 任务 CRUD / 触发记录查询。
 * 另外两半在同目录的兄弟文件里（对外仍从**本文件**导出，调用方只认一个入口）：
 *  · `task-center-scan.ts` —— 关键词扫描、水位推进、最近图片抓取；
 *  · `task-center-callback.ts` —— 两种触发方式的 payload / 图片 data URL / 出网 POST。
 *
 * 三个口径值得先说清（都直接决定用户会不会被"历史消息全触发"打到）：
 *  ① **水位**（`last_scan_seq`）：任务新建 / 由「待完善」变「已完善」时初始化成该会话
 *     当前最大 `sort_seq` —— 否则一启用就会把历史消息全部当成"新消息"，一次生成几百条
 *     触发记录、并向下游（Webhook / 八爪鱼 RPA）打几百发 POST。
 *  ② **去重**靠 `UNIQUE(task_id, message_local_id)` + `INSERT OR IGNORE`（见 scan 兄弟文件）。
 *  ③ **图片不在扫描时解码**：只记引用（localId/createTime/sender）；Webhook 在投递那一刻解码，
 *     八爪鱼方式不发图片（接口没有对应参数，`photoLimit` 对它不生效）。
 *
 * 连接纪律与 N1 同款：写走 `withWritableDb`、读走 `existsSync` 判断 + `withDb`；
 * 「库不存在」= 确实还没有数据（空 + 无 `readError`），「库打不开」= 带 `readError` + 留痕。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { queryMessages } from './messages.ts'
import type {
  TaskBatchMutationResult,
  TaskInfo,
  TaskInfoChatType,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoSnapshot,
  TaskInfoStatus,
  TaskTriggerCallbackStatus,
  TaskTriggerImage,
  TaskTriggerMethod,
  TaskTriggerQuery,
  TaskTriggerRecord,
  TaskTriggerSnapshot,
} from '../types.ts'

// 扫描与投递的实现在兄弟文件里；这里统一再导出，调用方只需认 `query/task-center.ts`。
export { scanTaskTriggers } from './task-center-scan.ts'
export type { ScanTaskTriggersOptions } from './task-center-scan.ts'
export { dispatchPendingTaskCallbacks, dispatchTaskCallback } from './task-center-callback.ts'
export type { PendingDispatchResult, TaskDispatchDeps } from './task-center-callback.ts'

/** 任务库文件名（建在解密数据根的父目录，与待办/摘要等同族）。 */
const DB_FILE = 'wechat_task_center.db'
/** 单个关键词 trim 后的最大字符数。 */
const KEYWORD_MAX_LEN = 64
/** 一个任务最多几个去重后的关键词。 */
const KEYWORD_MAX = 20
/** 触发图片张数上限（0 = 不带图片）。 */
const PHOTO_LIMIT_MAX = 9
/** 回调地址最大长度。 */
const CALLBACK_URL_MAX = 2048
/** 八爪鱼 FlowId 最大长度（trim 后）。 */
const BAZHUAYU_FLOW_ID_MAX = 128
/** 八爪鱼 FlowId 允许的字符集（流程 id 形态：字母 / 数字 / 下划线 / 短横线）。 */
const BAZHUAYU_FLOW_ID_PATTERN = /^[A-Za-z0-9_-]+$/
/** 八爪鱼 API Key 最大长度（trim 后）。 */
const BAZHUAYU_API_KEY_MAX = 512
/** API Key 会原样进 `X-Api-Key` 头，因此不允许空白与控制字符。 */
const BAZHUAYU_API_KEY_FORBIDDEN = /[\s\u0000-\u001f\u007f]/
/** 触发记录默认 / 最大返回条数。 */
const TRIGGER_QUERY_DEFAULT = 100
const TRIGGER_QUERY_MAX = 200
/** 触发记录搜索词最大长度（与前端输入上限同源；避免异常长 LIKE 把查询拖慢）。 */
const TRIGGER_SEARCH_MAX = 100
/** 搜索覆盖的记录快照字段；回调错误也纳入，便于按失败原因定位。 */
const TRIGGER_SEARCH_COLUMNS = [
  'text',
  'task_name',
  'chat_name',
  'target_name',
  'keyword',
  'chat_username',
  'target_username',
  'callback_error',
] as const
/** 一次批量删除最多处理多少条；超过时整单拒绝，避免静默只删一部分。 */
export const TASK_BATCH_DELETE_MAX = 500

/** 任务库路径（`decryptedDir` 的父目录下）。 */
export function taskDbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), DB_FILE)
}

/** 任务库是否存在（读路径据此区分「确实还没有数据」与「库打不开」）。 */
export function storeExists(decryptedDir: string): boolean {
  return existsSync(taskDbPath(decryptedDir))
}

/** 错误文本（Error.message 优先，非 Error 一律 String()）。 */
export function taskErrorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

export function taskCellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

export function taskCellNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 整数夹取（非数字按 fallback，其余夹到 [min, max]）。 */
export function clampTaskInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 清洗批量删除 id：只保留唯一正整数，并拒绝空选择和过大批次。
 *
 * Remote 入参来自序列化 JSON，不能只靠 TypeScript 类型；重复 id 去重后返回，
 * 超过上限时整单拒绝而不是截断 —— 用户勾了 501 条却只删 500 条更难排查。
 * @param raw - 入参里的 ids（运行时可能不是数组）。
 * @param max - 允许的最大条数。
 * @returns 清洗后的 id 或中文错误。
 */
export function cleanTaskBatchIds(raw: unknown, max = TASK_BATCH_DELETE_MAX): { ids: number[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ids: [], error: '请至少选择一条记录' }
  const ids: number[] = []
  const seen = new Set<number>()
  for (const value of raw) {
    const id = Math.trunc(Number(value))
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) return { ids: [], error: '请至少选择一条有效记录' }
  if (ids.length > max) {
    return { ids: [], error: '一次最多删除 ' + String(max) + ' 条，请分批操作' }
  }
  return { ids }
}

/** 生成 `?, ?, ?` 形式的 SQL 占位符（调用方已限制 id 数量上限）。 */
function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/**
 * 建父目录（N1 同款）：库建在解密数据根的父目录，那个目录可能在「还没解密过任何库」时不存在。
 * 建目录失败**刻意吞掉**：随后 SQLite 会报出原始错误，失败语义保持与同族 store 一致。
 * @param decryptedDir - 解密数据根。
 */
function ensureParentDir(decryptedDir: string): void {
  try {
    mkdirSync(dirname(taskDbPath(decryptedDir)), { recursive: true })
  } catch (e) {
    console.warn('[task-center] 数据根目录创建失败，继续尝试打开库：' + taskErrorText(e))
  }
}

/** 建表语句（两张表一次建齐；`IF NOT EXISTS` ⇒ 可在每个写连接里重复执行）。 */
export function ensureTaskSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    chat_username TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    chat_type TEXT NOT NULL DEFAULT 'private',
    target_username TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    photo_limit INTEGER NOT NULL DEFAULT 0,
    mention_me_only INTEGER NOT NULL DEFAULT 0,
    trigger_method TEXT NOT NULL DEFAULT 'webhook',
    bazhuayu_flow_id TEXT NOT NULL DEFAULT '',
    bazhuayu_api_key TEXT NOT NULL DEFAULT '',
    callback_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'incomplete',
    last_scan_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_triggered_at INTEGER,
    trigger_count INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS task_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    task_name TEXT NOT NULL DEFAULT '',
    chat_username TEXT NOT NULL DEFAULT '',
    chat_name TEXT NOT NULL DEFAULT '',
    target_username TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    keyword TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    message_local_id INTEGER NOT NULL,
    message_sort_seq INTEGER NOT NULL,
    triggered_at INTEGER NOT NULL,
    callback_status TEXT NOT NULL DEFAULT 'pending',
    callback_at INTEGER,
    callback_error TEXT NOT NULL DEFAULT '',
    UNIQUE(task_id, message_local_id)
  )`)
  // 老库升级：CREATE TABLE IF NOT EXISTS 不会补列，缺列时逐列 ALTER（见下表）。
  ensureTaskInfoColumns(db)
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_triggers_task ON task_triggers(task_id, triggered_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_triggers_task_order ON task_triggers(task_id, triggered_at DESC, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_triggers_order ON task_triggers(triggered_at DESC, id DESC)')
}

/**
 * `task_info` 的历史补列清单：`[列名, ALTER 语句]`。
 *
 * 列名 → 补列语句按引入顺序排列；`table_info` 里已有的列不会重复 ALTER（否则每次打开
 * 都会触发 "duplicate column name"）。旧行按语句里的 DEFAULT 归一：老任务触发方式变成
 * `webhook`（行为与旧版完全一致）、两个八爪鱼列变成空串（= 未配置）。
 */
const TASK_INFO_COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['mention_me_only', 'ALTER TABLE task_info ADD COLUMN mention_me_only INTEGER NOT NULL DEFAULT 0'],
  ['trigger_method', "ALTER TABLE task_info ADD COLUMN trigger_method TEXT NOT NULL DEFAULT 'webhook'"],
  ['bazhuayu_flow_id', "ALTER TABLE task_info ADD COLUMN bazhuayu_flow_id TEXT NOT NULL DEFAULT ''"],
  ['bazhuayu_api_key', "ALTER TABLE task_info ADD COLUMN bazhuayu_api_key TEXT NOT NULL DEFAULT ''"],
]

/**
 * 老库补列：先读 `PRAGMA table_info(task_info)`，只对缺的列执行 ALTER。
 * @param db - 已打开的任务库连接（`task_info` 必须已存在）。
 */
function ensureTaskInfoColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(task_info)').all() as Array<Record<string, unknown>>)
      .map((row) => taskCellStr(row['name'])),
  )
  for (const [name, sql] of TASK_INFO_COLUMN_MIGRATIONS) {
    if (!columns.has(name)) db.exec(sql)
  }
}

/** JSON 字符串数组解析（失败/非数组按空数组容错 —— 配置坏了不等于任务不可用）。 */
function parseStringArray(raw: unknown): string[] {
  const text = taskCellStr(raw)
  if (text === '') return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** 触发图片数组解析（逐项校验形状，坏项丢弃）。 */
function parseTriggerImages(raw: unknown): TaskTriggerImage[] {
  const text = taskCellStr(raw)
  if (text === '') return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    const out: TaskTriggerImage[] = []
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const localId = taskCellNum(row['localId'])
      if (localId <= 0) continue
      const image: TaskTriggerImage = {
        localId,
        createTime: taskCellNum(row['createTime']),
        sender: taskCellStr(row['sender']),
      }
      const md5 = taskCellStr(row['md5'])
      if (md5 !== '') image.md5 = md5
      out.push(image)
    }
    return out
  } catch {
    return []
  }
}

/** `task_info` 行 → 契约里的 `TaskInfo`（`last_scan_seq` 是扫描内部状态，不进契约）。 */
export function rowToTask(r: Record<string, unknown>): TaskInfo {
  const task: TaskInfo = {
    id: taskCellNum(r['id']),
    name: taskCellStr(r['name']),
    chatUsername: taskCellStr(r['chat_username']),
    chatName: taskCellStr(r['chat_name']),
    chatType: taskCellStr(r['chat_type']) === 'group' ? 'group' : 'private',
    targetUsername: taskCellStr(r['target_username']),
    targetName: taskCellStr(r['target_name']),
    keywords: parseStringArray(r['keywords']),
    photoLimit: taskCellNum(r['photo_limit']),
    mentionMeOnly: taskCellNum(r['mention_me_only']) === 1,
    triggerMethod: taskCellStr(r['trigger_method']) === 'bazhuayu' ? 'bazhuayu' : 'webhook',
    callbackUrl: taskCellStr(r['callback_url']),
    bazhuayuFlowId: taskCellStr(r['bazhuayu_flow_id']),
    bazhuayuApiKeySet: taskCellStr(r['bazhuayu_api_key']) !== '',
    status: taskCellStr(r['status']) === 'ready' ? 'ready' : 'incomplete',
    createdAt: taskCellNum(r['created_at']),
    updatedAt: taskCellNum(r['updated_at']),
    triggerCount: taskCellNum(r['trigger_count']),
  }
  if (r['last_triggered_at'] !== null && r['last_triggered_at'] !== undefined) {
    task.lastTriggeredAt = taskCellNum(r['last_triggered_at'])
  }
  return task
}

/** `task_triggers` 行 → 契约里的 `TaskTriggerRecord`。 */
export function rowToTrigger(r: Record<string, unknown>): TaskTriggerRecord {
  const statusText = taskCellStr(r['callback_status'])
  const callbackStatus: TaskTriggerCallbackStatus =
    statusText === 'sent' || statusText === 'failed' || statusText === 'skipped' ? statusText : 'pending'
  const record: TaskTriggerRecord = {
    id: taskCellNum(r['id']),
    taskId: taskCellNum(r['task_id']),
    taskName: taskCellStr(r['task_name']),
    chatUsername: taskCellStr(r['chat_username']),
    chatName: taskCellStr(r['chat_name']),
    targetUsername: taskCellStr(r['target_username']),
    targetName: taskCellStr(r['target_name']),
    keyword: taskCellStr(r['keyword']),
    text: taskCellStr(r['text']),
    images: parseTriggerImages(r['images']),
    messageLocalId: taskCellNum(r['message_local_id']),
    messageSortSeq: taskCellNum(r['message_sort_seq']),
    triggeredAt: taskCellNum(r['triggered_at']),
    callbackStatus,
  }
  if (r['callback_at'] !== null && r['callback_at'] !== undefined) record.callbackAt = taskCellNum(r['callback_at'])
  const callbackError = taskCellStr(r['callback_error'])
  if (callbackError !== '') record.callbackError = callbackError
  return record
}

// ---------------------------------------------------------------- 校验

/** 关键词清洗结果（`error` 非空 = 整单校验失败，不是"部分丢弃"）。 */
interface KeywordsResult {
  keywords: string[]
  error?: string
}

/**
 * 关键词：trim → 去空 → 大小写不敏感去重（保序）→ 每项 ≤64 → 总数 ≤20。
 * @param raw - 入参里的 `keywords`（运行时可能不是数组）。
 * @returns 清洗后的关键词或中文错误。
 */
function cleanKeywords(raw: unknown): KeywordsResult {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const keyword = typeof item === 'string' ? item.trim() : ''
    if (keyword === '') continue
    if (keyword.length > KEYWORD_MAX_LEN) {
      return { keywords: [], error: '单个触发关键词不能超过 ' + String(KEYWORD_MAX_LEN) + ' 个字' }
    }
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(keyword)
  }
  if (out.length === 0) return { keywords: [], error: '至少填写一个触发关键词' }
  if (out.length > KEYWORD_MAX) {
    return { keywords: [], error: '触发关键词最多 ' + String(KEYWORD_MAX) + ' 个' }
  }
  return { keywords: out }
}

/** 回调地址清洗结果（空串 = 不配置，合法）。 */
interface CallbackUrlResult {
  url: string
  error?: string
}

/**
 * 回调地址：非空时必须是 http/https 的绝对 URL，且 ≤2048 字符。
 *
 * 只校验"能不能发出去"，不校验对端是否活着 —— 那是投递时的事（失败会记进触发记录）。
 * @param raw - 入参里的 `callbackUrl`（运行时可能不是字符串）。
 * @returns 规整后的地址或中文错误。
 */
function cleanCallbackUrl(raw: unknown): CallbackUrlResult {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { url: '' }
  if (value.length > CALLBACK_URL_MAX) {
    return { url: '', error: '回调地址过长（最多 ' + String(CALLBACK_URL_MAX) + ' 个字符）' }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { url: '', error: '回调地址必须是合法的 http/https 地址' }
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
    return { url: '', error: '回调地址必须是合法的 http/https 地址' }
  }
  return { url: value }
}

/** 八爪鱼 FlowId 清洗结果（空串 = 未配置，合法）。 */
interface BazhuayuFlowIdResult {
  flowId: string
  error?: string
}

/**
 * 八爪鱼 FlowId：trim 后 ≤128 字符，且只含 `[A-Za-z0-9_-]`；空串合法。
 *
 * 空串是合法的（待完善任务可以先不填），「已完善」校验才要求非空。
 * @param raw - 入参里的 `bazhuayuFlowId`（运行时可能不是字符串）。
 * @returns 规整后的 FlowId 或中文错误。
 */
function cleanBazhuayuFlowId(raw: unknown): BazhuayuFlowIdResult {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { flowId: '' }
  if (value.length > BAZHUAYU_FLOW_ID_MAX) {
    return { flowId: '', error: '八爪鱼 FlowId 过长（最多 ' + String(BAZHUAYU_FLOW_ID_MAX) + ' 个字符）' }
  }
  if (!BAZHUAYU_FLOW_ID_PATTERN.test(value)) {
    return { flowId: '', error: '八爪鱼 FlowId 只能包含字母、数字、下划线和短横线' }
  }
  return { flowId: value }
}

/** 八爪鱼 API Key 清洗结果（空串 = 清空/未配置，合法）。 */
interface BazhuayuApiKeyResult {
  apiKey: string
  error?: string
}

/**
 * 八爪鱼 API Key：trim 后 ≤512 字符，且不含空白/控制字符（它会原样进 `X-Api-Key` 头）。
 *
 * 空串合法（= 清空）；**缺省（undefined）的语义是「保留旧 Key」**，由
 * {@link resolveTaskFields} 在合并旧行时处理，这个函数只负责清洗显式传入的值。
 * @param raw - 入参里的 `bazhuayuApiKey`（运行时可能不是字符串）。
 * @returns 规整后的 Key 或中文错误。
 */
function cleanBazhuayuApiKey(raw: unknown): BazhuayuApiKeyResult {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { apiKey: '' }
  if (value.length > BAZHUAYU_API_KEY_MAX) {
    return { apiKey: '', error: '八爪鱼 API Key 过长（最多 ' + String(BAZHUAYU_API_KEY_MAX) + ' 个字符）' }
  }
  if (BAZHUAYU_API_KEY_FORBIDDEN.test(value)) {
    return { apiKey: '', error: '八爪鱼 API Key 不能包含空白或控制字符' }
  }
  return { apiKey: value }
}

/**
 * 「已完善」的前置条件：关键词、群聊目标必填，再加**当前触发方式**对应的一侧配置。
 *
 * 两种方式互斥地决定「发得出去吗」：webhook 要回调地址，bazhuayu 要 FlowId + API Key。
 * 另一方式的字段不参与判定（也不清空，方便用户来回切换）。
 * @param triggerMethod - 任务的下游触发方式。
 * @param callbackUrl - 已清洗的回调地址。
 * @param bazhuayuFlowId - 已清洗的八爪鱼 FlowId。
 * @param bazhuayuApiKey - 已清洗的八爪鱼 API Key。
 * @param keywords - 触发关键词。
 * @param chatType - 会话类型。
 * @param targetUsername - 群内目标用户。
 * @returns 中文错误；齐全时为空串。
 */
function readyPreconditionError(
  triggerMethod: TaskTriggerMethod,
  callbackUrl: string,
  bazhuayuFlowId: string,
  bazhuayuApiKey: string,
  keywords: string[],
  chatType: TaskInfoChatType,
  targetUsername: string,
): string {
  if (triggerMethod === 'bazhuayu') {
    if (bazhuayuFlowId === '') return '标记已完善前请先填写八爪鱼 FlowId'
    if (bazhuayuApiKey === '') return '标记已完善前请先填写八爪鱼 API Key'
  } else if (callbackUrl === '') {
    return '标记已完善前请先填写回调地址'
  }
  if (keywords.length === 0) return '标记已完善前请先填写触发关键词'
  if (chatType === 'group' && targetUsername === '') return '标记已完善前请先选择群内目标用户'
  return ''
}

/**
 * 该会话**当前**最大 `sort_seq`（水位初始化用）。
 *
 * 读失败退回 0 而不是抛错：水位 0 只会"多扫一些历史"，而抛错会让「保存任务」直接失败。
 * 多扫的历史仍受关键词 + 触发对象两道条件约束，不会凭空产生记录。
 * @param decryptedDir - 解密数据根。
 * @param chatUsername - 会话 username。
 * @param selfUsername - 登录账号 wxid（`isSender` 判定）。
 * @returns 最大 sort_seq；空会话/读失败为 0。
 */
function currentMaxSortSeq(decryptedDir: string, chatUsername: string, selfUsername: string): number {
  try {
    const snap = queryMessages(decryptedDir, chatUsername, 1, undefined, selfUsername)
    return snap.messages.at(-1)?.sortSeq ?? 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------- 读

/**
 * 任务列表（id DESC，最新在前）。
 *
 * 读也走 `withWritableDb`：这是**我们自己的写库**，异常退出后可能残留 `-wal/-shm`，
 * 只读连接会因此报错、让面板显示 `readError`（而数据其实可读）。`withDb` 留给微信
 * 解密库那种只读快照（与 `chat-collect.ts` 的口径一致）。
 * @param decryptedDir - 解密数据根。
 * @returns 任务快照；读库失败时带 `readError`（与「确实没有任务」区分）。
 */
export function listTaskInfos(decryptedDir: string): TaskInfoSnapshot {
  if (!storeExists(decryptedDir)) return { items: [], total: 0 }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      const rows = db.prepare('SELECT * FROM task_info ORDER BY id DESC').all() as Array<Record<string, unknown>>
      const items = rows.map(rowToTask)
      return { items, total: items.length }
    })
  } catch (e) {
    const readError = taskErrorText(e)
    console.warn('[task-center] 任务库读取失败（与「确实没有任务」不同）：' + readError)
    return { items: [], total: 0, readError }
  }
}

/**
 * 触发记录列表（triggered_at DESC, id DESC，最新在前）。
 *
 * 翻页用 `(triggered_at, id)` 复合游标：先取同一时间戳下 id 更小的记录，再用剩余额度
 * 取严格更早的记录。顺序不能反过来 —— 更早记录如果先占满本页，同一时间戳的剩余记录
 * 会被游标永久越过。
 * @param decryptedDir - 解密数据根。
 * @param query - 可选的 `taskId` / `search` 过滤、`limit`（夹 1..200，默认 100）与复合游标。
 * @returns 记录快照（含真实总数与下一页游标）；读库失败时带 `readError`。
 */
export function listTaskTriggers(decryptedDir: string, query?: TaskTriggerQuery): TaskTriggerSnapshot {
  if (!storeExists(decryptedDir)) return { items: [], total: 0 }
  const limit = clampTaskInt(query?.limit, TRIGGER_QUERY_DEFAULT, 1, TRIGGER_QUERY_MAX)
  const taskId = taskCellNum(query?.taskId)
  const search = typeof query?.search === 'string'
    ? query.search.trim().slice(0, TRIGGER_SEARCH_MAX)
    : ''
  const cursor = query?.cursor
  const cursorAt = cursor === undefined ? 0 : Math.max(0, taskCellNum(cursor.triggeredAt))
  const cursorId = cursor === undefined ? 0 : Math.max(0, taskCellNum(cursor.id))
  if (cursor !== undefined && (cursorAt <= 0 || cursorId <= 0)) return { items: [], total: 0 }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      const whereTask = taskId > 0 ? ' AND task_id = ?' : ''
      const taskArg = taskId > 0 ? [taskId] : []
      const whereSearch = search === ''
        ? ''
        : ' AND (' + TRIGGER_SEARCH_COLUMNS.map((column) =>
          'instr(lower(' + column + '), ?) > 0',
        ).join(' OR ') + ')'
      const searchArg = search === '' ? [] : TRIGGER_SEARCH_COLUMNS.map(() => search.toLowerCase())
      const where = ' WHERE 1 = 1' + whereTask + whereSearch
      const whereArg: Array<string | number> = [...taskArg, ...searchArg]
      const totalRow = db.prepare('SELECT COUNT(*) AS n FROM task_triggers' + where).get(...whereArg) as { n?: unknown } | undefined
      const total = Math.max(0, taskCellNum(totalRow?.n))
      if (total === 0) return { items: [], total: 0 }

      let rows: Array<Record<string, unknown>>
      if (cursor === undefined || cursorAt <= 0) {
        rows = db.prepare(
          'SELECT * FROM task_triggers' + where + ' ORDER BY triggered_at DESC, id DESC LIMIT ?',
        ).all(...whereArg, limit) as Array<Record<string, unknown>>
      } else {
        // 复合排序里，同一时间戳的记录全部排在更早时间之前，因此必须先吃边界这一段。
        const sameTimestamp = db.prepare(
          'SELECT * FROM task_triggers WHERE 1 = 1 AND triggered_at = ? AND id < ?' + whereTask + whereSearch + ' ORDER BY id DESC LIMIT ?',
        ).all(cursorAt, cursorId, ...whereArg, limit) as Array<Record<string, unknown>>
        const older = sameTimestamp.length < limit
          ? db.prepare(
            'SELECT * FROM task_triggers WHERE 1 = 1 AND triggered_at < ?' + whereTask + whereSearch + ' ORDER BY triggered_at DESC, id DESC LIMIT ?',
          ).all(cursorAt, ...whereArg, limit - sameTimestamp.length) as Array<Record<string, unknown>>
          : []
        rows = [...sameTimestamp, ...older]
      }

      rows.sort((a, b) => {
        const at = taskCellNum(a['triggered_at'])
        const bt = taskCellNum(b['triggered_at'])
        if (at !== bt) return bt - at
        return taskCellNum(b['id']) - taskCellNum(a['id'])
      })
      const items = rows.map(rowToTrigger)
      const last = items[items.length - 1]
      const hasMore = last !== undefined && db.prepare(
        'SELECT 1 AS found FROM task_triggers WHERE 1 = 1' + whereTask + whereSearch +
        ' AND (triggered_at < ? OR (triggered_at = ? AND id < ?)) LIMIT 1',
      ).get(...whereArg, last.triggeredAt, last.triggeredAt, last.id) !== undefined
      const nextCursor = hasMore && last !== undefined
        ? { triggeredAt: last.triggeredAt, id: last.id }
        : undefined
      return nextCursor === undefined ? { items, total } : { items, total, nextCursor }
    })
  } catch (e) {
    const readError = taskErrorText(e)
    console.warn('[task-center] 触发记录读取失败（与「确实没有记录」不同）：' + readError)
    return { items: [], total: 0, readError }
  }
}

// ---------------------------------------------------------------- 写

/** 解析后的任务字段（新建与更新共用；更新时缺省字段沿用旧值）。 */
interface ResolvedTaskFields {
  chatUsername: string
  chatName: string
  chatType: TaskInfoChatType
  targetUsername: string
  targetName: string
  keywords: string[]
  photoLimit: number
  mentionMeOnly: boolean
  triggerMethod: TaskTriggerMethod
  /** 触发方式 = webhook 时的回调地址；bazhuayu 时仍照旧保存/清洗，只是不参与 ready 判定。 */
  callbackUrl: string
  bazhuayuFlowId: string
  /** 八爪鱼 API Key（只落本机任务库，绝不进 `TaskInfo` 快照 / Remote 返回值）。 */
  bazhuayuApiKey: string
  status: TaskInfoStatus
  name: string
}

/**
 * 把入参 + 库里旧行合并成"这一次要落库的完整配置"。
 *
 * **更新时缺省字段一律沿用旧值**（`undefined` = 不修改，空串 = 清空）：
 * 编辑表单的「保存」通常只带用户改过的项，尤其 `status` 是可选 —— 若按"没传就是
 * incomplete"处理，用户改个名字就会把已完善任务退回待完善，触发器直接停摆。
 * 新建时缺省才用默认值（status = incomplete、photoLimit = 0、triggerMethod = webhook）。
 * `bazhuayuApiKey` 的缺省语义是**保留旧 Key**（表单不回显 Key 原文，无法区分"没改"与"清空"），
 * 想清空必须显式传空串。
 * @param input - 入参。
 * @param existing - 旧行（新建时为 undefined）。
 * @returns 完整字段或中文校验错误。
 */
function resolveTaskFields(
  input: TaskInfoInput,
  existing: Record<string, unknown> | undefined,
): { fields?: ResolvedTaskFields; error?: string } {
  const chatUsername = typeof input?.chatUsername === 'string' ? input.chatUsername.trim() : ''
  if (chatUsername === '') return { error: '未指定会话' }
  const existingChatType = existing === undefined ? '' : taskCellStr(existing['chat_type'])
  const chatType: TaskInfoChatType = input?.chatType === undefined
    ? (existingChatType === 'group' ? 'group' : 'private')
    : (input.chatType === 'group' ? 'group' : 'private')
  const existingTarget = existing === undefined ? '' : taskCellStr(existing['target_username'])
  const targetUsername = input?.targetUsername === undefined
    ? existingTarget
    : (typeof input.targetUsername === 'string' ? input.targetUsername.trim() : '')
  if (chatType === 'group' && targetUsername === '') {
    return { error: '群聊任务必须选择群内目标用户' }
  }
  const cleanedKeywords = cleanKeywords(input?.keywords)
  if (cleanedKeywords.error !== undefined) return { error: cleanedKeywords.error }
  const keywords = cleanedKeywords.keywords
  const existingCallbackUrl = existing === undefined ? '' : taskCellStr(existing['callback_url'])
  const cleanedUrl = input?.callbackUrl === undefined && existing !== undefined
    ? { url: existingCallbackUrl }
    : cleanCallbackUrl(input?.callbackUrl)
  if (cleanedUrl.error !== undefined) return { error: cleanedUrl.error }
  // 触发方式：只认 'bazhuayu'，其它值（含缺省）一律归一为 'webhook'；更新时缺省沿用旧行。
  const existingMethod = existing === undefined ? '' : taskCellStr(existing['trigger_method'])
  const triggerMethod: TaskTriggerMethod = input?.triggerMethod === 'bazhuayu'
    ? 'bazhuayu'
    : (input?.triggerMethod === 'webhook'
      ? 'webhook'
      : (existingMethod === 'bazhuayu' ? 'bazhuayu' : 'webhook'))
  // FlowId / API Key 与回调地址同一合并口径：undefined = 沿用旧值（API Key 是「保留已保存的
  // Key」），空串 = 清空。切换触发方式不清空另一方式的字段，用户来回切不该丢配置。
  const cleanedFlowId = input?.bazhuayuFlowId === undefined && existing !== undefined
    ? { flowId: taskCellStr(existing['bazhuayu_flow_id']) }
    : cleanBazhuayuFlowId(input?.bazhuayuFlowId)
  if (cleanedFlowId.error !== undefined) return { error: cleanedFlowId.error }
  const cleanedApiKey = input?.bazhuayuApiKey === undefined && existing !== undefined
    ? { apiKey: taskCellStr(existing['bazhuayu_api_key']) }
    : cleanBazhuayuApiKey(input?.bazhuayuApiKey)
  if (cleanedApiKey.error !== undefined) return { error: cleanedApiKey.error }
  const existingStatus = existing === undefined
    ? 'incomplete'
    : (taskCellStr(existing['status']) === 'ready' ? 'ready' : 'incomplete')
  const status: TaskInfoStatus = input?.status === 'ready'
    ? 'ready'
    : (input?.status === 'incomplete' ? 'incomplete' : existingStatus)
  if (status === 'ready') {
    const precondition = readyPreconditionError(
      triggerMethod, cleanedUrl.url, cleanedFlowId.flowId, cleanedApiKey.apiKey,
      keywords, chatType, targetUsername,
    )
    if (precondition !== '') return { error: precondition }
  }
  const existingChatName = existing === undefined ? '' : taskCellStr(existing['chat_name'])
  const chatName = input?.chatName === undefined
    ? existingChatName
    : (typeof input.chatName === 'string' ? input.chatName.trim() : '')
  const existingTargetName = existing === undefined ? '' : taskCellStr(existing['target_name'])
  const targetName = input?.targetName === undefined
    ? existingTargetName
    : (typeof input.targetName === 'string' ? input.targetName.trim() : '')
  const existingPhotoLimit = existing === undefined ? 0 : taskCellNum(existing['photo_limit'])
  const photoLimit = input?.photoLimit === undefined
    ? existingPhotoLimit
    : clampTaskInt(input.photoLimit, 0, 0, PHOTO_LIMIT_MAX)
  // 「仅匹配 @我」只对群聊生效：单聊没有结构化群 @ 列表，强行存 true 会永久不触发。
  const existingMentionMeOnly = existing === undefined ? false : taskCellNum(existing['mention_me_only']) === 1
  const mentionMeOnly = chatType === 'group' && (input?.mentionMeOnly === undefined
    ? existingMentionMeOnly
    : input.mentionMeOnly === true)
  const explicitName = typeof input?.name === 'string' ? input.name.trim() : ''
  const existingName = existing === undefined ? '' : taskCellStr(existing['name'])
  const name = explicitName !== ''
    ? explicitName
    : (existingName !== '' ? existingName : (chatName !== '' ? chatName : chatUsername) + ' · ' + (keywords[0] ?? ''))
  return {
    fields: {
      chatUsername, chatName, chatType, targetUsername, targetName,
      keywords, photoLimit, mentionMeOnly, triggerMethod,
      callbackUrl: cleanedUrl.url, bazhuayuFlowId: cleanedFlowId.flowId,
      bazhuayuApiKey: cleanedApiKey.apiKey, status, name,
    },
  }
}

/**
 * 新建 / 更新一个任务（`input.id` 缺省 = 新建）。
 *
 * 校验是"整单失败"而非"部分修正"：任务配置决定会不会触发与往哪发，静默改掉用户填的
 * 东西（比如把非法 URL 清空）比直接拒绝更难排查。
 * 更新语义见 {@link resolveTaskFields}：缺省字段沿用旧值（含 `status` 与 `photoLimit`）。
 * @param decryptedDir - 解密数据根。
 * @param input - 任务配置。
 * @param selfUsername - 登录账号 wxid（水位初始化读消息用，可缺省）。
 * @returns 写结果（失败带中文 error，不抛异常）。
 */
export function saveTaskInfo(decryptedDir: string, input: TaskInfoInput, selfUsername = ''): TaskInfoMutationResult {
  const id = taskCellNum(input?.id)
  ensureParentDir(decryptedDir)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureTaskSchema(db)
      const existing = id > 0
        ? db.prepare('SELECT * FROM task_info WHERE id = ?').get(id) as Record<string, unknown> | undefined
        : undefined
      if (id > 0 && existing === undefined) return { ok: false, error: '任务不存在' }
      const resolved = resolveTaskFields(input, existing)
      if (resolved.fields === undefined) return { ok: false, error: resolved.error ?? '任务配置无效' }
      const fields = resolved.fields
      const now = Date.now()
      if (id > 0 && existing !== undefined) {
        const existedReady = taskCellStr(existing['status']) === 'ready'
        const chatChanged = taskCellStr(existing['chat_username']) !== fields.chatUsername
        // 水位重置：转 ready、或「已 ready 但换了会话」—— 后者若沿用旧会话的 sort_seq，
        // 新会话会从错误的位置开始扫（可能整段历史被当成新消息）。
        const watermark = fields.status === 'ready' && (!existedReady || chatChanged)
          ? currentMaxSortSeq(decryptedDir, fields.chatUsername, selfUsername)
          : taskCellNum(existing['last_scan_seq'])
        db.prepare(`UPDATE task_info SET
          name = ?, chat_username = ?, chat_name = ?, chat_type = ?, target_username = ?, target_name = ?,
          keywords = ?, photo_limit = ?, mention_me_only = ?, trigger_method = ?, callback_url = ?,
          bazhuayu_flow_id = ?, bazhuayu_api_key = ?, status = ?, last_scan_seq = ?, updated_at = ?
          WHERE id = ?`).run(
          fields.name, fields.chatUsername, fields.chatName, fields.chatType,
          fields.targetUsername, fields.targetName, JSON.stringify(fields.keywords), fields.photoLimit,
          fields.mentionMeOnly ? 1 : 0, fields.triggerMethod, fields.callbackUrl,
          fields.bazhuayuFlowId, fields.bazhuayuApiKey, fields.status, watermark, now, id,
        )
        return { ok: true, id, status: fields.status }
      }
      // 新建：水位初始化成该会话当前最大 sort_seq（避免一启用就回扫历史）。
      const watermark = currentMaxSortSeq(decryptedDir, fields.chatUsername, selfUsername)
      const info = db.prepare(`INSERT INTO task_info
        (name, chat_username, chat_name, chat_type, target_username, target_name, keywords, photo_limit,
         mention_me_only, trigger_method, callback_url, bazhuayu_flow_id, bazhuayu_api_key,
         status, last_scan_seq, created_at, updated_at, trigger_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
        fields.name, fields.chatUsername, fields.chatName, fields.chatType,
        fields.targetUsername, fields.targetName, JSON.stringify(fields.keywords), fields.photoLimit,
        fields.mentionMeOnly ? 1 : 0, fields.triggerMethod, fields.callbackUrl,
        fields.bazhuayuFlowId, fields.bazhuayuApiKey, fields.status, watermark, now, now,
      )
      return { ok: true, id: taskCellNum(info.lastInsertRowid), status: fields.status }
    })
  } catch (e) {
    return { ok: false, error: '保存任务失败：' + taskErrorText(e) }
  }
}

/**
 * 标记「待完善 / 已完善」。
 *
 * 从「待完善」变「已完善」时重置水位 —— 这是本域唯一会改变"从哪条消息开始看"的写操作。
 * @param decryptedDir - 解密数据根。
 * @param id - 任务 id。
 * @param status - 目标状态。
 * @param selfUsername - 登录账号 wxid（水位初始化读消息用，可缺省）。
 * @returns 写结果（失败带中文 error）。
 */
export function setTaskInfoStatus(
  decryptedDir: string,
  id: number,
  status: TaskInfoStatus,
  selfUsername = '',
): TaskInfoMutationResult {
  const taskId = taskCellNum(id)
  if (taskId <= 0) return { ok: false, error: '任务不存在' }
  if (status !== 'ready' && status !== 'incomplete') return { ok: false, error: '无效的任务状态' }
  if (!storeExists(decryptedDir)) return { ok: false, error: '任务不存在' }
  ensureParentDir(decryptedDir)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureTaskSchema(db)
      const row = db.prepare('SELECT * FROM task_info WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
      if (row === undefined) return { ok: false, error: '任务不存在' }
      const existedReady = taskCellStr(row['status']) === 'ready'
      if (status === 'ready') {
        // 与保存同一条判据：先按触发方式分支，再要求关键词 / 群聊目标齐全。
        const savedMethod: TaskTriggerMethod =
          taskCellStr(row['trigger_method']) === 'bazhuayu' ? 'bazhuayu' : 'webhook'
        const savedUrl = cleanCallbackUrl(row['callback_url'])
        if (savedUrl.error !== undefined) return { ok: false, error: savedUrl.error }
        const precondition = readyPreconditionError(
          savedMethod,
          savedUrl.url,
          taskCellStr(row['bazhuayu_flow_id']),
          taskCellStr(row['bazhuayu_api_key']),
          parseStringArray(row['keywords']),
          taskCellStr(row['chat_type']) === 'group' ? 'group' : 'private',
          taskCellStr(row['target_username']),
        )
        if (precondition !== '') return { ok: false, error: precondition }
      }
      const watermark = !existedReady && status === 'ready'
        ? currentMaxSortSeq(decryptedDir, taskCellStr(row['chat_username']), selfUsername)
        : taskCellNum(row['last_scan_seq'])
      db.prepare('UPDATE task_info SET status = ?, last_scan_seq = ?, updated_at = ? WHERE id = ?')
        .run(status, watermark, Date.now(), taskId)
      return { ok: true, id: taskId, status }
    })
  } catch (e) {
    return { ok: false, error: '更新任务状态失败：' + taskErrorText(e) }
  }
}

/**
 * 删除任务。**触发记录刻意保留**：任务删了，记录仍是已经发生过的事实，
 * 前端也能凭记录里的快照字段继续展示（见 `types-taskcenter.ts` 的 `task_name` 注释）。
 * @param decryptedDir - 解密数据根。
 * @param id - 任务 id。
 * @returns 写结果（失败带中文 error）。
 */
export function deleteTaskInfo(decryptedDir: string, id: number): TaskInfoMutationResult {
  const taskId = taskCellNum(id)
  if (taskId <= 0) return { ok: false, error: '任务不存在' }
  if (!storeExists(decryptedDir)) return { ok: false, error: '任务不存在' }
  ensureParentDir(decryptedDir)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureTaskSchema(db)
      const info = db.prepare('DELETE FROM task_info WHERE id = ?').run(taskId)
      return Number(info.changes) > 0 ? { ok: true, id: taskId } : { ok: false, error: '任务不存在' }
    })
  } catch (e) {
    return { ok: false, error: '删除任务失败：' + taskErrorText(e) }
  }
}

/**
 * 批量删除任务配置。与单条删除同一语义：**触发记录刻意保留**，它们是已经发生过的事实。
 * @param decryptedDir - 解密数据根。
 * @param rawIds - 任务 id 列表（运行时未受类型保护）。
 * @returns 实际删除行数；空选择 / 非法 id / 超过上限时整单失败。
 */
export function deleteTaskInfos(decryptedDir: string, rawIds: unknown): TaskBatchMutationResult {
  const cleaned = cleanTaskBatchIds(rawIds)
  if (cleaned.error !== undefined) return { ok: false, removed: 0, error: cleaned.error }
  if (!storeExists(decryptedDir)) return { ok: true, removed: 0 }
  ensureParentDir(decryptedDir)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureTaskSchema(db)
      const result = db.prepare(
        'DELETE FROM task_info WHERE id IN (' + sqlPlaceholders(cleaned.ids.length) + ')',
      ).run(...cleaned.ids)
      return { ok: true, removed: Number(result.changes) }
    })
  } catch (e) {
    return { ok: false, removed: 0, error: '批量删除任务失败：' + taskErrorText(e) }
  }
}

/**
 * 批量删除触发记录，并在**同一事务**里重算受影响任务的统计缓存。
 *
 * `deleteTaskInfos` 刻意保留触发记录，所以这里要让任务行的 `trigger_count` /
 * `last_triggered_at` 重新等于记录表事实；否则删了记录，左栏仍显示旧的触发次数。
 * 任一步失败都回滚，不能留下「记录删了、统计没更新」的半完成状态。
 * @param decryptedDir - 解密数据根。
 * @param rawIds - 触发记录 id 列表（运行时未受类型保护）。
 * @returns 实际删除行数；空选择 / 非法 id / 超过上限时整单失败。
 */
export function deleteTaskTriggers(decryptedDir: string, rawIds: unknown): TaskBatchMutationResult {
  const cleaned = cleanTaskBatchIds(rawIds)
  if (cleaned.error !== undefined) return { ok: false, removed: 0, error: cleaned.error }
  if (!storeExists(decryptedDir)) return { ok: true, removed: 0 }
  ensureParentDir(decryptedDir)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureTaskSchema(db)
      const placeholders = sqlPlaceholders(cleaned.ids.length)
      db.exec('BEGIN IMMEDIATE')
      try {
        const affectedRows = db.prepare(
          'SELECT DISTINCT task_id FROM task_triggers WHERE id IN (' + placeholders + ')',
        ).all(...cleaned.ids) as Array<Record<string, unknown>>
        const affectedTaskIds = affectedRows
          .map((row) => taskCellNum(row['task_id']))
          .filter((id) => id > 0)
        const removed = Number(db.prepare(
          'DELETE FROM task_triggers WHERE id IN (' + placeholders + ')',
        ).run(...cleaned.ids).changes)
        const updateTask = db.prepare(`UPDATE task_info SET
          trigger_count = (SELECT COUNT(*) FROM task_triggers WHERE task_id = ?),
          last_triggered_at = (SELECT MAX(triggered_at) FROM task_triggers WHERE task_id = ?)
          WHERE id = ?`)
        for (const taskId of affectedTaskIds) {
          updateTask.run(taskId, taskId, taskId)
        }
        db.exec('COMMIT')
        return { ok: true, removed }
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 回滚失败时保留原始错误，便于定位真正的写入问题 */
        }
        throw e
      }
    })
  } catch (e) {
    return { ok: false, removed: 0, error: '批量删除触发记录失败：' + taskErrorText(e) }
  }
}

/**
 * 「任务回调投递」：把一条触发记录组装成 JSON，POST 到用户为该任务配置的回调地址。
 *
 * 从 `task-center.ts` 拆出来（M21 单文件 1000 行上限）：这里只有投递一侧的逻辑，
 * 存储/校验/CRUD 在 `task-center.ts`，对外接口由它统一再导出。
 *
 * 本文件是**本域唯一的出网点**（`postTaskCallback`）：地址来自用户逐条填写，
 * 只允许 http/https；任务未完善 / 未配置地址时不会走到这里。
 * 出网台账（`outbound-site-coverage.spec.ts`）登记的就是 `#postTaskCallback`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withWritableDb } from './db-open.ts'
import { fetchWithRetry } from '../net/fetch-retry.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import {
  clampTaskInt,
  ensureTaskSchema,
  rowToTask,
  rowToTrigger,
  storeExists,
  taskCellNum,
  taskCellStr,
  taskDbPath,
  taskErrorText,
} from './task-center.ts'
import type {
  TaskCallbackDispatchResult,
  TaskCallbackPayload,
  TaskInfo,
  TaskTriggerRecord,
} from '../types.ts'

/** 单张图片 data URL 的字符上限（约 6 MB 原始字节；超过就省略该张而不是把整条回调撑爆）。 */
const IMAGE_DATA_URL_MAX = 8_000_000
/** 回调失败原因落库上限。 */
const CALLBACK_ERROR_MAX = 500
/** 回调 POST：最多尝试 2 次（回调地址是用户自己的服务，抖动一次还有救，多了会堆重复投递）。 */
const DISPATCH_MAX_ATTEMPTS = 2
const DISPATCH_TIMEOUT_MS = 15_000
/** 一批待投递记录的上限（定时器每拍只处理这么多，避免一次拍住事件循环太久）。 */
const PENDING_DISPATCH_LIMIT = 10

/** 投递依赖：图片解码、隐私闸与 fetch 都由调用方注入（query 层不 import gateway 侧）。 */
export interface TaskDispatchDeps {
  /**
   * 解码一张图片（`username` + `localId`）。返回 `url`（data URL）或 `file`
   * （相对 `decodedDir` 的路径）之一；两者都没有 = 这张解不出来。
   */
  decodeImage: (username: string, localId: number) => Promise<{ url?: string; file?: string }>
  /** 隐私闸（脱敏 + 审计）；返回可直接发出去的文本。 */
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  /** 测试注入用；生产省略 = 全局 `fetch`。 */
  fetchImpl?: RetryFetch
}

/** 一批待投递记录的处理结果（扫描器把它并进 `TaskTriggerScanResult`）。 */
export interface PendingDispatchResult {
  dispatched: number
  failed: number
  errors?: string[]
}

/**
 * 读取投递需要的「记录 + 所属任务」；任一缺失都不抛错（调用方给可读结果）。
 *
 * 读也走 `withWritableDb`：这是**我们自己的写库**，异常退出后可能残留 `-wal/-shm`，
 * 只读连接会因此报错、让面板显示 `readError`（而数据其实可读）。`withDb` 留给
 * 微信解密库那种只读快照。
 * @param file - 任务库路径（已由调用方确认存在）。
 * @param triggerId - 触发记录 id。
 * @returns 记录 / 所属任务；找不到的部分缺省。
 */
function readDispatchTarget(file: string, triggerId: number): { record?: TaskTriggerRecord; task?: TaskInfo } {
  return withWritableDb(file, (db) => {
    const triggerRow = db.prepare('SELECT * FROM task_triggers WHERE id = ?').get(triggerId) as Record<string, unknown> | undefined
    if (triggerRow === undefined) return {}
    const record = rowToTrigger(triggerRow)
    const taskRow = db.prepare('SELECT * FROM task_info WHERE id = ?').get(record.taskId) as Record<string, unknown> | undefined
    if (taskRow === undefined) return { record }
    return { record, task: rowToTask(taskRow) }
  })
}

/** 文件扩展名 → data URL 的 MIME（未知按 jpeg，与解码器默认输出一致）。 */
function imageMimeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}

/** 图片路径是否安全（只接受 `decodedDir` 内的相对路径，拒绝绝对路径与 `..`）。 */
function isSafeDecodedPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  if (normalized.startsWith('..') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false
  return normalized !== ''
}

/**
 * 把一条记录的图片引用解码成回调里的 base64 / 错误说明。
 *
 * 单张失败不影响其它：解不出来就写 `error`（用户能看出"这张没带上"），
 * 而不是伪造一张图或让整条回调失败。单张超过 8,000,000 字符同样省略。
 * @param record - 触发记录（图片引用清单）。
 * @param decodedDir - 图片解码缓存根。
 * @param decodeImage - 注入的解码函数。
 * @returns 回调请求体里的 images 数组。
 */
async function buildPayloadImages(
  record: TaskTriggerRecord,
  decodedDir: string,
  decodeImage: TaskDispatchDeps['decodeImage'],
): Promise<TaskCallbackPayload['images']> {
  const out: TaskCallbackPayload['images'] = []
  for (const image of record.images) {
    const item: TaskCallbackPayload['images'][number] = {
      localId: image.localId,
      createTime: image.createTime,
      sender: image.sender,
    }
    if (image.md5 !== undefined) item.md5 = image.md5
    try {
      const decoded = await decodeImage(record.chatUsername, image.localId)
      let dataUrl = typeof decoded.url === 'string' ? decoded.url : ''
      if (dataUrl === '' && typeof decoded.file === 'string' && decoded.file !== '') {
        if (!isSafeDecodedPath(decoded.file)) {
          item.error = '图片路径超出解码目录，已省略'
        } else {
          const bytes = readFileSync(join(decodedDir, decoded.file))
          dataUrl = 'data:' + imageMimeOf(decoded.file) + ';base64,' + bytes.toString('base64')
        }
      }
      if (item.error === undefined) {
        if (dataUrl === '') item.error = '图片解码失败'
        else if (dataUrl.length > IMAGE_DATA_URL_MAX) item.error = '图片过大，已省略'
        else item.dataUrl = dataUrl
      }
    } catch (e) {
      item.error = taskErrorText(e).slice(0, CALLBACK_ERROR_MAX)
    }
    out.push(item)
  }
  return out
}

/**
 * 真正发出一次回调 POST（本域**唯一**出网点）。
 *
 * 走 `fetchWithRetry`：单次尝试 15s 超时、最多 2 次（用户自己的服务，抖动一次还有救；
 * 次数再多只会让重复投递变多）。非 2xx 一律当失败。
 * @param doFetch - fetch 实现（生产 = 全局 fetch）。
 * @param url - 用户配置的回调地址。
 * @param payload - 请求体（不持久化）。
 * @throws 网络/超时/非 2xx 时抛可读错误（调用方截断后落库）。
 */
async function postTaskCallback(doFetch: RetryFetch, url: string, payload: TaskCallbackPayload): Promise<void> {
  const res = await fetchWithRetry(doFetch, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, { maxAttempts: DISPATCH_MAX_ATTEMPTS, timeoutMs: DISPATCH_TIMEOUT_MS })
  if (!res.ok) throw new Error('回调失败：HTTP ' + String(res.status))
}

/** 组装回调请求体；`triggeredAtText` 用 zh-CN 的 24 小时制（只在 query 层格式化，不引 UI 依赖）。 */
function buildCallbackPayload(
  record: TaskTriggerRecord,
  task: TaskInfo,
  text: string,
  images: TaskCallbackPayload['images'],
): TaskCallbackPayload {
  return {
    taskId: task.id,
    taskName: task.name,
    recordId: record.id,
    triggeredAt: record.triggeredAt,
    triggeredAtText: new Date(record.triggeredAt).toLocaleString('zh-CN', { hour12: false }),
    chat: { username: task.chatUsername, name: task.chatName, type: task.chatType },
    target: { username: task.targetUsername, name: task.targetName },
    keyword: record.keyword,
    text,
    images,
  }
}

/** 把投递结果写回记录（单语句 autocommit；写失败不影响已经发出的请求这一事实）。 */
function saveDispatchResult(file: string, triggerId: number, status: 'sent' | 'failed', error: string): void {
  withWritableDb(file, (db) => {
    ensureTaskSchema(db)
    db.prepare('UPDATE task_triggers SET callback_status = ?, callback_at = ?, callback_error = ? WHERE id = ?')
      .run(status, Date.now(), error, triggerId)
  })
}

/**
 * 手动 / 扫描后投递一条触发记录的回调。
 *
 * 只投「任务已完善 + 配置了回调地址」的记录；文本先过隐私闸（脱敏 + 审计）。
 * 失败不抛异常：`{ok:false, status:'failed', error}` 并落进记录，供前端重试。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根。
 * @param triggerId - 触发记录 id。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @returns 投递结果（含 skipped 的三种可读原因）。
 */
export async function dispatchTaskCallback(
  decryptedDir: string,
  decodedDir: string,
  triggerId: number,
  deps: TaskDispatchDeps,
): Promise<TaskCallbackDispatchResult> {
  const id = taskCellNum(triggerId)
  if (id <= 0) return { ok: false, status: 'skipped', error: '触发记录不存在' }
  if (!storeExists(decryptedDir)) return { ok: false, status: 'skipped', error: '触发记录不存在' }
  const file = taskDbPath(decryptedDir)
  let record: TaskTriggerRecord | undefined
  let task: TaskInfo | undefined
  try {
    const target = readDispatchTarget(file, id)
    record = target.record
    task = target.task
  } catch (e) {
    return { ok: false, status: 'skipped', error: '读取触发记录失败：' + taskErrorText(e) }
  }
  if (record === undefined) return { ok: false, status: 'skipped', error: '触发记录不存在' }
  if (task === undefined) return { ok: false, status: 'skipped', error: '任务不存在或已删除' }
  if (task.status !== 'ready' || task.callbackUrl === '') {
    return { ok: false, status: 'skipped', error: '任务未完善或未配置回调地址' }
  }
  const gated = deps.gate('task_callback', { sessions: 1, messages: 1 }, [record.text])
  const text = Array.isArray(gated) && gated.length > 0 ? taskCellStr(gated[0]) : record.text
  const images = await buildPayloadImages(record, decodedDir, deps.decodeImage)
  const payload = buildCallbackPayload(record, task, text, images)
  // 直接取全局 `fetch`（而不是包一层箭头）：多包一层会在出网点台账里多出一个匿名调用点，
  // 而本域刻意只登记 `postTaskCallback` 这一处出网。
  const send: RetryFetch = deps.fetchImpl ?? fetch
  let sent = false
  let failure = ''
  try {
    await postTaskCallback(send, task.callbackUrl, payload)
    sent = true
  } catch (e) {
    failure = taskErrorText(e).slice(0, CALLBACK_ERROR_MAX)
  }
  try {
    saveDispatchResult(file, id, sent ? 'sent' : 'failed', failure)
  } catch (e) {
    // 请求可能已经到达对端；此时如实说"结果没存下来"，而不是回一个会诱发重复投递的失败。
    return sent
      ? { ok: true, status: 'sent', error: '回调结果保存失败：' + taskErrorText(e) }
      : { ok: false, status: 'failed', error: failure + '（结果保存失败：' + taskErrorText(e) + '）' }
  }
  return sent ? { ok: true, status: 'sent' } : { ok: false, status: 'failed', error: failure }
}

/**
 * 投递一批 `pending` 记录（只取所属任务仍「已完善」且有回调地址的）。
 *
 * 扫描器每拍「扫描 → 投递」；单条失败不连坐（错误只收集前 10 条）。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @param limit - 本次最多投几条（默认 10）。
 * @returns 成功/失败计数与失败原因。
 */
export async function dispatchPendingTaskCallbacks(
  decryptedDir: string,
  decodedDir: string,
  deps: TaskDispatchDeps,
  limit = PENDING_DISPATCH_LIMIT,
): Promise<PendingDispatchResult> {
  if (!storeExists(decryptedDir)) return { dispatched: 0, failed: 0 }
  const cap = clampTaskInt(limit, PENDING_DISPATCH_LIMIT, 1, 100)
  let ids: number[] = []
  try {
    ids = withWritableDb(taskDbPath(decryptedDir), (db) => {
      const rows = db.prepare(`SELECT t.id AS id FROM task_triggers t
        JOIN task_info i ON i.id = t.task_id
        WHERE t.callback_status = 'pending' AND i.status = 'ready' AND i.callback_url <> ''
        ORDER BY t.triggered_at ASC, t.id ASC LIMIT ?`).all(cap) as Array<{ id?: unknown }>
      return rows.map((row) => taskCellNum(row.id))
    })
  } catch (e) {
    return { dispatched: 0, failed: 0, errors: ['读取待投递记录失败：' + taskErrorText(e)] }
  }
  let dispatched = 0
  let failed = 0
  const errors: string[] = []
  for (const id of ids) {
    try {
      const r = await dispatchTaskCallback(decryptedDir, decodedDir, id, deps)
      if (r.ok) dispatched += 1
      else {
        failed += 1
        if (errors.length < 10) errors.push('记录 ' + String(id) + '：' + (r.error ?? r.status))
      }
    } catch (e) {
      failed += 1
      if (errors.length < 10) errors.push('记录 ' + String(id) + '：' + taskErrorText(e))
    }
  }
  return errors.length > 0 ? { dispatched, failed, errors } : { dispatched, failed }
}

/**
 * 「任务投递」：把一条触发记录按任务的**触发方式**送出。
 *
 * 从 `task-center.ts` 拆出来（M21 单文件 1000 行上限）：这里只有投递一侧的逻辑，
 * 存储/校验/CRUD 在 `task-center.ts`，对外接口由它统一再导出。
 *
 * 本文件是**本域仅有的两个出网点**（出网台账 `outbound-site-coverage.spec.ts` 逐条登记）：
 *  · `postTaskCallback` —— Webhook：整条记录 JSON POST 到用户逐条填写的地址（只允许 http/https）；
 *  · `postBazhuayuTrigger` —— 八爪鱼 RPA：POST 到固定的 `api-rpa.bazhuayu.com`，Key 在
 *    `X-Api-Key` 头，只发会话名 / 触发文本 / 触发对象三个参数（**不发图片**）。
 * 任务未完善 / 对应方式的配置不齐时不会走到出网函数（返回 skipped）。
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
  TaskBazhuayuStartPayload,
  TaskCallbackDispatchResult,
  TaskCallbackPayload,
  TaskInfo,
  TaskTriggerRecord,
} from '../types.ts'

/** 单张图片 data URL 的字符上限（约 6 MB 原始字节；超过就省略该张而不是把整条回调撑爆）。 */
const IMAGE_DATA_URL_MAX = 8_000_000
/** 回调失败原因落库上限。 */
const CALLBACK_ERROR_MAX = 500
/** 出网 POST：最多尝试 2 次（Webhook 对端抖动一次还有救；八爪鱼固定主机同理，多了只会堆重复投递）。 */
const DISPATCH_MAX_ATTEMPTS = 2
const DISPATCH_TIMEOUT_MS = 15_000
/** 一批待投递记录的上限（定时器每拍只处理这么多，避免一次拍住事件循环太久）。 */
const PENDING_DISPATCH_LIMIT = 10
/**
 * 八爪鱼「启动流程」接口地址（主机写死，不来自用户输入）。
 *
 * 出网台账按 `本文件#postBazhuayuTrigger` 记账；改地址=改出网目的地，必须同步隐私声明。
 */
const BAZHUAYU_TRIGGER_URL = 'https://api-rpa.bazhuayu.com/api/bots/scheduling/start'

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
 * @returns 记录 / 所属任务 / 任务行里的原始八爪鱼 API Key；找不到的部分缺省。
 */
function readDispatchTarget(file: string, triggerId: number): {
  record?: TaskTriggerRecord
  task?: TaskInfo
  /**
   * 八爪鱼 API Key 原文（内部字段，**不进 `TaskInfo` / 任何列表快照**）。
   *
   * 只有投递这一刻需要它；`rowToTask` 对外只给 `bazhuayuApiKeySet` 布尔。
   */
  bazhuayuApiKey?: string
} {
  return withWritableDb(file, (db) => {
    const triggerRow = db.prepare('SELECT * FROM task_triggers WHERE id = ?').get(triggerId) as Record<string, unknown> | undefined
    if (triggerRow === undefined) return {}
    const record = rowToTrigger(triggerRow)
    const taskRow = db.prepare('SELECT * FROM task_info WHERE id = ?').get(record.taskId) as Record<string, unknown> | undefined
    if (taskRow === undefined) return { record }
    return {
      record,
      task: rowToTask(taskRow),
      bazhuayuApiKey: taskCellStr(taskRow['bazhuayu_api_key']),
    }
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
 * 发出一次 **Webhook** 回调 POST（本域出网点之一）。
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

/**
 * 发出一次**八爪鱼 RPA 启动流程** POST（本域出网点之二）。
 *
 * 主机写死（{@link BAZHUAYU_TRIGGER_URL}，不来自用户输入）；只有用户为某个任务显式选了
 * 「八爪鱼 RPA」并填了 FlowId + API Key、任务已完善时才会走到这里。参数只有触发记录的
 * 会话名 / 触发文本 / 触发对象（见 {@link buildBazhuayuPayload}），**不发图片**。
 *
 * 重试口径与 Webhook 一致：2 次尝试 / 单次 15s，2xx = 成功。
 * @param doFetch - fetch 实现（生产 = 全局 fetch）。
 * @param apiKey - 任务行里的八爪鱼 API Key（只进请求头，不落 payload）。
 * @param payload - 启动流程请求体（不持久化）。
 * @throws 网络/超时/非 2xx 时抛可读错误（调用方截断后落 `callback_error`）。
 */
async function postBazhuayuTrigger(
  doFetch: RetryFetch,
  apiKey: string,
  payload: TaskBazhuayuStartPayload,
): Promise<void> {
  const res = await fetchWithRetry(doFetch, BAZHUAYU_TRIGGER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(payload),
  }, { maxAttempts: DISPATCH_MAX_ATTEMPTS, timeoutMs: DISPATCH_TIMEOUT_MS })
  if (!res.ok) throw new Error('八爪鱼触发失败：HTTP ' + String(res.status))
}

/**
 * 组装八爪鱼启动流程请求体：把一条触发记录映射成 `room_name` / `content` / `at_name`。
 *
 * 取值口径：`room_name` = 触发记录的会话名；`content` = 过隐私闸后的触发文本；
 * `at_name` = 触发对象显示名 —— 群聊用目标成员 `targetName`；单聊任务创建弹窗不填
 * `targetName`，此时「触发的用户对象」就是会话本人，**回落会话名 `record.chatName`**
 * （否则单聊任务会把 `at_name` 发成空串）。`FlowId` 来自任务配置。
 * @param task - 任务配置（提供 FlowId）。
 * @param record - 触发记录（提供三个业务参数的快照值）。
 * @param text - 已过隐私闸的触发文本。
 * @returns 启动流程请求体（与 `TaskBazhuayuStartPayload` 同形）。
 */
function buildBazhuayuPayload(
  task: TaskInfo,
  record: TaskTriggerRecord,
  text: string,
): TaskBazhuayuStartPayload {
  return {
    FlowId: task.bazhuayuFlowId,
    FlowContentRetrievalMode: 'ByNewestContent',
    SpecifiedPublicationVersion: '',
    SpecifiedBot: '',
    Params: {
      room_name: record.chatName,
      content: text,
      // 单聊没有独立的触发对象显示名 ⇒ 回落会话名；群聊保持目标成员显示名。
      at_name: record.targetName !== '' ? record.targetName : record.chatName,
    },
    UserStartSource: 'OpenApi',
  }
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
 * 手动 / 扫描后投递一条触发记录（按任务的触发方式分支）。
 *
 * 只投「任务已完善 + 当前触发方式的下游配置齐全」的记录：Webhook 要有回调地址，
 * 八爪鱼要有 FlowId + 已保存的 API Key。文本先过**同一个**隐私闸（feature 仍是
 * `task_callback`，审计口径不因触发方式而变）；Webhook 才解码图片，八爪鱼不发图片。
 * 失败不抛异常：`{ok:false, status:'failed', error}` 并落进记录，供前端重试。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 图片解码缓存根（仅 Webhook 方式使用）。
 * @param triggerId - 触发记录 id。
 * @param deps - 解码 / 隐私闸 / fetch 注入。
 * @returns 投递结果（含 skipped 的几种可读原因）。
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
  let apiKey = ''
  try {
    const target = readDispatchTarget(file, id)
    record = target.record
    task = target.task
    apiKey = target.bazhuayuApiKey ?? ''
  } catch (e) {
    return { ok: false, status: 'skipped', error: '读取触发记录失败：' + taskErrorText(e) }
  }
  if (record === undefined) return { ok: false, status: 'skipped', error: '触发记录不存在' }
  if (task === undefined) return { ok: false, status: 'skipped', error: '任务不存在或已删除' }
  if (task.status !== 'ready') return { ok: false, status: 'skipped', error: '任务未完善' }
  if (task.triggerMethod === 'bazhuayu') {
    if (task.bazhuayuFlowId === '' || apiKey === '') {
      return { ok: false, status: 'skipped', error: '任务未完善或未配置八爪鱼 FlowId / API Key' }
    }
  } else if (task.callbackUrl === '') {
    return { ok: false, status: 'skipped', error: '任务未完善或未配置回调地址' }
  }
  // 两种触发方式过同一个隐私闸：feature 不随方式变化（审计口径与用户告知保持一致）。
  const gated = deps.gate('task_callback', { sessions: 1, messages: 1 }, [record.text])
  const text = Array.isArray(gated) && gated.length > 0 ? taskCellStr(gated[0]) : record.text
  // 直接取全局 `fetch`（而不是包一层箭头）：多包一层会在出网点台账里多出一个匿名调用点，
  // 而本域刻意只登记 `postTaskCallback` / `postBazhuayuTrigger` 两个出网函数。
  const send: RetryFetch = deps.fetchImpl ?? fetch
  let sent = false
  let failure = ''
  try {
    if (task.triggerMethod === 'bazhuayu') {
      // 八爪鱼接口没有图片参数：不解码图片，只发三个业务参数。
      await postBazhuayuTrigger(send, apiKey, buildBazhuayuPayload(task, record, text))
    } else {
      const images = await buildPayloadImages(record, decodedDir, deps.decodeImage)
      await postTaskCallback(send, task.callbackUrl, buildCallbackPayload(record, task, text, images))
    }
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
 * 投递一批 `pending` 记录。
 *
 * 只取「所属任务仍已完善 + **触发方式对应的下游配置齐全**」的记录（与
 * `dispatchTaskCallback` 的 skipped 判据同口径）：Webhook 看回调地址，八爪鱼看
 * FlowId + 是否存过 API Key（Key 原文只在投递时读出，不在 SQL 里比较明文）。
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
      // 老库在这里顺手补列：这条 SQL 引用了 2026-10-21 新增的三列。
      ensureTaskSchema(db)
      const rows = db.prepare(`SELECT t.id AS id FROM task_triggers t
        JOIN task_info i ON i.id = t.task_id
        WHERE t.callback_status = 'pending' AND i.status = 'ready' AND (
          (i.trigger_method = 'webhook' AND i.callback_url <> '')
          OR (i.trigger_method = 'bazhuayu' AND i.bazhuayu_flow_id <> '' AND i.bazhuayu_api_key <> '')
        )
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

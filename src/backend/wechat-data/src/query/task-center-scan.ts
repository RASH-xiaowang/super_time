/**
 * 「任务触发扫描」：把某会话的新消息按「触发对象 + 关键词」判定，命中就落一条触发记录。
 *
 * 从 `task-center.ts` 拆出来（M21 单文件 1000 行上限）：这里只有扫描一侧的逻辑，
 * 存储/校验/CRUD 仍在 `task-center.ts`，对外接口由它统一再导出。
 *
 * 两条关键决策：
 *  ① **水位推进**只在确实见过更大的 `sort_seq` 时发生；无消息时不写库（否则每次空扫都写一行）。
 *  ② 单任务失败不连坐：坏会话（分片正在重解密/库被占用）只把原因收进 `errors`，其余任务照扫。
 *
 * 记录的初始回调状态也在这里定：`pending` = 该记录值得进入投递队列（**当前触发方式的
 * 描述符必填项齐全**），`skipped` = 任务没配好 / 厂商不在注册表。判定见
 * {@link scanOneTask} 里的 `downstreamReady`（与投递入口同一套 `missingReadyFields` 口径）。
 */
import { withWritableDb } from './db-open.ts'
import { findVendor } from './rpa/registry.ts'
import { missingReadyFields } from './rpa/template.ts'
import { queryMessages, queryNewMessages } from './messages.ts'
import { insertTaskTriggerGreeting } from './message-list-store.ts'
import {
  ensureTaskSchema,
  rowToTask,
  storeExists,
  taskCellNum,
  taskDbPath,
} from './task-center.ts'
import type {
  TaskInfo,
  TaskTriggerCallbackStatus,
  TaskTriggerImage,
  TaskTriggerScanResult,
  TaskTriggerText,
  WechatMessage,
} from '../types.ts'

/** 每次扫描每页拉多少新消息 / 每页往回翻多少张图片。 */
const SCAN_PAGE_SIZE = 200
/** 扫描与图片回溯的最大页数：防止在「一条命中都没有」的会话里扫全库。 */
const SCAN_MAX_PAGES = 5
/** 触发文本落库上限（与聊天素材收集同口径）。 */
const TRIGGER_TEXT_MAX = 4000

/**
 * 该任务当前是否「下游配置齐全」：厂商已注册 + 描述符必填项（含凭据是否已保存）齐全。
 *
 * 未知/停用厂商与缺配置都返回 false ⇒ 记录初始状态写 `skipped`（投递入口还会再判一次，
 * 两层同一套 {@link missingReadyFields} 口径，避免"先 pending 再永远投不出去"）。
 * @param task - 任务配置。
 * @returns 可进入投递队列为 true。
 */
function downstreamReady(task: TaskInfo): boolean {
  const adapter = findVendor(task.triggerMethod)
  if (adapter === undefined) return false
  return missingReadyFields(adapter.descriptor, task.triggerConfig, task.triggerSecretSet).length === 0
}

/** 扫描参数（网关把登录账号 wxid 注进来，query 层不 import gateway 侧）。 */
export interface ScanTaskTriggersOptions {
  /** 登录账号 wxid（用于判定单聊里"对方发的"）。 */
  selfUsername?: string
}

/**
 * 一条消息是否来自"触发对象"。
 *
 * 单聊 = 对方发的（`isSender === 0`）；群聊 = 发送者等于任务配置的目标成员。
 * 群聊里目标正是登录账号本人时，`isSender === 1` 也算（自己发的消息同样能被监听）。
 * @param msg - 已解析的消息。
 * @param task - 任务配置。
 * @param selfUsername - 登录账号 wxid。
 * @returns 命中触发对象为 true。
 */
function isTargetMessage(msg: WechatMessage, task: TaskInfo, selfUsername: string): boolean {
  if (task.chatType === 'private') return msg.isSender === 0
  const target = task.targetUsername
  if (target === '') return false
  if (msg.sender === target) return true
  return selfUsername !== '' && target === selfUsername && msg.isSender === 1
}

/**
 * 是否命中「仅匹配 @我」条件。
 *
 * 只认消息解析层从 `source.atuserlist` 给出的结构化列表，不拿正文里的 `@昵称` 猜：
 * 昵称可改、重名、正文里的普通 @ 都会造成误触发。群消息 @所有人（`notify@all`）
 * 不算单独 @ 我，避免一条公告命中所有任务。
 * @param msg - 已解析消息。
 * @param task - 任务配置。
 * @param selfUsername - 登录账号 wxid。
 * @returns 未开启该条件，或结构化 @ 列表包含登录账号时为 true。
 */
function matchesMentionMe(msg: WechatMessage, task: TaskInfo, selfUsername: string): boolean {
  if (!task.mentionMeOnly) return true
  if (selfUsername === '') return false
  return (msg.atUsers ?? []).some((user) => user.username === selfUsername)
}

/** 消息的可读正文（`displayText` 优先，退回原文；trim 后为空表示"没有正文"）。 */
function readableText(msg: WechatMessage): string {
  const raw = msg.displayText ?? msg.msgContent ?? msg.strContent ?? ''
  return raw.trim()
}

/** 图片消息判定（`renderType` 是解析层给的归一化种类，`type === 3` 兼容老/未分类形状）。 */
function isImageMessage(msg: WechatMessage): boolean {
  return msg.renderType === 'image' || msg.type === 3
}

/** 文本消息判定：有可读正文，且不是图片/语音/视频/文件等媒体消息。 */
function isTextMessage(msg: WechatMessage): boolean {
  if (readableText(msg) === '') return false
  if (msg.renderType === undefined) return msg.type === 1
  return msg.renderType === 'text'
}

/** 触发图片的发送者显示名（与消息列表同一口径：昵称 → wxid → 我/对方）。 */
function imageSenderOf(msg: WechatMessage): string {
  if (msg.senderName !== undefined && msg.senderName.trim() !== '') return msg.senderName.trim()
  if (msg.sender !== undefined && msg.sender.trim() !== '') return msg.sender.trim()
  return msg.isSender === 1 ? '我' : '对方'
}

/**
 * 取该任务触发对象**最近 limit 张图片**（时间正序返回）。
 *
 * 分页往回扫（每页 200、最多 5 页）：只读消息表、不解码字节；一张都没命中时最多翻 5 页，
 * 避免在纯文本会话里扫全库。`limit === 0` 直接返回空数组（用户不想带图）。
 * @param decryptedDir - 解密数据根。
 * @param task - 任务配置。
 * @param selfUsername - 登录账号 wxid。
 * @param limit - 张数（0..9）。
 * @returns 图片引用（时间正序：早 → 晚）。
 */
function collectTriggerImages(
  decryptedDir: string,
  task: TaskInfo,
  selfUsername: string,
  limit: number,
  cache: Map<string, TaskTriggerImage[]>,
): TaskTriggerImage[] {
  if (limit <= 0) return []
  const cacheKey = task.chatUsername + '\0' + task.targetUsername + '\0' + selfUsername + '\0' + String(limit)
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached
  const out: TaskTriggerImage[] = []
  let cursor: number | undefined
  let cursorLocalId: number | undefined
  for (let page = 0; page < SCAN_MAX_PAGES && out.length < limit; page += 1) {
    const snap = queryMessages(decryptedDir, task.chatUsername, SCAN_PAGE_SIZE, cursor, selfUsername, cursorLocalId)
    const messages = snap.messages
    // queryMessages 返回的是「早 → 晚」，所以从尾部往前取才是"最近"。
    for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const msg = messages[i]
      if (msg === undefined || !isImageMessage(msg) || !isTargetMessage(msg, task, selfUsername)) continue
      const image: TaskTriggerImage = {
        localId: msg.localId,
        createTime: msg.createTime * 1000,
        sender: imageSenderOf(msg),
      }
      const senderUsername = msg.sender?.trim()
        || (msg.isSender === 1
          ? selfUsername
          : (task.chatType === 'private' ? (task.targetUsername || task.chatUsername) : ''))
      if (senderUsername) image.senderUsername = senderUsername
      if (msg.senderEnterpriseName) image.senderEnterpriseName = msg.senderEnterpriseName
      if (msg.rich?.md5 !== undefined && msg.rich.md5 !== '') image.md5 = msg.rich.md5
      out.push(image)
    }
    if (snap.hasMore !== true || snap.cursor === undefined) break
    cursor = snap.cursor
    cursorLocalId = snap.cursorLocalId
  }
  // 收集时是「新 → 旧」，回调按时间正序发出去（与阅读方向一致）。
  out.reverse()
  cache.set(cacheKey, out)
  return out
}

/**
 * 取该任务触发对象**最近 limit 条文本消息**（时间正序返回）。
 *
 * 与 {@link collectTriggerImages} 同一套口径：分页往回扫、只读消息表、不解码字节，
 * 并且**只取触发人发的**（`isTargetMessage`：单聊 = 对方，群聊 = 被监听的那个成员）。
 * `limit === 0` 直接返回空数组。
 * @param decryptedDir - 解密数据根。
 * @param task - 任务配置。
 * @param selfUsername - 登录账号 wxid。
 * @param limit - 条数（0..9）。
 * @returns 文本引用（时间正序：早 → 晚）。
 */
function collectTriggerTexts(
  decryptedDir: string,
  task: TaskInfo,
  selfUsername: string,
  limit: number,
  cache: Map<string, TaskTriggerText[]>,
): TaskTriggerText[] {
  if (limit <= 0) return []
  const cacheKey = task.chatUsername + '\0' + task.targetUsername + '\0' + selfUsername + '\0' + String(limit)
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached
  const out: TaskTriggerText[] = []
  let cursor: number | undefined
  let cursorLocalId: number | undefined
  for (let page = 0; page < SCAN_MAX_PAGES && out.length < limit; page += 1) {
    const snap = queryMessages(decryptedDir, task.chatUsername, SCAN_PAGE_SIZE, cursor, selfUsername, cursorLocalId)
    const messages = snap.messages
    for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const msg = messages[i]
      if (msg === undefined || !isTextMessage(msg) || !isTargetMessage(msg, task, selfUsername)) continue
      out.push({
        localId: msg.localId,
        createTime: msg.createTime * 1000,
        sender: imageSenderOf(msg),
        text: readableText(msg).slice(0, TRIGGER_TEXT_MAX),
      })
    }
    if (snap.hasMore !== true || snap.cursor === undefined) break
    cursor = snap.cursor
    cursorLocalId = snap.cursorLocalId
  }
  out.reverse()
  cache.set(cacheKey, out)
  return out
}

/** 命中一条消息时的判定结果（keyword 记用户配置里的原文）。 */
interface TriggerMatch {
  keyword: string
  text: string
  triggeredAt: number
}

/**
 * 文本命中判定：可读正文非空，且**第一个**满足"包含关系（大小写不敏感）"的关键词命中。
 * 一条消息只产生一条记录（多关键词同时命中不重复触发）。
 * @param msg - 消息。
 * @param keywords - 任务关键词（已有序）。
 * @returns 命中信息；未命中为 null。
 */
function matchTrigger(msg: WechatMessage, keywords: readonly string[], lowered: readonly string[]): TriggerMatch | null {
  const text = readableText(msg)
  if (text === '') return null
  const lower = text.toLowerCase()
  const index = lowered.findIndex((item) => lower.includes(item))
  const keyword = index >= 0 ? keywords[index] : undefined
  if (keyword === undefined) return null
  const triggeredAt = msg.createTime > 0 ? msg.createTime * 1000 : Date.now()
  return { keyword, text: text.slice(0, TRIGGER_TEXT_MAX), triggeredAt }
}

/** 扫描的错误收集器：单个任务失败不连坐，只保留前 10 条原因。 */
function pushScanError(errors: string[], message: string): void {
  if (errors.length >= 10) return
  errors.push(message)
}

/** 一次扫描要处理的已完善任务（水位不在 TaskInfo 契约里，单独带着）。 */
interface ScanTask {
  task: TaskInfo
  lastScanSeq: number
}

/**
 * 同步扫描一次：对每个已完善任务，从水位之后拉新消息、命中关键词就落一条触发记录。
 *
 * 同一会话、同一水位的任务只读一次新消息；图片/文本回溯在这一拍里按对象复用。
 * 读消息时不占任务库写锁，写记录时再短开一次。单任务失败不连坐（错误只收集前 10 条）；
 * 水位只在**确实见过更大的 sort_seq** 时推进，无消息时不动。记录写入用 `INSERT OR IGNORE`。
 * @param decryptedDir - 解密数据根。
 * @param opts - 扫描参数（登录账号 wxid）。
 * @returns 扫描结果（tasks / scanned / created / dispatched 恒有；失败带 error / errors）。
 */
export function scanTaskTriggers(decryptedDir: string, opts?: ScanTaskTriggersOptions): TaskTriggerScanResult {
  const selfUsername = typeof opts?.selfUsername === 'string' ? opts.selfUsername.trim() : ''
  const result: TaskTriggerScanResult = { ok: true, tasks: 0, scanned: 0, created: 0, dispatched: 0 }
  // 库不存在 = 还没建过任务：不建库、直接空结果（后台定时器不该凭空造文件）。
  if (!storeExists(decryptedDir)) return result
  const errors: string[] = []
  let ready: ScanTask[]
  try {
    ready = loadReadyTasks(decryptedDir)
  } catch (e) {
    result.ok = false
    result.error = '任务库读取失败：' + errorText(e)
    return result
  }
  result.tasks = ready.length
  const imageCache = new Map<string, TaskTriggerImage[]>()
  const textCache = new Map<string, TaskTriggerText[]>()
  for (const group of groupScanTasks(ready)) {
    try {
      scanTaskGroup(decryptedDir, group, selfUsername, imageCache, textCache, result, errors)
    } catch (e) {
      const name = group[0]?.task.chatName || group[0]?.task.chatUsername || '会话'
      pushScanError(errors, '会话「' + name + '」扫描失败：' + errorText(e))
    }
  }
  if (errors.length > 0) result.errors = errors
  return result
}

/** 读出全部已完善任务。短开任务库，避免后面翻消息时一直占着写锁。 */
function loadReadyTasks(decryptedDir: string): ScanTask[] {
  return withWritableDb(taskDbPath(decryptedDir), (db) => {
    ensureTaskSchema(db)
    const rows = db.prepare("SELECT * FROM task_info WHERE status = 'ready' ORDER BY id ASC").all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      task: rowToTask(row, decryptedDir),
      lastScanSeq: taskCellNum(row['last_scan_seq']),
    }))
  })
}

/**
 * 把同一会话、同一水位的任务合成一组。
 *
 * 水位不同不能合并：落后的任务会吃掉页预算，让已经追上的任务这一拍看不到新消息。
 * @param tasks - 已按 id 升序的已完善任务。
 * @returns 分组（组内、组间都保持原顺序）；没有关键词的任务不进组。
 */
function groupScanTasks(tasks: readonly ScanTask[]): ScanTask[][] {
  const groups: ScanTask[][] = []
  const index = new Map<string, ScanTask[]>()
  for (const item of tasks) {
    if (item.task.keywords.length === 0) continue
    const key = item.task.chatUsername + '\0' + String(item.lastScanSeq)
    const found = index.get(key)
    if (found !== undefined) {
      found.push(item)
      continue
    }
    const created = [item]
    index.set(key, created)
    groups.push(created)
  }
  return groups
}

/** 同一会话只翻一次新消息，再分别套到组里每个任务上。 */
function scanTaskGroup(
  decryptedDir: string,
  group: readonly ScanTask[],
  selfUsername: string,
  imageCache: Map<string, TaskTriggerImage[]>,
  textCache: Map<string, TaskTriggerText[]>,
  result: TaskTriggerScanResult,
  errors: string[],
): void {
  const first = group[0]
  if (first === undefined) return
  const pages = readNewMessagePages(decryptedDir, first.task.chatUsername, first.lastScanSeq, selfUsername)
  for (const page of pages) result.scanned += page.length
  if (pages.length === 0) return
  for (const item of group) {
    try {
      applyScanPages(decryptedDir, item, pages, selfUsername, imageCache, textCache, result, errors)
    } catch (e) {
      pushScanError(errors, '任务「' + item.task.name + '」扫描失败：' + errorText(e))
    }
  }
}

/** 从水位往后最多翻 {@link SCAN_MAX_PAGES} 页新消息。页内顺序是早 → 晚。 */
function readNewMessagePages(
  decryptedDir: string,
  chatUsername: string,
  after: number,
  selfUsername: string,
): WechatMessage[][] {
  const pages: WechatMessage[][] = []
  let cursor = after
  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const snapshot = queryNewMessages(decryptedDir, chatUsername, cursor, SCAN_PAGE_SIZE, selfUsername)
    const messages = snapshot.messages
    if (messages.length === 0) break
    pages.push(messages)
    if (messages.length < SCAN_PAGE_SIZE) break
    const last = messages[messages.length - 1]
    const next = last?.sortSeq ?? 0
    // sort_seq 可能重复；没有前进就停，避免同一页被反复读成"新消息"。
    if (next <= cursor) break
    cursor = next
  }
  return pages
}

/** 错误文本（Error.message 优先；本文件只用于收集逐任务失败原因）。 */
function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/**
 * 把已经读好的新消息套到一个任务上：判定对象/关键词 → 落记录 → 推进水位。
 *
 * 语句在本任务里只准备一次。图片和文本回溯走这一拍共享的缓存。
 * @param decryptedDir - 解密数据根。
 * @param item - 任务与扫描前水位。
 * @param pages - 该水位之后的新消息页。
 * @param selfUsername - 登录账号 wxid。
 * @param imageCache - 这一拍的图片回溯缓存。
 * @param textCache - 这一拍的文本回溯缓存。
 * @param result - 累计结果（就地累加 created）。
 * @param errors - 逐问候失败原因收集器（最多 10 条）。
 */
function applyScanPages(
  decryptedDir: string,
  item: ScanTask,
  pages: readonly (readonly WechatMessage[])[],
  selfUsername: string,
  imageCache: Map<string, TaskTriggerImage[]>,
  textCache: Map<string, TaskTriggerText[]>,
  result: TaskTriggerScanResult,
  errors: string[],
): void {
  const task = item.task
  const lowered = task.keywords.map((keyword) => keyword.toLowerCase())
  withWritableDb(taskDbPath(decryptedDir), (db) => {
    ensureTaskSchema(db)
    const insert = db.prepare(`INSERT OR IGNORE INTO task_triggers
      (task_id, task_name, chat_username, chat_name, target_username, target_name, keyword, text, images, texts,
       message_local_id, message_sort_seq, triggered_at, callback_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const advance = db.prepare('UPDATE task_info SET last_scan_seq = ? WHERE id = ?')
    const count = db.prepare('UPDATE task_info SET last_triggered_at = ?, trigger_count = trigger_count + ? WHERE id = ?')
    let maxSeen = item.lastScanSeq
    let taskCreated = 0
    let lastTriggeredAt = 0
    let cachedImages: TaskTriggerImage[] | null = null
    let cachedTexts: TaskTriggerText[] | null = null
    for (const messages of pages) {
      for (const msg of messages) {
        const messageSortSeq = msg.sortSeq ?? 0
        if (messageSortSeq > maxSeen) maxSeen = messageSortSeq
        if (!isTargetMessage(msg, task, selfUsername)) continue
        if (!matchesMentionMe(msg, task, selfUsername)) continue
        const match = matchTrigger(msg, task.keywords, lowered)
        if (match === null) continue
        const images = cachedImages ??= collectTriggerImages(
          decryptedDir, task, selfUsername, task.photoLimit, imageCache,
        )
        const textPool = task.textLimit > 0
          ? (cachedTexts ??= collectTriggerTexts(decryptedDir, task, selfUsername, task.textLimit + 1, textCache))
          : []
        const texts = task.textLimit > 0
          ? textPool.filter((entry) => entry.localId !== msg.localId).slice(-task.textLimit)
          : []
        const callbackStatus: TaskTriggerCallbackStatus = downstreamReady(task) ? 'pending' : 'skipped'
        const info = insert.run(
          task.id, task.name, task.chatUsername, task.chatName, task.targetUsername, task.targetName,
          match.keyword, match.text, JSON.stringify(images), JSON.stringify(texts),
          msg.localId, messageSortSeq, match.triggeredAt, callbackStatus,
        )
        if (Number(info.changes) <= 0) continue
        result.created += 1
        taskCreated += 1
        if (match.triggeredAt > lastTriggeredAt) lastTriggeredAt = match.triggeredAt
        if (!task.greetingEnabled || task.greetingText.trim() === '') continue
        try {
          const greeting = insertTaskTriggerGreeting(decryptedDir, db, {
            taskId: task.id,
            triggerId: taskCellNum(info.lastInsertRowid),
            taskName: task.name,
            chatName: task.chatName,
            chatUsername: task.chatUsername,
            targetName: task.targetName,
            targetUsername: task.targetUsername,
            images,
            triggeredAt: match.triggeredAt,
            greetingText: task.greetingText,
          })
          if (!greeting.ok && greeting.error !== undefined) {
            pushScanError(errors, '任务「' + task.name + '」问候语写入失败：' + greeting.error)
          }
        } catch (e) {
          pushScanError(errors, '任务「' + task.name + '」问候语写入失败：' + errorText(e))
        }
      }
    }
    if (maxSeen > item.lastScanSeq) advance.run(maxSeen, task.id)
    if (taskCreated > 0) count.run(lastTriggeredAt, taskCreated, task.id)
  })
}

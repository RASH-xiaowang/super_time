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
import type { DatabaseSync } from './db-open.ts'
import { findVendor } from './rpa/registry.ts'
import { missingReadyFields } from './rpa/template.ts'
import { queryMessages, queryNewMessages } from './messages.ts'
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
): TaskTriggerImage[] {
  if (limit <= 0) return []
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
      if (msg.rich?.md5 !== undefined && msg.rich.md5 !== '') image.md5 = msg.rich.md5
      out.push(image)
    }
    if (snap.hasMore !== true || snap.cursor === undefined) break
    cursor = snap.cursor
    cursorLocalId = snap.cursorLocalId
  }
  // 收集时是「新 → 旧」，回调按时间正序发出去（与阅读方向一致）。
  out.reverse()
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
function matchTrigger(msg: WechatMessage, keywords: readonly string[]): TriggerMatch | null {
  const text = readableText(msg)
  if (text === '') return null
  const lower = text.toLowerCase()
  const keyword = keywords.find((item) => lower.includes(item.toLowerCase()))
  if (keyword === undefined) return null
  const triggeredAt = msg.createTime > 0 ? msg.createTime * 1000 : Date.now()
  return { keyword, text: text.slice(0, TRIGGER_TEXT_MAX), triggeredAt }
}

/** 扫描的错误收集器：单个任务失败不连坐，只保留前 10 条原因。 */
function pushScanError(errors: string[], message: string): void {
  if (errors.length >= 10) return
  errors.push(message)
}

/**
 * 同步扫描一次：对每个已完善任务，从水位之后拉新消息、命中关键词就落一条触发记录。
 *
 * 单任务失败不连坐（错误只收集前 10 条）；水位只在**确实见过更大的 sort_seq** 时推进，
 * 无消息时不动。记录写入用 `INSERT OR IGNORE`（UNIQUE 冲突 = 已经记过，跳过）。
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
  try {
    withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureTaskSchema(db)
      const rows = db.prepare("SELECT * FROM task_info WHERE status = 'ready' ORDER BY id ASC").all() as Array<Record<string, unknown>>
      result.tasks = rows.length
      for (const row of rows) {
        const task = rowToTask(row)
        try {
          // 水位不在 `TaskInfo` 契约里（它是扫描内部状态），直接从行上取。
          scanOneTask(db, decryptedDir, task, taskCellNum(row['last_scan_seq']), selfUsername, result)
        } catch (e) {
          pushScanError(errors, '任务「' + task.name + '」扫描失败：' + errorText(e))
        }
      }
    })
  } catch (e) {
    result.ok = false
    result.error = '任务库读取失败：' + errorText(e)
    return result
  }
  if (errors.length > 0) result.errors = errors
  return result
}

/** 错误文本（Error.message 优先；本文件只用于收集逐任务失败原因）。 */
function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/**
 * 扫一个任务：翻新消息 → 判定对象/关键词 → 落记录 → 推进水位与任务计数。
 *
 * 独立成函数是为了让 {@link scanTaskTriggers} 的循环体保持可读（同一层里三个 try 会让
 * "哪一步失败算谁的"糊掉）。所有 SQL 都是单语句 autocommit，不跨 await 开事务。
 * @param db - 已打开的可写任务库连接。
 * @param decryptedDir - 解密数据根。
 * @param task - 任务配置。
 * @param lastScanSeq - 该任务已处理到的 `sort_seq` 水位（来自 `task_info.last_scan_seq`）。
 * @param selfUsername - 登录账号 wxid。
 * @param result - 累计结果（就地累加 scanned/created）。
 */
function scanOneTask(
  db: DatabaseSync,
  decryptedDir: string,
  task: TaskInfo,
  lastScanSeq: number,
  selfUsername: string,
  result: TaskTriggerScanResult,
): void {
  if (task.keywords.length === 0) return
  let after = lastScanSeq
  let maxSeen = lastScanSeq
  let taskCreated = 0
  let lastTriggeredAt = 0
  /**
   * 图片回溯的**每任务一次**缓存。
   *
   * 一次同步可能带来同一会话的多条命中；原实现每条命中都重新翻最多 5 页 ×200 条消息去
   * 收集"最近 N 张图"，同一批数据被重复读好几遍 —— 这是扫描耗时的主要放大项。
   * "触发时携带该对象最近 N 张"在同一个扫描批次里本来就是同一个快照，直接复用即可。
   */
  let cachedImages: TaskTriggerImage[] | null = null
  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const snapshot = queryNewMessages(decryptedDir, task.chatUsername, after, SCAN_PAGE_SIZE, selfUsername)
    const messages = snapshot.messages
    if (messages.length === 0) break
    result.scanned += messages.length
    for (const msg of messages) {
      // `sortSeq` 在类型上是可选的（解析层对极老的库可能给不出），缺省按 0 处理：
      // 只影响"水位能不能前进"，不影响命中判定本身。
      const messageSortSeq = msg.sortSeq ?? 0
      if (messageSortSeq > maxSeen) maxSeen = messageSortSeq
      if (!isTargetMessage(msg, task, selfUsername)) continue
      if (!matchesMentionMe(msg, task, selfUsername)) continue
      const match = matchTrigger(msg, task.keywords)
      if (match === null) continue
      const images = cachedImages ??= collectTriggerImages(decryptedDir, task, selfUsername, task.photoLimit)
      // 记录是否值得进入投递队列：按注册表 + 描述符必填项判定（与投递入口同一口径）。
      const callbackStatus: TaskTriggerCallbackStatus = downstreamReady(task) ? 'pending' : 'skipped'
      const info = db.prepare(`INSERT OR IGNORE INTO task_triggers
        (task_id, task_name, chat_username, chat_name, target_username, target_name, keyword, text, images,
         message_local_id, message_sort_seq, triggered_at, callback_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        task.id, task.name, task.chatUsername, task.chatName, task.targetUsername, task.targetName,
        match.keyword, match.text, JSON.stringify(images), msg.localId, messageSortSeq, match.triggeredAt, callbackStatus,
      )
      if (Number(info.changes) > 0) {
        result.created += 1
        taskCreated += 1
        if (match.triggeredAt > lastTriggeredAt) lastTriggeredAt = match.triggeredAt
      }
    }
    if (messages.length < SCAN_PAGE_SIZE) break
    const last = messages[messages.length - 1]
    const next = last?.sortSeq ?? 0
    // sort_seq 可能重复；没有前进就停，避免同一页被反复读成"新消息"。
    if (next <= after) break
    after = next
  }
  if (maxSeen > lastScanSeq) {
    db.prepare('UPDATE task_info SET last_scan_seq = ? WHERE id = ?').run(maxSeen, task.id)
  }
  if (taskCreated > 0) {
    db.prepare('UPDATE task_info SET last_triggered_at = ?, trigger_count = trigger_count + ? WHERE id = ?')
      .run(lastTriggeredAt, taskCreated, task.id)
  }
}

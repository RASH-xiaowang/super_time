/**
 * 微信 ClawBot 接入会话（`clawbot_message`）——写入与检索。
 *
 * ## 顺序的唯一事实是 `id`
 *
 * 事件推送只当幂等提示：前端收到 `clawbot/message` 后按 `lastId` 拉 `id > afterId` 的增量，
 * 用 `Set<id>` 去重、按 **`id`（不是 `ts`）** 合并 —— 同毫秒多条时 `ts` 排不出先后。
 * 因此 `id` 是 `AUTOINCREMENT` 且永不复用（见建表语句）。
 *
 * ## 检索的三条纪律（与 `operation-log.ts` 同源）
 *
 * 1. **关键词必须服务端过滤**：列表是分页取的，客户端过滤等于只搜当前页。
 * 2. **LIKE 必须转义** `%` `_` `\`，否则用户输入 `%` 等于全表。
 * 3. **读失败 ≠ 没有数据**：库打不开时返回 `readError`，而不是空列表；
 *    但**库不存在不算读失败**（还没接入过消息），返回空快照即可。
 *
 * @module query/clawbot/clawbot-message
 */
import type { ClawbotMessage, ClawbotMessageQuery, ClawbotMessageSnapshot } from '../../types.ts'
import { DEFAULT_CLAWBOT_SLOT, clawbotDbExists, clawbotDbPath, ensureClawbotSchema } from './clawbot-db.ts'
import { withDb, withWritableDb } from '../db-open.ts'
import type { DatabaseSync } from '../db-open.ts'
import { enqueueOrMergeReplyRunOn } from './clawbot-reply-store.ts'
import { ClawbotSessionChangedError } from './clawbot-errors.ts'

/** 每页默认条数（与 `usePagedList` 一页一致）。 */
export const CLAWBOT_MESSAGE_DEFAULT_LIMIT = 100
/**
 * 单次检索上限。
 *
 * 比 `operation-log` 的 5000 严：那条记的是元数据，这条记的是**正文**，同样的行数
 * 体积大一个量级（正文一句话就能上百字节）。2000 条已远超一屏，再多只是给 IPC 添堵。
 */
export const CLAWBOT_MESSAGE_MAX_LIMIT = 2000
/** 单实例单会话最多保留多少条 clear 竞态墓碑，防止长期运行无界增长。 */
export const CLAWBOT_MESSAGE_TOMBSTONE_LIMIT = 10_000
const TOMBSTONE_LOOKUP_CHUNK = 400
/** 多行 INSERT 每行 4 个参数；200 行仍低于 SQLite 常见的 999 变量上限。 */
const TOMBSTONE_INSERT_CHUNK = 200

function clampLimit(v: number | undefined): number {
  return Math.min(Math.max(Math.floor(v ?? CLAWBOT_MESSAGE_DEFAULT_LIMIT), 1), CLAWBOT_MESSAGE_MAX_LIMIT)
}

function asDirection(v: unknown): 'in' | 'out' {
  return v === 'out' ? 'out' : 'in'
}

/** 字符串列 → string | null（空串归一成 null）。 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** 数字列 → number | null。 */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 附件引用（**内部**：怎么取 + 展示元数据；`key` 与 `ref` 不进渲染层快照）。 */
export interface ClawbotMediaRef {
  /** 看 msgType 同源：image / voice / video / file。 */
  kind: 'image' | 'voice' | 'video' | 'file'
  /** 明文 URL，或 CDN 加密参数（看 `key` 是否为空）。 */
  ref: string
  /** base64 的 AES key；空串 = `ref` 是明文 URL（无需解密）。 */
  key: string
  /** 文件名（文件类；其余为 null）。 */
  name: string | null
  /** 密文/明文体积提示（字节；未知为 null）。 */
  size: number | null
  /** 时长（毫秒；**只有语音有**，协议 `voice_item.playtime`；其余为 null）。 */
  duration: number | null
}

/** 行 → 公开附件信息（只给渲染层展示元数据：kind/name/size/duration；不含取数引用与密钥）。 */
function toMediaInfo(r: Record<string, unknown>): { kind: string, name: string | null, size: number | null, duration: number | null } | null {
  const kind = typeof r['media_kind'] === 'string' && r['media_kind'] !== '' ? r['media_kind'] : null
  if (kind === null) return null
  return {
    kind,
    name: str(r['media_name']),
    size: num(r['media_size']),
    duration: num(r['media_duration']),
  }
}

function toMessage(r: Record<string, unknown>): ClawbotMessage {
  return {
    /* v8 ignore next -- id/ts 是非空主键与 NOT NULL 列，存下来的行一定有。 */
    id: Number(r['id'] ?? 0),
    slot: Number(r['slot'] ?? DEFAULT_CLAWBOT_SLOT),
    ts: Number(r['ts'] ?? 0),
    direction: asDirection(r['direction']),
    msgType: typeof r['msg_type'] === 'string' && r['msg_type'] !== '' ? r['msg_type'] : null,
    /* v8 ignore next -- content 允许为 NULL（非文本消息），归一成空串给展示层。 */
    content: typeof r['content'] === 'string' ? r['content'] : '',
    createdAt: Number(r['created_at'] ?? 0),
    media: toMediaInfo(r),
  }
}

/** 一条待落库的消息（服务端收/发时构造；`createdAt` 缺省取当前时间）。 */
export interface ClawbotMessageInput {
  /** 实例编号（缺省 1 = 第一个实例，旧调用方零改动）。 */
  slot?: number
  ts: number
  direction: 'in' | 'out'
  msgType?: string | null
  content: string
  createdAt?: number
  /**
   * 服务端消息 id（`message_id`），用于**去重**。
   *
   * 为什么必须去重：会话过期（errcode -14）时我们会清空同步游标重拉，
   * 服务端会把历史**重发**一遍 —— 没有它同一句话会在列表里出现两次。
   * 缺省/非正数 = 不去重（尽力而为：没有 id 的帧只能按新消息处理）。
   */
  msgId?: number | null
  /**
   * 本地发送幂等键。
   *
   * 自动回复 outbox 在发送前就把它持久化；进程在「上游已接收、本地尚未记账」
   * 之间崩溃时，重试复用同一个键。发送路径据此在本地也只落一行，避免
   * 服务端幂等成功但本地会话里出现重复出站气泡。
   */
  clientId?: string | null
  /** 附件引用（图片/语音/视频/文件）；纯文本为 null。 */
  media?: ClawbotMediaRef | null
}

/** 批量落库时可选地在同一事务里创建自动回复 run。 */
export interface ClawbotMessageBatchOptions {
  /** 批次捕获时的会话代次；仅允许用于单 slot 批次。 */
  expectedSessionEpoch?: number
  replyIntake?: {
    debounceMs?: number
    maxPending?: number
  }
}

/** 单条落库时的可选持久会话 fencing。 */
export interface ClawbotMessageInsertOptions {
  expectedSessionEpoch?: number
}

/**
 * 写入一条接入会话消息。
 *
 * 带 `msgId` 且库里已有同一 id ⇒ **跳过**（返回 null），事件与 id 都不产生 ——
 * 去重判断与插入在同一条连接里，不存在检查后被并发插入的窗口（单写方）。
 * @param decryptedDir - 解密数据根。
 * @param input - 消息内容（正文原文；打码只在展示层做）。
 * @param options - 可选的会话代次快照；传入后在同一事务内校验后才允许写入。
 * @returns 新行的 `id`；被去重跳过时为 null。
 */
export function insertClawbotMessage(
  decryptedDir: string,
  input: ClawbotMessageInput,
  options: ClawbotMessageInsertOptions = {},
): number | null {
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    const slot = Math.max(Math.floor(input.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
    const expectedSessionEpoch = options.expectedSessionEpoch
    const hasMsgId = typeof input.msgId === 'number' && input.msgId > 0
    if (expectedSessionEpoch === undefined && !hasMsgId) return insertClawbotMessageOn(db, input)

    // 有 msgId 时也必须进写事务：clear 不能在“查水位”和“插入”之间插队提交。
    db.exec('BEGIN IMMEDIATE')
    try {
      if (expectedSessionEpoch !== undefined) {
        const actual = sessionEpochOn(db, slot)
        if (actual !== expectedSessionEpoch) {
          throw new ClawbotSessionChangedError(slot, expectedSessionEpoch, actual)
        }
      }
      const blocked = hasMsgId
        ? blockedMessageIdsOn(db, slot, [input.msgId as number], expectedSessionEpoch)
        : undefined
      const id = insertClawbotMessageOn(db, input, blocked)
      db.exec('COMMIT')
      return id
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 保留原始异常 */ }
      throw e
    }
  })
}

/**
 * 按发送幂等键查本地消息行。
 *
 * durable outbox 重试先查这里：行已经存在说明上游上一次已成功且本地已回填，
 * 可以直接补记 outbox，不必再次请求上游。读取失败必须抛给调用方，不能把
 * 「查不到」与「库坏了」混为一谈后冒险重发。
 */
export function findClawbotMessageIdByClientId(
  decryptedDir: string,
  slot: number,
  clientId: string,
): number | null {
  const s = Math.max(Math.floor(slot), 1)
  const key = clientId.trim()
  if (key === '' || !clawbotDbExists(decryptedDir)) return null
  return withDb(clawbotDbPath(decryptedDir), (db) => {
    const row = db.prepare('SELECT id FROM clawbot_message WHERE slot = ? AND client_id = ? LIMIT 1')
      .get(s, key) as { id?: number } | undefined
    const id = Number(row?.id ?? 0)
    return id > 0 ? id : null
  })
}

function sessionEpochOn(db: DatabaseSync, slot: number): number {
  const row = db.prepare('SELECT session_epoch FROM clawbot_binding WHERE slot = ? ORDER BY id DESC LIMIT 1')
    .get(slot) as { session_epoch?: number } | undefined
  return Math.max(Math.floor(Number(row?.session_epoch ?? 0)), 0)
}

/** 读当前会话的清空水位（没有绑定行时按 0 处理）。 */
function clearWatermarkOn(db: DatabaseSync, slot: number): number {
  const row = db.prepare('SELECT clear_watermark FROM clawbot_binding WHERE slot = ? ORDER BY id DESC LIMIT 1')
    .get(slot) as { clear_watermark?: number } | undefined
  return Math.max(Math.floor(Number(row?.clear_watermark ?? 0)), 0)
}

/** 在当前绑定会话代次里查 tombstone；分块查询避免超过 SQLite 参数上限。 */
function suppressedMessageIdsOn(
  db: DatabaseSync,
  slot: number,
  msgIds: readonly number[],
  epoch: number = sessionEpochOn(db, slot),
): Set<number> {
  const unique = [...new Set(msgIds.filter(id => Number.isFinite(id) && id > 0).map(id => Math.floor(id)))]
  const blocked = new Set<number>()
  if (unique.length === 0) return blocked
  for (let offset = 0; offset < unique.length; offset += TOMBSTONE_LOOKUP_CHUNK) {
    const chunk = unique.slice(offset, offset + TOMBSTONE_LOOKUP_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.prepare(`SELECT msg_id FROM clawbot_message_tombstone
      WHERE slot = ? AND session_epoch = ? AND msg_id IN (${placeholders})`)
      .all(slot, epoch, ...chunk) as Array<{ msg_id?: number }>
    for (const row of rows) blocked.add(Number(row.msg_id ?? 0))
  }
  return blocked
}

/** 合并墓碑与清空水位：水位即使因墓碑裁剪而失去记录，也能继续拦截旧回放。 */
function blockedMessageIdsOn(
  db: DatabaseSync,
  slot: number,
  msgIds: readonly number[],
  epoch: number = sessionEpochOn(db, slot),
): Set<number> {
  const blocked = suppressedMessageIdsOn(db, slot, msgIds, epoch)
  const watermark = clearWatermarkOn(db, slot)
  if (watermark <= 0) return blocked
  for (const msgId of msgIds) {
    if (Number.isFinite(msgId) && msgId > 0 && Math.floor(msgId) <= watermark) {
      blocked.add(Math.floor(msgId))
    }
  }
  return blocked
}

/** 在当前会话代次写入墓碑；`INSERT OR IGNORE` 与既有墓碑自然合并。 */
function insertTombstonesOn(
  db: DatabaseSync,
  slot: number,
  epoch: number,
  msgIds: readonly number[],
  createdAt: number,
): number {
  let inserted = 0
  for (let offset = 0; offset < msgIds.length; offset += TOMBSTONE_INSERT_CHUNK) {
    const chunk = msgIds.slice(offset, offset + TOMBSTONE_INSERT_CHUNK)
    const values = chunk.map(() => '(?, ?, ?, ?)').join(',')
    const params: number[] = []
    for (const msgId of chunk) params.push(slot, epoch, msgId, createdAt)
    inserted += Number(db.prepare(`INSERT OR IGNORE INTO clawbot_message_tombstone
      (slot, session_epoch, msg_id, created_at) VALUES ${values}`).run(...params).changes)
  }
  return inserted
}

/** 只裁剪当前会话的墓碑，保留最近写入的 {@link CLAWBOT_MESSAGE_TOMBSTONE_LIMIT} 条。 */
function trimTombstonesOn(db: DatabaseSync, slot: number, epoch: number): void {
  const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM clawbot_message_tombstone
    WHERE slot = ? AND session_epoch = ?`).get(slot, epoch) as { n?: number } | undefined)?.n ?? 0)
  if (count <= CLAWBOT_MESSAGE_TOMBSTONE_LIMIT) return
  db.prepare(`DELETE FROM clawbot_message_tombstone WHERE rowid IN (
    SELECT rowid FROM clawbot_message_tombstone
    WHERE slot = ? AND session_epoch = ?
    ORDER BY created_at ASC, msg_id ASC LIMIT ?
  )`).run(slot, epoch, count - CLAWBOT_MESSAGE_TOMBSTONE_LIMIT)
}

/** 在已打开并完成迁移的连接上插入一条消息（单条与批量共用）。 */
function insertClawbotMessageOn(
  db: DatabaseSync,
  input: ClawbotMessageInput,
  blockedMsgIds?: ReadonlySet<number>,
): number | null {
  const slot = Math.max(Math.floor(input.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
  const clientId = typeof input.clientId === 'string' && input.clientId.trim() !== '' ? input.clientId.trim() : null
  if (clientId !== null) {
    // outbox 重试必须命中同一行；返回既有 id，让事件/回填仍可幂等。
    const dup = db.prepare('SELECT id AS x FROM clawbot_message WHERE client_id = ? AND slot = ? LIMIT 1').get(clientId, slot) as { x?: number } | undefined
    if (dup !== undefined) return Number(dup.x)
  }
  const msgId = typeof input.msgId === 'number' && input.msgId > 0 ? input.msgId : null
  if (msgId !== null && blockedMsgIds?.has(msgId) === true) return null
  if (msgId !== null) {
    // 去重按 **slot 内** 判：消息 id 由服务端按会话下发，跨实例复用同一个号段并不安全。
    const dup = db.prepare('SELECT 1 AS x FROM clawbot_message WHERE msg_id = ? AND slot = ? LIMIT 1').get(msgId, slot)
    if (dup) return null
  }
  const m = input.media ?? null
  const r = db.prepare('INSERT INTO clawbot_message(slot, ts, direction, msg_type, content, created_at, msg_id, client_id, media_kind, media_ref, media_key, media_name, media_size, media_duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      slot, Math.floor(input.ts), input.direction === 'out' ? 'out' : 'in', input.msgType ?? null, input.content,
      Math.floor(input.createdAt ?? Date.now()), msgId, clientId,
      m?.kind ?? null, m?.ref ?? null, m?.key ?? null, m?.name ?? null, m?.size ?? null, m?.duration ?? null,
    )
  return Number(r.lastInsertRowid)
}

/**
 * 批量写入一帧里的多条消息：**一次开库、一次建表检查、一个事务**。
 *
 * 接收通道一帧常带多条历史消息。逐条调用 {@link insertClawbotMessage} 会为每条消息
 * 重新打开数据库并跑迁移检查，首绑回补历史时会把 I/O 放大到消息数倍。批量入口保持
 * 逐条去重的语义，同时让整帧要么全部落库、要么全部回滚（游标据此安全推进）。
 * @param decryptedDir - 解密数据根。
 * @param inputs - 同一帧内的消息（空数组不建库）。
 * @returns 与输入等长的行 id；被 `msgId` 去重跳过处为 null。
 */
export function insertClawbotMessagesBatch(
  decryptedDir: string,
  inputs: readonly ClawbotMessageInput[],
  options: ClawbotMessageBatchOptions = {},
): Array<number | null> {
  if (inputs.length === 0) return []
  const expectedSessionEpoch = options.expectedSessionEpoch
  const slots = new Set(inputs.map(input => Math.max(Math.floor(input.slot ?? DEFAULT_CLAWBOT_SLOT), 1)))
  if (expectedSessionEpoch !== undefined && slots.size !== 1) {
    throw new TypeError('expectedSessionEpoch 只能用于单 slot 批次')
  }
  const expectedSlot = slots.size === 1 ? [...slots][0] : undefined
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (expectedSessionEpoch !== undefined && expectedSlot !== undefined) {
        const actual = sessionEpochOn(db, expectedSlot)
        if (actual !== expectedSessionEpoch) {
          throw new ClawbotSessionChangedError(expectedSlot, expectedSessionEpoch, actual)
        }
      }
      const idsBySlot = new Map<number, number[]>()
      for (const input of inputs) {
        if (typeof input.msgId !== 'number' || input.msgId <= 0) continue
        const slot = Math.max(Math.floor(input.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
        const list = idsBySlot.get(slot)
        if (list === undefined) idsBySlot.set(slot, [input.msgId])
        else list.push(input.msgId)
      }
      const blockedBySlot = new Map<number, Set<number>>()
      for (const [slot, msgIds] of idsBySlot) {
        blockedBySlot.set(slot, blockedMessageIdsOn(
          db,
          slot,
          msgIds,
          expectedSessionEpoch !== undefined && slot === expectedSlot ? expectedSessionEpoch : undefined,
        ))
      }
      const ids = inputs.map((input) => {
        const slot = Math.max(Math.floor(input.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
        return insertClawbotMessageOn(db, input, blockedBySlot.get(slot))
      })
      if (options.replyIntake !== undefined) {
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index]
          const id = ids[index]
          if (
            input === undefined ||
            id === null ||
            id === undefined ||
            input.direction !== 'in' ||
            input.msgType !== 'text' ||
            input.content.trim() === ''
          ) continue
          try {
            enqueueOrMergeReplyRunOn(db, {
              slot: Math.max(Math.floor(input.slot ?? DEFAULT_CLAWBOT_SLOT), 1),
              targetMessageId: id,
              question: input.content,
              debounceMs: options.replyIntake.debounceMs,
              maxPending: options.replyIntake.maxPending,
            })
          } catch (e) {
            // 主动背压不应回滚已经收到的消息；其他错误让整帧回滚，由通道重拉。
            if (e instanceof Error && e.message.includes('已积压')) continue
            throw e
          }
        }
      }
      db.exec('COMMIT')
      return ids
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 回滚失败时保留原始异常 */ }
      throw e
    }
  })
}

/**
 * 持久记住 clear 竞态下不能回放的旧消息 id。
 *
 * 只按当前会话代次生效：重新绑定或同 wxid 被别的实例接管会推进代次，
 * 下一次会话不受上一场 tombstone 影响。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param msgIds - 旧批次里的服务端消息 id。
 * @param nowOrOptions - 测试注入时间，或携带时间与预期会话代次的选项。
 * @returns 实际新增的 tombstone 条数。
 */
export interface SuppressClawbotMessageIdsOptions {
  now?: number
  expectedSessionEpoch?: number
}

export function suppressClawbotMessageIds(
  decryptedDir: string,
  slot: number,
  msgIds: readonly number[],
  nowOrOptions: number | SuppressClawbotMessageIdsOptions = Date.now(),
): number {
  const s = Math.max(Math.floor(slot), 1)
  const ids = [...new Set(msgIds.filter(id => Number.isFinite(id) && id > 0).map(id => Math.floor(id)))]
  if (ids.length === 0) return 0
  const now = typeof nowOrOptions === 'number' ? nowOrOptions : nowOrOptions.now ?? Date.now()
  const expectedSessionEpoch = typeof nowOrOptions === 'number' ? undefined : nowOrOptions.expectedSessionEpoch
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      const actual = sessionEpochOn(db, s)
      if (expectedSessionEpoch !== undefined && actual !== expectedSessionEpoch) {
        throw new ClawbotSessionChangedError(s, expectedSessionEpoch, actual)
      }
      const epoch = expectedSessionEpoch ?? actual
      const createdAt = Math.floor(now)
      const inserted = insertTombstonesOn(db, s, epoch, ids, createdAt)
      trimTombstonesOn(db, s, epoch)
      db.exec('COMMIT')
      return inserted
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 保留原始异常 */ }
      throw e
    }
  })
}

/** 列表 SELECT 的列（公开行 + 媒体展示元数据；取数引用与密钥**不在这里**）。 */
const SELECT_COLS = 'id, slot, ts, direction, msg_type, content, created_at, media_kind, media_name, media_size, media_duration'

/**
 * **内部**读一行（含媒体取数引用与密钥）—— 取媒体时用，不进渲染层快照。
 *
 * 打不开 / 行不存在都返回 null（调用方把 null 翻译成可读错误）；打不开时留一行 warn。
 * @param decryptedDir - 解密数据根。
 * @param id - 消息行 id。
 * @returns 内部行；库打不开或行不存在为 null。
 */
export function readClawbotMessageInternal(decryptedDir: string, id: number): ClawbotMessageInternal | null {
  if (!clawbotDbExists(decryptedDir)) return null
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => {
      const row = db.prepare('SELECT id, direction, msg_type, content, media_kind, media_ref, media_key, media_name, media_size, media_duration FROM clawbot_message WHERE id = ? LIMIT 1').get(Math.floor(id)) as Record<string, unknown> | undefined
      if (row === undefined) return null
      const kind = typeof row['media_kind'] === 'string' ? row['media_kind'] : ''
      const ref = typeof row['media_ref'] === 'string' ? row['media_ref'] : ''
      const media: ClawbotMediaRef | null = (kind === 'image' || kind === 'voice' || kind === 'video' || kind === 'file') && ref !== ''
        ? {
            kind,
            ref,
            key: typeof row['media_key'] === 'string' ? row['media_key'] : '',
            name: str(row['media_name']),
            size: num(row['media_size']),
            duration: num(row['media_duration']),
          }
        : null
      return {
        /* v8 ignore next -- id 是主键，行存在则一定有。 */
        id: Number(row['id'] ?? 0),
        direction: asDirection(row['direction']),
        msgType: str(row['msg_type']),
        content: typeof row['content'] === 'string' ? row['content'] : '',
        media,
      }
    })
  } catch (e) {
    console.warn('[clawbot] 消息读取失败（取媒体用，与「没有这条消息」不同）：' + (e instanceof Error ? e.message : String(e)))
    return null
  }
}

/**
 * 待取附件的行 id（有媒体引用、方向为入站；新 → 旧）。
 *
 * 「是否已缓存」**不在这里判** —— 那是文件系统的事（`clawbot-media.ts#findCached`）；
 * 队列对每一条调 `ensure`，命中即秒回（一次 stat）。启动补扫用它兜住
 * 「上次运行没来得及取完 / 当时网络不通」的缺口。
 * @param decryptedDir - 解密数据根。
 * @param limit - 单次补扫上限（防首次启动对空缓存全量狂扫）。
 * @returns 行 id 数组（新 → 旧）；库不存在或读不出来时为空数组（留 warn）。
 */
export function listClawbotMediaPending(decryptedDir: string, limit: number): number[] {
  if (!clawbotDbExists(decryptedDir)) return []
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => {
      const rows = db.prepare("SELECT id FROM clawbot_message WHERE media_ref IS NOT NULL AND direction = 'in' ORDER BY id DESC LIMIT ?")
        .all(Math.max(1, Math.floor(limit))) as Array<{ id?: number }>
      return rows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0)
    })
  } catch (e) {
    console.warn('[clawbot] 待取附件清点失败（与「没有附件」不同）：' + (e instanceof Error ? e.message : String(e)))
    return []
  }
}
/** 内部行（取媒体用；见 {@link readClawbotMessageInternal}）。 */
export interface ClawbotMessageInternal {
  id: number
  direction: 'in' | 'out'
  msgType: string | null
  content: string
  media: ClawbotMediaRef | null
}

/** 由查询条件构造 WHERE（`%` `_` `\` 全部转义后再进 LIKE）。 */
function whereClause(query: ClawbotMessageQuery): { sql: string, params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  // 实例范围**恒**生效（缺省 1）：多实例之后列表按实例分，漏传就看不到别人的消息。
  clauses.push('slot = ?')
  params.push(Math.max(Math.floor(query.slot ?? DEFAULT_CLAWBOT_SLOT), 1))
  if (query.from !== undefined) { clauses.push('ts >= ?'); params.push(Math.floor(query.from)) }
  if (query.to !== undefined) { clauses.push('ts <= ?'); params.push(Math.floor(query.to)) }
  if (query.direction === 'in' || query.direction === 'out') { clauses.push('direction = ?'); params.push(query.direction) }
  const kw = (query.q ?? '').trim()
  if (kw !== '') {
    // 转义 % 与 _（以及转义符自身），否则用户输入 `%` 等于全表 —— 与 operation-log 同款修复。
    const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    clauses.push("content LIKE ? ESCAPE '\\'")
    params.push(like)
  }
  if (query.afterId !== undefined) { clauses.push('id > ?'); params.push(Math.floor(query.afterId)) }
  if (query.beforeId !== undefined) { clauses.push('id < ?'); params.push(Math.floor(query.beforeId)) }
  return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params }
}

/**
 * 检索接入会话。
 *
 * 两种模式：
 * - **浏览**（默认）：按 `id DESC`（最新在前）分页，`total` 为全量匹配数；
 * - **续传**（带 `afterId`）：只取 `id > afterId` 且按 `id ASC` 返回，
 *   供前端把实时增量按序并入列表（忽略 `offset`）。
 *
 * `maxId` 恒为表内最大值（**不受筛选影响**）——前端拿它当 `lastId`，
 * 才不会因为「当前筛选恰好没命中最新一条」而重复拉取。
 * @param decryptedDir - 解密数据根。
 * @param query - 时间区间 / 方向 / 关键词 / 续传 / 分页条件。
 * @returns 快照；库不存在返回空快照（无 `readError`），打不开才带 `readError`。
 */
export function listClawbotMessages(decryptedDir: string, query: ClawbotMessageQuery = {}): ClawbotMessageSnapshot {
  if (!clawbotDbExists(decryptedDir)) return { items: [], total: 0, maxId: 0 }
  const { sql, params } = whereClause(query)
  const limit = clampLimit(query.limit)
  const offset = Math.max(Math.floor(query.offset ?? 0), 0)
  // 续传模式按 id 升序（并入列表时有序可依）；浏览模式最新在前（与操作日志同观感）。
  const order = query.afterId !== undefined ? 'id ASC' : 'id DESC'
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => {
      const countRow = db.prepare('SELECT COUNT(*) AS n FROM clawbot_message' + sql).get(...params) as { n?: number } | undefined
      // maxId 也要按实例取：前端拿它当续传位，跨实例的最大值会让续传位虚高、增量被跳过。
      const maxRow = db.prepare('SELECT MAX(id) AS m FROM clawbot_message WHERE slot = ?').get(params[0] as number) as { m?: number | null } | undefined
      const rows = query.afterId !== undefined
        ? db.prepare('SELECT ' + SELECT_COLS + ' FROM clawbot_message' + sql + ` ORDER BY ${order} LIMIT ?`).all(...params, limit)
        : db.prepare('SELECT ' + SELECT_COLS + ' FROM clawbot_message' + sql + ` ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset)
      return {
        items: (rows as Array<Record<string, unknown>>).map(toMessage),
        /* v8 ignore next -- COUNT(*) 恒返回一行。 */
        total: countRow?.n ?? 0,
        maxId: Number(maxRow?.m ?? 0),
      }
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[clawbot] 接入会话读取失败（与「还没有会话」不同）：' + message)
    return { items: [], total: 0, maxId: 0, readError: '接入会话读取失败：' + message }
  }
}

/**
/**
 * 清空某实例的**接入会话**（2026-10-17 用户要求「增加对话历史清除按钮，可以删除对话历史
 * 以防止污染回复」）。
 *
 * 为什么需要它：接入会话是**累积**的（永久保留、无自动清理），而它同时是
 * 「对话读法」的展示内容与「自动回复」的上下文来源。用户换话题、或 bot 之前回错了一堆，
 * 旧消息会一直留在那里 —— 清空是唯一的「重新开始」手段。
 *
 * ⚠️ **只删消息，不动绑定与配置**：绑定（`clawbot_binding`）与行为偏好
 * （`clawbot_instance_config`）是另一回事，清历史不该把它们一起清掉。
 * ⚠️ **不可恢复**：调用方必须在确认框里说清条数（与「移除实例」同一纪律）。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @returns 删掉的条数（供界面如实回报）。
 */
export function clearClawbotMessages(decryptedDir: string, slot: number = DEFAULT_CLAWBOT_SLOT): { removed: number } {
  const s = Math.max(Math.floor(slot), 1)
  if (!clawbotDbExists(decryptedDir)) return { removed: 0 }
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      const epoch = sessionEpochOn(db, s)
      const maxBefore = Number((db.prepare(`SELECT MAX(msg_id) AS max_id FROM clawbot_message
        WHERE slot = ? AND msg_id IS NOT NULL AND msg_id > 0`).get(s) as { max_id?: number | null } | undefined)?.max_id ?? 0)
      db.prepare('UPDATE clawbot_binding SET clear_watermark = MAX(clear_watermark, ?) WHERE slot = ?')
        .run(Math.max(Math.floor(maxBefore), 0), s)
      // 一条 INSERT…SELECT 完成快照，避免 clear 时在同步 SQLite 上逐条写 1 万次。
      db.prepare(`INSERT OR IGNORE INTO clawbot_message_tombstone
        (slot, session_epoch, msg_id, created_at)
        SELECT ?, ?, msg_id, ? FROM clawbot_message
        WHERE slot = ? AND msg_id IS NOT NULL AND msg_id > 0
        ORDER BY id DESC LIMIT ?`)
        .run(s, epoch, Date.now(), s, CLAWBOT_MESSAGE_TOMBSTONE_LIMIT)
      trimTombstonesOn(db, s, epoch)
      const removed = Number(db.prepare('DELETE FROM clawbot_message WHERE slot = ?').run(s).changes)
      db.exec('COMMIT')
      return { removed }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 保留原始异常 */ }
      throw e
    }
  })
}

/**
 * 计数（设置卡片的「今日消息 / 累计消息」）—— 一条连接里同时取三个数。
 *
 * 读失败时返回全 0 并留一行 warn：这张卡片是状态展示，库级失败已由绑定行的
 * `readError` 覆盖（同一个库，两者几乎必然同时失败），不在这里再造一个错误通道。
 * @param decryptedDir - 解密数据根。
 * @param opts.since - 「今日」的起点（本地时区当天 0 点的时间戳）。
 * @returns `{ today, total, lastTs }`（`lastTs` = 最后一条消息的接收时间，0 = 还没有消息）。
 */
export function clawbotMessageCounts(decryptedDir: string, opts: { since: number, slot?: number }): { today: number, total: number, lastTs: number } {
  if (!clawbotDbExists(decryptedDir)) return { today: 0, total: 0, lastTs: 0 }
  const slot = Math.max(Math.floor(opts.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => {
      /*
       * `lastTs` 用 `MAX(ts)` 而不是「最后一行」：`ts` 是**接收时间**（协议帧没有时间戳），
       * 而 `id` 是插入顺序 —— 两者在正常路径下同序，但补扫历史时 `id` 会晚于 `ts`。
       * 实例卡要回答的是「这个号最近什么时候有动静」，用 `ts` 才符合直觉。
       */
      const row = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today, MAX(ts) AS last_ts FROM clawbot_message WHERE slot = ?')
        .get(Math.floor(opts.since), slot) as { total?: number, today?: number | null, last_ts?: number | null } | undefined
      return { today: Number(row?.today ?? 0), total: Number(row?.total ?? 0), lastTs: Number(row?.last_ts ?? 0) }
    })
  } catch (e) {
    console.warn('[clawbot] 会话计数失败（显示为 0）：' + (e instanceof Error ? e.message : String(e)))
    return { today: 0, total: 0, lastTs: 0 }
  }
}

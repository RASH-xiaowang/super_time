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

/** 每页默认条数（与 `usePagedList` 一页一致）。 */
export const CLAWBOT_MESSAGE_DEFAULT_LIMIT = 100
/**
 * 单次检索上限。
 *
 * 比 `operation-log` 的 5000 严：那条记的是元数据，这条记的是**正文**，同样的行数
 * 体积大一个量级（正文一句话就能上百字节）。2000 条已远超一屏，再多只是给 IPC 添堵。
 */
export const CLAWBOT_MESSAGE_MAX_LIMIT = 2000

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
}

/** 行 → 公开附件信息（只给渲染层展示元数据：kind/name/size；不含取数引用与密钥）。 */
function toMediaInfo(r: Record<string, unknown>): { kind: string, name: string | null, size: number | null } | null {
  const kind = typeof r['media_kind'] === 'string' && r['media_kind'] !== '' ? r['media_kind'] : null
  if (kind === null) return null
  return {
    kind,
    name: str(r['media_name']),
    size: num(r['media_size']),
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
  /** 附件引用（图片/语音/视频/文件）；纯文本为 null。 */
  media?: ClawbotMediaRef | null
}

/**
 * 写入一条接入会话消息。
 *
 * 带 `msgId` 且库里已有同一 id ⇒ **跳过**（返回 null），事件与 id 都不产生 ——
 * 去重判断与插入在同一条连接里，不存在检查后被并发插入的窗口（单写方）。
 * @param decryptedDir - 解密数据根。
 * @param input - 消息内容（正文原文；打码只在展示层做）。
 * @returns 新行的 `id`；被去重跳过时为 null。
 */
export function insertClawbotMessage(decryptedDir: string, input: ClawbotMessageInput): number | null {
  const slot = Math.max(Math.floor(input.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    const msgId = typeof input.msgId === 'number' && input.msgId > 0 ? input.msgId : null
    if (msgId !== null) {
      // 去重按 **slot 内** 判：消息 id 由服务端按会话下发，跨实例复用同一个号段并不安全。
      const dup = db.prepare('SELECT 1 AS x FROM clawbot_message WHERE msg_id = ? AND slot = ? LIMIT 1').get(msgId, slot)
      if (dup) return null
    }
    const m = input.media ?? null
    const r = db.prepare('INSERT INTO clawbot_message(slot, ts, direction, msg_type, content, created_at, msg_id, media_kind, media_ref, media_key, media_name, media_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        slot, Math.floor(input.ts), input.direction === 'out' ? 'out' : 'in', input.msgType ?? null, input.content,
        Math.floor(input.createdAt ?? Date.now()), msgId,
        m?.kind ?? null, m?.ref ?? null, m?.key ?? null, m?.name ?? null, m?.size ?? null,
      )
    return Number(r.lastInsertRowid)
  })
}

/** 列表 SELECT 的列（公开行 + 媒体展示元数据；取数引用与密钥**不在这里**）。 */
const SELECT_COLS = 'id, slot, ts, direction, msg_type, content, created_at, media_kind, media_name, media_size'

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
      const row = db.prepare('SELECT id, direction, msg_type, content, media_kind, media_ref, media_key, media_name, media_size FROM clawbot_message WHERE id = ? LIMIT 1').get(Math.floor(id)) as Record<string, unknown> | undefined
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
 * 计数（设置卡片的「今日消息 / 累计消息」）—— 一条连接里同时取两个数。
 *
 * 读失败时返回全 0 并留一行 warn：这张卡片是状态展示，库级失败已由绑定行的
 * `readError` 覆盖（同一个库，两者几乎必然同时失败），不在这里再造一个错误通道。
 * @param decryptedDir - 解密数据根。
 * @param opts.since - 「今日」的起点（本地时区当天 0 点的时间戳）。
 * @returns `{ today, total }`。
 */
export function clawbotMessageCounts(decryptedDir: string, opts: { since: number, slot?: number }): { today: number, total: number } {
  if (!clawbotDbExists(decryptedDir)) return { today: 0, total: 0 }
  const slot = Math.max(Math.floor(opts.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => {
      const row = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today FROM clawbot_message WHERE slot = ?')
        .get(Math.floor(opts.since), slot) as { total?: number, today?: number | null } | undefined
      return { today: Number(row?.today ?? 0), total: Number(row?.total ?? 0) }
    })
  } catch (e) {
    console.warn('[clawbot] 会话计数失败（显示为 0）：' + (e instanceof Error ? e.message : String(e)))
    return { today: 0, total: 0 }
  }
}

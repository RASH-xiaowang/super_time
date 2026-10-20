/**
 * 微信 ClawBot 集成的绑定关系（`clawbot_binding`）读写。
 *
 * ## 语义（A 方案 · 官方一对一）
 *
 * 官方是一个桌面端对一个微信账号，所以这张表**本质上只有一行**；用表而不是单配置文件，
 * 是为了承载二维码中间态（`binding` 态）并与 `withDb` / `withWritableDb` 的账本体系一致。
 * 读路径永远取**最新一行**（`ORDER BY id DESC LIMIT 1`）；绑定历史（谁在何时绑/解）
 * 落在 `operation_log` 的 `clawbot` 分类里，不在这张表里堆积行。
 *
 * 状态机：`unbound` →（申请二维码）`binding` →（扫码确认）`bound` →（解绑）`unbound-by-user`。
 * `unbound-by-user` 与从未绑定的 `unbound` 分开，便于界面区分「欢迎绑定」与「已解绑，可重新绑定」。
 *
 * 读失败语义：库**不存在** ⇒ 返回默认未绑定行（不是错误）；库存在但打不开 ⇒
 * `readError` 且行仍是默认值 —— 界面必须把「读不到」与「没绑定」分开显示
 * （与 `operation-log.ts` 的 readError 同一条纪律）。
 *
 * @module query/clawbot/clawbot-binding
 */
import type { DatabaseSync } from '../db-open.ts'
import type { ClawbotBinding } from '../../types.ts'
import { DEFAULT_CLAWBOT_SLOT, clawbotDbExists, clawbotDbPath, ensureClawbotSchema } from './clawbot-db.ts'
import { withDb, withWritableDb } from '../db-open.ts'

/** 默认（从未绑定）的绑定行；时间戳用 0 表示「没有发生过」。 */
export function defaultBinding(slot: number = DEFAULT_CLAWBOT_SLOT): ClawbotBinding {
  return {
    id: 0, slot, status: 'unbound', qrToken: null, qrExpiresAt: null,
    wxid: null, userName: null, label: null, avatar: null, boundAt: null, unboundAt: null,
    createdAt: 0, updatedAt: 0,
  }
}

function asStatus(v: unknown): ClawbotBinding['status'] {
  return v === 'binding' || v === 'bound' || v === 'unbound-by-user' ? v : 'unbound'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 归一一行存储记录（列缺失 / 脏值都收敛成合法形状）。 */
function toBinding(r: Record<string, unknown>): ClawbotBinding {
  return {
    /* v8 ignore next -- id 是 AUTOINCREMENT 主键，存下来的行一定有；归一只为类型干净。 */
    id: Number(r['id'] ?? 0),
    slot: Number(r['slot'] ?? DEFAULT_CLAWBOT_SLOT),
    status: asStatus(r['status']),
    qrToken: str(r['qr_token']),
    qrExpiresAt: num(r['qr_expires_at']),
    wxid: str(r['wxid']),
    userName: str(r['user_name']),
    label: str(r['label']),
    avatar: str(r['avatar']),
    boundAt: num(r['bound_at']),
    unboundAt: num(r['unbound_at']),
    createdAt: Number(r['created_at'] ?? 0),
    updatedAt: Number(r['updated_at'] ?? 0),
  }
}

const SELECT_COLUMNS = 'id, slot, status, qr_token, qr_expires_at, wxid, user_name, label, avatar, bound_at, unbound_at, created_at, updated_at'

/**
 * 读路径的**列自愈**：库已存在时先补一次列（幂等），再读。
 *
 * 为什么读路径也要补（2026-10-16 真机踩到）：`ensureClawbotSchema` 原先只在**写路径**调用，
 * 而 `SELECT_COLUMNS` 是写死的列名 —— 老库（升级前建的）缺 `label` 列时，
 * `SELECT … label …` 直接抛 `no such column: label`，界面显示成
 * 「实例列表读取失败：绑定列表读取失败：no such column: label」。
 * 用户什么都没做错，只是升级了版本 —— 而**读**是打开面板的第一件事，写路径的自愈根本轮不到。
 *
 * 代价可忽略：`ensureColumns` 先 `PRAGMA table_info` 查一遍，列齐了就一行 SQL 都不发。
 * 失败**不抛**（读路径的纪律：读不到要如实说，但不能因为补列失败就整个读不了）——
 * 补列失败时照常往下读，让真正的 SELECT 错误自己浮上来。
 * @param decryptedDir - 解密数据根。
 */
function healColumns(decryptedDir: string): void {
  try {
    withWritableDb(clawbotDbPath(decryptedDir), (db) => { ensureClawbotSchema(db) })
  } catch (e) {
    console.warn('[clawbot] 读路径补列失败（继续尝试读）：' + (e instanceof Error ? e.message : String(e)))
  }
}

/** 读某个 slot 的最新一行（一 slot 一行；万一被手工清空则回落到该 slot 的默认行，不抛）。 */
function readLatest(db: DatabaseSync, slot: number): ClawbotBinding {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM clawbot_binding WHERE slot = ? ORDER BY id DESC LIMIT 1`).get(slot) as Record<string, unknown> | undefined
  return row ? toBinding(row) : defaultBinding(slot)
}

/**
 * 确保某个 slot 有一行（**写路径自愈**）。
 *
 * 为什么要有它：`UPDATE … WHERE slot = ?` 在 slot 不存在时**命中 0 行且不报错** ——
 * 扫码确认写不进去、界面却以为绑定成功，正是本仓最忌的「静默少记」。
 * 判据是「这一行在不在」而不是「表空不空」：表里有别的实例时也要能补出这一行。
 * @param db - 已打开的可写连接。
 * @param slot - 实例编号。
 */
function ensureSlotRow(db: DatabaseSync, slot: number): void {
  const row = db.prepare('SELECT 1 AS x FROM clawbot_binding WHERE slot = ? LIMIT 1').get(slot)
  if (row) return
  const now = Date.now()
  db.prepare('INSERT INTO clawbot_binding(slot, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run(slot, 'unbound', now, now)
}

/** 拆成两半：绑定行 + （可选）读失败原因。 */
export interface BindingRead {
  binding: ClawbotBinding
  readError?: string
}

/**
 * 读当前绑定行。
 *
 * 库不存在 ⇒ 默认未绑定（**不带 readError**：还没绑定过不是错误）；
 * 库存在但打不开 ⇒ 默认未绑定 + `readError`（界面要显示「读取失败」而不是「未绑定」）。
 */
export function readBinding(decryptedDir: string, slot: number = DEFAULT_CLAWBOT_SLOT): BindingRead {
  if (!clawbotDbExists(decryptedDir)) return { binding: defaultBinding(slot) }
  healColumns(decryptedDir)
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => ({ binding: readLatest(db, slot) }))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[clawbot] 绑定信息读取失败（与「尚未绑定」不同）：' + message)
    return { binding: defaultBinding(slot), readError: '绑定信息读取失败：' + message }
  }
}

/**
 * 读**全部** slot 的绑定行（实例列表用；按 slot 升序）。
 *
 * 与 {@link readBinding} 同一套读失败语义：库不存在 ⇒ 空列表且无 readError；
 * 打不开 ⇒ 空列表 + readError（界面必须把「读不到」与「一个实例都没有」分开说）。
 * @param decryptedDir - 解密数据根。
 * @returns 绑定行数组（含 readError）。
 */
export function readBindings(decryptedDir: string): { bindings: ClawbotBinding[], readError?: string } {
  if (!clawbotDbExists(decryptedDir)) return { bindings: [] }
  healColumns(decryptedDir)
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => ({
      bindings: (db.prepare(`SELECT ${SELECT_COLUMNS} FROM clawbot_binding ORDER BY slot ASC, id ASC`).all() as Array<Record<string, unknown>>).map(toBinding),
    }))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[clawbot] 绑定列表读取失败：' + message)
    return { bindings: [], readError: '绑定列表读取失败：' + message }
  }
}

/**
 * 申请二维码：把绑定行推进到 `binding` 态并记下凭证与过期时间。
 *
 * 只负责**本机状态**；向腾讯服务取码是 iLink 通道的事（见 `clawbot-ilink.ts`），
 * 两者分开是为了让数据层能独立被测试、也为了出网失败时本机状态机照常工作
 * （取码抛错 = 一个字节都没发出去，绑定行不会被推进）。
 * @param decryptedDir - 解密数据根（`clawbot.db` 的父目录定位基准）。
 * @param qr - 一次性凭证与过期时间戳。
 * @returns 落库后的绑定行。
 */
export function markBindingQr(decryptedDir: string, qr: { token: string, expiresAt: number }, slot: number = DEFAULT_CLAWBOT_SLOT): ClawbotBinding {
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    ensureSlotRow(db, slot)
    const now = Date.now()
    db.prepare(`UPDATE clawbot_binding SET status = 'binding', qr_token = ?, qr_expires_at = ?, updated_at = ?
      WHERE slot = ?`).run(qr.token, Math.floor(qr.expiresAt), now, slot)
    return readLatest(db, slot)
  })
}

/**
 * 扫码确认后回写身份与**会话凭证**，进入 `bound`。
 *
 * 同时把**别的** `bound` 行收敛成 `unbound-by-user` —— 一对一约束不靠调用方自觉：
 * 手工编辑出两行 `bound` 时，这里保证「已绑定」永远只有一行。
 *
 * 凭证列（`bot_token` / `ilink_bot_id` / `ilink_user_id` / `base_url`）只走
 * {@link readBindingInternal} 读回给 worker 内部，**永远不进渲染层**；
 * 同步游标一并清零（新会话的游标从零开始）。
 * @param decryptedDir - 解密数据根。
 * @param identity - 微信身份（wxid / 昵称 / 头像，后两者可为空）。
 * @param credentials - iLink 会话凭证；缺省/null = 清空（测试里可造「只有绑定没有凭证」的态）。
 * @returns 落库后的绑定行。
 */
export function completeBinding(
  decryptedDir: string,
  identity: { wxid: string, userName?: string | null, avatar?: string | null },
  credentials?: BindingCredentials | null,
  slot: number = DEFAULT_CLAWBOT_SLOT,
): ClawbotBinding {
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    ensureSlotRow(db, slot)
    const now = Date.now()
    /*
     * 「一个微信号只服务一个实例」的约束（多实例版，替换原来的「全局只有一行 bound」）：
     * 同一个 wxid 出现在别的 slot 上 ⇒ 把那一条收敛成 `unbound-by-user` 并**清空凭证**。
     * 清空是「解绑即停轮询」的存储侧保证：另一个实例的通道即使还在飞，
     * 下一轮拿不到凭证就自然停住（界面会在自检里看到它断开）。
     */
    db.prepare(`UPDATE clawbot_binding SET status = 'unbound-by-user', unbound_at = ?, updated_at = ?,
      qr_token = NULL, qr_expires_at = NULL, bot_token = NULL, ilink_bot_id = NULL, ilink_user_id = NULL,
      base_url = NULL, sync_buf = NULL, send_context_token = NULL
      WHERE slot <> ? AND wxid = ? AND status = 'bound'`).run(now, now, slot, identity.wxid)
    db.prepare(`UPDATE clawbot_binding SET status = 'bound', wxid = ?, user_name = ?, avatar = ?, bound_at = ?,
      qr_token = NULL, qr_expires_at = NULL,
      bot_token = ?, ilink_bot_id = ?, ilink_user_id = ?, base_url = ?, sync_buf = NULL,
      send_context_token = NULL, updated_at = ? WHERE slot = ?`)
      .run(
        identity.wxid, identity.userName ?? null, identity.avatar ?? null, now,
        credentials?.botToken ?? null, credentials?.ilinkBotId ?? null,
        credentials?.ilinkUserId ?? null, credentials?.baseUrl ?? null,
        now, slot,
      )
    return readLatest(db, slot)
  })
}

/**
 * 解绑：`bound` → `unbound-by-user`。
 *
 * **不动 `clawbot_message`**（D-4：接入会话保留，解绑只是断开通道）。
 * `wxid` / `user_name` / `avatar` 保留为「上次绑定」的痕迹（界面显示用），
 * 重新绑定时被 `completeBinding` 覆盖；**会话凭证与同步游标立刻清空** ——
 * 清空是「解绑即停轮询」的存储侧保证：即使进程内循环漏了停止位，凭证也没了。
 * @param decryptedDir - 解密数据根。
 * @returns 落库后的绑定行。
 */
export function unbindBinding(decryptedDir: string, slot: number = DEFAULT_CLAWBOT_SLOT): ClawbotBinding {
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    ensureSlotRow(db, slot)
    const now = Date.now()
    db.prepare(`UPDATE clawbot_binding SET status = 'unbound-by-user', unbound_at = ?, qr_token = NULL,
      qr_expires_at = NULL, bot_token = NULL, ilink_bot_id = NULL, ilink_user_id = NULL, base_url = NULL,
      sync_buf = NULL, send_context_token = NULL, updated_at = ? WHERE slot = ?`).run(now, now, slot)
    return readLatest(db, slot)
  })
}

/**
 * 给实例起别名（`label`；2026-10-16）。
 *
 * 与 `completeBinding` / `unbindBinding` **刻意分开**：那两条是绑定状态机的一部分
 * （会清凭证、改 status），而别名是纯用户偏好 —— 它必须活过重新绑定，也不该因为
 * 解绑而消失。所以这里只动 `label` 与 `updated_at` 两列。
 *
 * 归一：首尾空白去掉；空串 / 全空白 ⇒ 存 `NULL`（=「没起别名」，界面回落到昵称）。
 * 长度上限 40 字符（超出截断而不是抛错 —— 别名是展示用的，截断比拒绝更友好）。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param label - 新别名（空串 = 清除别名）。
 * @returns 落库后的绑定行。
 * @throws 实例不存在时抛可读中文（调用方按 message 展示）。
 */
export function renameBinding(decryptedDir: string, slot: number, label: string): ClawbotBinding {
  const s = Math.max(Math.floor(slot), 1)
  const trimmed = label.trim().slice(0, 40)
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    const exists = db.prepare('SELECT 1 AS x FROM clawbot_binding WHERE slot = ? LIMIT 1').get(s)
    if (!exists) throw new Error(`实例 ${s} 不存在（别名只能挂在已建的实例上）`)
    db.prepare('UPDATE clawbot_binding SET label = ?, updated_at = ? WHERE slot = ?')
      .run(trimmed === '' ? null : trimmed, Date.now(), s)
    return readLatest(db, s)
  })
}

/** 会话凭证（iLink 绑定确认后由服务端下发；只进 worker 内部）。 */
export interface BindingCredentials {
  botToken: string
  ilinkBotId: string
  ilinkUserId: string
  baseUrl: string
}

/** 拆成五份：绑定行（公开）+ 凭证 + 同步游标 + 发送令牌 +（可选）读失败原因。 */
export interface BindingInternalRead {
  binding: ClawbotBinding
  /** 身份三项**齐备**才是凭证，缺一个就归 null（半截凭证发不出合法请求）。 */
  credentials: BindingCredentials | null
  /** 同步游标（空串 = 从头/没有）。 */
  syncBuf: string
  /** 最近一条入站消息带来的会话令牌（空串 = 还没收到过消息，**发不了**）。 */
  sendContextToken: string
  readError?: string
}

/**
 * 读当前绑定行 + 内部字段（凭证 / 游标 / 发送令牌）。
 *
 * 与 {@link readBinding} 同一套读失败语义（库不存在 = 默认值无 readError；打不开 = readError），
 * 区别只在多带三列 —— 给 worker 内的通道装配与发送路径用，**不要**把它接进渲染层的快照。
 * @param decryptedDir - 解密数据根。
 * @returns 内部读结果。
 */
export function readBindingInternal(decryptedDir: string, slot: number = DEFAULT_CLAWBOT_SLOT): BindingInternalRead {
  const none = { binding: defaultBinding(slot), credentials: null, syncBuf: '', sendContextToken: '' }
  if (!clawbotDbExists(decryptedDir)) return none
  healColumns(decryptedDir)
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => toInternal(readLatestRow(db, slot)))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[clawbot] 绑定信息读取失败（与「尚未绑定」不同）：' + message)
    return { ...none, readError: '绑定信息读取失败：' + message }
  }
}

/**
 * 保存同步游标（消息长轮询的进度）。
 *
 * **不动 `updated_at`**：游标是会话运行态（约半分钟一次），不是绑定关系的变更 ——
 * 让它冲刷 `updated_at` 会把「最近一次绑定状态迁移」的时间搅浑。
 * @param decryptedDir - 解密数据根。
 * @param buf - 服务端下发的游标。
 */
export function saveSyncBuf(decryptedDir: string, buf: string, slot: number = DEFAULT_CLAWBOT_SLOT): void {
  withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    db.prepare('UPDATE clawbot_binding SET sync_buf = ? WHERE slot = ?').run(buf, slot)
  })
}

/**
 * 保存发送用的会话令牌（最近一条入站消息带来）。
 *
 * 空串**直接跳过**：调用方（通道）对不带令牌的帧没得存，写空会把上一枚好令牌冲掉。
 * 与 {@link saveSyncBuf} 同款：不动 `updated_at`。
 * @param decryptedDir - 解密数据根。
 * @param token - 非空令牌。
 */
export function saveSendContextToken(decryptedDir: string, token: string, slot: number = DEFAULT_CLAWBOT_SLOT): void {
  if (token === '') return
  withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    db.prepare('UPDATE clawbot_binding SET send_context_token = ? WHERE slot = ?').run(token, slot)
  })
}

/** 取某个 slot 的最新一行原始记录（内部版，含凭证/游标/令牌列）。 */
function readLatestRow(db: DatabaseSync, slot: number): Record<string, unknown> {
  const row = db.prepare('SELECT ' + SELECT_COLUMNS + ', bot_token, ilink_bot_id, ilink_user_id, base_url, sync_buf, send_context_token FROM clawbot_binding WHERE slot = ? ORDER BY id DESC LIMIT 1').get(slot) as Record<string, unknown> | undefined
  return row ?? {}
}

/**
 * 读**全部** slot 的 iLink 机器人 id（`ilink_bot_id`；2026-10-17 补全实例信息）。
 *
 * 为什么单独开一个函数而不是并进 {@link readBindings}：`ilink_bot_id` 住在**凭证列组**里，
 * 而 `SELECT_COLUMNS` 是「公开列」白名单 —— 把凭证列并进去等于把 `bot_token` 也一起
 * 带进渲染层快照（那正是本仓反复强调不许发生的事）。这里只挑**一个非敏感列**出来，
 * 让实例卡能显示「这个实例挂在哪个 bot 上」。
 *
 * `ilink_bot_id` 是**公开标识**（bot 的编号），不是密钥：真正的密钥是 `bot_token`，
 * 它仍然只走 {@link readBindingInternal}。未绑定 / 老库无此列 ⇒ 该 slot 不出现在结果里。
 * @param decryptedDir - 解密数据根。
 * @returns `slot → botId` 映射（读失败返回空映射，不抛 —— 它是展示增强，不该拖垮实例列表）。
 */
export function readBotIds(decryptedDir: string): Record<number, string> {
  if (!clawbotDbExists(decryptedDir)) return {}
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => {
      const rows = db.prepare('SELECT slot, ilink_bot_id FROM clawbot_binding WHERE ilink_bot_id IS NOT NULL').all() as Array<{ slot?: number, ilink_bot_id?: string }>
      const out: Record<number, string> = {}
      for (const r of rows) {
        const slot = Number(r.slot ?? 0)
        const id = typeof r.ilink_bot_id === 'string' ? r.ilink_bot_id : ''
        if (slot > 0 && id !== '') out[slot] = id
      }
      return out
    })
  } catch (e) {
    console.warn('[clawbot] 机器人 id 读取失败（实例卡少显示一项）：' + (e instanceof Error ? e.message : String(e)))
    return {}
  }
}

/** 原始记录 → 内部读结果（脏值收敛：身份三项缺一即 null；baseurl 允许空串 = 缺省主机）。 */
function toInternal(row: Record<string, unknown>): BindingInternalRead {
  const botToken = str(row['bot_token'])
  const ilinkBotId = str(row['ilink_bot_id'])
  const ilinkUserId = str(row['ilink_user_id'])
  // baseurl 空串是**合法值**（协议里空 = 用缺省主机），不能和「缺列」一样归 null ——
  // 否则 confirmed 响应不带 baseurl 时会被判成「凭证不齐」，通道拿到 null 凭证后
  // 每轮都立刻失败（实测会把事件循环饿死）。
  const baseUrl = str(row['base_url']) ?? ''
  const credentials: BindingCredentials | null = botToken !== null && ilinkBotId !== null && ilinkUserId !== null
    ? { botToken, ilinkBotId, ilinkUserId, baseUrl }
    : null
  return {
    binding: toBinding(row),
    credentials,
    syncBuf: str(row['sync_buf']) ?? '',
    sendContextToken: str(row['send_context_token']) ?? '',
  }
}

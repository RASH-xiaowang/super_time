/**
 * 微信 ClawBot 集成的本机库（`<数据根>/clawbot.db`）——路径、建表与迁移纪律。
 *
 * ## 这个库是什么
 *
 * A 方案（官方一对一绑定）下 Super Time 自己就是被手机微信绑定的桌面端宿主：
 * 绑定关系与接入会话正文都由**我们自己**读写，不存在第三方写库 ⇒ 无并发写冲突。
 * 库与 `wechat_privacy.db` 同级、同数据根（照抄 `query/operation-log.ts` 的推导）。
 *
 * ## 连接纪律（照抄 `query/db-open.ts`，**绝不自己 `new DatabaseSync`**）
 *
 * - 建表/写：`withWritableDb`（文件不存在时由 SQLite 创建）；
 * - 读：`withDb`（文件必须已存在 ⇒ 读路径要先过 {@link clawbotDbExists} 短路，
 *   否则新装用户会得到「库打不开」而不是「还没绑定」——那正是「读失败 ≠ 没有数据」的反面）。
 *
 * ## 迁移纪律（照抄 `migrateOperationLog` 的教训）
 *
 * 新列必须走 `ALTER TABLE ADD COLUMN`（元数据操作，不重写既有行），**不能改 CREATE TABLE**：
 * 老库上 `INSERT … 新列` 会抛 `no such column`，而写入多为 best-effort，症状是**静默少记**。
 * 每一列都登记在下面两张表里；建表语句里已含它们，登记表的价值在**将来加列时**
 * 老库能被补齐（`clawbot-migration.spec.ts` 用「缺列的老库」把这条机制钉住）。
 *
 * @module query/clawbot/clawbot-db
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from '../db-open.ts'
import { withDb, withWritableDb } from '../db-open.ts'
import type {
  ClawbotMessage,
} from '../../types.ts'
import type { ClawbotReplyRunDetail } from './clawbot-reply-types.ts'
import type {
  ClawbotReplyPart,
  ClawbotReplyPartStatus,
  ClawbotReplyRun,
  ClawbotReplyRunAttachments,
  ClawbotReplyRunStatus,
} from './clawbot-reply-store.ts'
import { parseReplyRunDetail } from './clawbot-run-detail.ts'

export {
  mergeReplyRunDetail,
  parseReplyRunDetail,
  replyRunDetailJson,
  serializeReplyRunDetail,
} from './clawbot-run-detail.ts'

/** `clawbot.db` 在数据根里的位置（与 `wechat_privacy.db` 同级）。 */
export function clawbotDbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'clawbot.db')
}

/** 库文件是否已存在（读路径的第一道短路：不存在 = 还没绑定过，不是读失败）。 */
export function clawbotDbExists(decryptedDir: string): boolean {
  return existsSync(clawbotDbPath(decryptedDir))
}

/**
 * 默认实例编号。**多实例**（2026-10-13）之后 `clawbot_binding` 一 slot 一行，
 * 且 **slot 就是这一行的自增主键 `id`**：
 *
 *   · `AUTOINCREMENT` 保证 id **只增不复用** —— 复用是这里唯一不能接受的语义
 *     （配置与会话都按 slot 存，复用等于把上一个实例的偏好送给新实例，用户全看不出来）；
 *   · id 唯一 ⇒ slot 天然唯一，省掉一个「唯一性靠自觉」的索引；
 *   · 老库补齐时把已有行回填成 `slot = id`（见 {@link ensureClawbotSchema}），
 *     于是「原来那唯一一行」= slot 1，旧客户端不传 slot 时也落在它上面。
 */
export const DEFAULT_CLAWBOT_SLOT = 1

/**
 * `clawbot_binding` 的列登记表：`[列名, 定义]`。
 * 建表语句已含全部列；老库缺哪列就在这里补哪列（PRAGMA 先查，已有则跳过）。
 *
 * 2026-10-12（iLink 接入）：新增凭证列（`bot_token` 等，**内部读取**，不进渲染层）
 * 与同步游标列 `sync_buf` —— 老库（当时还没接过通道）在这里被补齐。
 */
const BINDING_COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['slot', 'INTEGER NOT NULL DEFAULT 1'],
  ['status', "TEXT NOT NULL DEFAULT 'unbound'"],
  ['qr_token', 'TEXT'],
  ['qr_expires_at', 'INTEGER'],
  ['wxid', 'TEXT'],
  ['user_name', 'TEXT'],
  ['avatar', 'TEXT'],
  ['bound_at', 'INTEGER'],
  ['unbound_at', 'INTEGER'],
  ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['bot_token', 'TEXT'],
  ['ilink_bot_id', 'TEXT'],
  ['ilink_user_id', 'TEXT'],
  ['base_url', 'TEXT'],
  ['sync_buf', 'TEXT'],
  ['send_context_token', 'TEXT'],
  // 2026-10-21：持久会话代次。清空消息不换会话；重新绑定/被别的实例接管才换。
  // 让旧批次墓碑跨进程保留，但不会误伤下一次绑定会话里同号的合法消息。
  ['session_epoch', 'INTEGER NOT NULL DEFAULT 0'],
  // 2026-10-21：清空水位。墓碑有保留上限，水位负责在裁剪后继续拒绝旧消息回放；
  // 重新绑定进入新会话时归零。
  ['clear_watermark', 'INTEGER NOT NULL DEFAULT 0'],
  // 2026-10-16：用户给实例起的**别名**（「工作号」「客服号」）。与 `user_name` 分开存：
  // `user_name` 是微信昵称（绑定回写、重新绑定会变），别名是用户偏好（必须活过重新绑定）。
  // 空串 / NULL 都表示「没起别名」⇒ 界面回落到昵称，再回落到「实例 N」。
  ['label', 'TEXT'],
]

/**
 * `clawbot_message` 的列登记表（同上）。
 *
 * `msg_id` = 服务端消息 id，用于去重：会话过期清游标后服务端会**重发**历史，
 * 没有它同一句话会落两次（WeClaw 不存正文所以不在乎，我们存）。
 *
 * 2026-10-12（媒体可见）：新增五列描述**附件**（图片/语音/视频/文件）——
 * 只存「怎么取」的引用与展示元数据，**不存字节**；取回时按需下载、解密、落
 * `<数据根>/clawbot-media/` 缓存。`media_key` 为空 ⇒ `media_ref` 是明文 URL；
 * 非空 ⇒ `media_ref` 是 CDN 加密参数（配 `media_key` 解密）。
 */
const MESSAGE_COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['slot', 'INTEGER NOT NULL DEFAULT 1'],
  ['ts', 'INTEGER NOT NULL DEFAULT 0'],
  ['direction', "TEXT NOT NULL DEFAULT 'in'"],
  ['msg_type', 'TEXT'],
  ['content', 'TEXT'],
  ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['msg_id', 'INTEGER'],
  ['media_kind', 'TEXT'],
  ['media_ref', 'TEXT'],
  ['media_key', 'TEXT'],
  ['media_name', 'TEXT'],
  ['media_size', 'INTEGER'],
  // 2026-10-17：语音时长（毫秒；协议 `voice_item.playtime`）。
  // 单独一列而不是塞进 `media_size`：体积与时长是两件事，混在一起后
  // 「3 秒的语音」与「3KB 的语音」在界面上分不出来。非语音类恒为 NULL。
  ['media_duration', 'INTEGER'],
  // 2026-10-20：发送幂等键。与 `(slot, client_id)` 的部分唯一索引配合，
  // 集成层在发送成功但本地状态未落盘时，可按同一个 client_id 判定重复回填。
  ['client_id', 'TEXT'],
]

/**
 * `clawbot_instance_config` 的列登记表（同上）。
 *
 * 新建即含全部列；这里登记是为了**将来加开关时**老库能被补齐 —— 漏登记的后果是
 * `UPDATE … 新列` 在老库上抛 `no such column`，而配置写入是 best-effort，
 * 症状是「设置保存了但没生效」，没有任何报错。
 */
const INSTANCE_CONFIG_COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['auto_reply', 'INTEGER NOT NULL DEFAULT 0'],
  ['kb_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['kb_id', 'INTEGER'],
  // 2026-10-17：实例的系统提示词（人设 / 语气 / 回复风格）。空串 = 用内置拟人化默认值。
  ['system_prompt', "TEXT NOT NULL DEFAULT ''"],
  // 2026-10-17：长回复是否分段发送（微信里一条几千字读起来很累）。
  ['split_reply', 'INTEGER NOT NULL DEFAULT 1'],
  ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
]

/** `clawbot_reply_run` 的列登记表（老库缺表时先建，未来缺列时按这里补）。 */
const REPLY_RUN_COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['slot', 'INTEGER NOT NULL DEFAULT 1'],
  ['target_message_id', 'INTEGER NOT NULL DEFAULT 0'],
  ['question', "TEXT NOT NULL DEFAULT ''"],
  ['status', "TEXT NOT NULL DEFAULT 'debouncing'"],
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_error', 'TEXT'],
  ['next_attempt_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['lease_owner', 'TEXT'],
  ['lease_until', 'INTEGER NOT NULL DEFAULT 0'],
  ['lease_fence', 'INTEGER NOT NULL DEFAULT 0'],
  // 2026-10-22：自动回复运行详情（工具调用/证据/引用/接地/发送决策）。
  // 只存白名单摘要，不存回答正文、工具完整参数或资源凭证。
  ['result_json', 'TEXT'],
]

/** `clawbot_reply_outbox` 的列登记表（同上）。 */
const REPLY_OUTBOX_COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['run_id', 'INTEGER NOT NULL DEFAULT 0'],
  ['slot', 'INTEGER NOT NULL DEFAULT 1'],
  ['part_index', 'INTEGER NOT NULL DEFAULT 0'],
  ['text', "TEXT NOT NULL DEFAULT ''"],
  ['client_id', "TEXT NOT NULL DEFAULT ''"],
  ['status', "TEXT NOT NULL DEFAULT 'pending'"],
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['sent_message_id', 'INTEGER'],
  ['last_error', 'TEXT'],
  ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['lease_owner', 'TEXT'],
  ['lease_until', 'INTEGER NOT NULL DEFAULT 0'],
  ['lease_fence', 'INTEGER NOT NULL DEFAULT 0'],
]

/** 给老库补列。`ALTER TABLE ADD COLUMN` 是元数据操作：既有行一行不丢。 */
function ensureColumns(db: DatabaseSync, table: string, columns: ReadonlyArray<readonly [string, string]>): void {
  const have = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).map((c) => c.name),
  )
  for (const [name, def] of columns) {
    if (have.has(name)) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`)
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>)
    .some(c => c.name === column)
}

/**
 * 在一条**已打开的可写连接**上建表 / 补列 / 首次建库时补默认绑定行。
 *
 * 拆成「接收 db」而不是「自己开库」，是为了让写路径把「建表 + 本次写」放进同一条连接
 * （一次 `withWritableDb` 里干完），不出现同一操作两次开库。
 */
export function ensureClawbotSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_binding (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slot         INTEGER NOT NULL DEFAULT 1,
    status       TEXT    NOT NULL DEFAULT 'unbound',
    qr_token     TEXT,
    qr_expires_at INTEGER,
    wxid         TEXT,
    user_name    TEXT,
    avatar       TEXT,
    bound_at     INTEGER,
    unbound_at   INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    bot_token    TEXT,
    ilink_bot_id TEXT,
    ilink_user_id TEXT,
    base_url     TEXT,
    sync_buf     TEXT,
    send_context_token TEXT,
    session_epoch INTEGER NOT NULL DEFAULT 0,
    clear_watermark INTEGER NOT NULL DEFAULT 0,
    label        TEXT
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_message (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slot        INTEGER NOT NULL DEFAULT 1,
    ts          INTEGER NOT NULL,
    direction   TEXT    NOT NULL,
    msg_type    TEXT,
    content     TEXT,
    created_at  INTEGER NOT NULL,
    msg_id      INTEGER,
    media_kind  TEXT,
    media_ref   TEXT,
    media_key   TEXT,
    media_name  TEXT,
    media_size  INTEGER,
    media_duration INTEGER,
    client_id   TEXT
  )`)
  /*
   * 每实例的行为配置（多实例，2026-10-13）：与绑定表**分表**是刻意的 ——
   * 绑定行会在重新绑定时被覆盖，而「自动回复开不开、要不要带知识库」属于用户偏好，
   * 必须活过重新绑定；分表后行为开关将来要扩（提示词/冷却/白名单）也只动这一张。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_instance_config (
    slot        INTEGER PRIMARY KEY,
    auto_reply  INTEGER NOT NULL DEFAULT 0,
    kb_enabled  INTEGER NOT NULL DEFAULT 0,
    kb_id       INTEGER,
    system_prompt TEXT NOT NULL DEFAULT '',
    split_reply INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
  )`)
  /*
   * clear 竞态的持久墓碑：清空消息时正在飞的旧批次可能没有任何游标可推进，
   * 进程重启后服务端会从旧 sync_buf 重放。按「实例 + 会话代次 + msg_id」记住，
   * 下一批即使同时夹着新消息，也只落新消息。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_message_tombstone (
    slot          INTEGER NOT NULL,
    session_epoch INTEGER NOT NULL,
    msg_id        INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (slot, session_epoch, msg_id)
  )`)
  /*
   * 每实例的模型 token 消耗（2026-10-19）：按「实例 + 本地日期」聚合。
   * 自动回复每次拿到供应商 usage 后 upsert 一行；删实例时一并清掉。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_token_usage (
    slot         INTEGER NOT NULL,
    day          TEXT    NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    calls        INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (slot, day)
  )`)
  /*
   * 库级一次性状态。`default_instance_seeded` 用来区分「首次建库」与
   * 「用户主动删光了所有实例」；两类库的绑定表都为空，不能再只看 COUNT。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`)
  /*
   * 自动回复持久化 run：同一 slot 的连续消息先在 `debouncing` 窗口内合并；
   * 生成、发送与失败重试都落在这一行，进程重启后由恢复器继续消费。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_reply_run (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    slot              INTEGER NOT NULL,
    target_message_id INTEGER NOT NULL,
    question          TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'debouncing',
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    next_attempt_at   INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    lease_owner       TEXT,
    lease_until       INTEGER NOT NULL DEFAULT 0,
    lease_fence       INTEGER NOT NULL DEFAULT 0,
    result_json       TEXT
  )`)
  /*
   * 分段 outbox：`(run_id, part_index)` 唯一，重复生成同一 run 不会多出分段；
   * `client_id` 首次写入后保持不变，发送超时/崩溃重试必须复用同一值。
   */
  db.exec(`CREATE TABLE IF NOT EXISTS clawbot_reply_outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL,
    slot            INTEGER NOT NULL,
    part_index      INTEGER NOT NULL,
    text            TEXT    NOT NULL,
    client_id       TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    sent_message_id INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    lease_owner     TEXT,
    lease_until     INTEGER NOT NULL DEFAULT 0,
    lease_fence     INTEGER NOT NULL DEFAULT 0
  )`)
  ensureColumns(db, 'clawbot_binding', BINDING_COLUMN_MIGRATIONS)
  /*
   * 老库回填：`slot` 是后加的列，老行全部拿到 DEFAULT 1 ⇒ 多行老库会出现重复 slot。
   * 回填成 `slot = id` 一次修好，且**幂等**（补完 slot 恒等于 id，这条 UPDATE 匹配 0 行）。
   */
  db.exec('UPDATE clawbot_binding SET slot = id WHERE slot <> id')
  ensureColumns(db, 'clawbot_message', MESSAGE_COLUMN_MIGRATIONS)
  ensureColumns(db, 'clawbot_instance_config', INSTANCE_CONFIG_COLUMN_MIGRATIONS)
  const replyRunLeaseMissing = ['lease_owner', 'lease_until', 'lease_fence']
    .some(column => !hasColumn(db, 'clawbot_reply_run', column))
  const replyOutboxLeaseMissing = ['lease_owner', 'lease_until', 'lease_fence']
    .some(column => !hasColumn(db, 'clawbot_reply_outbox', column))
  ensureColumns(db, 'clawbot_reply_run', REPLY_RUN_COLUMN_MIGRATIONS)
  ensureColumns(db, 'clawbot_reply_outbox', REPLY_OUTBOX_COLUMN_MIGRATIONS)
  /*
   * 升级时旧代码可能正停在 generating/sending。它们没有 owner/fence，但原
   * `next_attempt_at` 就是当时的恢复时间；只在新列第一次补上时回填，避免把
   * 新 claim 主动清零的 lease_until 又“复活”成有效租约。
   */
  if (replyRunLeaseMissing) {
    db.exec(`UPDATE clawbot_reply_run
      SET lease_until = CASE WHEN next_attempt_at > 0 THEN next_attempt_at ELSE lease_until END
      WHERE status IN ('generating', 'sending') AND lease_until = 0`)
  }
  if (replyOutboxLeaseMissing) {
    db.exec(`UPDATE clawbot_reply_outbox
      SET lease_until = COALESCE((
        SELECT r.next_attempt_at FROM clawbot_reply_run r WHERE r.id = clawbot_reply_outbox.run_id
      ), 0)
      WHERE status = 'sending' AND lease_until = 0`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_binding_slot ON clawbot_binding(slot)')
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_message_ts ON clawbot_message(ts)')
  // 列表按实例过滤 + 按时间排序（多实例下的主查询形状）。
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_message_slot_ts ON clawbot_message(slot, ts)')
  db.exec(`CREATE INDEX IF NOT EXISTS clawbot_message_tombstone_age
    ON clawbot_message_tombstone(slot, session_epoch, created_at)`)
  // 去重查询（`WHERE msg_id = ?`）走这条索引；非唯一索引足够 —— 去重判断在写入前一次 SELECT。
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_message_msgid ON clawbot_message(msg_id)')
  // 出站发送幂等：同一实例的 client_id 只允许回填一条消息；NULL 是历史行/未带幂等键的行。
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS clawbot_message_slot_client_id
    ON clawbot_message(slot, client_id) WHERE client_id IS NOT NULL`)
  // 同一实例内 target_message_id 天然幂等；槽位内允许不同实例复用同一服务端号段。
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS clawbot_reply_run_slot_target
    ON clawbot_reply_run(slot, target_message_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS clawbot_reply_run_recoverable
    ON clawbot_reply_run(status, next_attempt_at, id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS clawbot_reply_run_slot_status
    ON clawbot_reply_run(slot, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS clawbot_reply_run_claim
    ON clawbot_reply_run(status, next_attempt_at, lease_until, id)`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS clawbot_reply_outbox_run_part
    ON clawbot_reply_outbox(run_id, part_index)`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS clawbot_reply_outbox_client_id
    ON clawbot_reply_outbox(client_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS clawbot_reply_outbox_run_status
    ON clawbot_reply_outbox(run_id, status, part_index)`)
  db.exec(`CREATE INDEX IF NOT EXISTS clawbot_reply_outbox_slot_status
    ON clawbot_reply_outbox(slot, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS clawbot_reply_outbox_claim
    ON clawbot_reply_outbox(status, lease_until, id)`)
  /*
   * 仅首次建库时补一行 `unbound`（= 第一个实例）。
   * 不能只按「绑定表为空」判断：用户删掉唯一实例后表同样为空，旧逻辑会让
   * 下一次任意 schema 写路径把默认实例重建出来。持久标记保证删空后保持空。
   */
  const n = (db.prepare('SELECT COUNT(*) AS n FROM clawbot_binding').get() as { n?: number } | undefined)?.n ?? 0
  const defaultSeeded = db.prepare("SELECT value FROM clawbot_store_meta WHERE key = 'default_instance_seeded'").get() !== undefined
  if (!defaultSeeded) {
    db.exec('SAVEPOINT clawbot_seed_default')
    try {
      // 先原子抢占标记：多连接同时首次初始化时，只有抢到标记的一方可以补默认行。
      const claimed = db.prepare("INSERT OR IGNORE INTO clawbot_store_meta(key, value) VALUES ('default_instance_seeded', '1')").run()
      if (Number(claimed.changes) > 0 && n === 0) {
        const now = Date.now()
        db.prepare('INSERT INTO clawbot_binding(slot, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run(DEFAULT_CLAWBOT_SLOT, 'unbound', now, now)
      }
      db.exec('RELEASE clawbot_seed_default')
    } catch (e) {
      try { db.exec('ROLLBACK TO clawbot_seed_default') } catch { /* 保留原始异常 */ }
      try { db.exec('RELEASE clawbot_seed_default') } catch { /* 保留原始异常 */ }
      throw e
    }
  }
}

/** 打开一次可写连接完成建表/补列（读路径不需要它）。 */
export function ensureClawbotStore(decryptedDir: string): void {
  withWritableDb(clawbotDbPath(decryptedDir), (db) => { ensureClawbotSchema(db) })
}

/** 回复 run/outbox 的公共列、行映射与老库缺列兼容（store 与消息列表共用）。 */
export const REPLY_RUN_COLS = 'id, slot, target_message_id, question, status, attempts, last_error, result_json, next_attempt_at, created_at, updated_at'
export const REPLY_PART_COLS = 'id, run_id, slot, part_index, text, client_id, status, attempts, sent_message_id, last_error, created_at, updated_at'
export const REPLY_RUN_STATUSES = new Set<ClawbotReplyRunStatus>([
  'debouncing', 'queued', 'generating', 'ready', 'sending', 'done', 'failed', 'skipped',
])
export const REPLY_PART_STATUSES = new Set<ClawbotReplyPartStatus>(['pending', 'sending', 'sent', 'failed'])

export function replyPositiveInt(value: number, label: string): number {
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n < 1) throw new Error(`${label} 必须是正整数`)
  return n
}

export function replyTimestamp(value: number | undefined): number {
  return Number.isFinite(value) ? Math.floor(value as number) : Date.now()
}

export function replyTextOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function toReplyRun(row: Record<string, unknown>): ClawbotReplyRun {
  const rawStatus = row['status']
  const status = typeof rawStatus === 'string' && REPLY_RUN_STATUSES.has(rawStatus as ClawbotReplyRunStatus)
    ? rawStatus as ClawbotReplyRunStatus
    : 'queued'
  return {
    id: Number(row['id'] ?? 0),
    slot: Number(row['slot'] ?? 1),
    targetMessageId: Number(row['target_message_id'] ?? 0),
    question: typeof row['question'] === 'string' ? row['question'] : '',
    status,
    attempts: Number(row['attempts'] ?? 0),
    lastError: replyTextOrNull(row['last_error']),
    resultJson: replyTextOrNull(row['result_json']),
    nextAttemptAt: Number(row['next_attempt_at'] ?? 0),
    createdAt: Number(row['created_at'] ?? 0),
    updatedAt: Number(row['updated_at'] ?? 0),
  }
}

export function toReplyPart(row: Record<string, unknown>): ClawbotReplyPart {
  const rawStatus = row['status']
  const status = typeof rawStatus === 'string' && REPLY_PART_STATUSES.has(rawStatus as ClawbotReplyPartStatus)
    ? rawStatus as ClawbotReplyPartStatus
    : 'pending'
  const sentMessageId = Number(row['sent_message_id'] ?? 0)
  return {
    id: Number(row['id'] ?? 0),
    runId: Number(row['run_id'] ?? 0),
    partIndex: Number(row['part_index'] ?? 0),
    slot: Number(row['slot'] ?? 1),
    text: typeof row['text'] === 'string' ? row['text'] : '',
    clientId: typeof row['client_id'] === 'string' ? row['client_id'] : '',
    status,
    attempts: Number(row['attempts'] ?? 0),
    sentMessageId: Number.isFinite(sentMessageId) && sentMessageId > 0 ? sentMessageId : null,
    lastError: replyTextOrNull(row['last_error']),
    createdAt: Number(row['created_at'] ?? 0),
    updatedAt: Number(row['updated_at'] ?? 0),
  }
}

export function replyResultJsonOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 旧调用不传摘要时保留已落库详情；显式新摘要则覆盖上一轮。 */
export function setReplyRunResultOn(
  db: DatabaseSync,
  runId: number,
  resultJson: string | null | undefined,
): void {
  const result = replyResultJsonOrNull(resultJson)
  if (result === null) return
  db.prepare('UPDATE clawbot_reply_run SET result_json = COALESCE(?, result_json) WHERE id = ?')
    .run(result, runId)
}

export function readReplyRunOn(db: DatabaseSync, runId: number): ClawbotReplyRun | null {
  const row = db.prepare(`SELECT ${replyRunColsOn(db)} FROM clawbot_reply_run WHERE id = ? LIMIT 1`)
    .get(runId) as Record<string, unknown> | undefined
  return row === undefined ? null : toReplyRun(row)
}

export function readReplyPartsOn(db: DatabaseSync, runId: number): ClawbotReplyPart[] {
  const rows = db.prepare(`SELECT ${REPLY_PART_COLS} FROM clawbot_reply_outbox WHERE run_id = ? ORDER BY part_index ASC`)
    .all(runId) as Array<Record<string, unknown>>
  return rows.map(toReplyPart)
}

export function readReplyPartOn(db: DatabaseSync, partId: number): ClawbotReplyPart | null {
  const row = db.prepare(`SELECT ${REPLY_PART_COLS} FROM clawbot_reply_outbox WHERE id = ? LIMIT 1`)
    .get(partId) as Record<string, unknown> | undefined
  return row === undefined ? null : toReplyPart(row)
}

export function hasClawbotTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined
}

/** 老库还没补 result_json 时，读取仍按旧列集合工作。 */
export function replyRunColsOn(db: DatabaseSync): string {
  return hasColumn(db, 'clawbot_reply_run', 'result_json')
    ? REPLY_RUN_COLS
    : REPLY_RUN_COLS.replace(', result_json', '')
}

export function uniqueReplyIds(values: readonly number[]): number[] {
  return [...new Set(values
    .filter(value => Number.isFinite(value))
    .map(value => Math.floor(value))
    .filter(value => value > 0))]
}

export function replySqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

export function* replyIdChunks(ids: readonly number[], size: number = 400): Generator<readonly number[]> {
  for (let index = 0; index < ids.length; index += size) {
    yield ids.slice(index, index + size)
  }
}

/** 一页消息对应的 run 摘要；按 target/sent 两条路径各一次批量查询，避免 N+1。 */
export function listReplyRunAttachments(
  dir: string,
  slot: number,
  targetMessageIds: readonly number[],
  sentMessageIds: readonly number[],
): ClawbotReplyRunAttachments {
  const empty: ClawbotReplyRunAttachments = { target: new Map(), sent: new Map() }
  if (!clawbotDbExists(dir)) return empty
  const s = replyPositiveInt(slot, 'slot')
  const targets = uniqueReplyIds(targetMessageIds)
  const sentIds = uniqueReplyIds(sentMessageIds)
  if (targets.length === 0 && sentIds.length === 0) return empty
  return withDb(clawbotDbPath(dir), (db) => {
    if (!hasClawbotTable(db, 'clawbot_reply_run')) return empty
    const cols = replyRunColsOn(db)
    const target = new Map<number, ClawbotReplyRun>()
    const sent = new Map<number, ClawbotReplyRun>()
    for (const chunk of replyIdChunks(targets)) {
      const rows = db.prepare(`SELECT ${cols} FROM clawbot_reply_run
        WHERE slot = ? AND target_message_id IN (${replySqlPlaceholders(chunk.length)})`)
        .all(s, ...chunk) as Array<Record<string, unknown>>
      for (const row of rows) target.set(Number(row['target_message_id'] ?? 0), toReplyRun(row))
    }
    if (sentIds.length === 0 || !hasClawbotTable(db, 'clawbot_reply_outbox')) return { target, sent }
    const runIdBySentMessage = new Map<number, number>()
    for (const chunk of replyIdChunks(sentIds)) {
      const rows = db.prepare(`SELECT sent_message_id, run_id FROM clawbot_reply_outbox
        WHERE slot = ? AND sent_message_id IN (${replySqlPlaceholders(chunk.length)})`)
        .all(s, ...chunk) as Array<{ sent_message_id?: number | null, run_id?: number | null }>
      for (const row of rows) {
        const sentId = Number(row.sent_message_id ?? 0)
        const runId = Number(row.run_id ?? 0)
        if (sentId > 0 && runId > 0) runIdBySentMessage.set(sentId, runId)
      }
    }
    const runs = new Map<number, ClawbotReplyRun>()
    for (const chunk of replyIdChunks(uniqueReplyIds([...runIdBySentMessage.values()]))) {
      const rows = db.prepare(`SELECT ${cols} FROM clawbot_reply_run
        WHERE slot = ? AND id IN (${replySqlPlaceholders(chunk.length)})`)
        .all(s, ...chunk) as Array<Record<string, unknown>>
      for (const row of rows) runs.set(Number(row['id'] ?? 0), toReplyRun(row))
    }
    for (const [messageId, runId] of runIdBySentMessage) {
      const run = runs.get(runId)
      if (run !== undefined) sent.set(messageId, run)
    }
    return { target, sent }
  })
}

/**
 * 给消息页批量附上自动回复运行详情。
 *
 * 入站目标消息与对应出站分段共用同一份摘要；run 表状态覆盖 JSON 里的生成状态。
 * 附件查询失败或旧库缺列时退回原消息，列表本身不能因诊断信息不可读取而失败。
 */
export function attachReplyRunDetails(
  dir: string,
  slot: number,
  messages: readonly ClawbotMessage[],
): ClawbotMessage[] {
  const targetIds = messages.filter(item => item.direction === 'in').map(item => item.id)
  const sentIds = messages.filter(item => item.direction === 'out').map(item => item.id)
  let attachments: ReturnType<typeof listReplyRunAttachments>
  try {
    attachments = listReplyRunAttachments(dir, slot, targetIds, sentIds)
  } catch {
    return [...messages]
  }
  const details = new Map<number, ClawbotReplyRunDetail>()
  const detailOf = (run: ClawbotReplyRun): ClawbotReplyRunDetail => {
    const cached = details.get(run.id)
    if (cached !== undefined) return cached
    const parsed = parseReplyRunDetail(run.resultJson)
    const error = parsed?.error ?? run.lastError ?? undefined
    const detail: ClawbotReplyRunDetail = {
      ...(parsed ?? { runId: run.id, status: run.status }),
      runId: run.id,
      status: run.status,
      ...(error === undefined ? {} : { error }),
    }
    details.set(run.id, detail)
    return detail
  }
  return messages.map((item) => {
    const run = item.direction === 'in' ? attachments.target.get(item.id) : attachments.sent.get(item.id)
    return run === undefined ? { ...item } : { ...item, run: detailOf(run) }
  })
}

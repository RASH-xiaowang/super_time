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
import { withWritableDb } from '../db-open.ts'

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
  ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
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

/**
 * 在一条**已打开的可写连接**上建表 / 补列 / 保证绑定行存在。
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
    send_context_token TEXT
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
    media_size  INTEGER
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
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
  )`)
  ensureColumns(db, 'clawbot_binding', BINDING_COLUMN_MIGRATIONS)
  /*
   * 老库回填：`slot` 是后加的列，老行全部拿到 DEFAULT 1 ⇒ 多行老库会出现重复 slot。
   * 回填成 `slot = id` 一次修好，且**幂等**（补完 slot 恒等于 id，这条 UPDATE 匹配 0 行）。
   */
  db.exec('UPDATE clawbot_binding SET slot = id WHERE slot <> id')
  ensureColumns(db, 'clawbot_message', MESSAGE_COLUMN_MIGRATIONS)
  ensureColumns(db, 'clawbot_instance_config', INSTANCE_CONFIG_COLUMN_MIGRATIONS)
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_binding_slot ON clawbot_binding(slot)')
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_message_ts ON clawbot_message(ts)')
  // 列表按实例过滤 + 按时间排序（多实例下的主查询形状）。
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_message_slot_ts ON clawbot_message(slot, ts)')
  // 去重查询（`WHERE msg_id = ?`）走这条索引；非唯一索引足够 —— 去重判断在写入前一次 SELECT。
  db.exec('CREATE INDEX IF NOT EXISTS clawbot_message_msgid ON clawbot_message(msg_id)')
  /*
   * 表**整个为空**时补一行 `unbound`（= 第一个实例；老库与新库都靠它自愈）。
   * ⚠ 判据是「一行都没有」而不是「slot 1 不存在」：后者会把用户删掉的实例重新变出来。
   */
  const n = (db.prepare('SELECT COUNT(*) AS n FROM clawbot_binding').get() as { n?: number } | undefined)?.n ?? 0
  if (n === 0) {
    const now = Date.now()
    db.prepare('INSERT INTO clawbot_binding(slot, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run(DEFAULT_CLAWBOT_SLOT, 'unbound', now, now)
  }
}

/** 打开一次可写连接完成建表/补列（读路径不需要它）。 */
export function ensureClawbotStore(decryptedDir: string): void {
  withWritableDb(clawbotDbPath(decryptedDir), (db) => { ensureClawbotSchema(db) })
}

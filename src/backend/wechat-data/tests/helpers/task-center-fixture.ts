/**
 * 任务中心测试的真实消息分片夹具。
 *
 * 生产扫描链路仍由 `task-center.spec.ts` 调用；这里只负责按微信 4.x 的
 * `Msg_<md5(talker)>` 形状合成临时 SQLite 数据，避免夹具继续挤占用例文件。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 发送者 → 分片 Name2Id 的 rowid。
 *
 * 真机上登录账号有**显式 wxid 行**（rowid 5 = `wxid_self`），空名行（rowid 1）
 * 是**另一位群成员** —— 归属判据见 `messages.ts#shardMarksSelfWithEmptyRow`。
 * 夹具必须照这个形状造：把 `self` 指向空名行会让「自己发的」被当成对方，
 * 任务中心的「单聊只触发对方消息」用例就失去意义。
 */
const SENDER_ROWID: Record<string, number> = {
  unknown: 1,
  wxid_lisi: 2,
  wxid_target: 3,
  wxid_other: 4,
  self: 5,
  'wxid_ent@openim': 6,
}

/** 一条合成消息。 */
export interface SeedRow {
  localId: number
  sortSeq: number
  createTime: number
  sender: keyof typeof SENDER_ROWID
  /** 缺省 1 = 文本；3 = 图片。 */
  type?: number
  text?: string
  /** 图片消息的 md5（写进 `<img md5="…">`）。 */
  md5?: string
  /** 群消息 `source` 列里的结构化 @ 列表。 */
  atUsers?: readonly string[]
}

let decryptedDir = ''

/** 每个用例在 `beforeEach` 中把夹具定向到当前临时解密目录。 */
export function configureTaskCenterFixture(dir: string): void {
  decryptedDir = dir
}

function openFixtureDb(): DatabaseSync {
  mkdirSync(join(decryptedDir, 'message'), { recursive: true })
  // 文件名必须避开 `_shm/_wal/media/fts/resource` 这些过滤词。
  const db = new DatabaseSync(join(decryptedDir, 'message', 'message_0.db'))
  db.exec('CREATE TABLE IF NOT EXISTS Name2Id (user_name TEXT)')
  const count = db.prepare('SELECT COUNT(*) AS n FROM Name2Id').get() as { n: number }
  if (Number(count.n) === 0) {
    const insert = db.prepare('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)')
    for (const [sender, rowid] of Object.entries(SENDER_ROWID)) {
      insert.run(rowid, sender === 'self' ? '' : sender)
    }
  }
  return db
}

/** Build `contact.extra_buffer` with protobuf field 2 = enterprise wording id. */
function enterpriseBuffer(wordingId: string): Buffer {
  const value = Buffer.from(wordingId, 'utf8')
  return Buffer.concat([Buffer.from([0x12, value.length]), value])
}

/** Add a WeCom contact whose enterprise name is resolved through `openim_wording`. */
export function seedEnterpriseContact(
  username: string,
  name: string,
  enterpriseName: string,
): void {
  mkdirSync(join(decryptedDir, 'contact'), { recursive: true })
  const db = new DatabaseSync(join(decryptedDir, 'contact', 'contact.db'))
  try {
    db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, extra_buffer BLOB)')
    db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
    db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-ent', enterpriseName)
    db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(
      username,
      name,
      name,
      enterpriseBuffer('wording-ent'),
    )
  } finally {
    db.close()
  }
}

function contentOf(row: SeedRow, talker: string): string {
  const isGroup = talker.endsWith('@chatroom')
  const prefix = isGroup && row.sender !== 'self' ? row.sender + ':\n' : ''
  const body = (row.text ?? '') + (isGroup && row.atUsers !== undefined && !String(row.text ?? '').includes('@') ? ' @' : '')
  if ((row.type ?? 1) === 3) {
    return prefix + body + '<?xml version="1.0"?><msg><img md5="' + (row.md5 ?? '') + '"/></msg>'
  }
  return prefix + body
}

function sourceOf(row: SeedRow): string {
  if (row.atUsers === undefined) return ''
  return '<msgsource><atuserlist><![CDATA[' + row.atUsers.join(',') + ']]></atuserlist></msgsource>'
}

/** 往某会话的 `Msg_` 表追加消息（可多次调用；表已存在时只插新行）。 */
export function seedMessages(talker: string, rows: SeedRow[]): void {
  const db = openFixtureDb()
  try {
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
      local_id INTEGER PRIMARY KEY,
      sort_seq INTEGER,
      local_type INTEGER,
      create_time INTEGER,
      real_sender_id INTEGER,
      message_content TEXT,
      source TEXT
    )`)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO "${table}" (local_id, sort_seq, local_type, create_time, real_sender_id, message_content, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      insert.run(
        row.localId, row.sortSeq, row.type ?? 1, row.createTime,
        SENDER_ROWID[row.sender] ?? 1, contentOf(row, talker), sourceOf(row),
      )
    }
  } finally {
    db.close()
  }
}

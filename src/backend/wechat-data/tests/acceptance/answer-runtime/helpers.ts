// @vitest-environment node
/**
 * 问答运行时验收夹具。
 *
 * 这里只放**可复用且无生产副作用**的东西：
 *   · 最小可检索数据根（消息 + 会话 + 通讯录 + 真实 FTS 索引）；
 *   · 合成工具（用于验证注册表/执行守卫对不可信输入的反应）；
 *   · 严格取下标的小工具（沿用后端测试的 `at()` 口径）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bigramTokens, INDEX_SCHEMA_VERSION } from '../../../src/query/search-scaffold.ts'
import { buildSearchIndex } from '../../../src/query/search.ts'
import type { RetrievalTool, ToolResult } from '../../../src/query/tools/types.ts'

export const LISI = 'wxid_lisi'
export const WANG = 'wxid_wangwu'
export const GROUP = '12345678@chatroom'
/** 跨日窗口夹具：中心消息前后 10 秒各有一条，只有中心与后一条在目标日期内。 */
export const CONTEXT_OUTSIDE_ID = 101
export const CONTEXT_CENTER_ID = 102
export const CONTEXT_INSIDE_ID = 103
export const CONTEXT_CENTER_DAY = '2026-10-21'

const scratch: string[] = []

/** 清掉本文件创建的全部临时根。 */
export function cleanupAcceptanceScratch(): void {
  for (const dir of scratch.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不应掩盖真正的断言结果。
    }
  }
}

function trackScratch(root: string): string {
  scratch.push(root)
  return root
}

/**
 * 工具契约用的最小数据根：只有索引库、通讯录表与消息索引。
 *
 * 刻意不造 `message/message_0.db`：`get_message_context` 的窗口展开会被降到空结果，
 * 而工具失败的**其余分支**（缺库、缺参数、范围阻断）仍能独立断言。
 */
export function makeToolDataDir(): string {
  const root = trackScratch(mkdtempSync(join(tmpdir(), 'answer-runtime-tools-')))
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const db = new DatabaseSync(join(root, 'wechat_search.db'))
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.exec("CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER, sender TEXT NOT NULL DEFAULT '')")
  db.exec('CREATE TABLE contact_fts (username TEXT, name TEXT, remark TEXT, alias TEXT, quanpin TEXT, local_type INTEGER)')
  db.exec("CREATE VIRTUAL TABLE message_fts USING fts5(tokens, who, tokenize='unicode61', content='')")
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(INDEX_SCHEMA_VERSION))

  const rows: Array<[number, string, string, number, number, string]> = [
    [1, '合同附件已经发到邮箱，验收款 12000 元', LISI, 1, 1_700_000_000, ''],
    [2, '蓝鲸协议的模板我改好了，差额字段单独列出来', LISI, 2, 1_700_000_100, ''],
    [3, '周末一起打球吗', WANG, 1, 1_700_000_200, ''],
    [4, '合同模板我再确认一下', GROUP, 1, 1_700_000_300, LISI],
  ]
  const insertMeta = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?,?)')
  const insertFts = db.prepare('INSERT INTO message_fts(rowid, tokens, who) VALUES(?,?,?)')
  for (const row of rows) {
    insertMeta.run(...row)
    insertFts.run(row[0], bigramTokens(row[1]), row[2])
  }
  db.prepare('INSERT INTO contact_fts VALUES (?,?,?,?,?,?)')
    .run(LISI, '李四', '李四', 'lisi123', 'lisi', 3)
  db.close()

  const cdb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (id INTEGER, username TEXT, local_type INTEGER, alias TEXT, remark TEXT, nick_name TEXT, description TEXT)')
  cdb.prepare('INSERT INTO contact VALUES (?,?,?,?,?,?,?)')
    .run(1, LISI, 3, 'lisi123', '李四', '李四', '')
  cdb.close()

  return decrypted
}

/** 造一个不存在的解密根；父目录唯一且登记清理，避免命中全局 %TEMP%/wechat_search.db。 */
export function makeMissingToolDataDir(): string {
  const root = trackScratch(mkdtempSync(join(tmpdir(), 'answer-runtime-missing-')))
  return join(root, 'decrypted')
}

/**
 * 会话隔离用的真实检索夹具：两个单聊 + 一个群，群里也有李四的发言。
 *
 * 之所以要三项齐全：`scope.username` 如果没下发，实体通道会同时召回单聊与群聊；
 * 只有两半都成立（未限定确实跨会话、限定后确实只剩当前会话），断言才不是空转。
 */
export async function makeScopedRetrievalFixture(): Promise<string> {
  const root = trackScratch(mkdtempSync(join(tmpdir(), 'answer-runtime-scope-')))
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'contact'), { recursive: true })

  const names: Array<[string, string]> = [[LISI, '李四'], [WANG, '王五'], [GROUP, '项目组']]
  const cdb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, flag INTEGER)')
  const insertContact = cdb.prepare('INSERT INTO contact VALUES (?,?,?,0)')
  for (const [username, name] of names) insertContact.run(username, name, name)
  cdb.close()

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insertSession = sdb.prepare("INSERT INTO SessionTable VALUES (?,?,1700000000,1700000000,0,1,'')")
  for (const [username] of names) insertSession.run(username, username)
  sdb.close()

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const tableOf = (username: string): string =>
    'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  const bodies = new Map<string, Array<[number, string]>>([
    [LISI, [
      [1, '微信转账 收到转账13.00元 请及时查收'],
      [2, '合同的事我看过了，差额那部分我们再对一下'],
      [3, '好的，我明天把合同改好发你'],
    ]],
    [WANG, [[1, '周末一起去打球吗'], [2, '可以，周六下午三点']]],
    [GROUP, [
      [1, LISI + ':\n合同的模板我改好了，差额字段单独列出来了'],
      [2, WANG + ':\n收到，我今晚看'],
    ]],
  ])
  for (const [username, rows] of bodies) {
    mdb.exec(`CREATE TABLE "${tableOf(username)}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const insert = mdb.prepare(`INSERT INTO "${tableOf(username)}" VALUES (?,?,1,0,?,1,?,?, '')`)
    rows.forEach(([localId, text], index) => {
      const createTime = 1_700_000_000 + localId
      // 真实 Msg_* 表的 sort_seq 是毫秒排序键；窗口展开按它取区间。
      insert.run(localId, createTime * 1000, createTime, text, 'srv' + String(index))
    })
    if (username === LISI) {
      const midnight = Math.floor(new Date(2026, 9, 21, 0, 0, 0).getTime() / 1000)
      const boundary: Array<[number, number, string]> = [
        [CONTEXT_OUTSIDE_ID, midnight - 10, '日期边界之前的合同消息'],
        [CONTEXT_CENTER_ID, midnight, '日期边界当天的合同消息'],
        [CONTEXT_INSIDE_ID, midnight + 10, '同一天稍后的合同消息'],
      ]
      for (const [localId, createTime, text] of boundary) {
        insert.run(localId, createTime * 1000, createTime, text, `boundary-${String(localId)}`)
      }
    }
  }
  mdb.close()

  const built = await buildSearchIndex(decrypted, true)
  if (built.status !== 'ok') {
    throw new Error(`验收夹具建索引失败：${built.message ?? built.status}`)
  }
  return decrypted
}

/** 造一个命名固定的合成工具，便于验证注册表与 profile 守卫。 */
export function makeStubTool(
  name: RetrievalTool['name'],
  run: RetrievalTool['run'],
  overrides: Partial<Omit<RetrievalTool, 'name' | 'run'>> = {},
): RetrievalTool {
  return {
    name,
    category: overrides.category ?? 'message',
    description: overrides.description ?? `${name} 的验收合成工具（仅测试使用）`,
    parameters: overrides.parameters ?? { type: 'object', properties: {} },
    run,
  }
}

/** 造一个固定返回结果的工具。 */
export function makeResultTool(name: RetrievalTool['name'], result: ToolResult): RetrievalTool {
  return makeStubTool(name, () => result)
}

// @vitest-environment node
/**
 * 「任务信息 / 任务触发记录 / 回调投递」的后端行为守卫（2026-10-19）。
 *
 * 用临时目录合成**真实的解密消息分片**（`decrypted/message/media_0.db` 里按微信 4.x 的
 * `Msg_<md5(username)>` 表名建表），因此扫描链路（queryNewMessages / queryMessages /
 * isSender 判定 / renderType 归一化）走的是生产代码，而不是桩。
 *
 * 覆盖：
 *  ① CRUD + 关键词 JSON 往返 + name 缺省 + photoLimit 夹取；
 *  ② 校验（ready 缺回调 / 群聊缺目标 / 无关键词 / 非法 URL / 状态切换前置条件）；
 *  ③ 扫描水位：新建任务不回扫历史、新消息命中一次、再扫不重复；
 *  ④ 触发对象过滤：单聊只认对方、群聊只认目标成员；
 *  ⑤ 图片按 photoLimit 取「最近 N 张」并按时间正序；
 *  ⑥ 回调投递：请求体字段、隐私闸脱敏、成功/失败状态与错误落库、skipped 的三种原因；
 *  ⑦ 读错误口径：库不存在 = 空且无 readError；库打不开 = readError + 留痕。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanTaskBatchIds,
  deleteTaskInfos,
  deleteTaskInfo,
  deleteTaskTriggers,
  dispatchPendingTaskCallbacks,
  dispatchTaskCallback,
  listTaskInfos,
  listTaskTriggers,
  saveTaskInfo,
  scanTaskTriggers,
  setTaskInfoStatus,
  TASK_BATCH_DELETE_MAX,
} from '../src/query/task-center.ts'
import type { TaskDispatchDeps } from '../src/query/task-center.ts'
import type { TaskInfoInput } from '../src/types.ts'

const SELF = 'wxid_self'
const PRIVATE_TALKER = 'wxid_lisi'
const GROUP_TALKER = 'room@chatroom'

let root = ''
let decrypted = ''
let decoded = ''
const scratch: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-center-'))
  scratch.push(root)
  decrypted = join(root, 'data', 'decrypted')
  decoded = join(root, 'data', 'decoded_images')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 发送者 → 分片 Name2Id 的 rowid（rowid 1 是空串 = 微信对「登录账号自己」的标记）。 */
const SENDER_ROWID: Record<string, number> = {
  self: 1,
  wxid_lisi: 2,
  wxid_target: 3,
  wxid_other: 4,
  wxid_self: 5,
}

/** 一条合成消息。 */
interface SeedRow {
  localId: number
  sortSeq: number
  createTime: number
  sender: keyof typeof SENDER_ROWID
  /** 缺省 1 = 文本；3 = 图片。 */
  type?: number
  text?: string
  /** 图片消息的 md5（写进 `<img md5="…">`）。 */
  md5?: string
  /**
   * 群消息 `source` 列里的结构化 @ 列表。
   *
   * 生产解析只在**正文含 `@`** 的群消息上读取它；这里的正文会由
   * {@link contentOf} 自动补一个真实的 `@`，避免夹具与真实消息形状漂移。
   */
  atUsers?: readonly string[]
}

/** 测试里直接开库造夹具：与 `query-db-lifetime.spec.ts` 同款（生产代码才受连接棘轮约束）。 */
function openFixtureDb(): DatabaseSync {
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  // 文件名必须避开 `_shm/_wal/media/fts/resource` 这些过滤词（`meta.ts#shardCatalogDirs`
  // 只认真正存放消息分片的文件；`media_*.db` 是媒体资源库，不在消息目录里）。
  const db = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
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

/** 一条消息的原始 `message_content`：群聊带 `wxid:\n` 前缀（微信真实形状）。 */
function contentOf(row: SeedRow, talker: string): string {
  const isGroup = talker.endsWith('@chatroom')
  const prefix = isGroup && row.sender !== 'self' ? row.sender + ':\n' : ''
  const body = (row.text ?? '') + (isGroup && row.atUsers !== undefined && !String(row.text ?? '').includes('@') ? ' @' : '')
  if ((row.type ?? 1) === 3) {
    return prefix + body + '<?xml version="1.0"?><msg><img md5="' + (row.md5 ?? '') + '"/></msg>'
  }
  return prefix + body
}

/** 一条消息的 `source` XML（真实微信把 `atuserlist` 放在这里，不是正文）。 */
function sourceOf(row: SeedRow): string {
  if (row.atUsers === undefined) return ''
  return '<msgsource><atuserlist><![CDATA[' + row.atUsers.join(',') + ']]></atuserlist></msgsource>'
}

/** 往某会话的 `Msg_` 表追加消息（可多次调用；表已存在时只插新行）。 */
function seedMessages(talker: string, rows: SeedRow[]): void {
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

/** 一个「已完善」的单聊任务入参（可覆写）。 */
function taskInput(overrides: Partial<TaskInfoInput> = {}): TaskInfoInput {
  return {
    chatUsername: PRIVATE_TALKER,
    chatName: '李四',
    chatType: 'private',
    targetUsername: '',
    targetName: '',
    keywords: ['发票'],
    photoLimit: 0,
    callbackUrl: 'https://callback.example/hook',
    status: 'ready',
    ...overrides,
  }
}

/** 投递依赖桩：默认解码出一张 data URL，闸门把「秘密」打码。 */
function dispatchDeps(overrides: Partial<TaskDispatchDeps> = {}): TaskDispatchDeps {
  const base: TaskDispatchDeps = {
    decodeImage: async () => ({ url: 'data:image/png;base64,AAAA' }),
    gate: (_feature, _stats, texts) => texts.map((text) => text.replace('秘密', '***')),
  }
  return { ...base, ...overrides }
}

/** 把一条记录置为一条已知 id 的触发记录（便于断言）。 */
function firstTriggerId(): number {
  const id = listTaskTriggers(decrypted).items[0]?.id
  if (id === undefined) throw new Error('夹具里没有触发记录')
  return id
}

describe('任务配置 CRUD 与校验', () => {
  it('新建 / 列出 / 更新 / 删除：关键词去重保序、name 缺省、photoLimit 夹取', () => {
    const created = saveTaskInfo(decrypted, taskInput({
      status: 'incomplete', callbackUrl: '', keywords: [' 发票 ', '发票', '报销'], photoLimit: 12,
    }))
    expect(created.ok).toBe(true)
    const id = created.id ?? 0
    expect(id).toBeGreaterThan(0)

    const snapshot = listTaskInfos(decrypted)
    expect(snapshot.readError).toBeUndefined()
    expect(snapshot.total).toBe(1)
    const task = snapshot.items[0]
    expect(task?.id).toBe(id)
    expect(task?.name).toBe('李四 · 发票')
    expect(task?.keywords).toEqual(['发票', '报销'])
    expect(task?.photoLimit).toBe(9)
    expect(task?.status).toBe('incomplete')
    expect(task?.triggerCount).toBe(0)
    expect(task?.lastTriggeredAt).toBeUndefined()

    const updated = saveTaskInfo(decrypted, taskInput({ id, name: '自定义任务', keywords: ['报销'] }))
    expect(updated.ok).toBe(true)
    expect(updated.status).toBe('ready')
    const after = listTaskInfos(decrypted).items[0]
    expect(after?.name).toBe('自定义任务')
    expect(after?.keywords).toEqual(['报销'])

    expect(deleteTaskInfo(decrypted, id).ok).toBe(true)
    expect(listTaskInfos(decrypted).items).toHaveLength(0)
  })

  it('ready 必须有回调地址；群聊缺目标用户 / 无关键词 / 非法 URL 一律拒绝且不落库', () => {
    const noCallback = saveTaskInfo(decrypted, taskInput({ status: 'ready', callbackUrl: '' }))
    expect(noCallback.ok).toBe(false)
    expect(String(noCallback.error)).toContain('标记已完善前请先填写回调地址')

    const groupWithoutTarget = saveTaskInfo(decrypted, taskInput({
      chatUsername: GROUP_TALKER, chatName: '项目群', chatType: 'group', targetUsername: '',
    }))
    expect(groupWithoutTarget.ok).toBe(false)
    expect(String(groupWithoutTarget.error)).toContain('群内目标用户')

    const noKeyword = saveTaskInfo(decrypted, taskInput({ keywords: [] }))
    expect(noKeyword.ok).toBe(false)
    expect(String(noKeyword.error)).toContain('至少填写一个触发关键词')

    const longKeyword = saveTaskInfo(decrypted, taskInput({ keywords: ['长'.repeat(65)] }))
    expect(longKeyword.ok).toBe(false)
    expect(String(longKeyword.error)).toContain('64')

    const badUrl = saveTaskInfo(decrypted, taskInput({ callbackUrl: 'ftp://callback.example/hook' }))
    expect(badUrl.ok).toBe(false)
    expect(String(badUrl.error)).toContain('回调地址')

    // 校验失败不该留下半条任务
    expect(listTaskInfos(decrypted).items).toHaveLength(0)

    // 待完善 → 已完善也要过同一道前置条件
    const incomplete = saveTaskInfo(decrypted, taskInput({ status: 'incomplete', callbackUrl: '' }))
    const id = incomplete.id ?? 0
    const toReady = setTaskInfoStatus(decrypted, id, 'ready')
    expect(toReady.ok).toBe(false)
    expect(String(toReady.error)).toContain('回调地址')
  })

  it('更新时缺省字段沿用旧值：不传 status 不会把已完善任务降级，photoLimit/回调地址也保留', () => {
    seedMessages(PRIVATE_TALKER, [{ localId: 1, sortSeq: 10, createTime: 10, sender: 'wxid_lisi', text: '历史' }])
    const created = saveTaskInfo(decrypted, taskInput({ photoLimit: 3 }))
    const id = created.id ?? 0
    expect(created.status).toBe('ready')

    // 模拟编辑表单「保存」：只带用户改过的名字与关键词，不带 status / callbackUrl / photoLimit。
    const updated = saveTaskInfo(decrypted, {
      id,
      chatUsername: PRIVATE_TALKER,
      chatType: 'private',
      keywords: ['报销'],
      name: '改过的任务名',
    })
    expect(updated.ok).toBe(true)
    expect(updated.status).toBe('ready')
    const task = listTaskInfos(decrypted).items[0]
    expect(task?.status).toBe('ready')
    expect(task?.callbackUrl).toBe('https://callback.example/hook')
    expect(task?.photoLimit).toBe(3)
    expect(task?.name).toBe('改过的任务名')
  })

  it('仅匹配@我：群聊保存勾选、更新缺省沿用、单聊强制归一为 false', () => {
    const group = saveTaskInfo(decrypted, taskInput({
      chatUsername: GROUP_TALKER,
      chatName: '项目群',
      chatType: 'group',
      targetUsername: 'wxid_target',
      targetName: '小王',
      mentionMeOnly: true,
    }))
    const groupId = group.id ?? 0
    expect(group.ok).toBe(true)
    expect(listTaskInfos(decrypted).items.find((task) => task.id === groupId)?.mentionMeOnly).toBe(true)

    expect(saveTaskInfo(decrypted, {
      id: groupId,
      chatUsername: GROUP_TALKER,
      chatType: 'group',
      keywords: ['发票'],
      name: '只改名字',
    }).ok).toBe(true)
    expect(listTaskInfos(decrypted).items.find((task) => task.id === groupId)?.mentionMeOnly)
      .toBe(true)

    const privateTask = saveTaskInfo(decrypted, taskInput({ mentionMeOnly: true }))
    expect(privateTask.ok).toBe(true)
    expect(listTaskInfos(decrypted).items.find((task) => task.id === privateTask.id)?.mentionMeOnly)
      .toBe(false)
  })

  it('老库没有 mention_me_only 时自动补列，旧任务按未勾选读取且可正常更新', () => {
    const file = join(root, 'data', 'wechat_task_center.db')
    mkdirSync(join(root, 'data'), { recursive: true })
    const db = new DatabaseSync(file)
    try {
      db.exec(`CREATE TABLE task_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        chat_username TEXT NOT NULL,
        chat_name TEXT NOT NULL DEFAULT '',
        chat_type TEXT NOT NULL DEFAULT 'private',
        target_username TEXT NOT NULL DEFAULT '',
        target_name TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '[]',
        photo_limit INTEGER NOT NULL DEFAULT 0,
        callback_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'incomplete',
        last_scan_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_triggered_at INTEGER,
        trigger_count INTEGER NOT NULL DEFAULT 0
      )`)
      db.prepare(`INSERT INTO task_info
        (name, chat_username, chat_name, chat_type, target_username, target_name,
         keywords, photo_limit, callback_url, status, last_scan_seq,
         created_at, updated_at, trigger_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        '旧任务', PRIVATE_TALKER, '李四', 'private', PRIVATE_TALKER, '李四',
        '["发票"]', 0, 'https://callback.example/hook', 'ready', 0, 1, 1, 0,
      )
    } finally {
      db.close()
    }

    const migrated = listTaskInfos(decrypted)
    expect(migrated.readError).toBeUndefined()
    expect(migrated.items[0]?.mentionMeOnly).toBe(false)
    expect(saveTaskInfo(decrypted, taskInput({
      id: migrated.items[0]?.id,
      name: '迁移后可更新',
      mentionMeOnly: false,
    })).ok).toBe(true)
    expect(listTaskInfos(decrypted).items[0]?.name).toBe('迁移后可更新')
  })

  it('已完善任务换会话时重置水位（不拿旧会话的 sort_seq 扫新会话）', () => {
    const OTHER = 'wxid_other_chat'
    const created = saveTaskInfo(decrypted, taskInput())
    const id = created.id ?? 0
    // 新会话里已有历史消息（命中关键词），换会话后不该被回扫。
    seedMessages(OTHER, [{ localId: 1, sortSeq: 500, createTime: 500, sender: 'wxid_other', text: '历史 发票' }])
    const updated = saveTaskInfo(decrypted, {
      id, chatUsername: OTHER, chatType: 'private', keywords: ['发票'],
    })
    expect(updated.ok).toBe(true)
    seedMessages(OTHER, [{ localId: 2, sortSeq: 600, createTime: 600, sender: 'wxid_other', text: '新的 发票' }])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    expect(listTaskTriggers(decrypted).items[0]?.messageLocalId).toBe(2)
  })

  it('删除任务保留触发记录（记录里存了任务快照）', () => {
    seedMessages(PRIVATE_TALKER, [{ localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '历史' }])
    const created = saveTaskInfo(decrypted, taskInput())
    const taskId = created.id ?? 0
    seedMessages(PRIVATE_TALKER, [{ localId: 2, sortSeq: 20, createTime: 200, sender: 'wxid_lisi', text: '带 发票' }])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    expect(deleteTaskInfo(decrypted, taskId).ok).toBe(true)
    const triggers = listTaskTriggers(decrypted)
    expect(triggers.items).toHaveLength(1)
    expect(triggers.items[0]?.taskName).toBe('李四 · 发票')
  })
})

describe('批量删除任务与触发记录', () => {
  it('批量删除任务只删所选配置，历史触发记录仍保留', () => {
    seedMessages(PRIVATE_TALKER, [{ localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '历史' }])
    const first = saveTaskInfo(decrypted, taskInput({ name: '任务一' }))
    const second = saveTaskInfo(decrypted, taskInput({ name: '任务二' }))
    const third = saveTaskInfo(decrypted, taskInput({ name: '任务三' }))
    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 200, sender: 'wxid_lisi', text: '发票 一' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(3)
    const records = listTaskTriggers(decrypted)
    expect(records.total).toBe(3)

    const ids = [first.id ?? 0, third.id ?? 0, first.id ?? 0, -1, Number.NaN]
    const result = deleteTaskInfos(decrypted, ids)
    expect(result).toEqual({ ok: true, removed: 2 })
    expect(listTaskInfos(decrypted).items.map((task) => task.id)).toEqual([second.id])
    expect(listTaskTriggers(decrypted).total).toBe(3)
    expect(listTaskTriggers(decrypted).items.map((record) => record.taskId).sort())
      .toEqual([first.id, second.id, third.id].sort())
  })

  it('批量删除触发记录只删所选，并重算任务触发次数与最近触发时间', () => {
    seedMessages(PRIVATE_TALKER, [{ localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '历史' }])
    const first = saveTaskInfo(decrypted, taskInput({ name: '任务一' }))
    const second = saveTaskInfo(decrypted, taskInput({ name: '任务二' }))
    const firstId = first.id ?? 0
    const secondId = second.id ?? 0
    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 200, sender: 'wxid_lisi', text: '发票 一' },
      { localId: 3, sortSeq: 30, createTime: 300, sender: 'wxid_lisi', text: '发票 二' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(4)

    const firstRecords = listTaskTriggers(decrypted, { taskId: firstId }).items
    const secondRecords = listTaskTriggers(decrypted, { taskId: secondId }).items
    expect(firstRecords).toHaveLength(2)
    expect(secondRecords).toHaveLength(2)
    const removeFirstTaskRecord = firstRecords[0]
    const removeSecondTaskRecords = secondRecords.map((record) => record.id)
    expect(removeFirstTaskRecord).toBeDefined()

    const result = deleteTaskTriggers(decrypted, [
      removeFirstTaskRecord?.id ?? 0,
      ...removeSecondTaskRecords,
      removeFirstTaskRecord?.id ?? 0,
    ])
    expect(result).toEqual({ ok: true, removed: 3 })

    const remainingFirst = listTaskTriggers(decrypted, { taskId: firstId })
    expect(remainingFirst.items).toHaveLength(1)
    const firstTask = listTaskInfos(decrypted).items.find((task) => task.id === firstId)
    expect(firstTask?.triggerCount).toBe(1)
    expect(firstTask?.lastTriggeredAt).toBe(remainingFirst.items[0]?.triggeredAt)

    const secondTask = listTaskInfos(decrypted).items.find((task) => task.id === secondId)
    expect(secondTask?.triggerCount).toBe(0)
    expect(secondTask?.lastTriggeredAt).toBeUndefined()
    expect(listTaskTriggers(decrypted, { taskId: secondId }).total).toBe(0)
  })

  it('空选择、全无效与超过 500 条整单拒绝；边界 500 条可处理', () => {
    expect(deleteTaskInfos(decrypted, [])).toMatchObject({ ok: false, removed: 0 })
    expect(deleteTaskTriggers(decrypted, [0, -1, 'x', null])).toMatchObject({ ok: false, removed: 0 })
    expect(cleanTaskBatchIds([1, 1, 2, 0, -3, '4', 5.9, 'bad']))
      .toEqual({ ids: [1, 2, 4, 5] })

    const tooMany = Array.from({ length: TASK_BATCH_DELETE_MAX + 1 }, (_, index) => index + 1)
    expect(deleteTaskInfos(decrypted, tooMany)).toEqual({
      ok: false,
      removed: 0,
      error: `一次最多删除 ${String(TASK_BATCH_DELETE_MAX)} 条，请分批操作`,
    })
    expect(deleteTaskTriggers(decrypted, tooMany)).toEqual({
      ok: false,
      removed: 0,
      error: `一次最多删除 ${String(TASK_BATCH_DELETE_MAX)} 条，请分批操作`,
    })
    const atLimit = Array.from({ length: TASK_BATCH_DELETE_MAX }, (_, index) => index + 1)
    expect(deleteTaskInfos(decrypted, atLimit)).toEqual({ ok: true, removed: 0 })
    expect(deleteTaskTriggers(decrypted, atLimit)).toEqual({ ok: true, removed: 0 })
  })
})

describe('触发扫描：水位、命中与去重', () => {
  it('新建任务初始化水位（不回扫历史）；新消息命中 1 次；再扫不重复', () => {
    // 历史消息：任务创建**之前**就存在，不该被触发。
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 100, createTime: 1000, sender: 'wxid_lisi', text: '历史消息里也有 发票' },
    ])
    const created = saveTaskInfo(decrypted, taskInput())
    expect(created.ok).toBe(true)

    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 200, createTime: 2000, sender: 'wxid_lisi', text: '这条 发票 触发' },
      // 自己发的消息不满足「单聊 = 对方发的」。
      { localId: 3, sortSeq: 300, createTime: 3000, sender: 'self', text: '我发的 发票' },
    ])

    const first = scanTaskTriggers(decrypted, { selfUsername: SELF })
    expect(first.ok).toBe(true)
    expect(first.tasks).toBe(1)
    expect(first.scanned).toBe(2)
    expect(first.created).toBe(1)

    const triggers = listTaskTriggers(decrypted)
    expect(triggers.total).toBe(1)
    const record = triggers.items[0]
    expect(record?.keyword).toBe('发票')
    expect(record?.text).toBe('这条 发票 触发')
    expect(record?.messageLocalId).toBe(2)
    expect(record?.triggeredAt).toBe(2_000_000)
    expect(record?.callbackStatus).toBe('pending')
    expect(record?.images).toEqual([])
    expect(record?.chatUsername).toBe(PRIVATE_TALKER)
    expect(record?.chatName).toBe('李四')

    const task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerCount).toBe(1)
    expect(task?.lastTriggeredAt).toBe(2_000_000)

    // 水位已推进 + UNIQUE(task_id, message_local_id)：再扫既不出新记录也不重复。
    const second = scanTaskTriggers(decrypted, { selfUsername: SELF })
    expect(second.created).toBe(0)
    expect(second.scanned).toBe(0)
    expect(listTaskTriggers(decrypted).items).toHaveLength(1)
  })

  it('群聊只触发目标成员的消息；单聊触发对象过滤同时生效', () => {
    seedMessages(GROUP_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 10, sender: 'wxid_other', text: '历史 报销' },
    ])
    const created = saveTaskInfo(decrypted, taskInput({
      chatUsername: GROUP_TALKER, chatName: '项目群', chatType: 'group',
      targetUsername: 'wxid_target', targetName: '小王', keywords: ['报销'],
    }))
    expect(created.ok).toBe(true)

    seedMessages(GROUP_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 20, sender: 'wxid_other', text: '别的成员 报销' },
      { localId: 3, sortSeq: 30, createTime: 30, sender: 'wxid_target', text: '小王 报销 了' },
    ])
    const result = scanTaskTriggers(decrypted, { selfUsername: SELF })
    expect(result.created).toBe(1)
    const record = listTaskTriggers(decrypted).items[0]
    expect(record?.keyword).toBe('报销')
    expect(record?.text).toBe('小王 报销 了')
    expect(record?.targetUsername).toBe('wxid_target')
    expect(record?.targetName).toBe('小王')
    expect(record?.messageLocalId).toBe(3)
  })

  it('单聊过滤：目标对象（对方）的消息才触发', () => {
    const created = saveTaskInfo(decrypted, taskInput())
    expect(created.ok).toBe(true)
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 10, sender: 'self', text: '自己说 发票' },
      { localId: 2, sortSeq: 20, createTime: 20, sender: 'wxid_lisi', text: '对方说 发票' },
    ])
    const result = scanTaskTriggers(decrypted, { selfUsername: SELF })
    expect(result.created).toBe(1)
    expect(listTaskTriggers(decrypted).items[0]?.messageLocalId).toBe(2)
  })

  it('群聊「仅匹配@我」：无结构@或仅@所有人不触发，结构化@登录账号才触发', () => {
    seedMessages(GROUP_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 10, sender: 'wxid_other', text: '历史 报销' },
    ])
    const created = saveTaskInfo(decrypted, taskInput({
      chatUsername: GROUP_TALKER,
      chatName: '项目群',
      chatType: 'group',
      targetUsername: 'wxid_target',
      targetName: '小王',
      keywords: ['报销'],
      mentionMeOnly: true,
    }))
    expect(created.ok).toBe(true)

    seedMessages(GROUP_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 20, sender: 'wxid_target', text: '小王 报销 了' },
      { localId: 3, sortSeq: 30, createTime: 30, sender: 'wxid_target', text: '小王 报销 @所有人', atUsers: ['notify@all'] },
      { localId: 4, sortSeq: 40, createTime: 40, sender: 'wxid_target', text: '小王 报销 @你', atUsers: [SELF] },
      { localId: 5, sortSeq: 50, createTime: 50, sender: 'wxid_target', text: '小王 报销 @别人', atUsers: ['wxid_other'] },
    ])
    const result = scanTaskTriggers(decrypted, { selfUsername: SELF })
    expect(result.created).toBe(1)
    expect(listTaskTriggers(decrypted).items.map((record) => record.messageLocalId)).toEqual([4])
  })

  it('群聊未勾选「仅匹配@我」时保持原逻辑：只看目标成员与关键词', () => {
    const created = saveTaskInfo(decrypted, taskInput({
      chatUsername: GROUP_TALKER,
      chatName: '项目群',
      chatType: 'group',
      targetUsername: 'wxid_target',
      targetName: '小王',
      keywords: ['报销'],
      mentionMeOnly: false,
    }))
    expect(created.ok).toBe(true)
    seedMessages(GROUP_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 10, sender: 'wxid_target', text: '小王 报销 了' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
  })
})

describe('触发记录分页：真实总数、复合游标与兼容旧调用', () => {
  /** 直接向任务库写触发记录，专注分页查询（扫描链路另有一组用例）。 */
  function seedTriggers(
    count: number,
    triggeredAt?: readonly number[],
    overrides?: (index: number) => Partial<Record<'taskId' | 'taskName' | 'chatUsername' | 'chatName' | 'targetName' | 'keyword' | 'text' | 'callbackError', string | number>>,
  ): void {
    const file = join(root, 'data', 'wechat_task_center.db')
    const db = new DatabaseSync(file)
    try {
      db.exec('CREATE TABLE IF NOT EXISTS task_triggers (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, task_name TEXT NOT NULL DEFAULT \'\', chat_username TEXT NOT NULL DEFAULT \'\', chat_name TEXT NOT NULL DEFAULT \'\', target_username TEXT NOT NULL DEFAULT \'\', target_name TEXT NOT NULL DEFAULT \'\', keyword TEXT NOT NULL DEFAULT \'\', text TEXT NOT NULL DEFAULT \'\', images TEXT NOT NULL DEFAULT \'[]\', message_local_id INTEGER NOT NULL, message_sort_seq INTEGER NOT NULL, triggered_at INTEGER NOT NULL, callback_status TEXT NOT NULL DEFAULT \'pending\', callback_at INTEGER, callback_error TEXT NOT NULL DEFAULT \'\', UNIQUE(task_id, message_local_id))')
      const insert = db.prepare(`INSERT INTO task_triggers
        (task_id, task_name, chat_username, chat_name, target_username, target_name, keyword, text, images,
         message_local_id, message_sort_seq, triggered_at, callback_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (let i = 1; i <= count; i += 1) {
        const at = triggeredAt?.[i - 1] ?? 1000
        const row = overrides?.(i) ?? {}
        insert.run(
          row.taskId ?? 1,
          row.taskName ?? '分页任务',
          row.chatUsername ?? PRIVATE_TALKER,
          row.chatName ?? '李四',
          '',
          row.targetName ?? '',
          row.keyword ?? '发票',
          row.text ?? String(i),
          '[]',
          i,
          i,
          at,
          'sent',
        )
        if (row.callbackError !== undefined) {
          db.prepare('UPDATE task_triggers SET callback_error = ? WHERE task_id = ? AND message_local_id = ?')
            .run(String(row.callbackError), row.taskId ?? 1, i)
        }
      }
    } finally {
      db.close()
    }
  }

  it('不传游标时保持旧调用形状，但 total 是真实总数并返回 nextCursor', () => {
    seedTriggers(3)
    const first = listTaskTriggers(decrypted, { limit: 2 })
    expect(first.items.map((r) => r.id)).toEqual([3, 2])
    expect(first.total).toBe(3)
    expect(first.nextCursor).toEqual({ triggeredAt: 1000, id: 2 })
  })

  it('复合游标跨页不重不漏（同一 triggered_at 的记录也按 id 续接）', () => {
    seedTriggers(3)
    const first = listTaskTriggers(decrypted, { limit: 2 })
    const second = listTaskTriggers(decrypted, { limit: 2, cursor: first.nextCursor })
    expect(second.items.map((r) => r.id)).toEqual([1])
    expect(second.nextCursor).toBeUndefined()
    expect([...first.items, ...second.items].map((r) => r.id)).toEqual([3, 2, 1])
  })

  it('边界时间戳还有记录时，不能让更早记录先占满下一页', () => {
    seedTriggers(8, [1000, 1000, 1000, 1000, 900, 900, 800, 800])
    const first = listTaskTriggers(decrypted, { limit: 2 })
    const second = listTaskTriggers(decrypted, { limit: 2, cursor: first.nextCursor })
    const third = listTaskTriggers(decrypted, { limit: 2, cursor: second.nextCursor })
    expect(first.items.map((r) => r.id)).toEqual([4, 3])
    expect(second.items.map((r) => r.id)).toEqual([2, 1])
    expect(third.items.map((r) => r.id)).toEqual([6, 5])
    expect([...first.items, ...second.items, ...third.items].map((r) => r.id)).toEqual([4, 3, 2, 1, 6, 5])
  })

  it('恰好取完整页时不返回无效 nextCursor（最后一页不必再请求）', () => {
    seedTriggers(2)
    const page = listTaskTriggers(decrypted, { limit: 2 })
    expect(page.items.map((r) => r.id)).toEqual([2, 1])
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeUndefined()
  })

  it('非法游标返回空页，不会把第一页误当成末页', () => {
    seedTriggers(2)
    expect(listTaskTriggers(decrypted, { cursor: { triggeredAt: 0, id: 2 } })).toEqual({ items: [], total: 0 })
    expect(listTaskTriggers(decrypted, { cursor: { triggeredAt: 1000, id: 0 } })).toEqual({ items: [], total: 0 })
  })

  it('搜索覆盖正文、任务名、会话/对象、关键词与回调错误，且 total 同口径', () => {
    seedTriggers(5, [500, 400, 300, 200, 100], (i) => {
      if (i === 1) return { text: '客户提到 Alpha 项目' }
      if (i === 2) return { taskName: '财务周报' }
      if (i === 3) return { chatName: '项目群' }
      if (i === 4) return { targetName: '王小明' }
      return { keyword: 'beta', callbackError: 'HTTP 502 Bad Gateway' }
    })

    expect(listTaskTriggers(decrypted, { search: 'alpha' }).items.map((r) => r.id)).toEqual([1])
    expect(listTaskTriggers(decrypted, { search: '财务' }).items.map((r) => r.id)).toEqual([2])
    expect(listTaskTriggers(decrypted, { search: '项目群' }).items.map((r) => r.id)).toEqual([3])
    expect(listTaskTriggers(decrypted, { search: '王小明' }).items.map((r) => r.id)).toEqual([4])
    expect(listTaskTriggers(decrypted, { search: 'BETA' }).items.map((r) => r.id)).toEqual([5])
    expect(listTaskTriggers(decrypted, { search: '502' }).items.map((r) => r.id)).toEqual([5])
    expect(listTaskTriggers(decrypted, { search: '不存在' })).toEqual({ items: [], total: 0 })
  })

  it('taskId + search 可组合，搜索结果跨页不重不漏', () => {
    seedTriggers(6, [600, 500, 400, 300, 200, 100], (i) => ({
      taskId: i <= 3 ? 1 : 2,
      text: '共同命中 发票 ' + String(i),
    }))
    const first = listTaskTriggers(decrypted, { taskId: 1, search: '共同', limit: 2 })
    const second = listTaskTriggers(decrypted, { taskId: 1, search: '共同', limit: 2, cursor: first.nextCursor })
    expect(first.total).toBe(3)
    expect(first.items.map((r) => r.id)).toEqual([1, 2])
    expect(second.items.map((r) => r.id)).toEqual([3])
    expect(second.nextCursor).toBeUndefined()
    expect([...first.items, ...second.items].every((r) => r.taskId === 1)).toBe(true)
    expect([...first.items, ...second.items].map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('搜索把 % / _ 当普通字符（instr 按字面匹配）', () => {
    seedTriggers(3, [300, 200, 100], (i) => {
      if (i === 1) return { text: '进度 100% 完成', chatName: '报价群', chatUsername: 'wxid-lisi-a' }
      if (i === 2) return { text: '统计 A_B 指标', chatName: '项目群', chatUsername: 'wxid-lisi-b' }
      return { text: '普通内容', chatName: '通知群', chatUsername: 'wxid-lisi-c' }
    })
    expect(listTaskTriggers(decrypted, { search: '100%' }).items.map((r) => r.id)).toEqual([1])
    expect(listTaskTriggers(decrypted, { search: 'A_B' }).items.map((r) => r.id)).toEqual([2])
    expect(listTaskTriggers(decrypted, { search: '%' }).items.map((r) => r.id)).toEqual([1])
    expect(listTaskTriggers(decrypted, { search: '_' }).items.map((r) => r.id)).toEqual([2])
    expect(listTaskTriggers(decrypted, { search: 'A%' })).toEqual({ items: [], total: 0 })
  })
})

describe('触发图片：按 photoLimit 取最近 N 张并按时间正序', () => {
  it('photoLimit=2 取目标对象最近两张图片（自己发的不算），时间正序', () => {
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', type: 3, md5: 'md5_first' },
      { localId: 2, sortSeq: 20, createTime: 200, sender: 'wxid_lisi', type: 3, md5: 'md5_second' },
      { localId: 3, sortSeq: 30, createTime: 300, sender: 'self', type: 3, md5: 'md5_self' },
    ])
    const created = saveTaskInfo(decrypted, taskInput({ photoLimit: 2 }))
    expect(created.ok).toBe(true)
    seedMessages(PRIVATE_TALKER, [
      { localId: 4, sortSeq: 40, createTime: 400, sender: 'wxid_lisi', text: '带图的 发票' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    const record = listTaskTriggers(decrypted).items[0]
    expect(record?.images).toHaveLength(2)
    expect(record?.images.map((image) => image.localId)).toEqual([1, 2])
    expect(record?.images.map((image) => image.createTime)).toEqual([100_000, 200_000])
    expect(record?.images[1]?.md5).toBe('md5_second')
    // 单聊消息不写 `sender`（那是群聊成员字段），显示名退回「对方」。
    expect(record?.images[1]?.sender).toBe('对方')
  })
})

describe('回调投递：请求体、隐私闸与失败落库', () => {
  /** 造一个「已完善任务 + 一条带图触发记录」，返回记录 id。 */
  function fixtureWithPendingTrigger(): number {
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', type: 3, md5: 'md5_img' },
    ])
    expect(saveTaskInfo(decrypted, taskInput({ photoLimit: 1 })).ok).toBe(true)
    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_lisi', text: '秘密 发票 内容' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    return firstTriggerId()
  }

  it('成功：POST JSON 字段正确、gate 脱敏生效、图片 dataUrl 带上、记录置 sent', async () => {
    const triggerId = fixtureWithPendingTrigger()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const gateCalls: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} })
      return new Response('{"ok":true}', { status: 200 })
    }
    const deps = dispatchDeps({
      fetchImpl,
      gate: (feature, stats, texts) => {
        gateCalls.push(feature)
        expect(stats).toEqual({ sessions: 1, messages: 1 })
        return texts.map((text) => text.replace('秘密', '***'))
      },
    })
    const result = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(result).toEqual({ ok: true, status: 'sent' })
    expect(gateCalls).toEqual(['task_callback'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://callback.example/hook')

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body['recordId']).toBe(triggerId)
    expect(body['taskName']).toBe('李四 · 发票')
    expect(body['keyword']).toBe('发票')
    expect(body['text']).toBe('*** 发票 内容')
    expect(body['triggeredAt']).toBe(2_000_000)
    expect(typeof body['triggeredAtText']).toBe('string')
    expect(body['chat']).toEqual({ username: PRIVATE_TALKER, name: '李四', type: 'private' })
    expect(body['target']).toEqual({ username: '', name: '' })
    const images = body['images'] as Array<Record<string, unknown>>
    expect(images).toHaveLength(1)
    expect(images[0]?.['dataUrl']).toBe('data:image/png;base64,AAAA')
    expect(images[0]?.['localId']).toBe(1)

    const saved = listTaskTriggers(decrypted).items.find((item) => item.id === triggerId)
    expect(saved?.callbackStatus).toBe('sent')
    expect(typeof saved?.callbackAt).toBe('number')
    expect(saved?.callbackError).toBeUndefined()
  })

  it('图片来自解码缓存文件：按扩展名拼 data URL；解不出来的那张带 error 但不影响整条', async () => {
    seedMessages(PRIVATE_TALKER, [
      { localId: 11, sortSeq: 30, createTime: 300, sender: 'wxid_lisi', type: 3, md5: 'md5_file' },
      { localId: 12, sortSeq: 40, createTime: 400, sender: 'wxid_lisi', type: 3, md5: 'md5_fail' },
    ])
    expect(saveTaskInfo(decrypted, taskInput({ photoLimit: 2 })).ok).toBe(true)
    seedMessages(PRIVATE_TALKER, [
      { localId: 13, sortSeq: 50, createTime: 500, sender: 'wxid_lisi', text: '发票 带两张图' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    const triggerId = firstTriggerId()
    mkdirSync(join(decoded, 'wxid_lisi'), { recursive: true })
    writeFileSync(join(decoded, 'wxid_lisi', 'md5_file.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const calls: Array<{ init: RequestInit }> = []
    const deps = dispatchDeps({
      fetchImpl: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response('ok', { status: 200 })
      },
      decodeImage: async (_username, localId) => {
        if (localId === 11) return { file: 'wxid_lisi/md5_file.jpg' }
        throw new Error('解码失败')
      },
    })
    const result = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(result.ok).toBe(true)
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    const images = body['images'] as Array<Record<string, unknown>>
    expect(images).toHaveLength(2)
    const withData = images.find((image) => image['localId'] === 11)
    expect(String(withData?.['dataUrl'])).toMatch(/^data:image\/jpeg;base64,/)
    const failed = images.find((image) => image['localId'] === 12)
    expect(failed?.['dataUrl']).toBeUndefined()
    expect(String(failed?.['error'])).toContain('解码失败')
  })

  it('失败：非 2xx / 网络错误 → status=failed 且 callback_error 落库', async () => {
    const triggerId = fixtureWithPendingTrigger()
    const deps = dispatchDeps({
      fetchImpl: async () => new Response('boom', { status: 500 }),
    })
    const result = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(String(result.error)).toContain('500')
    const saved = listTaskTriggers(decrypted).items.find((item) => item.id === triggerId)
    expect(saved?.callbackStatus).toBe('failed')
    expect(String(saved?.callbackError)).toContain('500')
    expect(typeof saved?.callbackAt).toBe('number')
  })

  it('skipped：记录不存在 / 任务被退回待完善', async () => {
    const missing = await dispatchTaskCallback(decrypted, decoded, 999, dispatchDeps())
    expect(missing).toEqual({ ok: false, status: 'skipped', error: '触发记录不存在' })

    const triggerId = fixtureWithPendingTrigger()
    const taskId = listTaskInfos(decrypted).items[0]?.id ?? 0
    expect(setTaskInfoStatus(decrypted, taskId, 'incomplete').ok).toBe(true)
    const skipped = await dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps())
    expect(skipped.ok).toBe(false)
    expect(skipped.status).toBe('skipped')
    expect(String(skipped.error)).toContain('未完善')
  })

  it('批量投递 pending：交付数回填、记录状态为 sent', async () => {
    seedMessages(PRIVATE_TALKER, [])
    expect(saveTaskInfo(decrypted, taskInput()).ok).toBe(true)
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '第一条 发票' },
      { localId: 2, sortSeq: 20, createTime: 200, sender: 'wxid_lisi', text: '第二条 发票' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(2)
    const result = await dispatchPendingTaskCallbacks(decrypted, decoded, dispatchDeps({
      fetchImpl: async () => new Response('ok', { status: 200 }),
    }))
    expect(result.dispatched).toBe(2)
    expect(result.failed).toBe(0)
    const statuses = listTaskTriggers(decrypted).items.map((item) => item.callbackStatus)
    expect(statuses).toEqual(['sent', 'sent'])
    // 再跑一次没有 pending 可投
    expect((await dispatchPendingTaskCallbacks(decrypted, decoded, dispatchDeps())).dispatched).toBe(0)
  })
})

describe('读错误口径：库不存在 ≠ 库打不开', () => {
  it('库不存在：返回空列表且没有 readError（也不凭空建库）', () => {
    const missing = listTaskInfos(decrypted)
    expect(missing).toEqual({ items: [], total: 0 })
    expect(missing.readError).toBeUndefined()
    expect(listTaskTriggers(decrypted)).toEqual({ items: [], total: 0 })
    // 后台扫描同理：没有任务库就什么都不做。
    const scan = scanTaskTriggers(decrypted, { selfUsername: SELF })
    expect(scan).toEqual({ ok: true, tasks: 0, scanned: 0, created: 0, dispatched: 0 })
  })

  it('库路径被占成目录：readError 带 SQLite 原文且 console.warn 留痕', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ })
    const brokenRoot = mkdtempSync(join(tmpdir(), 'task-center-broken-'))
    scratch.push(brokenRoot)
    const broken = join(brokenRoot, 'data', 'decrypted')
    mkdirSync(broken, { recursive: true })
    mkdirSync(join(brokenRoot, 'data', 'wechat_task_center.db'))

    const tasks = listTaskInfos(broken)
    expect(tasks.items).toEqual([])
    expect(tasks.total).toBe(0)
    expect(String(tasks.readError)).toContain('unable to open database file')

    const triggers = listTaskTriggers(broken)
    expect(triggers.items).toEqual([])
    expect(String(triggers.readError)).toContain('unable to open database file')

    const warned = warn.mock.calls.some((call) => String(call[0]).includes('任务库读取失败'))
    expect(warned).toBe(true)
  })
})

// @vitest-environment node
/**
 * 「任务触发方式 = 八爪鱼 RPA」的后端行为守卫（2026-10-21）。
 *
 * 背景：任务在编辑抽屉里新增「触发方式」二选一 —— `webhook`（原有：整条记录 JSON POST）
 * 与 `bazhuayu`（八爪鱼 RPA：调 `bots/scheduling/start`，只把触发记录映射成
 * `room_name` / `content` / `at_name`）。本文件覆盖四类行为：
 *  ① **落库与凭据边界**：三列往返，列表只回 `bazhuayuApiKeySet`，任何快照都不含 Key 原文；
 *  ② **更新语义**：不传 Key = 保留、传空串 = 清空，切换触发方式不清空另一方式的字段；
 *  ③ **「已完善」校验**：save 与 setTaskInfoStatus 两处都按触发方式分支；
 *  ④ **投递**：八爪鱼请求的 URL / `X-Api-Key` 头 / 请求体字段，成功/失败/未配置三种结果，
 *     以及「不限 Webhook 地址」的扫描 → pending → 批量投递链路（旧口径会把八爪鱼记录
 *     直接写成 skipped，这条用例就是那处 bug 的回归判据）。
 *
 * 与 `task-center.spec.ts` 同款：临时目录 + 合成**真实解密消息分片**（`Msg_<md5>` 表），
 * 扫描链路走生产代码；投递用注入的假 fetch，不联网。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dispatchPendingTaskCallbacks,
  dispatchTaskCallback,
  listTaskInfos,
  listTaskTriggers,
  saveTaskInfo,
  scanTaskTriggers,
  setTaskInfoStatus,
} from '../src/query/task-center.ts'
import type { TaskDispatchDeps } from '../src/query/task-center.ts'
import type { TaskInfoInput } from '../src/types.ts'

const SELF = 'wxid_self'
const PRIVATE_TALKER = 'wxid_lisi'
const GROUP_TALKER = 'room@chatroom'
const API_KEY = 'bz-secret-key-123456'
const FLOW_ID = '6ad859ccee2df270d53fc6e5'
const BAZHUAYU_URL = 'https://api-rpa.bazhuayu.com/api/bots/scheduling/start'

let root = ''
let decrypted = ''
let decoded = ''
const scratch: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-center-bazhuayu-'))
  scratch.push(root)
  decrypted = join(root, 'data', 'decrypted')
  decoded = join(root, 'data', 'decoded_images')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
})

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 任务库文件路径（生产 `taskDbPath(decrypted)` 同口径）。 */
function taskDbFile(): string {
  return join(root, 'data', 'wechat_task_center.db')
}

/** 发送者 → 分片 Name2Id 的 rowid（rowid 1 是空串 = 微信对「登录账号自己」的标记）。 */
const SENDER_ROWID: Record<string, number> = {
  self: 1,
  wxid_lisi: 2,
  wxid_target: 3,
}

/** 一条合成文本消息。 */
interface SeedRow {
  localId: number
  sortSeq: number
  createTime: number
  sender: keyof typeof SENDER_ROWID
  text?: string
}

/** 测试里直接开库造消息夹具（生产代码才受连接棘轮约束）。 */
function openFixtureDb(): DatabaseSync {
  mkdirSync(join(decrypted, 'message'), { recursive: true })
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
  return (isGroup && row.sender !== 'self' ? row.sender + ':\n' : '') + (row.text ?? '')
}

/** 往某会话的 `Msg_` 表追加消息。 */
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
        row.localId, row.sortSeq, 1, row.createTime,
        SENDER_ROWID[row.sender] ?? 1, contentOf(row, talker), '',
      )
    }
  } finally {
    db.close()
  }
}

/** 一个八爪鱼触发的**待完善**任务入参（可覆写）。 */
function bazhuayuInput(overrides: Partial<TaskInfoInput> = {}): TaskInfoInput {
  return {
    chatUsername: PRIVATE_TALKER,
    chatName: '李四',
    chatType: 'private',
    targetUsername: '',
    targetName: '',
    keywords: ['发票'],
    photoLimit: 0,
    triggerMethod: 'bazhuayu',
    bazhuayuFlowId: FLOW_ID,
    bazhuayuApiKey: API_KEY,
    status: 'incomplete',
    ...overrides,
  }
}

/** 群聊八爪鱼任务（已完善）入参：callbackUrl 留空，证明它不再是 ready 的必填项。 */
function groupBazhuayuInput(overrides: Partial<TaskInfoInput> = {}): TaskInfoInput {
  return bazhuayuInput({
    chatUsername: GROUP_TALKER,
    chatName: '报价群',
    chatType: 'group',
    targetUsername: 'wxid_target',
    targetName: '小王',
    keywords: ['报价'],
    photoLimit: 2,
    status: 'ready',
    ...overrides,
  })
}

/** 投递依赖桩：默认解码出一张 data URL，闸门把「秘密」打码。 */
function dispatchDeps(overrides: Partial<TaskDispatchDeps> = {}): TaskDispatchDeps {
  const base: TaskDispatchDeps = {
    decodeImage: async () => ({ url: 'data:image/png;base64,AAAA' }),
    gate: (_feature, _stats, texts) => texts.map((text) => text.replace('秘密', '***')),
  }
  return { ...base, ...overrides }
}

/** 第一条触发记录的 id（夹具里刚扫出来那条）。 */
function firstTriggerId(): number {
  const id = listTaskTriggers(decrypted).items[0]?.id
  if (id === undefined) throw new Error('夹具里没有触发记录')
  return id
}

/** 直接读写任务库的测试夹具（模拟老库/脏状态；生产代码走 query 层）。 */
function withTaskDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(taskDbFile())
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** 造一个「已完善八爪鱼群任务 + 一条 pending 触发记录」，返回触发记录 id。 */
function fixtureWithBazhuayuTrigger(): number {
  seedMessages(GROUP_TALKER, [
    { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_target', text: '历史 报价' },
  ])
  expect(saveTaskInfo(decrypted, groupBazhuayuInput()).ok).toBe(true)
  seedMessages(GROUP_TALKER, [
    { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_target', text: '秘密 报价 内容' },
  ])
  expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
  return firstTriggerId()
}

describe('八爪鱼触发方式：落库与凭据边界', () => {
  it('新建落三列：列表回 triggerMethod / flowId / 是否已配置，JSON 里不含 Key 原文', () => {
    const created = saveTaskInfo(decrypted, bazhuayuInput())
    expect(created.ok).toBe(true)

    const snapshot = listTaskInfos(decrypted)
    expect(snapshot.readError).toBeUndefined()
    const task = snapshot.items[0]
    expect(task?.triggerMethod).toBe('bazhuayu')
    expect(task?.bazhuayuFlowId).toBe(FLOW_ID)
    expect(task?.bazhuayuApiKeySet).toBe(true)
    expect(task?.callbackUrl).toBe('')

    // Key 只存在本机任务库：任何 list 快照 / Remote 返回值都不带原文。
    expect(JSON.stringify(snapshot)).not.toContain(API_KEY)
    expect(JSON.stringify(listTaskTriggers(decrypted))).not.toContain(API_KEY)
    // 但库里确实存了（投递时由后端读出）。
    const stored = withTaskDb((db) => db.prepare(
      'SELECT bazhuayu_api_key AS k FROM task_info ORDER BY id LIMIT 1',
    ).get() as { k?: unknown } | undefined)
    expect(stored?.k).toBe(API_KEY)
  })

  it('形状校验：FlowId 只允许 [A-Za-z0-9_-] 且 ≤128，Key 不含空白/控制字符', () => {
    expect(saveTaskInfo(decrypted, bazhuayuInput({ bazhuayuFlowId: 'bad id!' })).ok).toBe(false)
    expect(String(saveTaskInfo(decrypted, bazhuayuInput({ bazhuayuFlowId: 'x'.repeat(129) })).error))
      .toContain('FlowId')
    const blankKey = saveTaskInfo(decrypted, bazhuayuInput({ bazhuayuApiKey: 'abc def' }))
    expect(blankKey.ok).toBe(false)
    expect(String(blankKey.error)).toContain('API Key')
    // callbackUrl 仍照旧清洗：即使触发方式不是 webhook，非法地址也整单拒绝。
    const badUrl = saveTaskInfo(decrypted, bazhuayuInput({ callbackUrl: 'ftp://callback.example' }))
    expect(badUrl.ok).toBe(false)
    expect(String(badUrl.error)).toContain('回调地址')
    // 校验失败不该留下半条任务
    expect(listTaskInfos(decrypted).items).toHaveLength(0)

    // 只认 'bazhuayu'：运行时传入其它值（脏数据）一律归一为 webhook。
    const normalized = saveTaskInfo(decrypted, {
      ...bazhuayuInput(),
      triggerMethod: 'rpa' as unknown as TaskInfoInput['triggerMethod'],
    })
    expect(normalized.ok).toBe(true)
    expect(listTaskInfos(decrypted).items[0]?.triggerMethod).toBe('webhook')
  })
})

describe('八爪鱼触发方式：更新语义', () => {
  it('不传 Key = 保留；传空串 = 清空；切换触发方式不清空另一方式的字段', () => {
    const id = saveTaskInfo(decrypted, bazhuayuInput()).id ?? 0

    // 编辑表单「保存」通常不带 Key（不回显原文）：应保留已保存的 Key。
    expect(saveTaskInfo(decrypted, {
      id,
      chatUsername: PRIVATE_TALKER,
      chatType: 'private',
      keywords: ['报销'],
      name: '只改名字',
    }).ok).toBe(true)
    let task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerMethod).toBe('bazhuayu')
    expect(task?.bazhuayuApiKeySet).toBe(true)
    expect(task?.bazhuayuFlowId).toBe(FLOW_ID)

    // 空串 = 清空（用户显式要删 Key）。
    expect(saveTaskInfo(decrypted, { ...bazhuayuInput(), id, bazhuayuApiKey: '' }).ok).toBe(true)
    expect(listTaskInfos(decrypted).items[0]?.bazhuayuApiKeySet).toBe(false)

    // 切到 webhook：八爪鱼的 FlowId / Key 不清空（用户来回切不该丢配置）。
    expect(saveTaskInfo(decrypted, {
      id,
      chatUsername: PRIVATE_TALKER,
      chatType: 'private',
      keywords: ['报销'],
      triggerMethod: 'webhook',
      callbackUrl: 'https://callback.example/hook',
      bazhuayuApiKey: 'k2-abcdef',
    }).ok).toBe(true)
    task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerMethod).toBe('webhook')
    expect(task?.bazhuayuFlowId).toBe(FLOW_ID)
    expect(task?.bazhuayuApiKeySet).toBe(true)

    // 切回八爪鱼：刚才那套配置还在。
    expect(saveTaskInfo(decrypted, {
      id,
      chatUsername: PRIVATE_TALKER,
      chatType: 'private',
      keywords: ['报销'],
      triggerMethod: 'bazhuayu',
    }).ok).toBe(true)
    task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerMethod).toBe('bazhuayu')
    expect(task?.callbackUrl).toBe('https://callback.example/hook')
    expect(task?.bazhuayuApiKeySet).toBe(true)
  })
})

describe('八爪鱼触发方式：「已完善」校验（save 与 setTaskInfoStatus 两处分支）', () => {
  it('bazhuayu 缺 FlowId / 缺 Key 整单失败；webhook 缺回调地址仍失败', () => {
    const noFlow = saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready', bazhuayuFlowId: '' }))
    expect(noFlow.ok).toBe(false)
    expect(String(noFlow.error)).toContain('标记已完善前请先填写八爪鱼 FlowId')

    const noKey = saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready', bazhuayuApiKey: '' }))
    expect(noKey.ok).toBe(false)
    expect(String(noKey.error)).toContain('标记已完善前请先填写八爪鱼 API Key')

    const webhookNoUrl = saveTaskInfo(decrypted, {
      ...bazhuayuInput({ status: 'ready' }),
      triggerMethod: 'webhook',
      callbackUrl: '',
    })
    expect(webhookNoUrl.ok).toBe(false)
    expect(String(webhookNoUrl.error)).toContain('标记已完善前请先填写回调地址')

    // bazhuayu 的 ready 不要求 callbackUrl（空串合法）。
    expect(saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready' })).ok).toBe(true)
  })

  it('setTaskInfoStatus(ready) 也按触发方式拦：缺 FlowId / 缺 Key 都会被拒', () => {
    const noFlow = saveTaskInfo(decrypted, bazhuayuInput({ bazhuayuFlowId: '', bazhuayuApiKey: '' }))
    const noFlowId = noFlow.id ?? 0
    const toReadyNoFlow = setTaskInfoStatus(decrypted, noFlowId, 'ready')
    expect(toReadyNoFlow.ok).toBe(false)
    expect(String(toReadyNoFlow.error)).toContain('八爪鱼 FlowId')

    const keyless = saveTaskInfo(decrypted, bazhuayuInput({ bazhuayuApiKey: '' }))
    const toReadyNoKey = setTaskInfoStatus(decrypted, keyless.id ?? 0, 'ready')
    expect(toReadyNoKey.ok).toBe(false)
    expect(String(toReadyNoKey.error)).toContain('八爪鱼 API Key')

    // 配齐后才能变已完善。
    const ready = setTaskInfoStatus(decrypted, noFlowId, 'ready')
    expect(ready.ok).toBe(false)
    expect(saveTaskInfo(decrypted, { ...bazhuayuInput(), id: noFlowId }).ok).toBe(true)
    expect(setTaskInfoStatus(decrypted, noFlowId, 'ready').ok).toBe(true)
  })
})

describe('八爪鱼触发方式：老库迁移', () => {
  it('旧 task_info（无三列）打开后自动补列，旧任务按 webhook 读取且行为不变', () => {
    mkdirSync(join(root, 'data'), { recursive: true })
    withTaskDb((db) => {
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
    })

    // 读路径不建表/不补列，但缺列按默认值归一：旧任务 = webhook、未配置八爪鱼。
    const before = listTaskInfos(decrypted)
    expect(before.readError).toBeUndefined()
    expect(before.items[0]?.triggerMethod).toBe('webhook')
    expect(before.items[0]?.bazhuayuFlowId).toBe('')
    expect(before.items[0]?.bazhuayuApiKeySet).toBe(false)

    // 任何一次写（这里 saveTaskInfo 改名字）都会 ensureTaskSchema → 自动补三列。
    const id = before.items[0]?.id ?? 0
    expect(saveTaskInfo(decrypted, {
      id,
      chatUsername: PRIVATE_TALKER,
      chatType: 'private',
      keywords: ['发票'],
      name: '迁移后',
    }).ok).toBe(true)
    const columns = withTaskDb((db) => (
      db.prepare('PRAGMA table_info(task_info)').all() as Array<Record<string, unknown>>
    ).map((row) => String(row['name'])))
    expect(columns).toEqual(expect.arrayContaining([
      'trigger_method', 'bazhuayu_flow_id', 'bazhuayu_api_key',
    ]))
    const after = listTaskInfos(decrypted).items[0]
    expect(after?.name).toBe('迁移后')
    expect(after?.triggerMethod).toBe('webhook')
    expect(after?.status).toBe('ready')
  })
})

describe('八爪鱼触发方式：投递', () => {
  it('成功：URL / X-Api-Key / 请求体字段正确，记录置 sent，且不解码图片', async () => {
    const triggerId = fixtureWithBazhuayuTrigger()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const gateCalls: string[] = []
    let decodeCalls = 0
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} })
      return new Response('{"code":0}', { status: 200 })
    }
    const deps = dispatchDeps({
      fetchImpl,
      decodeImage: async () => {
        decodeCalls += 1
        return { url: 'data:image/png;base64,AAAA' }
      },
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
    expect(calls[0]?.url).toBe(BAZHUAYU_URL)

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['X-Api-Key']).toBe(API_KEY)
    const rawBody = String(calls[0]?.init.body)
    expect(rawBody).not.toContain(API_KEY)
    expect(JSON.parse(rawBody)).toEqual({
      FlowId: FLOW_ID,
      FlowContentRetrievalMode: 'ByNewestContent',
      SpecifiedPublicationVersion: '',
      SpecifiedBot: '',
      Params: { room_name: '报价群', content: '*** 报价 内容', at_name: '小王' },
      UserStartSource: 'OpenApi',
    })
    // RPA 接口没有图片参数：即使任务 photoLimit=2 也不解码图片。
    expect(decodeCalls).toBe(0)

    const saved = listTaskTriggers(decrypted).items.find((item) => item.id === triggerId)
    expect(saved?.callbackStatus).toBe('sent')
    expect(typeof saved?.callbackAt).toBe('number')
    expect(saved?.callbackError).toBeUndefined()
  })

  it('单聊任务（targetName 为空）at_name 回落会话名；群聊仍严格用触发对象显示名', async () => {
    // 单聊：创建弹窗不填 targetName ⇒「触发的用户对象」就是会话本人，at_name 应回落 chatName。
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '历史' },
    ])
    expect(saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready', chatName: '李四' })).ok).toBe(true)
    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_lisi', text: '秘密 发票 内容' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    const triggerId = firstTriggerId()
    const record = listTaskTriggers(decrypted).items[0]
    expect(record?.chatName).toBe('李四')
    expect(record?.targetName).toBe('')

    const bodies: Array<Record<string, unknown>> = []
    const deps = dispatchDeps({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response('ok', { status: 200 })
      },
    })
    const result = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(result).toEqual({ ok: true, status: 'sent' })
    const params = bodies[0]?.['Params'] as Record<string, unknown> | undefined
    expect(params?.['room_name']).toBe('李四')
    expect(params?.['at_name']).toBe('李四')
    // 群聊用例见上一条成功用例：targetName='小王' 时 at_name 严格保持「小王」（不回落群名）。
  })

  it('失败：非 2xx ⇒ failed + 八爪鱼错误落库（≤500 字）', async () => {
    const triggerId = fixtureWithBazhuayuTrigger()
    const deps = dispatchDeps({
      fetchImpl: async () => new Response('boom', { status: 500 }),
    })
    const result = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(String(result.error)).toContain('八爪鱼触发失败：HTTP 500')
    const saved = listTaskTriggers(decrypted).items.find((item) => item.id === triggerId)
    expect(saved?.callbackStatus).toBe('failed')
    expect(String(saved?.callbackError)).toContain('八爪鱼触发失败：HTTP 500')
    expect(typeof saved?.callbackAt).toBe('number')
  })

  it('未配置（缺 Key / 缺 FlowId / 任务被退回待完善）⇒ skipped 且不发请求', async () => {
    const triggerId = fixtureWithBazhuayuTrigger()
    const taskId = listTaskInfos(decrypted).items[0]?.id ?? 0
    let requests = 0
    const deps = dispatchDeps({
      fetchImpl: async () => {
        requests += 1
        return new Response('ok', { status: 200 })
      },
    })

    // 缺 Key（模拟 Key 被清掉的老状态；正常保存路径下 ready 任务不允许缺 Key）。
    withTaskDb((db) => { db.prepare("UPDATE task_info SET bazhuayu_api_key = '' WHERE id = ?").run(taskId) })
    const noKey = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(noKey).toEqual({ ok: false, status: 'skipped', error: '任务未完善或未配置八爪鱼 FlowId / API Key' })

    // 缺 FlowId。
    withTaskDb((db) => {
      db.prepare("UPDATE task_info SET bazhuayu_flow_id = '', bazhuayu_api_key = ? WHERE id = ?").run(API_KEY, taskId)
    })
    const noFlow = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(noFlow.status).toBe('skipped')
    expect(String(noFlow.error)).toContain('八爪鱼 FlowId')

    // 任务退回待完善。
    withTaskDb((db) => { db.prepare('UPDATE task_info SET bazhuayu_flow_id = ? WHERE id = ?').run(FLOW_ID, taskId) })
    expect(setTaskInfoStatus(decrypted, taskId, 'incomplete').ok).toBe(true)
    const incomplete = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(incomplete).toEqual({ ok: false, status: 'skipped', error: '任务未完善' })

    expect(requests).toBe(0)
  })

  it('链路：bazhuayu 任务（callbackUrl 为空）扫出 pending 记录，批量投递能捞出并送出', async () => {
    // 扫描阶段：旧口径只看 callbackUrl，八爪鱼任务会直接写成 skipped ⇒ 永远不进投递队列。
    seedMessages(GROUP_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_target', text: '历史' },
    ])
    expect(saveTaskInfo(decrypted, groupBazhuayuInput()).ok).toBe(true)
    seedMessages(GROUP_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_target', text: '第一 报价' },
      { localId: 3, sortSeq: 30, createTime: 3000, sender: 'wxid_target', text: '第二 报价' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(2)
    const scanned = listTaskTriggers(decrypted)
    expect(scanned.items.map((item) => item.callbackStatus)).toEqual(['pending', 'pending'])

    const calls: Array<{ url: string; init: RequestInit }> = []
    const deps = dispatchDeps({
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} })
        return new Response('ok', { status: 200 })
      },
    })
    const result = await dispatchPendingTaskCallbacks(decrypted, decoded, deps)
    expect(result.dispatched).toBe(2)
    expect(result.failed).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.url === BAZHUAYU_URL)).toBe(true)
    expect(listTaskTriggers(decrypted).items.map((item) => item.callbackStatus)).toEqual(['sent', 'sent'])
    // 再跑一次没有 pending 可投。
    expect((await dispatchPendingTaskCallbacks(decrypted, decoded, deps)).dispatched).toBe(0)
  })

  it('链路：bazhuayu 任务缺 Key 时扫描写 skipped（不制造永远投不出去的 pending）', () => {
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '历史' },
    ])
    const created = saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready' }))
    const taskId = created.id ?? 0
    // 模拟 Key 丢失的脏状态（正常保存路径下 ready 任务不允许缺 Key）。
    withTaskDb((db) => { db.prepare("UPDATE task_info SET bazhuayu_api_key = '' WHERE id = ?").run(taskId) })
    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_lisi', text: '命中 发票' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    expect(listTaskTriggers(decrypted).items[0]?.callbackStatus).toBe('skipped')
  })
})

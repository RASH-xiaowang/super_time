// @vitest-environment node
/**
 * 「触发方式 = 内置八爪鱼 RPA」的后端行为守卫（多厂商版，2026-10-21 改写）。
 *
 * 多厂商改造后八爪鱼只是注册表里的一个内置厂商：配置走通用 `triggerConfig`、凭据走通用
 * `triggerSecret`，旧入参/旧专用列只在兼容期做归一。本文件覆盖：
 *  ① 通用配置/凭据的落库、描述符版本，以及「列表永不回 Key 原文」；
 *  ② 旧入参（callbackUrl / bazhuayuFlowId / bazhuayuApiKey）与旧库专用列的迁移兼容；
 *  ③ 更新语义（缺省保留 / `''` 清空 / triggerConfig 整体替换）与 ready 校验（save + setStatus）；
 *  ④ 投递：固定 URL、`X-Api-Key` 头、Params 三键（含单聊 at_name 回落）、成功/失败/未配置；
 *  ⑤ 链路：bazhuayu 任务（通用配置里没有 Webhook 地址）也能扫出 pending 并批量投递。
 *
 * 与 `task-center.spec.ts` 同款：临时目录 + 合成真实解密消息分片（走生产扫描链路），
 * 投递注入假 fetch，不联网。
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
/**
 * 八爪鱼描述符的默认非敏感配置（2026-10-21 参数增强后：除 FlowId 外还有可编辑的
 * 三个语义映射键（默认值）与空的附加参数列表）。保存时按描述符补默认值，因此列表
 * 读回的 triggerConfig 会带上这两个键。
 */
const BAZHUAYU_CONFIG_DEFAULTS = {
  paramMap: { room: 'room_name', content: 'content', at: 'at_name' },
  extraParams: [],
}

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

/** 一个八爪鱼触发的**待完善**任务入参（通用字段版）。 */
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
    triggerConfig: { flowId: FLOW_ID },
    triggerSecret: { apiKey: API_KEY },
    status: 'incomplete',
    ...overrides,
  }
}

/** 群聊八爪鱼任务（已完善）入参：通用配置里没有 Webhook 地址也能标记已完善。 */
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

/** 第一条触发记录的 id。 */
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

describe('通用配置/凭据：落库与凭据边界', () => {
  it('新建 bazhuayu：列表回通用配置/是否已配置/描述符版本，JSON 不含 Key 原文，旧列双写', () => {
    const created = saveTaskInfo(decrypted, bazhuayuInput())
    expect(created.ok).toBe(true)

    const snapshot = listTaskInfos(decrypted)
    expect(snapshot.readError).toBeUndefined()
    const task = snapshot.items[0]
    expect(task?.triggerMethod).toBe('bazhuayu')
    expect(task?.triggerConfig).toEqual({ flowId: FLOW_ID, ...BAZHUAYU_CONFIG_DEFAULTS })
    expect(task?.triggerSecretSet).toEqual({ apiKey: true })
    expect(task?.triggerVendorVersion).not.toBe('')
    // 兼容别名（派生视图）
    expect(task?.bazhuayuFlowId).toBe(FLOW_ID)
    expect(task?.bazhuayuApiKeySet).toBe(true)
    expect(task?.callbackUrl).toBe('')
    // 凭据原文只在本机库，不进任何列表快照
    expect(JSON.stringify(snapshot)).not.toContain(API_KEY)
    expect(JSON.stringify(listTaskTriggers(decrypted))).not.toContain(API_KEY)

    const row = withTaskDb((db) => db.prepare(
      'SELECT trigger_config AS c, trigger_secret AS s, bazhuayu_flow_id AS f, bazhuayu_api_key AS k FROM task_info ORDER BY id LIMIT 1',
    ).get() as Record<string, unknown> | undefined)
    expect(String(row?.['c'])).toContain(FLOW_ID)
    expect(String(row?.['s'])).toContain(API_KEY)
    // 双写旧列，保证降级可读
    expect(row?.['f']).toBe(FLOW_ID)
    expect(row?.['k']).toBe(API_KEY)
  })

  it('旧入参兼容：callbackUrl / bazhuayuFlowId / bazhuayuApiKey 仍被归一进通用配置与凭据', () => {
    const webhook = saveTaskInfo(decrypted, {
      chatUsername: PRIVATE_TALKER,
      chatName: '李四',
      chatType: 'private',
      targetUsername: '',
      targetName: '',
      keywords: ['发票'],
      callbackUrl: 'https://callback.example/hook',
      status: 'incomplete',
    })
    expect(webhook.ok).toBe(true)
    const webhookTask = listTaskInfos(decrypted).items[0]
    expect(webhookTask?.triggerMethod).toBe('webhook')
    expect(webhookTask?.triggerConfig['url']).toBe('https://callback.example/hook')
    expect(webhookTask?.callbackUrl).toBe('https://callback.example/hook')

    const bazhuayu = saveTaskInfo(decrypted, {
      chatUsername: PRIVATE_TALKER,
      chatName: '李四',
      chatType: 'private',
      targetUsername: '',
      targetName: '',
      keywords: ['发票'],
      triggerMethod: 'bazhuayu',
      bazhuayuFlowId: FLOW_ID,
      bazhuayuApiKey: API_KEY,
      status: 'incomplete',
    })
    expect(bazhuayu.ok).toBe(true)
    const bazhuayuTask = listTaskInfos(decrypted).items.find((item) => item.id === bazhuayu.id)
    expect(bazhuayuTask?.triggerConfig).toEqual({ flowId: FLOW_ID, ...BAZHUAYU_CONFIG_DEFAULTS })
    expect(bazhuayuTask?.triggerSecretSet).toEqual({ apiKey: true })
    expect(bazhuayuTask?.bazhuayuApiKeySet).toBe(true)
  })

  it('更新：triggerConfig 整体替换；凭据缺省保留、空串清空', () => {
    const id = saveTaskInfo(decrypted, bazhuayuInput()).id ?? 0

    // triggerConfig 整体替换：只传 flowId 就只留 flowId（按描述符补默认值，但不沿用旧值）。
    expect(saveTaskInfo(decrypted, {
      ...bazhuayuInput(),
      id,
      triggerConfig: { flowId: 'new-flow-id' },
      triggerSecret: undefined,
      name: '只改配置',
    }).ok).toBe(true)
    let task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerConfig).toEqual({ flowId: 'new-flow-id', ...BAZHUAYU_CONFIG_DEFAULTS })
    // triggerSecret 缺省 = 保留旧 Key
    expect(task?.triggerSecretSet).toEqual({ apiKey: true })

    // 显式空串 = 清空
    expect(saveTaskInfo(decrypted, { ...bazhuayuInput(), id, triggerSecret: { apiKey: '' } }).ok).toBe(true)
    task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerSecretSet).toEqual({})

    // 重新配置后可用
    expect(saveTaskInfo(decrypted, { ...bazhuayuInput(), id, triggerSecret: { apiKey: 'k2' } }).ok).toBe(true)
    task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerSecretSet).toEqual({ apiKey: true })
    const raw = withTaskDb((db) => db.prepare('SELECT bazhuayu_api_key AS k FROM task_info WHERE id = ?').get(id) as { k?: unknown } | undefined)
    expect(raw?.k).toBe('k2')
  })
})

describe('通用校验：ready 与未知触发方式', () => {
  it('bazhuayu 缺 FlowId / 缺 API Key 整单失败；webhook 缺地址仍失败；未知方式保存拒绝', () => {
    const noFlow = saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready', triggerConfig: {} }))
    expect(noFlow.ok).toBe(false)
    expect(String(noFlow.error)).toContain('标记已完善前需补全：')
    expect(String(noFlow.error)).toContain('FlowId')

    const noKey = saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready', triggerSecret: {} }))
    expect(noKey.ok).toBe(false)
    expect(String(noKey.error)).toContain('标记已完善前需补全：')
    expect(String(noKey.error)).toContain('API Key')

    const webhookNoUrl = saveTaskInfo(decrypted, {
      ...bazhuayuInput({ status: 'ready' }),
      triggerMethod: 'webhook',
      triggerConfig: {},
      triggerSecret: {},
    })
    expect(webhookNoUrl.ok).toBe(false)
    expect(String(webhookNoUrl.error)).toContain('标记已完善前需补全：')
    expect(String(webhookNoUrl.error)).toContain('回调地址')

    const unknown = saveTaskInfo(decrypted, bazhuayuInput({ triggerMethod: 'no-such-vendor' }))
    expect(unknown.ok).toBe(false)
    expect(String(unknown.error)).toContain('未知的触发方式')

    // bazhuayu 的 ready 不要求 Webhook 地址（通用配置里根本没有 url）
    expect(saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready' })).ok).toBe(true)
  })

  it('setTaskInfoStatus(ready) 同口径拦截：缺 FlowId / 缺 Key 都会被拒', () => {
    const noFlow = saveTaskInfo(decrypted, bazhuayuInput({ triggerConfig: {} }))
    const noFlowId = noFlow.id ?? 0
    const toReadyNoFlow = setTaskInfoStatus(decrypted, noFlowId, 'ready')
    expect(toReadyNoFlow.ok).toBe(false)
    expect(String(toReadyNoFlow.error)).toContain('标记已完善前需补全：')
    expect(String(toReadyNoFlow.error)).toContain('FlowId')

    const keyless = saveTaskInfo(decrypted, bazhuayuInput({ triggerSecret: {} }))
    const toReadyNoKey = setTaskInfoStatus(decrypted, keyless.id ?? 0, 'ready')
    expect(toReadyNoKey.ok).toBe(false)
    expect(String(toReadyNoKey.error)).toContain('API Key')

    // 配齐后可标记已完善
    expect(saveTaskInfo(decrypted, { ...bazhuayuInput(), id: noFlowId }).ok).toBe(true)
    expect(setTaskInfoStatus(decrypted, noFlowId, 'ready').ok).toBe(true)
  })
})

describe('老库迁移（旧专用列 → 通用列）', () => {
  it('旧 task_info 只有专用列：读取按旧列回退派生，写入后补齐通用列且行为不变', () => {
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
        '旧 Webhook 任务', PRIVATE_TALKER, '李四', 'private', PRIVATE_TALKER, '李四',
        '["发票"]', 0, 'https://callback.example/hook', 'ready', 0, 1, 1, 0,
      )
    })

    // 读路径不建表：旧任务按 webhook + 旧 callback_url 迁移成通用配置
    const before = listTaskInfos(decrypted)
    expect(before.readError).toBeUndefined()
    expect(before.items[0]?.triggerMethod).toBe('webhook')
    expect(before.items[0]?.triggerConfig).toEqual({ url: 'https://callback.example/hook' })
    expect(before.items[0]?.callbackUrl).toBe('https://callback.example/hook')

    // 任意一次写会 ensureTaskSchema 补新列，并把通用列写实
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
    expect(columns).toEqual(expect.arrayContaining(['trigger_config', 'trigger_secret', 'trigger_vendor_version']))
    const after = listTaskInfos(decrypted).items[0]
    expect(after?.name).toBe('迁移后')
    expect(after?.triggerMethod).toBe('webhook')
    expect(after?.triggerConfig['url']).toBe('https://callback.example/hook')
    expect(after?.status).toBe('ready')
  })

  it('旧八爪鱼任务（bazhuayu_flow_id + bazhuayu_api_key）迁移成通用配置与凭据', () => {
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
        mention_me_only INTEGER NOT NULL DEFAULT 0,
        trigger_method TEXT NOT NULL DEFAULT 'webhook',
        bazhuayu_flow_id TEXT NOT NULL DEFAULT '',
        bazhuayu_api_key TEXT NOT NULL DEFAULT '',
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
         keywords, photo_limit, mention_me_only, trigger_method, bazhuayu_flow_id, bazhuayu_api_key,
         callback_url, status, last_scan_seq, created_at, updated_at, trigger_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        '旧八爪鱼任务', PRIVATE_TALKER, '李四', 'private', '', '',
        '["发票"]', 0, 0, 'bazhuayu', FLOW_ID, API_KEY,
        '', 'ready', 0, 1, 1, 0,
      )
    })
    const task = listTaskInfos(decrypted).items[0]
    expect(task?.triggerMethod).toBe('bazhuayu')
    // 读旧行时只回退迁移出已有的键（flowId）；paramMap/extraParams 等默认值在保存/渲染时补齐。
    expect(task?.triggerConfig).toEqual({ flowId: FLOW_ID })
    expect(task?.triggerSecretSet).toEqual({ apiKey: true })
    expect(task?.bazhuayuFlowId).toBe(FLOW_ID)
    expect(task?.bazhuayuApiKeySet).toBe(true)
  })
})

describe('八爪鱼投递（注册表管道）', () => {
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
    // 八爪鱼接口没有图片参数：即使任务 photoLimit=2 也不解码图片。
    expect(decodeCalls).toBe(0)

    const saved = listTaskTriggers(decrypted).items.find((item) => item.id === triggerId)
    expect(saved?.callbackStatus).toBe('sent')
    expect(typeof saved?.callbackAt).toBe('number')
    expect(saved?.callbackError).toBeUndefined()
  })

  it('单聊任务（targetName 为空）at_name 回落会话名；群聊仍严格用触发对象显示名', async () => {
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '历史' },
    ])
    expect(saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready', chatName: '李四' })).ok).toBe(true)
    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_lisi', text: '秘密 发票 内容' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    const triggerId = firstTriggerId()
    const bodies: Array<Record<string, unknown>> = []
    const deps = dispatchDeps({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response('ok', { status: 200 })
      },
    })
    expect((await dispatchTaskCallback(decrypted, decoded, triggerId, deps)).ok).toBe(true)
    const params = bodies[0]?.['Params'] as Record<string, unknown> | undefined
    expect(params?.['room_name']).toBe('李四')
    expect(params?.['at_name']).toBe('李四')
    // 群聊用例见上一条成功用例：targetName='小王' 时 at_name 严格保持「小王」。
  })

  it('参数增强：参数映射改名 + 附加参数随 Params 一起发出（真实派发链路）', async () => {
    seedMessages(GROUP_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_target', text: '历史 报价' },
    ])
    expect(saveTaskInfo(decrypted, groupBazhuayuInput({
      name: '群报价任务',
      triggerConfig: {
        flowId: FLOW_ID,
        paramMap: { room: 'group_name', content: 'text', at: 'user' },
        extraParams: [
          { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
          { name: 'kw', source: 'keyword' },
          { name: 'tpl', source: 'template', template: '${record.chatName}/${task.name}' },
        ],
      },
    })).ok).toBe(true)
    seedMessages(GROUP_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_target', text: '秘密 报价 内容' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    const triggerId = firstTriggerId()
    const bodies: Array<Record<string, unknown>> = []
    const deps = dispatchDeps({
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response('ok', { status: 200 })
      },
    })
    expect((await dispatchTaskCallback(decrypted, decoded, triggerId, deps)).ok).toBe(true)
    const params = bodies[0]?.['Params'] as Record<string, string> | undefined
    expect(params?.['group_name']).toBe('报价群')
    expect(params?.['text']).toBe('*** 报价 内容')
    expect(params?.['user']).toBe('小王')
    expect(params?.['order_no']).toBe('A-001')
    expect(params?.['kw']).toBe('报价')
    expect(params?.['tpl']).toBe('报价群/群报价任务')
    expect(params?.['room_name']).toBeUndefined()
    expect(bodies[0]?.['FlowId']).toBe(FLOW_ID)
  })

  it('失败：非 2xx ⇒ failed + 错误落库', async () => {
    const triggerId = fixtureWithBazhuayuTrigger()
    const deps = dispatchDeps({ fetchImpl: async () => new Response('boom', { status: 500 }) })
    const result = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(String(result.error)).toContain('500')
    const saved = listTaskTriggers(decrypted).items.find((item) => item.id === triggerId)
    expect(saved?.callbackStatus).toBe('failed')
    expect(String(saved?.callbackError)).toContain('500')
  })

  it('未配置（缺 Key / 缺 FlowId / 未知厂商 / 任务非 ready）⇒ skipped 且不发请求', async () => {
    const triggerId = fixtureWithBazhuayuTrigger()
    const taskId = listTaskInfos(decrypted).items[0]?.id ?? 0
    let requests = 0
    const deps = dispatchDeps({
      fetchImpl: async () => {
        requests += 1
        return new Response('ok', { status: 200 })
      },
    })

    // 同时清掉通用列与旧列（旧列是降级回退读，不清会被迁移逻辑"复活"）
    withTaskDb((db) => {
      db.prepare("UPDATE task_info SET trigger_secret = '{}', bazhuayu_api_key = '' WHERE id = ?").run(taskId)
    })
    const noKey = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(noKey.status).toBe('skipped')
    expect(String(noKey.error)).toContain('触发配置不完整')
    expect(String(noKey.error)).toContain('API Key')

    withTaskDb((db) => {
      db.prepare("UPDATE task_info SET trigger_config = '{}', bazhuayu_flow_id = '', trigger_secret = ? WHERE id = ?")
        .run(JSON.stringify({ apiKey: API_KEY }), taskId)
    })
    const noFlow = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(noFlow.status).toBe('skipped')
    expect(String(noFlow.error)).toContain('FlowId')

    // 未知厂商：任务照常可读，投递 skipped 并写明原因
    withTaskDb((db) => {
      db.prepare("UPDATE task_info SET trigger_method = 'gone-vendor', trigger_config = ? WHERE id = ?")
        .run(JSON.stringify({ flowId: FLOW_ID }), taskId)
    })
    const unknown = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(unknown).toEqual({ ok: false, status: 'skipped', error: '触发方式不可用：gone-vendor' })

    // 任务退回待完善
    withTaskDb((db) => { db.prepare("UPDATE task_info SET trigger_method = 'bazhuayu' WHERE id = ?").run(taskId) })
    expect(setTaskInfoStatus(decrypted, taskId, 'incomplete').ok).toBe(true)
    const incomplete = await dispatchTaskCallback(decrypted, decoded, triggerId, deps)
    expect(incomplete).toEqual({ ok: false, status: 'skipped', error: '任务未完善' })

    expect(requests).toBe(0)
  })
})

describe('多厂商链路：扫描 → pending → 批量投递', () => {
  it('bazhuayu 任务（通用配置无 Webhook 地址）扫出 pending 记录，批量投递能捞出并送出', async () => {
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

    const calls: Array<{ url: string }> = []
    const deps = dispatchDeps({
      fetchImpl: async (url) => {
        calls.push({ url })
        return new Response('ok', { status: 200 })
      },
    })
    const result = await dispatchPendingTaskCallbacks(decrypted, decoded, deps)
    expect(result.dispatched).toBe(2)
    expect(result.failed).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.url === BAZHUAYU_URL)).toBe(true)
    expect(listTaskTriggers(decrypted).items.map((item) => item.callbackStatus)).toEqual(['sent', 'sent'])
    expect((await dispatchPendingTaskCallbacks(decrypted, decoded, deps)).dispatched).toBe(0)
  })

  it('未知厂商的任务：扫描直接写 skipped（不制造永远投不出去的 pending）', () => {
    seedMessages(PRIVATE_TALKER, [
      { localId: 1, sortSeq: 10, createTime: 100, sender: 'wxid_lisi', text: '历史' },
    ])
    const created = saveTaskInfo(decrypted, bazhuayuInput({ status: 'ready' }))
    const taskId = created.id ?? 0
    withTaskDb((db) => {
      db.prepare("UPDATE task_info SET trigger_method = 'gone-vendor' WHERE id = ?").run(taskId)
    })
    seedMessages(PRIVATE_TALKER, [
      { localId: 2, sortSeq: 20, createTime: 2000, sender: 'wxid_lisi', text: '命中 发票' },
    ])
    expect(scanTaskTriggers(decrypted, { selfUsername: SELF }).created).toBe(1)
    expect(listTaskTriggers(decrypted).items[0]?.callbackStatus).toBe('skipped')
  })

  it('厂商下线后的既有 pending：批量投递落成 skipped（不再每拍重复占用队头）', async () => {
    const triggerId = fixtureWithBazhuayuTrigger()
    const taskId = listTaskInfos(decrypted).items[0]?.id ?? 0
    withTaskDb((db) => {
      db.prepare("UPDATE task_info SET trigger_method = 'gone-vendor' WHERE id = ?").run(taskId)
    })
    const deps = dispatchDeps({
      fetchImpl: async () => {
        throw new Error('不该出网')
      },
    })
    const first = await dispatchPendingTaskCallbacks(decrypted, decoded, deps)
    expect(first.dispatched).toBe(0)
    expect(first.failed).toBe(1)
    const saved = listTaskTriggers(decrypted).items.find((item) => item.id === triggerId)
    expect(saved?.callbackStatus).toBe('skipped')
    expect(String(saved?.callbackError)).toContain('触发方式不可用')
    // 已落 skipped，下一拍不会再捞到（否则会阻塞后面配置齐全的记录）
    const second = await dispatchPendingTaskCallbacks(decrypted, decoded, deps)
    expect(second).toEqual({ dispatched: 0, failed: 0 })
  })
})

/**
 * 消息 / 聚合工具的参数判据（2026-11-13 新增）。
 *
 * ## 为什么这些参数要单独钉住
 *
 * 工具参数是**模型写的**，失效方式几乎都是「不报错、只是结果不对」：
 *   · `sender` 没生效 → 「张三说过什么」混入别人提到张三的消息；
 *   · `match=all` 退化成并集 → 高频词（「转账」）淹没组合条件；
 *   · 日期过滤发生在 top-N 之后 → 范围内明明有结果却返回 0；
 *   · `aggregate_messages` 拿不到原问题 → 「收到」与「付出」的方向词全部失效。
 *
 * 这些都不会让问答崩掉，只会让答案悄悄变错，所以必须用确定性夹具逐条锁住。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { allTools, runTool } from '../src/query/tools/index.ts'
import { bigramTokens, INDEX_SCHEMA_VERSION } from '../src/query/search-scaffold.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** 本地时区 `YYYY-MM-DD HH:mm` → epoch 秒（聚合按本地时区分组，夹具也必须用本地时间构造）。 */
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return Math.floor(new Date(y, m - 1, d, h, min, 0).getTime() / 1000)
}

interface FixtureMessage {
  id: number
  text: string
  username: string
  time: number
  sender?: string
}

const ROOM1 = 'room1@chatroom'
const CONTACTS: ReadonlyArray<readonly [string, string]> = [
  ['wxid_a', '房东老陈'],
  ['wxid_b', '租客小李'],
]

/** 造一个带自建 FTS 索引与通讯录的最小数据根。 */
function makeDataDir(messages: FixtureMessage[]): string {
  const root = mkdtempSync(join(tmpdir(), 'search-tools-params-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(join(dec, 'contact'), { recursive: true })
  mkdirSync(join(dec, 'message'), { recursive: true })
  const names = new Map(CONTACTS)

  const db = new DatabaseSync(join(root, 'wechat_search.db'))
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER, sender TEXT NOT NULL DEFAULT \'\')')
    db.exec("CREATE VIRTUAL TABLE message_fts USING fts5(tokens, who, tokenize='unicode61', content='')")
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(INDEX_SCHEMA_VERSION))
    const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?,?)')
    const insFts = db.prepare('INSERT INTO message_fts(rowid, tokens, who) VALUES (?,?,?)')
    for (const m of messages) {
      ins.run(m.id, m.text, m.username, m.id, m.time, m.sender ?? '')
      // 与构建侧同一口径：tokens = 正文 bigram，who = 会话名 + 发送者显示名。
      const who = [
        bigramTokens(m.username),
        m.sender ? bigramTokens(names.get(m.sender) ?? m.sender) : '',
      ].filter(Boolean).join(' ')
      insFts.run(m.id, bigramTokens(m.text), who)
    }
  } finally {
    db.close()
  }

  const cdb = new DatabaseSync(join(dec, 'contact', 'contact.db'))
  try {
    cdb.exec('CREATE TABLE contact (id INTEGER, username TEXT, local_type INTEGER, alias TEXT, remark TEXT, nick_name TEXT, quan_pin TEXT, description TEXT)')
    const ins = cdb.prepare('INSERT INTO contact VALUES (?,?,?,?,?,?,?,?)')
    CONTACTS.forEach(([username, name], i) => ins.run(i + 1, username, 3, '', name, name, '', ''))
  } finally {
    cdb.close()
  }
  return dec
}

/**
 * 主夹具：群聊 + 单聊、两个发送者、跨月/跨小时/跨星期。
 *
 * 群 room1 的 5 条消息用于 sender / match / order；
 * room2..room6 各 1 条用于 top 与 kind 过滤；wxid_b 是单聊（sender 列为空）。
 */
function makeToolsFixture(): string {
  const messages: FixtureMessage[] = [
    { id: 1, text: '收到转账100元', username: ROOM1, time: at(2026, 10, 5, 10, 0), sender: 'wxid_a' },
    { id: 2, text: '收到转账200元', username: ROOM1, time: at(2026, 10, 5, 11, 0), sender: 'wxid_a' },
    { id: 3, text: '付出转账50元', username: ROOM1, time: at(2026, 10, 6, 9, 0), sender: 'wxid_b' },
    { id: 4, text: '合同尾款已结清', username: ROOM1, time: at(2026, 10, 6, 9, 30), sender: 'wxid_b' },
    { id: 5, text: '合同变更需要确认', username: ROOM1, time: at(2026, 10, 6, 10, 0), sender: 'wxid_a' },
    { id: 6, text: '合同条款已发你', username: 'wxid_b', time: at(2026, 11, 7, 14, 0) },
    { id: 7, text: '收到款项谢谢', username: 'wxid_b', time: at(2026, 11, 7, 15, 0) },
  ]
  for (let i = 2; i <= 6; i += 1) {
    messages.push({
      id: 10 + i,
      text: `量产消息 ${i}`,
      username: `room${i}@chatroom`,
      time: at(2026, 10, 6 + i, 12, 0),
    })
  }
  return makeDataDir(messages)
}

/**
 * 批量夹具：350 条「压测」噪音（词频高、时间在范围外）+ 3 条范围内目标 + 120 条量产。
 *
 * 噪音刻意放前面且词频更高：旧实现先取 top-N 再过滤时，top-N 会被噪音占满，
 * 范围内的 3 条会被误判成 0 —— 这正是日期下推要修的失败模式。
 */
function makeVolumeFixture(): string {
  const messages: FixtureMessage[] = []
  let id = 1
  for (let i = 0; i < 350; i += 1) {
    // 提高词频：BM25 会把它们排到范围内目标之前。
    messages.push({ id, text: `${'压测 '.repeat(20)}噪音`, username: 'noise@chatroom', time: at(2026, 6, 1, 0, 0) + i })
    id += 1
  }
  for (let i = 0; i < 3; i += 1) {
    messages.push({ id, text: '压测目标', username: 'target@chatroom', time: at(2026, 1, 10, 10, 0) + i })
    id += 1
  }
  for (let i = 0; i < 120; i += 1) {
    messages.push({ id, text: `量产消息${i}`, username: 'limit@chatroom', time: at(2026, 5, 1, 10, 0) + i })
    id += 1
  }
  return makeDataDir(messages)
}

function argsOf(name: 'search_messages' | 'aggregate_messages'): Record<string, unknown> {
  const tool = allTools.find(t => t.name === name)
  expect(tool, `缺少工具 ${name}`).toBeTruthy()
  return tool!.parameters as Record<string, unknown>
}

describe('search_messages：sender / match / order / limit', () => {
  it('sender 按群内发送者过滤（显示名 → 原始 wxid）', async () => {
    const dec = makeToolsFixture()
    const r = await runTool(allTools, 'search_messages', {
      keywords: ['转账'], username: ROOM1, sender: '房东老陈', limit: 20,
    }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(2)
    expect(r.hits.every(h => h.sender === '房东老陈')).toBe(true)
    expect(r.hits.every(h => h.snippet.includes('收到转账'))).toBe(true)
  })

  it('sender 在单聊里按会话对方过滤（sender 列本身为空）', async () => {
    const dec = makeToolsFixture()
    const r = await runTool(allTools, 'search_messages', {
      keywords: ['合同'], username: 'wxid_b', sender: '租客小李',
    }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]?.key).toBe('wxid_b:6')
  })

  it('match=all 取关键词交集，match=any 保持并集', async () => {
    const dec = makeToolsFixture()
    const all = await runTool(allTools, 'search_messages', {
      keywords: ['转账', '收到'], match: 'all',
    }, { decryptedDir: dec })
    expect(all.ok).toBe(true)
    // 只有「收到转账」两条同时含两个词；「付出转账」「收到款项」都只含一个。
    expect(all.hits.map(h => h.key).sort()).toEqual(['room1@chatroom:1', 'room1@chatroom:2'])

    const any = await runTool(allTools, 'search_messages', {
      keywords: ['转账', '收到'], match: 'any',
    }, { decryptedDir: dec })
    expect(any.ok).toBe(true)
    // 并集：收到转账 ×2 + 付出转账 ×1 + 收到款项 ×1
    expect(any.hits.length).toBe(4)
  })

  it('order=recent 按消息时间倒序（相关度顺序回答不了「最近一次」）', async () => {
    const dec = makeToolsFixture()
    const r = await runTool(allTools, 'search_messages', {
      keywords: ['转账'], order: 'recent', limit: 10,
    }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits.length).toBeGreaterThanOrEqual(3)
    expect(r.hits[0]?.snippet).toContain('付出转账')
    const times = r.hits.map(h => h.time)
    expect(times).toEqual([...times].sort().reverse())
  })

  it('limit 上限提升到 100（旧上限 60 会把「还有更多」截断成假象）', async () => {
    const dec = makeVolumeFixture()
    const r = await runTool(allTools, 'search_messages', {
      keywords: ['量产'], limit: 100,
    }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(100)
    // 默认仍是 24
    const def = await runTool(allTools, 'search_messages', { keywords: ['量产'] }, { decryptedDir: dec })
    expect(def.hits).toHaveLength(24)
  })

  it('日期条件在 SQL 层下推：top-N 噪音不能把范围内结果挤成 0', async () => {
    const dec = makeVolumeFixture()
    const r = await runTool(allTools, 'search_messages', {
      keywords: ['压测'], from: '2026-01-01', to: '2026-01-31', limit: 10,
    }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits, '日期过滤仍发生在 top-N 之后 ⇒ 范围内 3 条被误判为 0').toHaveLength(3)
    expect(r.hits.every(h => h.snippet.includes('目标'))).toBe(true)
  })

  it('新参数出现在 schema 里（模型靠 schema 决定怎么填）', () => {
    const props = (argsOf('search_messages')['properties'] ?? {}) as Record<string, Record<string, unknown>>
    for (const key of ['sender', 'match', 'order', 'limit']) expect(props[key], `缺少参数 ${key}`).toBeTruthy()
    expect(String(props['match']?.['enum'])).toContain('all')
    expect(String(props['order']?.['enum'])).toContain('recent')
    expect(String(props['limit']?.['description'])).toContain('100')
  })
})

describe('get_session_messages：sender / offset', () => {
  it('sender 在 SQL 里过滤（显示名反查原始 wxid）', async () => {
    const dec = makeToolsFixture()
    const r = await runTool(allTools, 'get_session_messages', {
      username: ROOM1, sender: '租客小李', limit: 20,
    }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits.map(h => h.key)).toEqual(['room1@chatroom:3', 'room1@chatroom:4'])
    expect(r.hits.every(h => h.sender === '租客小李')).toBe(true)
  })

  it('offset 用于翻页（与 order/limit 组合）', async () => {
    const dec = makeToolsFixture()
    const r = await runTool(allTools, 'get_session_messages', {
      username: ROOM1, order: 'asc', limit: 1, offset: 1,
    }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]?.snippet).toContain('收到转账200元')
  })
})

describe('aggregate_messages：question / granularity / sender / kind / top / distinctField', () => {
  it('question 驱动方向词：收到 vs 付出互不混淆', async () => {
    const dec = makeToolsFixture()
    const received = await runTool(allTools, 'aggregate_messages', {
      dimension: 'keyword', keywords: ['转账'], question: '我一共收到多少笔转账',
    }, { decryptedDir: dec })
    expect(received.ok).toBe(true)
    expect(received.facts?.[0]?.body).toContain('含「收到转账」：2 条')

    const paid = await runTool(allTools, 'aggregate_messages', {
      dimension: 'keyword', keywords: ['转账'], question: '我付出了多少转账',
    }, { decryptedDir: dec })
    expect(paid.ok).toBe(true)
    expect(paid.facts?.[0]?.body).toContain('含「付出转账」：1 条')

    // 没有 question 时只能用关键词本身（不能再造出不存在的方向组合）
    const plain = await runTool(allTools, 'aggregate_messages', {
      dimension: 'keyword', keywords: ['转账'],
    }, { decryptedDir: dec })
    expect(plain.facts?.[0]?.body).toContain('含「转账」：3 条')
    expect(plain.facts?.[0]?.body).not.toContain('收到转账」：')
  })

  it('granularity 支持 month / hour / weekday', async () => {
    const dec = makeToolsFixture()
    const month = await runTool(allTools, 'aggregate_messages', {
      dimension: 'day', granularity: 'month',
    }, { decryptedDir: dec })
    expect(month.facts?.[0]?.title).toContain('按月')
    expect(month.facts?.[0]?.body).toContain('2026-10：')
    expect(month.facts?.[0]?.body).toContain('2026-11：')

    const hour = await runTool(allTools, 'aggregate_messages', {
      dimension: 'day', granularity: 'hour',
    }, { decryptedDir: dec })
    expect(hour.facts?.[0]?.title).toContain('按小时')
    // 10-05 10:00 与 10-06 10:00 各一条
    expect(hour.facts?.[0]?.body).toContain('10 点：2 条')

    const weekday = await runTool(allTools, 'aggregate_messages', {
      dimension: 'day', granularity: 'weekday',
    }, { decryptedDir: dec })
    expect(weekday.facts?.[0]?.title).toContain('按星期')
    // 2026-10-05 是周一；标签必须按本地时区换算，不能直接显示 0-6。
    expect(weekday.facts?.[0]?.body).toContain('周一：')
    expect(weekday.facts?.[0]?.body).toContain('周六：')
  })

  it('sender 过滤与 sender 排行不影响会话数口径', async () => {
    const dec = makeToolsFixture()
    const filtered = await runTool(allTools, 'aggregate_messages', {
      dimension: 'session', sender: '租客小李', kind: 'group',
    }, { decryptedDir: dec })
    expect(filtered.ok).toBe(true)
    expect(filtered.facts?.[0]?.body).toContain('群聊 room1：2 条')
    expect(filtered.facts?.[0]?.body).not.toContain('wxid_')

    const distinctSender = await runTool(allTools, 'aggregate_messages', {
      dimension: 'distinct', distinctField: 'sender',
    }, { decryptedDir: dec })
    expect(distinctSender.ok).toBe(true)
    expect(distinctSender.facts?.[0]?.title).toContain('去重发送者数')
    expect(distinctSender.facts?.[0]?.body).toContain('不同发送者（去重）：2 人')
  })

  it('kind=group 只统计群聊；top 控制上榜数量', async () => {
    const dec = makeToolsFixture()
    const groupOnly = await runTool(allTools, 'aggregate_messages', {
      dimension: 'distinct', kind: 'group',
    }, { decryptedDir: dec })
    expect(groupOnly.facts?.[0]?.body).toContain('其中群聊：6 个')
    expect(groupOnly.facts?.[0]?.body).toContain('其中单聊（含公众号/服务号等非群会话）：0 个')

    const top5 = await runTool(allTools, 'aggregate_messages', {
      dimension: 'session', kind: 'group', top: 5,
    }, { decryptedDir: dec })
    expect(top5.facts?.[0]?.title).toContain('5 个会话上榜')
  })

  it('新参数出现在 schema 里', () => {
    const props = (argsOf('aggregate_messages')['properties'] ?? {}) as Record<string, Record<string, unknown>>
    for (const key of ['question', 'granularity', 'sender', 'kind', 'top', 'distinctField']) {
      expect(props[key], `缺少参数 ${key}`).toBeTruthy()
    }
    expect(String(props['granularity']?.['enum'])).toContain('weekday')
    expect(String(props['distinctField']?.['enum'])).toContain('sender')
  })
})

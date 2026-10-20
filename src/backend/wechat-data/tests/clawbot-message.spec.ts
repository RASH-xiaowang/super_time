/**
 * ClawBot 接入会话（`clawbot_message`）检索守卫。
 *
 * 这一族守的是「检索本身会不会骗人」：区间边界、LIKE 转义、续传语义、
 * 以及**读失败 ≠ 没有会话**（N1 同族纪律）。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clawbotDbPath } from '../src/query/clawbot/clawbot-db.ts'
import {
  CLAWBOT_MESSAGE_DEFAULT_LIMIT,
  CLAWBOT_MESSAGE_MAX_LIMIT,
  clawbotMessageCounts,
  insertClawbotMessage,
  listClawbotMessages,
  readClawbotMessageInternal,
} from '../src/query/clawbot/clawbot-message.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-msg-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** 数据根父级是个普通文件：任何开库都会失败（用于读失败分支）。 */
function brokenRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-msg-'))
  scratch.push(base)
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, '')
  return join(blocker, 'decrypted')
}

describe('clawbot 接入会话：写入与检索', () => {
  it('写入后能按 id 倒序读出；total 计全量、maxId 是表内最大值', () => {
    const dir = root()
    insertClawbotMessage(dir, { ts: 1000, direction: 'in', content: '第一条', msgType: 'text' })
    insertClawbotMessage(dir, { ts: 2000, direction: 'out', content: '第二条' })
    insertClawbotMessage(dir, { ts: 3000, direction: 'in', content: '第三条' })

    const snap = listClawbotMessages(dir, { limit: 2 })
    expect(snap.total).toBe(3)
    expect(snap.items.map(m => m.content)).toEqual(['第三条', '第二条'])
    expect(snap.maxId).toBe(3)
    expect(snap.readError).toBeUndefined()
    // msgType 缺省归一成 null（展示层显示 text 是它自己的事）
    expect(snap.items[1]?.msgType).toBeNull()
  })

  it('时间区间含等于；方向过滤生效', () => {
    const dir = root()
    insertClawbotMessage(dir, { ts: 100, direction: 'in', content: 'a' })
    insertClawbotMessage(dir, { ts: 200, direction: 'out', content: 'b' })
    insertClawbotMessage(dir, { ts: 300, direction: 'in', content: 'c' })

    expect(listClawbotMessages(dir, { from: 100, to: 200 }).items.map(m => m.content).sort()).toEqual(['a', 'b'])
    expect(listClawbotMessages(dir, { direction: 'in' }).total).toBe(2)
    expect(listClawbotMessages(dir, { direction: 'out' }).items.map(m => m.content)).toEqual(['b'])
  })

  it('关键词走服务端 LIKE 且转义 `%` `_` `\\`（输入 `%` 不许返回全表）', () => {
    const dir = root()
    insertClawbotMessage(dir, { ts: 1, direction: 'in', content: '普通消息' })
    insertClawbotMessage(dir, { ts: 2, direction: 'in', content: '进度 100% 完成' })
    insertClawbotMessage(dir, { ts: 3, direction: 'in', content: 'a_b 下划线' })
    insertClawbotMessage(dir, { ts: 4, direction: 'in', content: '反斜杠 \\ 样例' })

    expect(listClawbotMessages(dir, { q: '%' }).items.map(m => m.content)).toEqual(['进度 100% 完成'])
    expect(listClawbotMessages(dir, { q: '_' }).items.map(m => m.content)).toEqual(['a_b 下划线'])
    expect(listClawbotMessages(dir, { q: '\\' }).items.map(m => m.content)).toEqual(['反斜杠 \\ 样例'])
    expect(listClawbotMessages(dir, { q: '普通' }).total).toBe(1)
  })

  it('续传模式（afterId）：只取 id > afterId，并按 id 升序返回', () => {
    const dir = root()
    const id1 = insertClawbotMessage(dir, { ts: 1, direction: 'in', content: 'a' })
    insertClawbotMessage(dir, { ts: 2, direction: 'in', content: 'b' })
    const id3 = insertClawbotMessage(dir, { ts: 3, direction: 'in', content: 'c' })

    expect(id1).toBe(1)
    const snap = listClawbotMessages(dir, { afterId: id1 ?? 0 })
    expect(snap.items.map(m => m.id)).toEqual([2, id3])
    expect(snap.items.map(m => m.content)).toEqual(['b', 'c'])
    // 没有新行时返回空数组（幂等提示重复到达时前端照常跑一遍）
    expect(listClawbotMessages(dir, { afterId: id3 ?? 0 }).items).toEqual([])
    expect(listClawbotMessages(dir, { afterId: id3 ?? 0 }).maxId).toBe(id3)
  })

  it('limit 收敛在 [1, 上限] 之间；缺省用默认每页', () => {
    const dir = root()
    for (let i = 0; i < 5; i += 1) insertClawbotMessage(dir, { ts: i, direction: 'in', content: `m${String(i)}` })
    expect(listClawbotMessages(dir, { limit: 0 }).items).toHaveLength(1)
    expect(listClawbotMessages(dir, { limit: 999_999 }).items.length).toBeLessThanOrEqual(CLAWBOT_MESSAGE_MAX_LIMIT)
    expect(listClawbotMessages(dir).items.length).toBeLessThanOrEqual(CLAWBOT_MESSAGE_DEFAULT_LIMIT)
    // offset 生效（缺省 0）
    expect(listClawbotMessages(dir, { limit: 2, offset: 1 }).items.map(m => m.content)).toEqual(['m3', 'm2'])
  })

  it('库不存在 ⇒ 空快照且**不带** readError（还没接入过 ≠ 读失败）', () => {
    const dir = root()
    const snap = listClawbotMessages(dir)
    expect(snap).toEqual({ items: [], total: 0, maxId: 0 })
    expect('readError' in snap).toBe(false)
  })

  it('库打不开（损坏）⇒ readError 且 items 空、total 为 0（读失败 ≠ 没有会话）', () => {
    const dir = root()
    writeFileSync(clawbotDbPath(dir), 'this is not a sqlite database at all')
    const snap = listClawbotMessages(dir)
    expect(snap.items).toEqual([])
    expect(snap.total).toBe(0)
    expect(snap.readError ?? '').toContain('接入会话读取失败')
  })

  it('计数：today 只数 ts >= since 的行，total 数全量，lastTs 取 MAX(ts)；库不存在时全 0', () => {
    const dir = root()
    expect(clawbotMessageCounts(dir, { since: 0 })).toEqual({ today: 0, total: 0, lastTs: 0 })
    insertClawbotMessage(dir, { ts: 100, direction: 'in', content: 'a' })
    insertClawbotMessage(dir, { ts: 200, direction: 'in', content: 'b' })
    insertClawbotMessage(dir, { ts: 300, direction: 'out', content: 'c' })
    expect(clawbotMessageCounts(dir, { since: 200 })).toEqual({ today: 2, total: 3, lastTs: 300 })
    // lastTs 是 MAX(ts) 而不是「最后一行的 ts」：先插晚的、再插早的，仍取最大值。
    insertClawbotMessage(dir, { ts: 50, direction: 'in', content: 'd' })
    expect(clawbotMessageCounts(dir, { since: 0 }).lastTs).toBe(300)
  })

  it('库里是原生表结构：direction 只接受 in/out（脏值按 in 归一，不抛）', () => {
    const dir = root()
    insertClawbotMessage(dir, { ts: 1, direction: 'in', content: 'x' })
    // 手工塞一行非法 direction（模拟外部写库）：读出时归一成 in，不让界面拿到脏值
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.prepare('INSERT INTO clawbot_message(ts, direction, msg_type, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(2, 'sideways', null, 'y', 2)
    db.close()
    const items = listClawbotMessages(dir).items
    expect(items.find(m => m.ts === 2)?.direction).toBe('in')
  })
})

/** 与 operation-log 的 brokenRoot 同款哨兵：写路径失败要报错，不许静默吞。 */
describe('clawbot 接入会话：写路径', () => {
  it('写不进（数据根不可写）时抛错而不是静默少记', () => {
    const dir = brokenRoot()
    expect(() => insertClawbotMessage(dir, { ts: 1, direction: 'in', content: 'x' })).toThrow()
  })
})

/**
 * 附件列（2026-10-12 媒体可见）：公开行只带展示元数据（kind/name/size），
 * **取数引用与密钥只走内部读**（`readClawbotMessageInternal`）——渲染层永远拿不到它们。
 */
describe('clawbot 接入会话：附件列', () => {
  it('落库 → 公开列表带 kind/name/size；内部读才带 ref/key', () => {
    const dir = root()
    const id = insertClawbotMessage(dir, {
      ts: 1, direction: 'in', msgType: 'file', content: '[文件] 报表.xlsx',
      media: { kind: 'file', ref: 'enc-param-1', key: 'a2V5', name: '报表.xlsx', size: 2048, duration: null },
    })
    expect(id).toBe(1)
    const row = listClawbotMessages(dir).items[0]
    expect(row?.media).toEqual({ kind: 'file', name: '报表.xlsx', size: 2048, duration: null })
    // 公开行里不许出现取数引用与密钥（它们只在内部读里）。
    expect(JSON.stringify(row)).not.toContain('enc-param-1')
    expect(JSON.stringify(row)).not.toContain('a2V5')

    const internal = readClawbotMessageInternal(dir, 1)
    expect(internal?.media).toEqual({ kind: 'file', ref: 'enc-param-1', key: 'a2V5', name: '报表.xlsx', size: 2048, duration: null })
  })

  it('纯文本行 media 为 null；不存在的行内部读为 null', () => {
    const dir = root()
    insertClawbotMessage(dir, { ts: 1, direction: 'in', content: '你好' })
    expect(listClawbotMessages(dir).items[0]?.media).toBeNull()
    expect(readClawbotMessageInternal(dir, 1)).toMatchObject({ content: '你好', media: null })
    expect(readClawbotMessageInternal(dir, 42)).toBeNull()
  })
})

/**
 * 去重（`message_id`）：会话过期（-14）时通道会清空游标重拉，服务端**重发**历史 ——
 * 没有这条，同一句话会在列表里出现两次。
 */
describe('clawbot 接入会话：message_id 去重', () => {
  it('同一 msgId 第二次插入 ⇒ 返回 null、行数不变、maxId 不变', () => {
    const dir = root()
    const first = insertClawbotMessage(dir, { ts: 10, direction: 'in', content: '重发前的第一次', msgId: 777 })
    expect(first).toBe(1)
    const dup = insertClawbotMessage(dir, { ts: 20, direction: 'in', content: '重发回来的同一条', msgId: 777 })
    expect(dup, '同 message_id 必须跳过（返回 null，事件/续传都不产生）').toBeNull()
    const snap = listClawbotMessages(dir)
    expect(snap.total).toBe(1)
    expect(snap.maxId).toBe(1)
    expect(snap.items[0]?.content).toBe('重发前的第一次')
  })

  it('不同 msgId 各自入库；缺 msgId 或非正数 ⇒ 不去重（尽力而为照常插入）', () => {
    const dir = root()
    insertClawbotMessage(dir, { ts: 1, direction: 'in', content: 'a', msgId: 1 })
    insertClawbotMessage(dir, { ts: 2, direction: 'in', content: 'b', msgId: 2 })
    insertClawbotMessage(dir, { ts: 3, direction: 'in', content: 'c' })
    insertClawbotMessage(dir, { ts: 4, direction: 'in', content: 'd' })
    insertClawbotMessage(dir, { ts: 5, direction: 'in', content: 'e', msgId: 0 })
    expect(listClawbotMessages(dir).total).toBe(5)
  })
})

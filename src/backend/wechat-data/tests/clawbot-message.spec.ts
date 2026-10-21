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
import { completeBinding, readBindingInternal } from '../src/query/clawbot/clawbot-binding.ts'
import { ClawbotSessionChangedError, isClawbotSessionChangedError } from '../src/query/clawbot/clawbot-errors.ts'
import {
  CLAWBOT_MESSAGE_DEFAULT_LIMIT,
  CLAWBOT_MESSAGE_MAX_LIMIT,
  clearClawbotMessages,
  clawbotMessageCounts,
  findClawbotMessageIdByClientId,
  insertClawbotMessage,
  insertClawbotMessagesBatch,
  listClawbotMessages,
  readClawbotMessageInternal,
  suppressClawbotMessageIds,
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

  it('历史模式（beforeId）：只取 id < beforeId，最新在前；与 afterId 同时存在时两项都生效', () => {
    const dir = root()
    const id1 = insertClawbotMessage(dir, { ts: 1, direction: 'in', content: 'a' })
    const id2 = insertClawbotMessage(dir, { ts: 2, direction: 'in', content: 'b' })
    const id3 = insertClawbotMessage(dir, { ts: 3, direction: 'in', content: 'c' })
    const id4 = insertClawbotMessage(dir, { ts: 4, direction: 'in', content: 'd' })

    const before = listClawbotMessages(dir, { beforeId: id3 ?? 0, limit: 2 })
    expect(before.items.map(m => m.id)).toEqual([id2, id1])
    expect(before.total).toBe(2)
    // maxId 不受筛选影响，仍供实时续传使用。
    expect(before.maxId).toBe(id4)

    const bounded = listClawbotMessages(dir, { afterId: id1 ?? 0, beforeId: id4 ?? 0 })
    expect(bounded.items.map(m => m.id)).toEqual([id2, id3])
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

  it('批量写入保持输入顺序与逐条去重语义（同帧重复 msgId 只落一条）', () => {
    const dir = root()
    const ids = insertClawbotMessagesBatch(dir, [
      { ts: 1, direction: 'in', content: 'a', msgId: 11 },
      { ts: 2, direction: 'in', content: 'b', msgId: 11 },
      { ts: 3, direction: 'in', content: 'c', msgId: 12 },
    ])
    expect(ids.length).toBe(3)
    expect(ids[0]).toBe(1)
    expect(ids[1]).toBeNull()
    expect(ids[2]).toBe(2)
    expect(listClawbotMessages(dir).items.map(m => m.content)).toEqual(['c', 'a'])
  })
})

describe('clawbot 接入会话：发送 clientId 本地幂等', () => {
  it('同一 slot + clientId 返回既有行；换 slot 仍是新行', () => {
    const dir = root()
    const first = insertClawbotMessage(dir, {
      slot: 1, ts: 1, direction: 'out', content: '已发送', clientId: 'client-1',
    })
    const duplicate = insertClawbotMessage(dir, {
      slot: 1, ts: 2, direction: 'out', content: '重试不应产生第二行', clientId: 'client-1',
    })
    const otherSlot = insertClawbotMessage(dir, {
      slot: 2, ts: 3, direction: 'out', content: '另一个实例', clientId: 'client-1',
    })

    expect(first).toBe(1)
    expect(duplicate).toBe(first)
    expect(otherSlot).toBe(2)
    expect(findClawbotMessageIdByClientId(dir, 1, 'client-1')).toBe(first)
    expect(findClawbotMessageIdByClientId(dir, 2, 'client-1')).toBe(otherSlot)
    expect(findClawbotMessageIdByClientId(dir, 1, 'missing')).toBeNull()
    expect(listClawbotMessages(dir, { slot: 1 }).total).toBe(1)
  })
})

describe('clawbot 接入会话：clear 竞态墓碑', () => {
  it('清空水位拦截单条旧回放，新 msg_id 不受影响', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-watermark' }, null, 1)
    insertClawbotMessage(dir, { slot: 1, ts: 1, direction: 'in', content: 'clear 前', msgId: 701 })

    clearClawbotMessages(dir, 1)
    expect(readBindingInternal(dir, 1).clearWatermark).toBe(701)
    expect(clearClawbotMessages(dir, 1)).toEqual({ removed: 0 })
    expect(readBindingInternal(dir, 1).clearWatermark, '空清空不能把水位降回去').toBe(701)
    expect(insertClawbotMessage(dir, {
      slot: 1, ts: 2, direction: 'in', content: '旧消息单条回放', msgId: 700,
    })).toBeNull()
    expect(insertClawbotMessage(dir, {
      slot: 1, ts: 3, direction: 'in', content: '清空后的新消息', msgId: 702,
    })).toEqual(expect.any(Number))
  })

  it('10,001 条清空后墓碑只留上限，最老 msg_id 仍被清空水位拦住', { timeout: 20_000 }, () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-watermark' }, null, 1)
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.exec('BEGIN IMMEDIATE')
    const insert = db.prepare(`INSERT INTO clawbot_message
      (slot, ts, direction, msg_type, content, created_at, msg_id)
      VALUES (1, ?, 'in', 'text', ?, ?, ?)`)
    for (let msgId = 1; msgId <= 10_001; msgId += 1) {
      insert.run(msgId, `旧消息 ${String(msgId)}`, msgId, msgId)
    }
    db.exec('COMMIT')
    db.close()

    expect(clearClawbotMessages(dir, 1)).toEqual({ removed: 10_001 })
    const current = readBindingInternal(dir, 1)
    expect(current.clearWatermark).toBe(10_001)

    const window = new DatabaseSync(clawbotDbPath(dir))
    const tombstones = window.prepare(`SELECT COUNT(*) AS n, MIN(msg_id) AS oldest, MAX(msg_id) AS newest
      FROM clawbot_message_tombstone WHERE slot = 1`).get() as { n?: number, oldest?: number, newest?: number } | undefined
    window.close()
    expect(Number(tombstones?.n ?? 0)).toBe(10_000)
    expect(Number(tombstones?.oldest ?? 0)).toBe(2)
    expect(Number(tombstones?.newest ?? 0)).toBe(10_001)

    const ids = insertClawbotMessagesBatch(dir, [
      { slot: 1, ts: 11_000, direction: 'in', content: '墓碑已裁剪的最老重放', msgId: 1 },
      { slot: 1, ts: 11_001, direction: 'in', content: '清空后的新消息', msgId: 10_002 },
    ], { expectedSessionEpoch: current.sessionEpoch })
    expect(ids[0], '墓碑裁剪不能绕过清空水位').toBeNull()
    expect(ids[1]).toEqual(expect.any(Number))
    expect(listClawbotMessages(dir, { slot: 1 }).items.map(item => item.content))
      .toEqual(['清空后的新消息'])
  })

  it('重新绑定把清空水位归零，新会话允许同号消息', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-old' }, null, 1)
    insertClawbotMessage(dir, { slot: 1, ts: 1, direction: 'in', content: '旧会话', msgId: 801 })
    clearClawbotMessages(dir, 1)
    expect(readBindingInternal(dir, 1).clearWatermark).toBe(801)

    completeBinding(dir, { wxid: 'wxid-new' }, null, 1)
    expect(readBindingInternal(dir, 1)).toMatchObject({ clearWatermark: 0 })
    expect(insertClawbotMessage(dir, {
      slot: 1, ts: 2, direction: 'in', content: '新会话同号消息', msgId: 801,
    })).toEqual(expect.any(Number))
  })

  it('clear 在删除前自行持久化墓碑：不经通道 suppress，重启式重放也只落新消息', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-clear' }, null, 1)
    insertClawbotMessage(dir, { slot: 1, ts: 1, direction: 'in', content: 'clear 前旧消息', msgId: 501 })

    expect(clearClawbotMessages(dir, 1)).toEqual({ removed: 1 })
    const ids = insertClawbotMessagesBatch(dir, [
      { slot: 1, ts: 2, direction: 'in', content: '服务端重放的旧消息', msgId: 501 },
      { slot: 1, ts: 3, direction: 'in', content: 'clear 后的新消息', msgId: 502 },
    ])

    expect(ids[0]).toBeNull()
    expect(ids[1]).toEqual(expect.any(Number))
    expect(listClawbotMessages(dir, { slot: 1 }).items.map(item => item.content))
      .toEqual(['clear 后的新消息'])
    const db = new DatabaseSync(clawbotDbPath(dir))
    const tombstones = db.prepare('SELECT msg_id FROM clawbot_message_tombstone WHERE slot = 1 ORDER BY msg_id').all() as Array<{ msg_id?: number }>
    db.close()
    expect(tombstones.map(row => Number(row.msg_id))).toEqual([501])
  })

  it('clear 中途删除失败时整笔回滚：消息与墓碑都不产生半状态', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-clear' }, null, 1)
    insertClawbotMessage(dir, { slot: 1, ts: 1, direction: 'in', content: '不能被半删', msgId: 601 })
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.exec(`CREATE TRIGGER fail_clear BEFORE DELETE ON clawbot_message
      WHEN OLD.slot = 1 BEGIN SELECT RAISE(ABORT, 'clear blocked'); END`)
    db.close()

    expect(() => clearClawbotMessages(dir, 1)).toThrow(/clear blocked/)
    const after = new DatabaseSync(clawbotDbPath(dir))
    const messages = after.prepare('SELECT COUNT(*) AS n FROM clawbot_message WHERE slot = 1').get() as { n?: number } | undefined
    const tombstones = after.prepare('SELECT COUNT(*) AS n FROM clawbot_message_tombstone WHERE slot = 1').get() as { n?: number } | undefined
    const watermark = after.prepare('SELECT clear_watermark FROM clawbot_binding WHERE slot = 1').get() as { clear_watermark?: number } | undefined
    after.close()
    expect(Number(messages?.n ?? 0)).toBe(1)
    expect(Number(tombstones?.n ?? 0)).toBe(0)
    expect(Number(watermark?.clear_watermark ?? 0)).toBe(0)
  })

  it('旧消息 id 在重放批次里被跳过，新消息仍落库；换会话后墓碑不再生效', () => {
    const dir = root()
    insertClawbotMessage(dir, { slot: 1, ts: 1, direction: 'in', content: 'clear 前', msgId: 41 })
    clearClawbotMessages(dir, 1)
    // clear 已在同一事务里写好墓碑；通道随后再抑制同一个 id 必须是幂等空操作。
    expect(suppressClawbotMessageIds(dir, 1, [41, 41], 100)).toBe(0)

    const ids = insertClawbotMessagesBatch(dir, [
      { slot: 1, ts: 2, direction: 'in', content: '服务端重放的旧消息', msgId: 41 },
      { slot: 1, ts: 3, direction: 'in', content: 'clear 后的新消息', msgId: 42 },
    ])
    expect(ids[0]).toBeNull()
    expect(ids[1]).toEqual(expect.any(Number))
    expect(listClawbotMessages(dir, { slot: 1 }).items.map(item => item.content))
      .toEqual(['clear 后的新消息'])

    completeBinding(dir, { wxid: 'wx-new-session' }, null, 1)
    const later = insertClawbotMessage(dir, {
      slot: 1, ts: 4, direction: 'in', content: '新会话同号消息', msgId: 41,
    })
    expect(later, '重新绑定推进 session_epoch 后，旧墓碑不能误伤新会话').toEqual(expect.any(Number))
  })
})

describe('clawbot 接入会话：持久会话代次 fencing', () => {
  it('单条发送回填带旧代次时抛错且不落消息', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-old' }, null, 1)
    const staleEpoch = readBindingInternal(dir, 1).sessionEpoch
    completeBinding(dir, { wxid: 'wxid-new' }, null, 1)
    const currentEpoch = readBindingInternal(dir, 1).sessionEpoch

    let error: unknown
    try {
      insertClawbotMessage(dir, {
        slot: 1,
        ts: 1,
        direction: 'out',
        content: '旧会话的迟到回填',
        clientId: 'stale-send-client',
      }, { expectedSessionEpoch: staleEpoch })
    } catch (e) {
      error = e
    }

    expect(isClawbotSessionChangedError(error)).toBe(true)
    expect(error).toMatchObject({ slot: 1, expected: staleEpoch, actual: currentEpoch })
    expect(listClawbotMessages(dir, { slot: 1 }).total).toBe(0)

    const currentId = insertClawbotMessage(dir, {
      slot: 1,
      ts: 2,
      direction: 'out',
      content: '当前会话的合法回填',
      clientId: 'current-send-client',
    }, { expectedSessionEpoch: currentEpoch })
    expect(currentId).toEqual(expect.any(Number))
    expect(listClawbotMessages(dir, { slot: 1 }).items.map(item => item.content))
      .toEqual(['当前会话的合法回填'])
  })

  it('旧代次批量写入在事务内失败：不落消息、不生成回复 run', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-old' }, null, 1)
    const staleEpoch = readBindingInternal(dir, 1).sessionEpoch
    completeBinding(dir, { wxid: 'wxid-new' }, null, 1)
    const currentEpoch = readBindingInternal(dir, 1).sessionEpoch

    let error: unknown
    try {
      insertClawbotMessagesBatch(dir, [
        { slot: 1, ts: 1, direction: 'in', msgType: 'text', content: '旧批次消息', msgId: 101 },
      ], { expectedSessionEpoch: staleEpoch, replyIntake: {} })
    } catch (e) {
      error = e
    }

    expect(isClawbotSessionChangedError(error)).toBe(true)
    expect(error).toBeInstanceOf(ClawbotSessionChangedError)
    expect(error).toMatchObject({ slot: 1, expected: staleEpoch, actual: currentEpoch })
    expect(listClawbotMessages(dir, { slot: 1 }).total).toBe(0)
    const db = new DatabaseSync(clawbotDbPath(dir))
    const runs = db.prepare('SELECT COUNT(*) AS n FROM clawbot_reply_run WHERE slot = 1').get() as { n?: number } | undefined
    db.close()
    expect(Number(runs?.n ?? 0)).toBe(0)
  })

  it('expectedSessionEpoch 配多 slot 批次时明确报参数错误（不落任何消息）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-a' }, null, 1)
    completeBinding(dir, { wxid: 'wxid-b' }, null, 2)
    const epoch = readBindingInternal(dir, 1).sessionEpoch

    expect(() => insertClawbotMessagesBatch(dir, [
      { slot: 1, ts: 1, direction: 'in', content: '实例一' },
      { slot: 2, ts: 2, direction: 'in', content: '实例二' },
    ], { expectedSessionEpoch: epoch })).toThrow(TypeError)
    expect(listClawbotMessages(dir).total).toBe(0)
  })

  it('旧代次墓碑写入失败且事务回滚；当前代次仍可正常抑制', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-old' }, null, 1)
    const staleEpoch = readBindingInternal(dir, 1).sessionEpoch
    completeBinding(dir, { wxid: 'wxid-new' }, null, 1)
    const currentEpoch = readBindingInternal(dir, 1).sessionEpoch

    let error: unknown
    try {
      suppressClawbotMessageIds(dir, 1, [201], { now: 100, expectedSessionEpoch: staleEpoch })
    } catch (e) {
      error = e
    }
    expect(isClawbotSessionChangedError(error)).toBe(true)
    expect(error).toMatchObject({ slot: 1, expected: staleEpoch, actual: currentEpoch })
    const db = new DatabaseSync(clawbotDbPath(dir))
    const staleCount = db.prepare('SELECT COUNT(*) AS n FROM clawbot_message_tombstone WHERE slot = 1').get() as { n?: number } | undefined
    db.close()
    expect(Number(staleCount?.n ?? 0)).toBe(0)

    expect(suppressClawbotMessageIds(dir, 1, [201], {
      now: 100,
      expectedSessionEpoch: currentEpoch,
    })).toBe(1)
  })

  it('未传 expectedSessionEpoch 时批量写入与墓碑保持旧行为', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid-a' }, null, 1)
    const ids = insertClawbotMessagesBatch(dir, [
      { slot: 1, ts: 1, direction: 'in', content: '旧行为批量消息', msgId: 301 },
    ])
    expect(ids[0]).toEqual(expect.any(Number))
    expect(suppressClawbotMessageIds(dir, 1, [302], 100)).toBe(1)
  })
})

/**
 * `sync-status.ts` 的行为守卫（2026-10-18）。
 *
 * 判据只钉两件 renderer 真正依赖的事：**空拍不推进 revision**、**messageChanged
 * 只认消息分片**（否则每拍都拉消息增量，等于没优化）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetDataRevision, publishDataRevision, readDataRevision } from '../src/query/sync-status.ts'

beforeEach(() => { forgetDataRevision() })

describe('revision：每发布一拍 +1，读取永远是防御性副本', () => {
  it('初始为 0；发布一次 +1；updatedAt 落时间戳', () => {
    expect(readDataRevision()).toMatchObject({ revision: 0, messageChanged: false, shards: [] })
    publishDataRevision(['session.db:full(0p/w1)'])
    const r = readDataRevision()
    expect(r.revision).toBe(1)
    expect(r.updatedAt).toBeGreaterThan(0)
    expect(r.shards).toEqual(['session.db:full(0p/w1)'])
    publishDataRevision(['contact.db:wal(0p/w0)'])
    expect(readDataRevision().revision).toBe(2)
  })

  it('读到的 shards 是副本：调用方改它不会污染下一拍', () => {
    publishDataRevision(['message_0.db:wal(0p/w3)'])
    const a = readDataRevision()
    a.shards.push('被外部改坏的名字')
    expect(readDataRevision().shards).toEqual(['message_0.db:wal(0p/w3)'])
  })
})

describe('messageChanged：只认消息分片', () => {
  it('message_<n>.db / biz_message_<n>.db（带 :via 后缀）都算消息变化', () => {
    publishDataRevision(['message_0.db:wal(0p/w3)'])
    expect(readDataRevision().messageChanged).toBe(true)
    publishDataRevision(['biz_message_12.db:full(2p/w0)'])
    expect(readDataRevision().messageChanged).toBe(true)
  })

  it('session / contact / 普通库不算消息变化（聊天面板据此跳过消息查询）', () => {
    publishDataRevision(['session.db:wal(0p/w0)'])
    expect(readDataRevision().messageChanged).toBe(false)
    publishDataRevision(['contact.db:full(0p/w0)', 'sns.db:wal(0p/w0)'])
    expect(readDataRevision().messageChanged).toBe(false)
  })

  it('混在一拍里：只要有一个消息分片，messageChanged 就是 true', () => {
    publishDataRevision(['session.db:wal(0p/w0)', 'message_2.db:wal(0p/w1)'])
    expect(readDataRevision().messageChanged).toBe(true)
  })
})

describe('shards 封顶：诊断字段不许无限增长', () => {
  it('超过 32 个只保留前 32 个，但 messageChanged 仍按全量判断', () => {
    const many = Array.from({ length: 40 }, (_, i) => `db_${String(i)}.db:wal(0p/w0)`)
    many.push('message_3.db:wal(0p/w7)')
    publishDataRevision(many)
    const r = readDataRevision()
    expect(r.shards).toHaveLength(32)
    expect(r.messageChanged, '封顶截掉的尾部里有消息分片也必须算到').toBe(true)
  })
})

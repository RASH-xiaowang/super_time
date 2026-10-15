/**
 * ClawBot **多实例**（slot）与**每实例配置**守卫（M1，2026-10-13）。
 *
 * 守五件事：
 *   ① slot 语义：一 slot 一行绑定；**只增不复用**（复用会把上个实例的残留配置串给新实例）；
 *   ② 配置隔离与持久：配置按 slot 分开，且**活过重新绑定**（绑定行被覆盖、偏好不该丢）；
 *   ③ 删除的边界：删实例连带删它自己的会话与配置，**别的实例一条都不许动**；
 *   ④ 同 wxid 接管：同一个微信号只服务一个实例，后绑的接管、前一个被收敛且**凭证清空**；
 *   ⑤ 老库迁移：没有 `slot` 列的旧库补齐后，原来那唯一一行 = slot 1，旧消息也归 1。
 *
 * 变异自证见 `working/m1-mutation.py`（每条断言都必须能被咬红）。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CLAWBOT_SLOT, clawbotDbPath } from '../src/query/clawbot/clawbot-db.ts'
import { completeBinding, readBinding, readBindingInternal } from '../src/query/clawbot/clawbot-binding.ts'
import { insertClawbotMessage, listClawbotMessages } from '../src/query/clawbot/clawbot-message.ts'
import { createClawbotInstance, defaultInstanceConfig, deleteClawbotInstance, listClawbotInstances, readInstanceConfig, saveInstanceConfig } from '../src/query/clawbot/clawbot-instance.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-inst-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** 直接开库读一行（绕开被测代码，用来验「库里真的写了什么」）。 */
function raw<T>(dir: string, sql: string, ...params: Array<string | number>): T | undefined {
  const db = new DatabaseSync(clawbotDbPath(dir))
  const r = db.prepare(sql).get(...params) as T | undefined
  db.close()
  return r
}

const CREDS = { botToken: 'bt', ilinkBotId: 'ib', ilinkUserId: 'iu', baseUrl: 'https://x' }

describe('clawbot 多实例：slot 与配置', () => {
  it('库不存在：空列表且**不带** readError；配置读回默认（自动回复关、知识库关）', () => {
    const dir = root()
    const snap = listClawbotInstances(dir, { since: 0 })
    expect(snap.instances, '新装用户应是「一个实例都没有」，不是错误').toEqual([])
    expect(snap.readError).toBeUndefined()
    expect(readInstanceConfig(dir, 3).config).toEqual(defaultInstanceConfig(3))
  })

  it('新库里第一个实例是 slot 1（与旧的单绑定形态一致）；再建则是 slot 2', () => {
    const dir = root()
    // 触发建库：写一次配置会因「实例不存在」被拒，这里用建实例之外的路径 —— 读绑定不建库，
    // 所以先用「建实例」把库拉起来（空库上 ensureSchema 会补出 slot 1）。
    const second = createClawbotInstance(dir)
    expect(second.slot, '空库上建实例：ensureSchema 已补出 slot 1，新建的应是 2').toBe(2)
    const snap = listClawbotInstances(dir, { since: 0 })
    expect(snap.instances.map((i) => i.slot), '两个实例都要在列表里，按 slot 升序').toEqual([1, 2])
    expect(snap.instances[0]?.status).toBe('unbound')
    expect(DEFAULT_CLAWBOT_SLOT).toBe(1)
  })

  it('配置按实例隔离，且**活过重新绑定**（绑定行被覆盖、偏好不该丢）', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    const saved = saveInstanceConfig(dir, 1, { autoReply: true, kbEnabled: true, kbId: 7 })
    expect(saved).toEqual({ slot: 1, autoReply: true, kbEnabled: true, kbId: 7 })
    expect(readInstanceConfig(dir, 2).config, 'slot 2 没配过，必须还是默认值（不许被 slot 1 的配置串到）')
      .toEqual(defaultInstanceConfig(2))

    // 部分更新：只关自动回复，知识库设置保持
    const patched = saveInstanceConfig(dir, 1, { autoReply: false })
    expect(patched).toEqual({ slot: 1, autoReply: false, kbEnabled: true, kbId: 7 })

    // 重新绑定（身份与凭证被覆盖）之后，配置仍在
    completeBinding(dir, { wxid: 'wxid_a', userName: '甲' }, CREDS, 1)
    expect(readInstanceConfig(dir, 1).config, '重新绑定把配置清了 = 用户每次扫码都要重设一遍')
      .toEqual({ slot: 1, autoReply: false, kbEnabled: true, kbId: 7 })
  })

  it('配置只能挂在已存在的实例上（拒绝造出「没有实例的配置」）', () => {
    const dir = root()
    createClawbotInstance(dir) // 建库
    expect(() => saveInstanceConfig(dir, 99, { autoReply: true })).toThrow(/不存在/)
  })

  it('删实例：连带删它自己的会话与配置，**别的实例一条不动**', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    for (const slot of [1, 2]) {
      insertClawbotMessage(dir, { slot, ts: 1000 + slot, direction: 'in', content: `来自 ${slot}`, msgType: 'text' })
    }
    saveInstanceConfig(dir, 2, { autoReply: true, kbEnabled: true, kbId: 5 })

    const r = deleteClawbotInstance(dir, 1)
    expect(r.removedMessages, '删掉的条数要如实回报（界面在确认框里要说这个数）').toBe(1)
    expect(Number(raw<{ n?: number }>(dir, 'SELECT COUNT(*) AS n FROM clawbot_binding WHERE slot = 1')?.n ?? -1),
      '实例 1 的绑定行必须被删（COUNT 恒返回一行，要读它的 n）').toBe(0)
    expect(readInstanceConfig(dir, 1).config, '实例 1 的配置行要一起删（否则新实例可能捡到残留）')
      .toEqual(defaultInstanceConfig(1))
    expect(listClawbotMessages(dir, { slot: 2 }).total, '实例 2 的会话不许被删').toBe(1)
    expect(readInstanceConfig(dir, 2).config, '实例 2 的配置不许被删')
      .toEqual({ slot: 2, autoReply: true, kbEnabled: true, kbId: 5 })
  })

  it('slot **不复用**：删掉 2 之后再建，拿到的是 3（否则新实例会捡到残留配置）', () => {
    const dir = root()
    createClawbotInstance(dir) // 2
    const third = createClawbotInstance(dir) // 3
    expect(third.slot).toBe(3)
    deleteClawbotInstance(dir, 3)
    const again = createClawbotInstance(dir)
    expect(again.slot, '复用 3 的话，上一轮 3 的残留在语义上会变成新实例的').toBe(4)
  })

  it('同一微信号只服务一个实例：后绑的接管，前一个被收敛且**凭证清空**', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    completeBinding(dir, { wxid: 'wxid_same', userName: '甲' }, CREDS, 1)
    completeBinding(dir, { wxid: 'wxid_same', userName: '甲' }, CREDS, 2)

    expect(readBinding(dir, 1).binding.status, '同一个号出现在两个实例上 ⇒ 前一个必须被收敛').toBe('unbound-by-user')
    expect(readBinding(dir, 2).binding.status).toBe('bound')
    const oldCreds = readBindingInternal(dir, 1).credentials
    expect(oldCreds, '凭证必须清空（存储侧的「解绑即停轮询」保证）').toBeNull()
    expect(readBindingInternal(dir, 2).credentials, '接管方的凭证要完好').not.toBeNull()
  })

  it('会话按实例隔离：列表与续传位（maxId）都只看本实例', () => {
    const dir = root()
    createClawbotInstance(dir)
    insertClawbotMessage(dir, { slot: 1, ts: 2000, direction: 'in', content: '一', msgType: 'text', msgId: 11 })
    const m2 = insertClawbotMessage(dir, { slot: 2, ts: 2001, direction: 'in', content: '二', msgType: 'text', msgId: 11 })
    expect(m2, '同一个 msg_id 在**不同实例**上不算重复（服务端按会话下发号段）').not.toBeNull()

    const one = listClawbotMessages(dir, { slot: 1 })
    expect(one.items.map((i) => i.content)).toEqual(['一'])
    expect(one.total).toBe(1)
    expect(one.maxId, 'maxId 跨实例取会让续传位虚高、增量被跳过').toBeLessThan(Number(m2))
    expect(listClawbotMessages(dir, { slot: 2 }).items.map((i) => i.content)).toEqual(['二'])
    expect(listClawbotMessages(dir, { slot: 2 }).items[0]?.slot).toBe(2)
    expect(listClawbotMessages(dir, {}).items.map((i) => i.content), '不传 slot = 第一个实例').toEqual(['一'])
  })

  it('实例列表带上配置与会话计数（设置视图一张卡所需的全部信息）', () => {
    const dir = root()
    insertClawbotMessage(dir, { slot: 1, ts: 5000, direction: 'in', content: 'x', msgType: 'text' })
    saveInstanceConfig(dir, 1, { autoReply: true })
    const inst = listClawbotInstances(dir, { since: 0 }).instances[0]
    expect(inst?.slot).toBe(1)
    expect(inst?.config.autoReply).toBe(true)
    expect(inst?.totalMessages).toBe(1)
    expect(inst?.todayMessages).toBe(1)
    expect(inst?.channel, '没注入通道查询时给「未运行」，不许瞎报运行中').toEqual({ running: false, error: null })
  })
})

describe('clawbot 多实例：老库迁移', () => {
  /** 造一个**改动之前**的库：两张表都没有 `slot` 列，且各有一行数据。 */
  function legacyDb(dir: string): void {
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.exec(`CREATE TABLE clawbot_binding (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'unbound', qr_token TEXT,
      qr_expires_at INTEGER, wxid TEXT, user_name TEXT, avatar TEXT, bound_at INTEGER, unbound_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, bot_token TEXT, ilink_bot_id TEXT,
      ilink_user_id TEXT, base_url TEXT, sync_buf TEXT, send_context_token TEXT)`)
    db.exec(`CREATE TABLE clawbot_message (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, direction TEXT NOT NULL, msg_type TEXT,
      content TEXT, created_at INTEGER NOT NULL, msg_id INTEGER, media_kind TEXT, media_ref TEXT,
      media_key TEXT, media_name TEXT, media_size INTEGER)`)
    db.prepare("INSERT INTO clawbot_binding(status, wxid, user_name, created_at, updated_at) VALUES ('bound', 'wxid_old', '老用户', 1, 1)").run()
    db.prepare("INSERT INTO clawbot_message(ts, direction, msg_type, content, created_at) VALUES (900, 'in', 'text', '老消息', 1)").run()
    db.close()
  }

  it('补齐 slot 列后：原来那唯一一行 = slot 1，旧消息也归 1（一条不丢）', () => {
    const dir = root()
    legacyDb(dir)
    // 任一写路径都会先 ensureClawbotSchema（补列），这里用一次解绑触发它
    const after = completeBinding(dir, { wxid: 'wxid_old', userName: '老用户' }, null, 1)
    expect(after.slot).toBe(1)
    expect(readBinding(dir, 1).binding.userName, '老库的身份不许丢').toBe('老用户')
    expect(listClawbotMessages(dir, { slot: 1 }).items.map((i) => i.content)).toEqual(['老消息'])
    expect(readInstanceConfig(dir, 1).config).toEqual(defaultInstanceConfig(1))
  })

  it('老库不会被「补出」多余实例：表里本来只有一行，补完还是一行', () => {
    const dir = root()
    legacyDb(dir)
    completeBinding(dir, { wxid: 'wxid_old' }, null, 1)
    expect(listClawbotInstances(dir, { since: 0 }).instances.map((i) => i.slot)).toEqual([1])
  })
})

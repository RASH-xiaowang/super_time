/**
 * ClawBot **多实例**守卫（2026-10-13）：一个微信号 = 一个实例，彼此不串。
 *
 * 守的是六件事 —— 每一条都对应一个「写错了也不会报错、只会静默串号」的失败模式：
 *  ① `resolveClawbotSlot`：**缺省不是硬编码 1**，而是「第一个还在的实例」；显式值原样透传；
 *  ② 实例管理三个方法（新建 / 删除 / 改配置）的返回与落库语义；
 *  ③ **通道按实例隔离**：两个号各自的入站消息落在各自的 slot 里，互不串；
 *  ④ **发送按实例**：`sendClawbotMessage({ slot })` 用的是那个实例的凭证与令牌（发错号最难查）；
 *  ⑤ 配置**部分更新**：改一个开关不许把别的字段冲回默认；
 *  ⑥ 解绑 / 删除只影响目标实例。
 *
 * 全部 iLink 依赖注入假实现 —— 这套用例一个字节都不出网。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClawbotRemotes, type ClawbotEmitEvent } from '../src/remotes/clawbot.ts'
import { readBindingInternal, saveSendContextToken, type BindingCredentials } from '../src/query/clawbot/clawbot-binding.ts'
import { resolveClawbotSlot } from '../src/query/clawbot/clawbot-instance.ts'
import { insertClawbotMessage } from '../src/query/clawbot/clawbot-message.ts'
import type { ClawbotMediaOutcome } from '../src/query/clawbot/clawbot-media.ts'
import type { IlinkCredentials, IlinkOutgoingText, IlinkPollResult, IlinkSendResult, IlinkUpdates } from '../src/query/clawbot/clawbot-ilink.ts'
import type { OperationCategory, OperationStatus } from '../src/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

interface OpRecord { category: OperationCategory, action: string, status: OperationStatus, target: string, detail: string }

/** 假 iLink：`getUpdates` **按凭证区分实例**（这正是「谁会串号」的判据所在）。 */
interface FakeIlink {
  updatesImpl: (creds: IlinkCredentials, buf: string) => Promise<IlinkUpdates>
  sendCalls: Array<{ toUserId: string, text: string, contextToken: string }>
  /** 每个 ilinkUserId 各被长轮询了几次（用来让「第一轮给消息、之后挂起」可控）。 */
  updateCounts: Map<string, number>
}

function makeHarness(): {
  rc: Parameters<typeof createClawbotRemotes>[0],
  ops: OpRecord[],
  events: ClawbotEmitEvent[],
  dir: string,
  ilink: FakeIlink,
} {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-multi-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  const ops: OpRecord[] = []
  const events: ClawbotEmitEvent[] = []
  const ilink: FakeIlink = {
    // 缺省挂起：循环不空转，测试手动放行才推进。
    updatesImpl: () => new Promise<IlinkUpdates>(() => { /* 挂起 */ }),
    sendCalls: [],
    updateCounts: new Map(),
  }
  const rc: Parameters<typeof createClawbotRemotes>[0] = {
    dirs: () => ({ decrypted: dir }),
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => {
      ops.push({ category, action, status, target: target ?? '', detail: detail ?? '' })
    },
    emit: (event: ClawbotEmitEvent) => { events.push(event) },
    ilink: {
      requestBindQr: async () => ({ token: 'qr-1', payload: 'https://liteapp.weixin.qq.com/q/x?qrcode=qr-1' }),
      pollBindStatus: async (): Promise<IlinkPollResult> => { throw new Error('本 spec 不走扫码路径') },
      getUpdates: (credentials: IlinkCredentials, buf: string) => {
        ilink.updateCounts.set(credentials.ilinkUserId, (ilink.updateCounts.get(credentials.ilinkUserId) ?? 0) + 1)
        return ilink.updatesImpl(credentials, buf)
      },
      sendTextMessage: async (_credentials: IlinkCredentials, out: IlinkOutgoingText): Promise<IlinkSendResult> => {
        ilink.sendCalls.push({ toUserId: out.toUserId, text: out.text, contextToken: out.contextToken })
        return { ret: 0, errMsg: '' }
      },
      // 退避不真等，但要**让出宏任务**（纯微任务的即时 sleep 会把事件循环饿死）。
      sleep: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
    },
    // 本 spec 不测媒体：注入假实现，杜绝任何真实下载。
    media: {
      ensure: async (): Promise<ClawbotMediaOutcome> => ({ ok: false, error: '本 spec 不取媒体' }),
      listPending: () => [],
    },
  }
  return { rc, ops, events, dir, ilink }
}

const flush = async (): Promise<void> => { await new Promise((resolve) => { setImmediate(resolve) }) }
/** 多让几拍：让通道循环（getUpdates → 落库 → 事件 → sleep → 下一轮）跑完。 */
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await flush() }

function credsOf(user: string): BindingCredentials {
  return { botToken: `bt-${user}`, ilinkBotId: `bot-${user}`, ilinkUserId: user, baseUrl: '' }
}

/** 每条消息一个**递增** id（去重按 msg_id，随机值会偶发撞车把用例变成随机红）。 */
let msgSeq = 0

function batchOf(text: string, buf: string): IlinkUpdates {
  msgSeq += 1
  return {
    ret: 0, errCode: 0, errMsg: '', buf, longPollingTimeoutMs: 0,
    messages: [{ message_id: msgSeq, message_type: 1, context_token: `ctx-${text}`, item_list: [{ type: 1, text_item: { text } }] }],
  }
}

describe('resolveClawbotSlot：缺省 = 第一个还在的实例（**不是硬编码 1**）', () => {
  it('库不存在 ⇒ 回落 1；有实例 ⇒ 取最小 slot；显式值原样透传（不校验存在性）', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    expect(resolveClawbotSlot(dir), '空库没有实例时应当回落 1（单实例时代的行为）').toBe(1)

    // 新库自带一个未绑定的默认实例（slot 1，见 `ensureClawbotSchema` 的空表兜底）⇒ 新建的从 2 起。
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    expect(a.slot).toBe(2)
    expect(b.slot).toBe(3)
    expect(resolveClawbotSlot(dir), '缺省应当落到第一个实例（默认那一条）').toBe(1)
    expect(resolveClawbotSlot(dir, 3)).toBe(3)
    // 显式给一个不存在的编号：**原样返回**（写路径自己去暴露「实例不存在」，
    // 这里偷偷改成别的实例会把「操作 A 号」变成「操作 B 号」）。
    expect(resolveClawbotSlot(dir, 99)).toBe(99)
    expect(resolveClawbotSlot(dir, 0)).toBe(1)
    expect(resolveClawbotSlot(dir, Number.NaN), '非法值也要走缺省规则（此时没有 bound ⇒ 第一个实例）').toBe(1)
  })

  it('有实例绑定过时，缺省优先「第一个已绑定」——不是那个从未绑定的默认实例', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    r.bindClawbotWechat({ wxid: 'user-b' }, credsOf('user-b'), b.slot)
    expect(a.slot, '前提：a 是那个从未绑定的实例').toBe(2)
    expect(resolveClawbotSlot(dir), '缺省落到从未绑定的实例 ⇒ 会话与发送面板会指向一个没有身份的号').toBe(b.slot)
    expect(resolveClawbotSlot(dir, a.slot), '显式指定仍然照用（哪怕它没绑定）').toBe(a.slot)
  })

  it('删掉第一个实例之后，缺省落到下一个（不是回到 1）', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    // 删掉默认实例（1）⇒ 缺省要落到**下一个还在的实例**（2），而不是回到 1。
    r.deleteClawbotInstance({ slot: 1 })
    expect(resolveClawbotSlot(dir), '删掉实例 1 之后默认还指向 1 ⇒ 界面会显示空卡片，而库里明明有实例').toBe(a.slot)
    expect(b.slot).toBe(3)
  })
})

describe('实例管理：列表 / 新建 / 删除 / 改配置', () => {
  it('listClawbotInstances：每个实例各带自己的配置与会话计数', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    r.setClawbotInstanceConfig({ slot: b.slot, autoReply: true, kbEnabled: true, kbId: 7 })
    insertClawbotMessage(dir, { slot: a.slot, ts: Date.now(), direction: 'in', msgType: 'text', content: 'a-1' })
    insertClawbotMessage(dir, { slot: b.slot, ts: Date.now(), direction: 'in', msgType: 'text', content: 'b-1' })
    insertClawbotMessage(dir, { slot: b.slot, ts: Date.now(), direction: 'in', msgType: 'text', content: 'b-2' })

    const snap = r.listClawbotInstances()
    expect(snap.readError).toBeUndefined()
    expect(snap.instances.map(i => i.slot), '列表要含默认实例并严格按 slot 升序').toEqual([1, a.slot, b.slot])
    expect(snap.instances[0]).toMatchObject({ status: 'unbound', config: { autoReply: false, kbEnabled: false, kbId: null }, totalMessages: 0, channel: { running: false, error: null } })
    expect(snap.instances[1]).toMatchObject({ totalMessages: 1 })
    expect(snap.instances[2]).toMatchObject({ config: { autoReply: true, kbEnabled: true, kbId: 7 }, totalMessages: 2 })
  })

  it('createClawbotInstance：返回新编号 + 列表里那条是未绑定', () => {
    const { rc, ops } = makeHarness()
    const r = createClawbotRemotes(rc)
    const created = r.createClawbotInstance()
    expect(created.slot, '新建的实例落在默认实例之后').toBe(2)
    expect(created.instances.map(i => i.slot)).toEqual([1, created.slot])
    expect(created.instances.at(-1)?.status).toBe('unbound')
    expect(ops.some(o => o.action === 'clawbot_instance_create')).toBe(true)
  })

  it('deleteClawbotInstance：连带删该实例的会话并如实回报条数，别的实例不动', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    insertClawbotMessage(dir, { slot: a.slot, ts: Date.now(), direction: 'in', msgType: 'text', content: 'keep' })
    insertClawbotMessage(dir, { slot: b.slot, ts: Date.now(), direction: 'in', msgType: 'text', content: 'gone-1' })
    insertClawbotMessage(dir, { slot: b.slot, ts: Date.now(), direction: 'in', msgType: 'text', content: 'gone-2' })

    const del = r.deleteClawbotInstance({ slot: b.slot })
    expect(del.removedMessages, '删除前必须数清连带删掉多少条（界面要如实告知）').toBe(2)
    expect(del.instances.map(i => i.slot)).toEqual([1, a.slot])
    expect(r.listClawbotMessages({ slot: a.slot }).items.map(m => m.content)).toEqual(['keep'])
    expect(r.listClawbotMessages({ slot: b.slot }).items).toEqual([])
  })

  it('setClawbotInstanceConfig：部分更新不冲掉别的字段；kbId 归一；实例不存在则抛错', () => {
    const { rc } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    expect(
      () => r.setClawbotInstanceConfig({ slot: a.slot, autoReply: true }),
      '无有效知识库时显式开启必须给出中文原因，而不是写入一个永远不会发送的开启态',
    ).toThrow(/自动回复需要选择知识库/)
    const first = r.setClawbotInstanceConfig({ slot: a.slot, kbEnabled: true, kbId: 5 })
    expect(first).toMatchObject({ autoReply: false, kbEnabled: true, kbId: 5 })
    // 只打开自动回复：kbId 必须原封不动（写成 null 就等于「用户选了库又被清掉」）。
    const second = r.setClawbotInstanceConfig({ slot: a.slot, autoReply: true })
    expect(second).toMatchObject({ autoReply: true, kbEnabled: true, kbId: 5 })
    // 脏值收敛：0 / 负数不是合法的库 id ⇒ null（而不是 0 这种「看起来指了个库」的值）。
    expect(r.setClawbotInstanceConfig({ slot: a.slot, kbId: 0 }).kbId).toBeNull()
    expect(r.setClawbotInstanceConfig({ slot: a.slot, kbId: -3 }).kbId).toBeNull()
    expect(() => r.setClawbotInstanceConfig({ slot: 42, autoReply: true }), '给不存在的实例写配置必须抛（否则造出永不生效的配置）').toThrow(/不存在/)
  })

  it('unbindClawbot 只动目标实例（另一个实例的绑定原样保留）', () => {
    const { rc } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    r.bindClawbotWechat({ wxid: 'user-a' }, credsOf('user-a'), a.slot)
    r.bindClawbotWechat({ wxid: 'user-b' }, credsOf('user-b'), b.slot)
    r.unbindClawbot({ slot: a.slot })
    expect(r.getClawbotBinding({ slot: a.slot }).binding.status).toBe('unbound-by-user')
    expect(r.getClawbotBinding({ slot: b.slot }).binding.status, '解绑 A 号把 B 号也解了').toBe('bound')
    expect(r.getClawbotBinding({ slot: b.slot }).binding.wxid).toBe('user-b')
  })
})

describe('通道与发送：按实例隔离', () => {
  it('两个实例各自的入站消息落在各自的会话里，互不串', async () => {
    const { rc, dir, ilink } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    // 每条通道第一轮给一批自己的消息，之后挂起（避免空转）。
    ilink.updatesImpl = (credentials) => {
      const n = ilink.updateCounts.get(credentials.ilinkUserId) ?? 0
      if (n === 1) return Promise.resolve(batchOf(`msg-from-${credentials.ilinkUserId}`, `buf-${credentials.ilinkUserId}`))
      return new Promise<IlinkUpdates>(() => { /* 挂起 */ })
    }
    r.bindClawbotWechat({ wxid: 'user-a' }, credsOf('user-a'), a.slot)
    r.bindClawbotWechat({ wxid: 'user-b' }, credsOf('user-b'), b.slot)
    await settle()

    const listA = r.listClawbotMessages({ slot: a.slot }).items.map(m => m.content)
    const listB = r.listClawbotMessages({ slot: b.slot }).items.map(m => m.content)
    expect(listA).toEqual(['msg-from-user-a'])
    expect(listB).toEqual(['msg-from-user-b'])
    // 反向：A 的列表里不许出现 B 的正文（串号就是在这里发生的）。
    expect(listA.join('|')).not.toContain('user-b')
    expect(listB.join('|')).not.toContain('user-a')
    // 游标也各存一份：共用一个游标会让一个号把另一个号的进度当成自己的（表现为「漏消息」）。
    expect(readBindingInternal(dir, a.slot).syncBuf).toBe('buf-user-a')
    expect(readBindingInternal(dir, b.slot).syncBuf).toBe('buf-user-b')
  })

  it('sendClawbotMessage({ slot }) 用那个实例的凭证与令牌（发错号最难查）', async () => {
    const { rc, dir, ilink } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    r.bindClawbotWechat({ wxid: 'user-a' }, credsOf('user-a'), a.slot)
    r.bindClawbotWechat({ wxid: 'user-b' }, credsOf('user-b'), b.slot)
    saveSendContextToken(dir, 'tok-a', a.slot)
    saveSendContextToken(dir, 'tok-b', b.slot)

    const sent = await r.sendClawbotMessage({ text: 'hi', slot: b.slot })
    expect(sent.ok, `向实例 B 发送应当成功：${sent.error ?? ''}`).toBe(true)
    expect(ilink.sendCalls).toEqual([{ toUserId: 'user-b', text: 'hi', contextToken: 'tok-b' }])
    // 落库也要落在 b 的会话里。
    expect(r.listClawbotMessages({ slot: b.slot }).items.map(m => m.content)).toEqual(['hi'])
    expect(r.listClawbotMessages({ slot: a.slot }).items).toEqual([])

    // 缺省（不传 slot）走第一个实例 —— 不是「最后一个碰过的实例」。
    const sentDefault = await r.sendClawbotMessage({ text: 'yo' })
    expect(sentDefault.ok).toBe(true)
    expect(ilink.sendCalls[1]).toEqual({ toUserId: 'user-a', text: 'yo', contextToken: 'tok-a' })
  })

  it('checkClawbotEnv 读的是目标实例的通道状态', () => {
    const { rc } = makeHarness()
    const r = createClawbotRemotes(rc)
    const a = r.createClawbotInstance()
    const b = r.createClawbotInstance()
    r.bindClawbotWechat({ wxid: 'user-a' }, credsOf('user-a'), a.slot)
    // b 未绑定 ⇒ 自检里「集成状态」是警告；a 已绑定且通道已起 ⇒ ok。
    const envA = r.checkClawbotEnv({ slot: a.slot })
    const envB = r.checkClawbotEnv({ slot: b.slot })
    expect(envA.items.find(i => i.key === 'channel')?.detail).toBe('接收中（长轮询）')
    expect(envB.items.find(i => i.key === 'binding')?.state).toBe('warn')
  })
})

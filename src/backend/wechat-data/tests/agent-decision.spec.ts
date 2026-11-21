/**
 * AI 队友决策与本机账本。
 *
 * 这些断言对应调研报告里的硬门槛：静默和紧急停止不发、群聊夹带知识库先草稿、
 * 无事发生不主动开口、同一事件不重复提案、记忆冲突不静默覆盖。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMisfire,
  classifyToolError,
  consumeApproval,
  decideProposal,
  degradeToText,
  deliveryKey,
  evaluateOutbound,
  eventKey,
  expectedUtility,
  governToolResult,
  inQuietHours,
  messageKey,
  planMemoryWrite,
  reconcileCounts,
  serviceWindowOpen,
  shouldRetryTool,
  toolIdempotencyKey,
  type OutboundFacts,
} from '../src/query/agent/decision.ts'
import {
  addAgentPromise,
  deleteAgentMemory,
  listAgentMemories,
  listAgentProposals,
  readAgentReconcile,
  runAgentTick,
  saveAgentControl,
  setProposalStatus,
  writeAgentMemory,
} from '../src/query/agent/store.ts'
import { assessReplyOutbound, rememberReplySent } from '../src/query/agent/reply-gate.ts'

function facts(patch: Partial<OutboundFacts> = {}): OutboundFacts {
  return {
    killed: false,
    quietStart: '',
    quietEnd: '',
    hour: 10,
    minute: 0,
    cooldownMs: 0,
    lastSentAt: 0,
    nowMs: 1_000_000,
    hourCount: 0,
    hourCap: 80,
    dayCount: 0,
    dayCap: 400,
    group: false,
    kbEnabled: false,
    proactive: false,
    shadow: true,
    recipientIsSelf: false,
    triggerTrusted: false,
    channel: 'generic',
    hasAttachment: false,
    handoff: false,
    ...patch,
  }
}

describe('发送闸', () => {
  it('默认的单聊回复允许发送', () => {
    expect(evaluateOutbound(facts()).action).toBe('send')
  })

  it('紧急停止、静默、冷却和额度都会把回复推迟，而不是丢掉', () => {
    expect(evaluateOutbound(facts({ killed: true })).reasonCode).toBe('kill_switch')
    expect(evaluateOutbound(facts({ handoff: true })).reasonCode).toBe('handoff')
    expect(evaluateOutbound(facts({ quietStart: '22:00', quietEnd: '07:00', hour: 23 })).action).toBe('defer')
    expect(evaluateOutbound(facts({ quietStart: '22:00', quietEnd: '07:00', hour: 6, minute: 59 })).action).toBe('defer')
    expect(evaluateOutbound(facts({ quietStart: '22:00', quietEnd: '07:00', hour: 7 })).action).toBe('send')
    expect(evaluateOutbound(facts({ cooldownMs: 60_000, lastSentAt: 990_000, nowMs: 1_000_000 })).reasonCode).toBe('cooldown')
    expect(evaluateOutbound(facts({ hourCount: 80, hourCap: 80 })).reasonCode).toBe('hour_budget')
  })

  it('跨午夜的静默时段在中午不生效', () => {
    expect(inQuietHours('22:00', '07:00', 12, 0)).toBe(false)
    expect(inQuietHours('09:00', '18:00', 9, 0)).toBe(true)
    expect(inQuietHours('09:00', '18:00', 18, 0)).toBe(false)
  })

  it('群聊同时使用知识库时留草稿', () => {
    const decision = evaluateOutbound(facts({ group: true, kbEnabled: true }))
    expect(decision.action).toBe('hold')
    expect(decision.reasonCode).toBe('rule_of_two')
  })

  it('主动消息在影子模式下不直接发送', () => {
    expect(evaluateOutbound(facts({
      proactive: true,
      shadow: true,
      triggerTrusted: true,
      recipientIsSelf: true,
    })).action).toBe('hold')
  })

  it('/send/text 遇到附件时不静默丢件', () => {
    expect(evaluateOutbound(facts({
      channel: 'feather-text',
      hasAttachment: true,
    })).reasonCode).toBe('capability')
  })

  it('Webhook 发送不看客服窗口，文本降级去掉 Markdown', () => {
    expect(serviceWindowOpen('feather-webhook').reason).toContain('Webhook')
    expect(serviceWindowOpen('feather-webhook').open).toBe(true)
    expect(degradeToText('## 标题\n- 一项\n看[这里](https://example.com)')).toBe('标题\n一项\n看这里')
  })
})

describe('记忆、提案和工具', () => {
  it('相同事实不重复写入，冲突时两边都保留', () => {
    const first = planMemoryWrite([], {
      scope: 'user',
      scopeKey: 'wxid',
      kind: 'profile',
      text: '喜欢短回复',
    })
    expect(first.op).toBe('ADD')
    const again = planMemoryWrite([{
      id: 1,
      scope: 'user',
      scopeKey: 'wxid',
      kind: 'profile',
      text: '喜欢短回复',
      status: 'active',
    }], {
      scope: 'user',
      scopeKey: 'wxid',
      kind: 'profile',
      text: '喜欢短回复',
    })
    expect(again.op).toBe('NOOP')
    const clash = planMemoryWrite([{
      id: 1,
      scope: 'user',
      scopeKey: 'wxid',
      kind: 'profile',
      text: '喜欢短回复',
      status: 'active',
    }], {
      scope: 'user',
      scopeKey: 'wxid',
      kind: 'profile',
      text: '喜欢长解释',
    })
    expect(clash.status).toBe('disputed')
    expect(clash.disputeId).toBe(1)
  })

  it('无事发生、重复事件和低置信度都不会发到聊天主线程', () => {
    const base = {
      duplicate: false,
      killed: false,
      quiet: false,
      nothingHappened: false,
      needProb: 0.8,
      value: 3,
      acceptProb: 0.5,
      interruptCost: 1,
      ignoreCost: 0.2,
      computeCost: 0.1,
      ageHours: 0,
      decay: 0.1,
      threshold: 0.2,
      confidence: 0.9,
      hourCount: 0,
      hourCap: 1,
      shadow: true,
      triggerTrusted: true,
      recipientIsSelf: true,
    }
    expect(decideProposal({ ...base, nothingHappened: true }).decision).toBe('drop')
    expect(decideProposal({ ...base, duplicate: true }).reasonCode).toBe('duplicate_event')
    expect(decideProposal({ ...base, confidence: 0.2 }).decision).toBe('hold')
    expect(decideProposal(base).decision).toBe('hold')
    expect(decideProposal({ ...base, shadow: false }).decision).toBe('send')
    expect(expectedUtility(base)).toBeGreaterThan(0)
  })

  it('日报错过就跳过，提醒只补跑一次；对账差额必须能算出来', () => {
    expect(applyMisfire('run_once', 60_000, 'digest')).toBe('skip')
    expect(applyMisfire('run_once', 60_000, 'reminder')).toBe('run')
    expect(applyMisfire('run_once', 7 * 60 * 60 * 1000, 'reminder')).toBe('skip')
    expect(reconcileCounts(3, 2, 1)).toEqual({ ok: true, delta: 0 })
    expect(reconcileCounts(3, 1, 1).ok).toBe(false)
  })

  it('工具错误只有暂时失败和限流可以重试，审批不能改参数重放', () => {
    expect(shouldRetryTool(classifyToolError(429))).toBe(true)
    expect(shouldRetryTool(classifyToolError(500))).toBe(true)
    expect(shouldRetryTool(classifyToolError(400))).toBe(false)
    expect(governToolResult('x'.repeat(120), 80, 'art-1')).toMatchObject({ truncated: true, artifactId: 'art-1' })
    expect(consumeApproval('approved', 'a', 'a')).toBe('consumed')
    expect(consumeApproval('approved', 'a', 'b')).toBe('reject')
    expect(consumeApproval('consumed', 'a', 'a')).toBe('reject')
  })

  it('传输层 eventId 不进入业务幂等键', () => {
    expect(messageKey('wechat', 'wxid', 'm1')).not.toContain('evt-platform')
    expect(deliveryKey({ channel: 'feather', account: 'wxid', outboundId: 'out-1' })).toContain('delivery:')
    expect(toolIdempotencyKey('run', 'call')).toBe('run:call')
    expect(toolIdempotencyKey('', 'call')).toBe('')
    expect(eventKey('promise', '9', 'due')).toBe('event:promise:9:due')
  })
})

describe('本机账本', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function decrypted(): string {
    const root = mkdtempSync(join(tmpdir(), 'agent-desk-'))
    dirs.push(root)
    return join(root, 'decrypted')
  }

  it('记忆可写可删，同一句话不会记两次', () => {
    const dir = decrypted()
    expect(writeAgentMemory(dir, {
      accountKey: 'wxid',
      scope: 'user',
      scopeKey: 'wxid',
      kind: 'profile',
      text: '称呼我为阿陈',
    }).op).toBe('ADD')
    expect(writeAgentMemory(dir, {
      accountKey: 'wxid',
      scope: 'user',
      scopeKey: 'wxid',
      kind: 'profile',
      text: '称呼我为阿陈',
    }).op).toBe('NOOP')
    expect(listAgentMemories(dir, 'wxid')).toHaveLength(1)
    const id = listAgentMemories(dir, 'wxid')[0]?.id ?? 0
    expect(deleteAgentMemory(dir, 'wxid', id)).toBe(true)
    expect(listAgentMemories(dir, 'wxid')).toHaveLength(0)
  })

  it('紧急停止会让回复闸推迟，额度用完后同样推迟', () => {
    const dir = decrypted()
    saveAgentControl(dir, { killed: true })
    expect(assessReplyOutbound(dir, {
      accountKey: 'wxid',
      chatUsername: 'friend',
      group: false,
      kbEnabled: false,
      phase: 'preflight',
    }).action).toBe('defer')
    saveAgentControl(dir, { killed: false, hourCap: 1 })
    rememberReplySent(dir, 'wxid', 'friend')
    expect(assessReplyOutbound(dir, {
      accountKey: 'wxid',
      chatUsername: 'friend',
      group: false,
      kbEnabled: false,
      phase: 'preflight',
    }).reasonCode).toBe('hour_budget')
  })

  it('到期承诺只生成一条提案，再跑一拍不会重复', () => {
    const dir = decrypted()
    saveAgentControl(dir, { shadow: true })
    expect(addAgentPromise(dir, 'wxid', '把报价发给对方', Date.now() - 1000)).toBe(true)
    const first = runAgentTick(dir, 'wxid')
    const second = runAgentTick(dir, 'wxid')
    expect(first.created).toBeGreaterThan(0)
    expect(second.created).toBe(0)
    const proposals = listAgentProposals(dir, 'wxid')
    expect(proposals.some((item) => item.body.includes('报价'))).toBe(true)
    expect(proposals.every((item) => item.decision !== 'send')).toBe(true)
    const id = proposals.find((item) => item.status === 'open')?.id ?? 0
    expect(setProposalStatus(dir, 'wxid', id, 'accepted')).toBe(true)
    expect(readAgentReconcile(dir).delta).toBe(0)
  })
})

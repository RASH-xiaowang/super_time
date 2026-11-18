// @vitest-environment node
/**
 * 会话级「上下文时间窗」。
 *
 * 锁四件事：
 *  ① 窗口起点以**触发消息时间**为基准（不是「现在」）；
 *  ② 窗口外的消息整条不进上下文（正文/图片/语音一起排除）；
 *  ③ 设置能存、能读、能被 revision 保护，越界值夹紧；
 *  ④ 时间窗与「最近 60 条」「token 预算」是叠加关系，不是替代。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHAT_AI_REPLY_CONTEXT_WINDOW_MAX_HOURS,
  normalizeContextWindowHours,
  readChatAiReplyState,
  saveChatAiReplyPersona,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import { contextWindowStart } from '../src/query/ai-reply/runner-generate.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-window-'))
  decrypted = join(root, 'data', 'decrypted')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('窗口起点换算', () => {
  it('以触发消息时间为基准，而不是当前时间', () => {
    const anchor = 1_800_000_000
    expect(contextWindowStart(anchor, 3)).toBe(anchor - 3 * 3600)
    expect(contextWindowStart(anchor, 24)).toBe(anchor - 24 * 3600)
  })

  it('未设置/非法值时不做时间过滤（返回 0）', () => {
    expect(contextWindowStart(1_800_000_000, 0)).toBe(0)
    expect(contextWindowStart(1_800_000_000, undefined)).toBe(0)
    expect(contextWindowStart(1_800_000_000, Number.NaN)).toBe(0)
    expect(contextWindowStart(1_800_000_000, -5)).toBe(0)
  })

  it('锚点时间不可信时退回不过滤，而不是算出负数窗口', () => {
    expect(contextWindowStart(0, 6)).toBe(0)
    expect(contextWindowStart(60, 24)).toBe(0)
  })
})

describe('时间窗归一化', () => {
  it('0 表示不限，正数按小时夹紧到 30 天上限', () => {
    expect(normalizeContextWindowHours(0)).toBe(0)
    expect(normalizeContextWindowHours(3)).toBe(3)
    expect(normalizeContextWindowHours(7.8)).toBe(7)
    expect(normalizeContextWindowHours(-2)).toBe(0)
    expect(normalizeContextWindowHours('abc')).toBe(0)
    expect(normalizeContextWindowHours(10_000)).toBe(CHAT_AI_REPLY_CONTEXT_WINDOW_MAX_HOURS)
  })
})

describe('会话级设置读写（单聊与群聊同一套）', () => {
  it.each([
    ['单聊', 'wxid_peer', '小王'],
    ['群聊', 'room@chatroom', '测试群'],
  ])('%s 能保存并读回上下文时间窗', (_kind, chatUsername, chatName) => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername,
      chatName,
      enabled: true,
      provider: 'dsh-wechat-bridge',
      contextWindowHours: 12,
    }).ok).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', chatUsername).contextWindowHours).toBe(12)
  })

  it('通过人格保存入口设置时间窗，并且默认不限', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').contextWindowHours).toBe(0)

    const saved = saveChatAiReplyPersona(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      personaName: '',
      personaPrompt: '',
      contextWindowHours: 6,
      expectedRevision: readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').revision,
    })
    expect(saved.ok, saved.ok ? '' : saved.error).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').contextWindowHours).toBe(6)
  })

  it('切换开关不会把已有时间窗改回默认（省略即保留）', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      contextWindowHours: 72,
    }).ok).toBe(true)
    // 关闭再打开，都不传该字段。
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: false,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').contextWindowHours).toBe(72)
  })

  it('越界值在写入时就被夹紧', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      contextWindowHours: 99_999,
    }).ok).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').contextWindowHours)
      .toBe(CHAT_AI_REPLY_CONTEXT_WINDOW_MAX_HOURS)
  })
})

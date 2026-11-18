// @vitest-environment node
/**
 * AI 回复上下文的装配接线。
 *
 * 预算算法本身在 `chat-ai-reply-context-budget.spec.ts` 里单测；这里钉住
 * `collectChatAiReplyContext` 没有把结构化条目又退回旧口径：
 *   · 时间标记、省略行、头尾截断都真的进了提示词；
 *   · `count` / `stats` 如实反映「模型实际看到几条」；
 *   · 图片按解码上限预留 token，不会被窗口里几十条视觉消息挤爆正文预算。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const collectEntries = vi.hoisted(() => vi.fn())

vi.mock('../src/query/reply-suggest.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/query/reply-suggest.ts')>()
  return { ...actual, collectReplyContextEntries: collectEntries }
})

import {
  AI_REPLY_CONTEXT_LIMIT,
  AI_REPLY_IMAGE_LIMIT,
  buildChatAiReplyPrompt,
  collectChatAiReplyContext,
} from '../src/query/ai-reply/context.ts'
import type { ReplyContextEntry } from '../src/query/reply-suggest.ts'

function at(hour: number, minute: number, day = 17): number {
  // 用本地时间构造，格式化也按本地时区，测试不依赖运行机器的时区。
  return Math.floor(new Date(2026, 10, day, hour, minute).getTime() / 1000)
}

function entry(over: Partial<ReplyContextEntry>): ReplyContextEntry {
  return {
    localId: 1,
    createTime: at(9, 0),
    isSender: false,
    speaker: '对方',
    text: '你好',
    ...over,
  }
}

function respond(
  entries: ReplyContextEntry[],
  imageCandidates?: Array<{ localId: number }>,
  voiceCandidates?: number[],
): void {
  collectEntries.mockReturnValue({
    entries,
    ...(imageCandidates === undefined ? {} : { imageCandidates }),
    ...(voiceCandidates === undefined ? {} : { voiceCandidates }),
    latestPeer: entries[entries.length - 1]?.text ?? '',
    count: entries.length,
    targetLine: entries.length === 0
      ? ''
      : `${entries[entries.length - 1]?.speaker ?? ''}：${entries[entries.length - 1]?.text ?? ''}`,
  })
}

beforeEach(() => {
  collectEntries.mockReset()
})

describe('AI 回复上下文装配', () => {
  it('每条对话都带自己的时间，统计与实际纳入条数一致', () => {
    respond([
      entry({ localId: 1, createTime: at(9, 0), text: '早上好' }),
      entry({ localId: 2, createTime: at(9, 1), isSender: true, speaker: '我', text: '早呀' }),
      entry({ localId: 3, createTime: at(10, 30), text: '报价多少' }),
    ])

    const context = collectChatAiReplyContext('decrypted', 'wxid_peer', 'wxid_self', 3)

    expect(collectEntries).toHaveBeenCalledWith(
      'decrypted',
      'wxid_peer',
      'wxid_self',
      AI_REPLY_CONTEXT_LIMIT,
      3,
      // 没设时间窗时起点为 0（不做时间过滤）。
      0,
    )
    expect(context.lines).toEqual([
      '[2026-11-17 09:00] 对方：早上好',
      '[2026-11-17 09:01] 我：早呀',
      '[2026-11-17 10:30] 对方：报价多少',
    ])
    expect(context.count).toBe(3)
    expect(context.stats).toMatchObject({
      collected: 3,
      included: 3,
      dropped: 0,
      truncated: false,
      peerIncluded: 2,
      selfIncluded: 1,
    })
    expect(context.prompt).toContain('对方：报价多少')
    expect(context.prompt).toContain('[年-月-日 时:分]')
  })

  it('图片只保留预算窗口内、最近 3 张，窗口外的历史图片不会出网', () => {
    respond(
      Array.from({ length: 10 }, (_, index) => entry({
        localId: index + 1,
        createTime: at(9, 0) + index,
        text: `看图 ${String(index + 1)}`,
      })),
      Array.from({ length: 10 }, (_, index) => ({ localId: index + 1 })),
    )

    const context = collectChatAiReplyContext('decrypted', 'wxid_peer', 'wxid_self')

    expect(context.imageCandidates?.map((candidate) => candidate.localId))
      .toEqual([8, 9, 10])
    expect(context.stats?.imageCount).toBe(AI_REPLY_IMAGE_LIMIT)
  })

  it('知识库检索只拿正文行，时间标记与省略行不进入检索词', () => {
    respond([
      entry({ localId: 1, createTime: at(9, 0), text: '早上好' }),
      entry({ localId: 2, createTime: at(11, 0), isSender: true, speaker: '我', text: '早' }),
      entry({ localId: 3, createTime: at(13, 0), text: '报价多少' }),
    ])

    const context = collectChatAiReplyContext('decrypted', 'wxid_peer', 'wxid_self')

    expect(context.lines.some((line) => line.startsWith('[2026-11-17'))).toBe(true)
    expect(context.dialogueLines).toEqual([
      '对方：早上好',
      '我：早',
      '对方：报价多少',
    ])
  })

  it('长消息保留开头和结尾，不再只留下头部', () => {
    const text = '开头：合同总价 120 元。' + '中间铺垫。'.repeat(200) + '结尾：周五前回复。'
    respond([entry({ localId: 1, text })])

    const context = collectChatAiReplyContext('decrypted', 'wxid_peer', 'wxid_self')

    expect(context.prompt).toContain('开头：合同总价 120 元。')
    expect(context.prompt).toContain('结尾：周五前回复。')
    expect(context.stats?.shortened).toBe(1)
  })

  it('超出预算时从最旧端连续裁剪，并明确标注历史被省略', () => {
    respond(Array.from({ length: 60 }, (_, index) => entry({
      localId: index + 1,
      createTime: at(9, 0) + index,
      isSender: index % 3 === 1,
      speaker: index % 3 === 1 ? '我' : '对方',
      text: `第 ${String(index + 1)} 条：` + '这是一段比较长的对话内容。'.repeat(10),
    })))

    const context = collectChatAiReplyContext('decrypted', 'wxid_peer', 'wxid_self')

    expect(context.stats?.collected).toBe(60)
    expect(context.stats?.dropped).toBeGreaterThan(0)
    expect(context.stats?.truncated).toBe(true)
    expect(context.count).toBe(context.stats?.included)
    expect(context.lines[0]).toBe('（更早的对话已省略）')
    expect(context.prompt).toContain('第 60 条：')
  })

  it('提示词说明时间的语义，图片附注与实际文案一致', () => {
    const prompt = buildChatAiReplyPrompt(['[2026-11-17 09:00]', '对方：在吗'], 2)

    expect(prompt).toContain('行首的时间只用于判断时效和语气')
    expect(prompt).toContain('本次随请求附带 2 张最近的图片或表情')
  })

  it('语音：没转写时交回 localId，转写后正文替换成「[语音]文本」', () => {
    respond([
      entry({ localId: 1, createTime: at(9, 0), text: '[语音]', voice: true }),
      entry({ localId: 2, createTime: at(9, 1), isSender: true, speaker: '我', text: '好' }),
      entry({ localId: 3, createTime: at(9, 2), text: '[语音]', voice: true }),
    ], undefined, [1, 3])

    const plain = collectChatAiReplyContext('decrypted', 'wxid_peer', 'wxid_self')
    expect(plain.voiceCandidates).toEqual([1, 3])
    expect(plain.lines).toContain('[2026-11-17 09:00] 对方：[语音]')

    const transcribed = collectChatAiReplyContext(
      'decrypted',
      'wxid_peer',
      'wxid_self',
      undefined,
      new Map([[1, '我到了'], [3, '马上下来']]),
    )
    expect(transcribed.lines).toEqual([
      '[2026-11-17 09:00] 对方：[语音]我到了',
      '[2026-11-17 09:01] 我：好',
      '[2026-11-17 09:02] 对方：[语音]马上下来',
    ])
    // 已转写的不再要求上层重复转写。
    expect(transcribed.voiceCandidates).toBeUndefined()
  })

  it('语音转写只交回最终窗口里的条数，窗口外不为转写付费', () => {
    respond(
      Array.from({ length: 60 }, (_, index) => entry({
        localId: index + 1,
        createTime: at(9, 0) + index,
        text: '[语音]' + '很长的正文。'.repeat(40),
        voice: true,
      })),
      undefined,
      Array.from({ length: 60 }, (_, index) => index + 1),
    )

    const context = collectChatAiReplyContext('decrypted', 'wxid_peer', 'wxid_self')
    expect(context.stats?.truncated).toBe(true)
    expect(context.voiceCandidates?.length).toBeLessThanOrEqual(5)
    // 一定是最新的那几条（升序、落到最终窗口里的尾部）。
    expect(context.voiceCandidates?.at(-1)).toBe(60)
  })
})

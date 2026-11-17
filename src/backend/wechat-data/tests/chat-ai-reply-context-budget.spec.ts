// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ReplyContextEntry } from '../src/query/reply-suggest.ts'
import {
  AI_REPLY_IMAGE_TOKEN_ESTIMATE,
  AI_REPLY_MIN_RECENT_ENTRIES,
  assembleChatAiReplyContext,
  estimateChatAiReplyTokens,
  shortenChatAiReplyLine,
} from '../src/query/ai-reply/context-budget.ts'

const BASE_TIME = new Date(2026, 10, 17, 9, 30).getTime() / 1000
const OMITTED_LINE = '（更早的对话已省略）'

let nextLocalId = 1

/** 造一条结构化上下文；默认是同一时段的一条对方文本。 */
function makeEntry(overrides: Partial<ReplyContextEntry> = {}): ReplyContextEntry {
  return {
    localId: nextLocalId++,
    createTime: BASE_TIME,
    isSender: false,
    speaker: '对方',
    text: '你好',
    ...overrides,
  }
}

/** 去掉时间标记与省略行，只留正文行。 */
function bodyLines(lines: readonly string[]): string[] {
  return lines.filter((line) =>
    line !== OMITTED_LINE && !/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/.test(line))
}

/** 字符串里是否存在落单的 UTF-16 代理项（被劈开的 emoji 会命中）。 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return true
      const next = value.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('AI 回复上下文 token 估算', () => {
  it('纯中文高于同长度 ASCII，空串为 0', () => {
    expect(estimateChatAiReplyTokens('')).toBe(0)
    // ASCII 按 3 字符≈1 token 保守估算，避免纯英文/URL 被明显低估。
    expect(estimateChatAiReplyTokens('abc')).toBe(1)
    expect(estimateChatAiReplyTokens('abcd')).toBe(2)
    expect(estimateChatAiReplyTokens('abcde')).toBe(2)
    expect(estimateChatAiReplyTokens('你好世界')).toBeGreaterThan(
      estimateChatAiReplyTokens('abcd'),
    )
    expect(estimateChatAiReplyTokens('中a')).toBe(2)
    expect(estimateChatAiReplyTokens('😀😀')).toBe(2)
  })

  it('空白也计入 ASCII 累计，不会得到 0', () => {
    expect(estimateChatAiReplyTokens('   ')).toBe(1)
  })
})

describe('AI 回复单条头尾截断', () => {
  it('同时保留开头和结尾，总长不超限', () => {
    const source = `开头${'中间内容'.repeat(40)}结尾`
    const result = shortenChatAiReplyLine(source, 24)
    const chars = Array.from(result.text)

    expect(result.shortened).toBe(true)
    expect(chars.length).toBeLessThanOrEqual(24)
    expect(result.text.startsWith('开头')).toBe(true)
    expect(result.text.endsWith('结尾')).toBe(true)
    expect(result.text.split('…')).toHaveLength(2)
  })

  it('按 code point 切，不劈开 emoji 代理对', () => {
    const result = shortenChatAiReplyLine('😀'.repeat(40), 9)

    expect(result.shortened).toBe(true)
    expect(result.text).toContain('…')
    expect(hasLoneSurrogate(result.text)).toBe(false)
    expect(Array.from(result.text).every((char) => char === '😀' || char === '…')).toBe(true)
    expect(Array.from(result.text).length).toBeLessThanOrEqual(9)
  })

  it('先压平空白；未超限时原样返回', () => {
    expect(shortenChatAiReplyLine('  你好\n\n世界  ', 100)).toEqual({
      text: '你好 世界',
      shortened: false,
    })
  })
})

describe('AI 回复上下文预算装配', () => {
  it('超预算时丢弃最旧一段并出现省略行，统计自洽', () => {
    const entries = Array.from({ length: 12 }, (_, i) => makeEntry({
      text: `第${String(i)}条${'很长的正文'.repeat(80)}`,
    }))
    const result = assembleChatAiReplyContext(entries, {
      tokenBudget: 150,
      minRecent: 1,
      minPeer: 0,
      minSelf: 0,
      maxLineChars: 100,
    })

    expect(result.lines[0]).toBe(OMITTED_LINE)
    expect(result.stats.collected).toBe(12)
    expect(result.stats.included).toBe(1)
    expect(result.stats.dropped).toBe(11)
    expect(result.stats.truncated).toBe(true)
    expect(result.stats.shortened).toBe(1)
    expect(result.stats.peerIncluded + result.stats.selfIncluded).toBe(result.stats.included)
    expect(bodyLines(result.lines)).toHaveLength(result.stats.included)
    expect(bodyLines(result.lines)[0]).toContain('第11条')
    expect(result.stats.estimatedTokens).toBe(
      result.lines.reduce((sum, line) => sum + estimateChatAiReplyTokens(line), 0),
    )
    // 最新一条即使自己就超预算也必须留下。
    expect(result.stats.included).toBeGreaterThanOrEqual(1)
    expect(bodyLines(result.lines).at(-1)).toContain('第11条')
  })

  it('预算极小时也保留最新 minRecent 条（默认与自定义）', () => {
    const entries = Array.from({ length: 12 }, (_, i) => makeEntry({
      text: `最近第${String(i)}条`,
    }))
    const defaults = assembleChatAiReplyContext(entries, {
      tokenBudget: 1,
      minPeer: 0,
      minSelf: 0,
    })
    const custom = assembleChatAiReplyContext(entries, {
      tokenBudget: 1,
      minRecent: 3,
      minPeer: 0,
      minSelf: 0,
    })

    expect(defaults.stats.included).toBe(AI_REPLY_MIN_RECENT_ENTRIES)
    expect(custom.stats.included).toBe(3)
    expect(bodyLines(custom.lines).at(-1)).toContain('最近第11条')
    expect(custom.stats.truncated).toBe(true)
  })

  it('对方/我条数不足时会突破软预算补齐最低条数', () => {
    const entries = Array.from({ length: 12 }, (_, i) => makeEntry({
      text: `第${String(i)}条`,
      isSender: i % 2 === 0,
      speaker: i % 2 === 0 ? '我' : '对方',
    }))
    const result = assembleChatAiReplyContext(entries, {
      tokenBudget: 12,
      minRecent: 1,
      minPeer: 2,
      minSelf: 2,
      hardOverrun: 10,
    })

    expect(result.stats.peerIncluded).toBeGreaterThanOrEqual(2)
    expect(result.stats.selfIncluded).toBeGreaterThanOrEqual(2)
    expect(result.stats.included).toBe(4)
    expect(result.stats.estimatedTokens).toBeGreaterThan(result.stats.tokenBudget)
  })

  it('纯对方窗口不会为凑「我」的最低条数扩到硬上限', () => {
    const entries = Array.from({ length: 30 }, (_, i) => makeEntry({
      text: `对方的第${String(i)}条${'很长的正文'.repeat(20)}`,
    }))
    const result = assembleChatAiReplyContext(entries, {
      tokenBudget: 100,
      minRecent: 2,
      minPeer: 4,
      minSelf: 2,
      maxLineChars: 100,
      hardOverrun: 10,
    })

    // 窗口里一条「我」都没有，self 目标应降为 0；补齐 4 条对方消息后停止，
    // 不能为了永远凑不齐的 self 一路扩到硬上限（1000 token）。
    expect(result.stats.selfIncluded).toBe(0)
    expect(result.stats.peerIncluded).toBe(4)
    expect(result.stats.included).toBe(4)
    expect(result.stats.estimatedTokens).toBeLessThan(600)
  })

  it('窗口里有「我」时，风格锚点不会被全部裁掉', () => {
    const entries = [
      makeEntry({ text: '更早的我', isSender: true, speaker: '我' }),
      ...Array.from({ length: 5 }, (_, i) => makeEntry({
        text: `对方的第${String(i)}条`,
      })),
    ]
    const result = assembleChatAiReplyContext(entries, {
      tokenBudget: 20,
      minRecent: 1,
      minPeer: 0,
      minSelf: 0,
      hardOverrun: 5,
    })

    expect(result.stats.selfIncluded).toBe(1)
    expect(result.stats.included).toBe(entries.length)
    expect(result.lines).toContain('我：更早的我')
  })
})

describe('AI 回复上下文时间标记', () => {
  it('跨天或间隔达到 30 分钟时加标记，同一时段不重复加', () => {
    const start = new Date(2026, 10, 17, 23, 40).getTime() / 1000
    const entries = [
      makeEntry({ createTime: start, text: '晚上好' }),
      makeEntry({ createTime: start + 600, text: '在吗' }),
      makeEntry({ createTime: start + 1200, text: '跨天了' }),
      makeEntry({ createTime: start + 1800, text: '十分钟后' }),
      makeEntry({ createTime: start + 3600, text: '半小时后' }),
    ]
    const result = assembleChatAiReplyContext(entries, {
      tokenBudget: 100_000,
      minRecent: entries.length,
      minPeer: 0,
      minSelf: 0,
    })

    expect(result.lines[0]).toBe('[2026-11-17 23:40]')
    expect(result.lines.filter((line) =>
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/.test(line))).toEqual([
      '[2026-11-17 23:40]',
      '[2026-11-18 00:00]',
      '[2026-11-18 00:40]',
    ])
    expect(bodyLines(result.lines)).toHaveLength(entries.length)
    expect(result.stats.included).toBe(entries.length)
  })

  it('没有有效时间戳时不加时间标记', () => {
    const result = assembleChatAiReplyContext([
      makeEntry({ createTime: 0, text: '无时间' }),
    ], {
      minPeer: 0,
      minSelf: 0,
    })

    expect(result.lines).toEqual(['对方：无时间'])
  })

  it('中间夹着缺失时间戳时，后一条有效时间仍会补标记', () => {
    const result = assembleChatAiReplyContext([
      makeEntry({ createTime: 0, text: '占位消息' }),
      makeEntry({ createTime: BASE_TIME, text: '有时间' }),
    ], {
      minPeer: 0,
      minSelf: 0,
    })

    expect(result.lines).toEqual([
      '对方：占位消息',
      '[2026-11-17 09:30]',
      '对方：有时间',
    ])
  })
})

describe('AI 回复上下文图片预留', () => {
  it('imageCount > 0 时更早裁剪文本，估算包含图片预留', () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry({
      text: `第${String(i)}条${'很长的正文'.repeat(50)}`,
    }))
    const plain = assembleChatAiReplyContext(entries, {
      tokenBudget: 1000,
      minRecent: 1,
      minPeer: 0,
      minSelf: 0,
    })
    const withImage = assembleChatAiReplyContext(entries, {
      tokenBudget: 1000,
      minRecent: 1,
      minPeer: 0,
      minSelf: 0,
      imageCount: 1,
    })

    expect(withImage.stats.included).toBeLessThan(plain.stats.included)
    expect(withImage.stats.imageCount).toBe(1)
    expect(withImage.stats.estimatedTokens).toBe(
      withImage.lines.reduce((sum, line) => sum + estimateChatAiReplyTokens(line), 0) +
      AI_REPLY_IMAGE_TOKEN_ESTIMATE,
    )
    expect(withImage.stats.estimatedTokens).toBeGreaterThanOrEqual(AI_REPLY_IMAGE_TOKEN_ESTIMATE)
  })
})

describe('AI 回复上下文输入保护', () => {
  it('不修改输入数组、条目和 options', () => {
    const entries: ReplyContextEntry[] = [
      makeEntry({
        localId: 1,
        text: '带图片的一条',
        image: { localId: 99, kind: 'sticker', md5: 'abc' },
      }),
      makeEntry({ localId: 2, createTime: BASE_TIME + 60, isSender: true, speaker: '我' }),
    ]
    for (const entry of entries) Object.freeze(entry)
    Object.freeze(entries)
    const options = Object.freeze({
      tokenBudget: 1000,
      minPeer: 0,
      minSelf: 0,
      imageCount: 1,
    })
    const entriesBefore = JSON.stringify(entries)
    const optionsBefore = JSON.stringify(options)

    const result = assembleChatAiReplyContext(entries, options)

    expect(result.stats.included).toBe(2)
    expect(JSON.stringify(entries)).toBe(entriesBefore)
    expect(JSON.stringify(options)).toBe(optionsBefore)
  })
})

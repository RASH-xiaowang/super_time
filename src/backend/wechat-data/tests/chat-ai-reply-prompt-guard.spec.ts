// @vitest-environment node
/**
 * 「同一个问题被反复回复」的两道防线。
 *
 * 现场故障：私聊里模型把几天前「我」交代过的事当成未完成待办，逐条追问/复述，
 * 读者看到的就是同一个问题被回复多次。两处防线在这里钉住：
 *  ① 上下文标出时间断层，断层之前只作背景；
 *  ② 提示词明确「我说过的已经发出去了，不要重复/追问」，寒暄就简短回应。
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_AI_REPLY_GAP_MARKER,
  CHAT_AI_REPLY_TIME_GAP_SECONDS,
  assembleChatAiReplyContext,
} from '../src/query/ai-reply/context-budget.ts'
import { buildChatAiReplyPrompt } from '../src/query/ai-reply/context.ts'
import type { ReplyContextEntry } from '../src/query/reply-suggest.ts'

function entry(
  localId: number,
  createTime: number,
  isSender: boolean,
  text: string,
): ReplyContextEntry {
  return {
    localId,
    createTime,
    isSender,
    speaker: isSender ? '我' : '对方',
    text,
  } as unknown as ReplyContextEntry
}

describe('上下文时间断层', () => {
  it('相邻消息间隔超过阈值时插入断层标记', () => {
    const day = 24 * 60 * 60
    const assembled = assembleChatAiReplyContext([
      entry(1, 1_700_000_000, false, '六天前的旧话题'),
      entry(2, 1_700_000_000 + day * 6, false, '你好'),
    ])
    expect(assembled.lines.filter((line) => line === CHAT_AI_REPLY_GAP_MARKER)).toHaveLength(1)
    // 断层是给模型看的，不参与检索：正文行里不能混进标记。
    expect(assembled.dialogueLines).not.toContain(CHAT_AI_REPLY_GAP_MARKER)
    expect(assembled.dialogueLines).toHaveLength(2)
  })

  it('连续对话（间隔小于阈值）不插标记', () => {
    const base = 1_700_000_000
    const assembled = assembleChatAiReplyContext([
      entry(1, base, false, '在吗'),
      entry(2, base + CHAT_AI_REPLY_TIME_GAP_SECONDS - 60, true, '在的'),
      entry(3, base + CHAT_AI_REPLY_TIME_GAP_SECONDS + 30, false, '帮我看下'),
    ])
    expect(assembled.lines).not.toContain(CHAT_AI_REPLY_GAP_MARKER)
  })

  it('断层标记本身计入 token 预算（不能白送上下文）', () => {
    const base = 1_700_000_000
    const withGap = assembleChatAiReplyContext([
      entry(1, base, false, '旧话题'),
      entry(2, base + 86_400, false, '新话题'),
    ], { tokenBudget: 10_000 })
    const withoutGap = assembleChatAiReplyContext([
      entry(1, base, false, '旧话题'),
      entry(2, base + 60, false, '新话题'),
    ], { tokenBudget: 10_000 })
    expect(withGap.lines).toContain(CHAT_AI_REPLY_GAP_MARKER)
    // 时间标签与正文完全一致，唯一差别就是那一行标记 ⇒ 预算必须更大。
    expect(withGap.stats.estimatedTokens).toBeGreaterThan(withoutGap.stats.estimatedTokens)
  })
})

describe('提示词约束', () => {
  it('明确禁止重复/追问「我」说过的话，并要求寒暄简短回应', () => {
    const prompt = buildChatAiReplyPrompt(['[2026-11-17 17:20] 我：安排老师登录丰田系统'], 0, 'private')
    expect(prompt).toContain('不要重复、不要改写、不要追问其中的事项')
    expect(prompt).toContain('只是寒暄、确认或结束语')
    expect(prompt).toContain('不要主动展开其它话题')
    // 断层标记的用法也要解释，否则模型会把标记当成一句人话。
    expect(prompt).toContain('与本条没有直接关系')
  })

  it('群聊仍保留「只有 @ 我 才回复」的说明', () => {
    const prompt = buildChatAiReplyPrompt(['[2026-11-18 16:00] 对方：@我 报价多少'], 0, 'group')
    expect(prompt).toContain('只有 @ 我的消息才会触发你回复')
    expect(prompt).toContain('替“我”写一条可以发在群里的话')
  })
})

/**
 * 两模块角色/人称回归：手动问答与会话问答、提问优化器。
 *
 * 这些文本直接进入模型，必须区分「AI 回答者/提问者」和「账号本人/聊天联系人」两套身份；
 * 自定义提示词也不能绕过固定规则。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  ASK_OPTIMIZE_SYSTEM_PROMPT,
  MANUAL_QA_PERSONA_MARKER,
  WECHAT_QA_SYSTEM_PROMPT,
  conversationRoleLabel,
  formatConversationHistory,
  withManualQaPersonaRules,
} from '../src/query/answer-runtime/persona.ts'
import {
  buildSynthesisPrompt,
  resolveSystemPrompt,
} from '../src/remotes/ask-runtime-prompt.ts'

describe('微信问答 / 会话内 AI 问答：回答者与提问者绑定', () => {
  it('系统提示词写清第一、第二、第三人称各自指谁', () => {
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('第一人称「我」在回答中只指 AI 回答者')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('第二人称统一用「你」指当前提问者，不用「您」')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('第三人称「他 / 她 / 他们 / 她们」只指前文已经明确的第三方')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('「它」只指非人对象')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('多个可能对象')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('「我们」不得泛指 AI 回答者与当前提问者')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('提问者输入的「您」仍按第二人称理解')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('「这个 / 那个 / 它」')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('不要称其为「用户」')
    expect(WECHAT_QA_SYSTEM_PROMPT).not.toContain('您好')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('先给一句直接结论')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('2-4 条关键事实')
    expect(WECHAT_QA_SYSTEM_PROMPT).toContain('按消息逐条倾倒记录')
  })

  it('自定义问答提示词会追加固定规则，且重复调用不叠加', () => {
    const once = withManualQaPersonaRules('自定义人设：保持简洁')
    expect(once).toContain('自定义人设：保持简洁')
    expect(once).toContain(MANUAL_QA_PERSONA_MARKER)
    expect(withManualQaPersonaRules(once)).toBe(once)
  })

  it('手动问答默认与自定义提示词共用同一套角色规则', () => {
    expect(resolveSystemPrompt(undefined)).toBe(WECHAT_QA_SYSTEM_PROMPT)
    expect(resolveSystemPrompt('')).toBe(WECHAT_QA_SYSTEM_PROMPT)
    const custom = resolveSystemPrompt('只答材料')
    expect(custom).toContain('只答材料')
    expect(custom).toContain(MANUAL_QA_PERSONA_MARKER)
  })

  it('历史消息使用提问者/AI 回答者标签，不把内部角色写成用户/助手', () => {
    const history = [
      { role: 'user' as const, content: '小何说的报价是多少？' },
      { role: 'assistant' as const, content: '小何说本周五前给。' },
    ]
    expect(conversationRoleLabel('user')).toBe('提问者')
    expect(conversationRoleLabel('assistant')).toBe('AI 回答者')
    expect(formatConversationHistory(history)).toBe('提问者：小何说的报价是多少？\nAI 回答者：小何说本周五前给。')
    const prompt = buildSynthesisPrompt({
      question: '他后来确认了吗？',
      history,
      imageHint: '',
      contextBlock: '材料',
      timeGuardRule: '',
    })
    expect(prompt).toContain('提问者本次问题：他后来确认了吗？')
    expect(prompt).toContain('提问者：')
    expect(prompt).toContain('AI 回答者：')
    expect(prompt).not.toContain('用户：')
    expect(prompt).not.toContain('助手：')
    expect(prompt).toContain('身份或指代不明先澄清')
  })
})

describe('提问优化器：保留提问者视角', () => {
  it('只改写问题，不把提问者改写成用户或助手', () => {
    expect(ASK_OPTIMIZE_SYSTEM_PROMPT).toContain('保持提问者的第一人称视角')
    expect(ASK_OPTIMIZE_SYSTEM_PROMPT).toContain('不得改写成 AI 回答者视角')
    expect(ASK_OPTIMIZE_SYSTEM_PROMPT).toContain('直接对提问者说「你」')
    expect(ASK_OPTIMIZE_SYSTEM_PROMPT).toContain('不要替提问者猜')
    expect(ASK_OPTIMIZE_SYSTEM_PROMPT).not.toContain('您好')
  })
})

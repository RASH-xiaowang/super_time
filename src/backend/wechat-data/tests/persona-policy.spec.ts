/**
 * 三模块角色/人称回归：手动问答、ClawBot 自动回复、提问优化器。
 *
 * 这些文本直接进入模型，必须区分「AI 回答者/提问者」和「账号本人/聊天联系人」两套身份；
 * 自定义提示词也不能绕过固定规则。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  ASK_OPTIMIZE_SYSTEM_PROMPT,
  CLAWBOT_PERSONA_MARKER,
  MANUAL_QA_PERSONA_MARKER,
  WECHAT_QA_SYSTEM_PROMPT,
  conversationRoleLabel,
  formatConversationHistory,
  withClawbotPersonaRules,
  withManualQaPersonaRules,
} from '../src/query/answer-runtime/persona.ts'
import { DEFAULT_CLAWBOT_SYSTEM_PROMPT } from '../src/query/clawbot/clawbot-prompt.ts'
import {
  blockedReply,
  clarificationReply,
  failedReply,
  insufficientReply,
} from '../src/query/answer-runtime/replies.ts'
import {
  CHAT_WITHHELD_ANSWER,
  IMAGE_UNSUPPORTED_NOTE,
  buildEmptyChatPrompt,
  buildSynthesisPrompt,
  emptyAnswerText,
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
  })

  it('自定义问答提示词会追加固定规则，且重复调用不叠加', () => {
    const once = withManualQaPersonaRules('自定义人设：保持简洁')
    expect(once).toContain('自定义人设：保持简洁')
    expect(once).toContain(MANUAL_QA_PERSONA_MARKER)
    expect(withManualQaPersonaRules(once)).toBe(once)
  })

  it('手动问答默认提示词在两处入口完全一致', () => {
    expect(resolveSystemPrompt(undefined, 'wechat')).toBe(WECHAT_QA_SYSTEM_PROMPT)
    expect(resolveSystemPrompt(undefined, undefined)).toBe(WECHAT_QA_SYSTEM_PROMPT)
    const custom = resolveSystemPrompt('只答材料', 'wechat')
    expect(custom).toContain('只答材料')
    expect(custom).toContain(MANUAL_QA_PERSONA_MARKER)
  })

  it('历史消息使用提问者/AI 回答者标签，不把内部角色写成用户/助手', () => {
    const history = [
      { role: 'user' as const, content: '小何说的报价是多少？' },
      { role: 'assistant' as const, content: '小何说本周五前给。' },
    ]
    expect(conversationRoleLabel('user', 'qa')).toBe('提问者')
    expect(conversationRoleLabel('assistant', 'qa')).toBe('AI 回答者')
    expect(formatConversationHistory(history, 'qa')).toBe('提问者：小何说的报价是多少？\nAI 回答者：小何说本周五前给。')
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

describe('ClawBot 集群 AI 自动回复：账号本人代理角色', () => {
  it('默认提示词把「我」固定为账号本人、「你」固定为聊天联系人', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('以当前微信账号本人的身份回复当前聊天联系人')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('第一人称「我」始终指当前微信账号本人')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('第二人称统一用「你」指当前聊天联系人，不用「您」')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('不得称聊天联系人为「用户」')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('身份不明时继续写姓名')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('不要用「本人」「账号本人」作为正文自称')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('聊天联系人输入的「您」仍按第二人称理解')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('「这个 / 那个 / 它」')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).not.toContain('问下本人')
  })

  it('自定义提示词仍会追加账号本人/聊天联系人角色规则，且保持幂等', () => {
    const custom = withClawbotPersonaRules('你是某品牌的客服助手')
    expect(custom).toContain('你是某品牌的客服助手')
    expect(custom).toContain(CLAWBOT_PERSONA_MARKER)
    expect(custom).toContain('第一人称「我」始终指当前微信账号本人')
    expect(withClawbotPersonaRules(custom)).toBe(custom)
    expect(resolveSystemPrompt('你是某品牌的客服助手', 'kb-only')).toBe(custom)
  })

  it('ClawBot 的自定义与默认提示词都不重复追加角色块', () => {
    expect(withClawbotPersonaRules(DEFAULT_CLAWBOT_SYSTEM_PROMPT)).toBe(DEFAULT_CLAWBOT_SYSTEM_PROMPT)
    expect(resolveSystemPrompt(undefined, 'kb-only')).toBe(DEFAULT_CLAWBOT_SYSTEM_PROMPT)
  })

  it('空材料兜底的消息历史使用聊天联系人/账号本人标签', () => {
    const prompt = buildEmptyChatPrompt('明天能到吗？', [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的' },
    ])
    expect(prompt).toContain('当前聊天联系人刚发来一条微信消息：明天能到吗？')
    expect(prompt).toContain('聊天联系人：在吗')
    expect(prompt).toContain('账号本人：在的')
    expect(prompt).not.toContain('用户：')
    expect(prompt).not.toContain('助手：')
    expect(prompt).toContain('回复里的「我」只指当前微信账号本人')
  })

  it('带材料的多轮提示词同样保持账号本人/聊天联系人标签', () => {
    const prompt = buildSynthesisPrompt({
      question: '合同款什么时候付？',
      history: [
        { role: 'user', content: '上次说的合同呢？' },
        { role: 'assistant', content: '我查一下' },
      ],
      imageHint: '',
      contextBlock: '材料',
      dataScope: 'kb-only',
      timeGuardRule: '',
    })
    expect(prompt).toContain('当前聊天联系人本次消息：合同款什么时候付？')
    expect(prompt).toContain('聊天联系人：上次说的合同呢？')
    expect(prompt).toContain('账号本人：我查一下')
    expect(prompt).toContain('回复里的「我」只指当前微信账号本人')
    expect(prompt).not.toContain('用户：')
    expect(prompt).not.toContain('助手：')
  })

  it('核对失败时以账号本人身份说“核实后再回你”，不再出现自指错位', () => {
    expect(CHAT_WITHHELD_ANSWER).toContain('我先核实一下再回你')
    expect(CHAT_WITHHELD_ANSWER).not.toContain('问下本人')
  })

  it('自动回复兜底不向聊天联系人暴露知识库或检索术语', () => {
    expect(insufficientReply('clawbot-auto')).toBe('这个我这边没查到，可以换个说法再问我。')
    expect(failedReply('clawbot-auto')).toBe('这次我这边暂时没查成，稍后再帮你看看。')
    expect(blockedReply('未选择知识库', 'clawbot-auto')).toBe('这次我这边没弄好，稍后再确认一下再回你。')
    expect(clarificationReply('检索条件缺少关键词', 'clawbot-auto'))
      .toBe('我还需要再确认一下具体要找什么。你再补充一下：是哪件事、哪个人或哪份文件？')
    expect(emptyAnswerText('kb-only', 'clawbot-auto')).toBe(insufficientReply('clawbot-auto'))
    expect(insufficientReply('clawbot-auto')).not.toContain('知识库')
    expect(failedReply('clawbot-auto')).not.toContain('检索')
    expect(blockedReply('未选择知识库', 'clawbot-auto')).not.toContain('知识库')
    expect(clarificationReply('检索条件缺少关键词', 'clawbot-auto')).not.toContain('材料')
  })

  it('图片不可识别提示只指向当前消息发送者，不并列两个入口角色', () => {
    expect(IMAGE_UNSUPPORTED_NOTE).toContain('当前消息发送者看不到图片内容')
    expect(IMAGE_UNSUPPORTED_NOTE).not.toContain('提问者或聊天联系人')
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

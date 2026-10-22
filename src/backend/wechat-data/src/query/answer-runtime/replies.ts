/**
 * 问答状态的确定性兜底文案。
 *
 * 模型调用、工具循环或综合生成都可能失败，但入口不能把空字符串直接交给用户
 * 或自动回复通道。这里只放与数据无关、不会编造事实的可读回复，供运行时与
 * 生产编排层共用，避免三个入口各自维护一套话术而逐渐漂移。
 *
 * @module query/answer-runtime/replies
 */
import type { AnswerProfileId } from '../tools/profiles.ts'

/** 需要澄清时的具体追问；优先点明缺的是参数、对象还是范围。 */
export function clarificationReply(
  reason = '',
  profile: AnswerProfileId = 'wechat-ask',
): string {
  if (/参数|关键词|检索条件|query|keywords/i.test(reason)) {
    return profile === 'clawbot-auto'
      ? '这轮检索条件不完整：请补充要查的关键词、文件名或具体问题，我再查一次。'
      : '这轮检索条件不完整：请补充要查的关键词、会话或时间范围，我再查一次。'
  }
  if (/代词|指代|对象|他|她|对方/.test(reason)) {
    return profile === 'clawbot-auto'
      ? '请问你具体想查哪份资料或哪件事？补充一下对象我再帮你查。'
      : '请问你指的是哪位联系人，或在哪个会话里？补充一下对象我再帮你查。'
  }
  return profile === 'clawbot-auto'
    ? '还需要你再补充一点信息：请说明要查的关键词、文件名或具体问题，我再帮你查。'
    : '还需要你再补充一点信息：请说明具体会话、联系人或时间范围，我再帮你查。'
}

/** 检索正常执行但没有可用证据时的说明；不能暗示成系统故障。 */
export function insufficientReply(
  profile: AnswerProfileId = 'wechat-ask',
): string {
  if (profile === 'clawbot-auto') {
    return '这个我这边没查到相关的知识库内容，可以换个关键词或确认一下知识库范围再试。'
  }
  if (profile === 'session-ask') {
    return '当前会话里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词，或补充更具体的时间与人物。'
  }
  return '本机记录里没有检索到与这个问题相关的原文，因此不作回答（不会基于常识推测）。可以试试：换关键词、收窄时间范围，或指定某个会话再问。'
}

/** 检索或模型链路暂时失败时的说明；必须与“没有数据”区分开。 */
export function failedReply(
  profile: AnswerProfileId = 'wechat-ask',
): string {
  const target = profile === 'clawbot-auto'
    ? '知识库检索'
    : profile === 'session-ask'
      ? '当前会话检索'
      : '本机记录检索'
  return `${target}暂时失败了，这次没有拿到可用结果。可以稍后再试；如果连续失败，请检查检索索引或模型配置。`
}

/** 请求在进入检索前就被范围门禁拦截时的可读原因。 */
export function blockedReply(reason: string | undefined): string {
  const detail = reason?.trim() || '当前范围不满足检索条件'
  return `这次没法开始检索：${detail}。请先补齐范围后再试。`
}

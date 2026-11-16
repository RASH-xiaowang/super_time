/**
 * AI 回复的上下文装配与模型生成边界。
 *
 * 从 runner-pipeline 拆出：这里只负责把上下文、图片、知识库和人格拼成一次
 * 模型调用，并把生成期取消信号透传给 `deps.generate`。本模块不写设置状态、
 * 不补全消息列表、不投递。
 */
import {
  buildChatAiReplyPrompt,
  collectChatAiReplyContext,
} from './context.ts'
import type { ChatAiReplyContextImage } from './context.ts'
import { buildChatAiReplySystemPrompt } from './persona.ts'
import { errorText } from './runner-recovery.ts'
import type { ChatAiReplyRunRef } from './runner-state.ts'
import type {
  ChatAiReplyScanDeps,
  ChatAiReplyState,
} from './types.ts'

/** 一次生成的结果；`canceled` 时 `text` 只含已经流出的部分正文。 */
export interface ChatAiReplyGeneration {
  text: string
  canceled: boolean
}

/**
 * 按会话设置检索知识库片段。
 *
 * 知识库是**增强**不是前置条件：未勾选、未选库或检索失败都返回 `undefined`，
 * 让回复退回普通对话，而不是让一次知识库故障卡住无人值守的自动回复。
 * @returns 检索成功时的片段（可能为空数组）；未启用或失败时 undefined。
 */
async function collectKbSnippetsForState(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  context: { lines: string[]; latestPeer: string },
): Promise<string[] | undefined> {
  if (!state.kbEnabled || state.kbId <= 0) return undefined
  if (deps.collectKbSnippets === undefined) {
    deps.op('chat_ai_reply', false, 'kb retrieval unavailable; reply without knowledge base')
    return undefined
  }
  try {
    const result = await deps.collectKbSnippets({
      kbId: state.kbId,
      lines: context.lines,
      ...(context.latestPeer === '' ? {} : { latestPeer: context.latestPeer }),
    })
    deps.op(
      'chat_ai_reply',
      true,
      'kb snippets=' + String(result.snippets.length)
        + (result.note === '' ? '' : '; ' + result.note),
    )
    return result.snippets
  } catch (e) {
    deps.op('chat_ai_reply', false, 'kb retrieval failed: ' + errorText(e))
    return undefined
  }
}

export async function generateChatAiReply(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<ChatAiReplyGeneration> {
  const anchor = run.anchor
  const collectContext = deps.collectContext ?? collectChatAiReplyContext
  const context = collectContext(
    deps.decryptedDir(),
    state.chatUsername,
    deps.selfUsername(),
    anchor.localId,
  )
  if (context.count === 0) throw new Error('当前会话没有可用文本')
  let images: ChatAiReplyContextImage[] = []
  if (context.imageCandidates !== undefined && context.imageCandidates.length > 0 && deps.decodeImages !== undefined) {
    try {
      images = await deps.decodeImages({
        decryptedDir: deps.decryptedDir(),
        talker: state.chatUsername,
        candidates: context.imageCandidates,
      })
    } catch (e) {
      // 图片/表情是增强信息，解码失败不能阻断纯文本回复。
      deps.op('chat_ai_reply', false, 'decode media failed: ' + errorText(e))
    }
  }
  const kb = await collectKbSnippetsForState(deps, state, context)
  const prompt = images.length > 0
    ? buildChatAiReplyPrompt(context.lines, images.length)
    : context.prompt
  const systemPrompt = buildChatAiReplySystemPrompt({
    name: state.personaName,
    prompt: state.personaPrompt,
  }, {
    splitReply: state.splitReply,
    ...(kb === undefined ? {} : { kbRequested: true, kbSnippets: kb }),
  })
  const [gatedSystem, gatedPrompt] = deps.gate(
    'ai_reply_analyze',
    { sessions: 1, messages: context.count },
    [systemPrompt, prompt],
  )
  const generated = await deps.generate({
    system: gatedSystem ?? systemPrompt,
    prompt: gatedPrompt ?? prompt,
    ...(images.length > 0 ? { images } : {}),
    accountKey: state.accountKey,
    chatUsername: state.chatUsername,
    ...(run.signal === undefined ? {} : { signal: run.signal }),
  })
  if (generated.canceled === true) {
    return { text: generated.text.trim(), canceled: true }
  }
  if (!generated.ok || generated.text.trim() === '') {
    throw new Error(generated.error ?? '模型没有返回可用回复')
  }
  return { text: generated.text.trim(), canceled: false }
}

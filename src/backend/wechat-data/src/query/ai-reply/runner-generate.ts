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
import { decideChatAiReplySafety } from './safety.ts'
import { errorText } from './runner-recovery.ts'
import type { ChatAiReplyRunRef } from './runner-state.ts'
import type {
  ChatAiReplyGenerationResult,
  ChatAiReplyScanDeps,
  ChatAiReplyState,
} from './types.ts'

/** 会话类型决定提示词措辞（群聊要说清「只有 @ 我 的消息才会触发」）。 */
function scopeOfChat(talker: string): 'private' | 'group' {
  return talker.endsWith('@chatroom') ? 'group' : 'private'
}

/**
 * 把「上下文时间窗（小时）」换算成消息时间起点。
 *
 * 基准是**触发消息的时间**而不是当前时间：消息可能延迟处理（App 刚启动、积压补发），
 * 用「现在」当基准会把本该回答的那一轮对话直接裁掉，模型甚至拿不到提问。
 * @param anchorCreateTime - 触发消息的 createTime（秒）。
 * @param contextWindowHours - 会话设置：0 表示不限。
 * @returns 起点秒数；0 表示不做时间过滤。
 */
export function contextWindowStart(
  anchorCreateTime: number,
  contextWindowHours: number | undefined,
): number {
  const hours = Number(contextWindowHours)
  if (!Number.isFinite(hours) || hours <= 0) return 0
  const anchor = Number(anchorCreateTime)
  if (!Number.isFinite(anchor) || anchor <= 0) return 0
  return Math.max(0, Math.trunc(anchor - hours * 3600))
}

/** 一次性生成的结果；`canceled` 时 `text` 只含已经流出的部分正文。 */
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
  context: { lines: string[]; dialogueLines?: string[]; latestPeer: string },
): Promise<string[] | undefined> {
  if (!state.kbEnabled || state.kbId <= 0) return undefined
  if (deps.collectKbSnippets === undefined) {
    deps.op('chat_ai_reply', false, 'kb retrieval unavailable; reply without knowledge base')
    return undefined
  }
  try {
    const result = await deps.collectKbSnippets({
      kbId: state.kbId,
      // 检索只看正文：时间标记与「更早的对话已省略」会把查询词切碎。
      lines: context.dialogueLines ?? context.lines,
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
  // 会话级「上下文时间窗」：只保留窗口内的消息。起点以**触发消息时间**为准，
  // 而不是「现在」—— 积压补发时按现在算会把本该回答的那轮对话整个裁掉。
  const sinceCreateTime = contextWindowStart(anchor.createTime, state.contextWindowHours)
  let context = collectContext(
    deps.decryptedDir(),
    state.chatUsername,
    deps.selfUsername(),
    anchor.localId,
    undefined,
    sinceCreateTime,
  )
  // 图片解码与语音转写互不依赖：并行跑，别让「等 whisper」把解码也一起拖住。
  const imageCandidates = context.imageCandidates
  const imageTask = (async (): Promise<ChatAiReplyContextImage[]> => {
    if (imageCandidates === undefined || imageCandidates.length === 0 || deps.decodeImages === undefined) return []
    try {
      return await deps.decodeImages({
        decryptedDir: deps.decryptedDir(),
        talker: state.chatUsername,
        candidates: imageCandidates,
      })
    } catch (e) {
      // 图片/表情是增强信息，解码失败不能阻断纯文本回复。
      deps.op('chat_ai_reply', false, 'decode media failed: ' + errorText(e))
      return []
    }
  })()
  // 语音先转文字再进上下文：否则模型只看到 `[语音]`，等于少了一整条对话。
  let voiceTranscribed = 0
  if (context.voiceCandidates !== undefined && context.voiceCandidates.length > 0
    && deps.transcribeVoices !== undefined) {
    const pendingCount = context.voiceCandidates.length
    try {
      const voiceTexts = await deps.transcribeVoices({
        decryptedDir: deps.decryptedDir(),
        talker: state.chatUsername,
        localIds: context.voiceCandidates,
      })
      voiceTranscribed = voiceTexts.size
      if (voiceTexts.size > 0) {
        context = collectContext(
          deps.decryptedDir(),
          state.chatUsername,
          deps.selfUsername(),
          anchor.localId,
          voiceTexts,
          sinceCreateTime,
        )
      }
      deps.op('chat_ai_reply', true,
        'voice transcribed=' + String(voiceTexts.size) + '/' + String(pendingCount))
    } catch (e) {
      // 转写是增强：失败就保留 `[语音]` 占位，不能阻断整次回复。
      deps.op('chat_ai_reply', false, 'transcribe voice failed: ' + errorText(e))
    }
  }
  const images = await imageTask
  if (context.count === 0) throw new Error('当前会话没有可用文本')
  // 只记录统计，不记录聊天正文：排查「为什么模型没看到某条消息」时，
  // 这条日志足以区分预算裁剪、图片预留与单条截断。
  const stats = context.stats
  if (stats !== undefined) {
    deps.op('chat_ai_reply', true,
      'context included=' + String(stats.included) + '/' + String(stats.collected)
        + ' tokens~' + String(stats.estimatedTokens) + '/' + String(stats.tokenBudget)
        // decoded/reserved：解码失败时两者不同，避免把预留 token 误读成正文预算。
        + ' images=' + String(images.length) + '/' + String(stats.imageCount)
        + (stats.truncated ? ' dropped=' + String(stats.dropped) : '')
        + (stats.shortened > 0 ? ' shortened=' + String(stats.shortened) : ''))
  }
  const kb = await collectKbSnippetsForState(deps, state, context)
  const safetyInput = {
    latestPeer: context.latestPeer,
    kbEnabled: state.kbEnabled,
    kbSnippets: kb ?? [],
    allowedText: context.lines.join('\n'),
    handoff: state.safetyHandoff,
    blocked: state.safetyBlocked,
  }
  const blockedBefore = decideChatAiReplySafety(safetyInput)
  if (blockedBefore !== null) {
    deps.writeTrace?.({
      recordId: run.recordId ?? 0,
      sourceRef: run.sourceRef,
      accountKey: state.accountKey,
      chatUsername: state.chatUsername,
      output: blockedBefore.text,
      stage: { name: 'generated', at: Date.now(), detail: 'safety=' + blockedBefore.reason },
    })
    return { text: blockedBefore.text, canceled: false }
  }
  const prompt = images.length > 0
    ? buildChatAiReplyPrompt(context.lines, images.length, scopeOfChat(state.chatUsername))
    : context.prompt
  const systemPrompt = [
    buildChatAiReplySystemPrompt({
      name: state.personaName,
      prompt: state.personaPrompt,
    }, {
      splitReply: state.splitReply,
      handoff: state.safetyHandoff,
      blocked: state.safetyBlocked,
      ...(kb === undefined ? {} : { kbRequested: true, kbSnippets: kb }),
    }),
  ].filter((part) => part.trim() !== '').join('\n\n')
  const [gatedSystem, gatedPrompt] = deps.gate(
    'ai_reply_analyze',
    { sessions: 1, messages: context.count },
    [systemPrompt, prompt],
  )
  const sentSystem = gatedSystem ?? systemPrompt
  const sentPrompt = gatedPrompt ?? prompt
  // 留痕记「实际发出去的那一版」：隐私闸若改写过提示词，详情里看到的必须与模型收到的一致。
  deps.writeTrace?.({
    recordId: run.recordId ?? 0,
    sourceRef: run.sourceRef,
    accountKey: state.accountKey,
    chatUsername: state.chatUsername,
    context: context.lines.join('\n'),
    ...(kb === undefined || kb.length === 0 ? {} : { kb: kb.join('\n\n') }),
    systemPrompt: sentSystem,
    userPrompt: sentPrompt,
    imageCount: images.length,
    voiceCount: voiceTranscribed,
    redacted: sentSystem !== systemPrompt || sentPrompt !== prompt,
    stage: {
      name: 'context',
      at: Date.now(),
      detail: 'messages=' + String(context.count)
        + ' images=' + String(images.length)
        + (kb === undefined ? '' : ' kb=' + String(kb.length))
        + (sinceCreateTime > 0
          ? ' window=' + String(state.contextWindowHours) + 'h'
          : ''),
    },
  })
  const generateAt = Date.now()
  let generated: ChatAiReplyGenerationResult
  try {
    generated = await deps.generate({
      system: sentSystem,
      publicText: context.latestPeer,
      prompt: sentPrompt,
      ...(images.length > 0 ? { images } : {}),
      accountKey: state.accountKey,
      chatUsername: state.chatUsername,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
    })
  } catch (e) {
    const error = errorText(e)
    deps.writeTrace?.({
      recordId: run.recordId ?? 0,
      error,
      finishedAt: Date.now(),
      stage: { name: 'generate_failed', at: Date.now(), detail: 'elapsed=' + String(Date.now() - generateAt) + 'ms' },
    })
    throw e
  }
  if (generated.canceled === true) {
    const partial = generated.text.trim()
    deps.writeTrace?.({
      recordId: run.recordId ?? 0,
      ...(generated.model === undefined ? {} : { model: generated.model }),
      output: partial,
      finishedAt: Date.now(),
      stage: { name: 'generate_failed', at: Date.now(), detail: 'canceled' },
    })
    return { text: partial, canceled: true }
  }
  if (!generated.ok || generated.text.trim() === '') {
    const error = generated.error ?? '模型没有返回可用回复'
    deps.writeTrace?.({
      recordId: run.recordId ?? 0,
      ...(generated.model === undefined ? {} : { model: generated.model }),
      error,
      output: generated.text,
      finishedAt: Date.now(),
      stage: {
        name: 'generate_failed',
        at: Date.now(),
        detail: 'elapsed=' + String(Date.now() - generateAt) + 'ms',
      },
    })
    throw new Error(error)
  }
  const rawText = generated.text.trim()
  const blockedAfter = decideChatAiReplySafety({ ...safetyInput, reply: rawText })
  const text = blockedAfter?.text ?? rawText
  const toolCalls = generated.toolCalls ?? []
  deps.writeTrace?.({
    recordId: run.recordId ?? 0,
    ...(generated.model === undefined ? {} : { model: generated.model }),
    output: text,
    ...(toolCalls.length === 0 ? {} : {
      tools: toolCalls.map(tool => ({
        name: tool.name,
        ok: tool.ok,
        ...(tool.code === undefined ? {} : { code: tool.code }),
        elapsedMs: tool.elapsedMs,
      })),
    }),
    stage: {
      name: 'generated',
      at: Date.now(),
      detail: 'chars=' + String(text.length) + ' elapsed=' + String(Date.now() - generateAt) + 'ms'
        + (blockedAfter === null ? '' : ' safety=' + blockedAfter.reason)
        + (toolCalls.length ? ' tools=' + toolCalls.map(t => t.name + ':' + (t.ok ? 'ok' : t.code ?? 'unavailable')).join(',') : ''),
    },
  })
  return { text, canceled: false }
}

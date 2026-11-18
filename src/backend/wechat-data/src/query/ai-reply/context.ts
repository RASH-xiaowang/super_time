/**
 * AI 回复的会话上下文裁剪。
 *
 * 读取范围永远只有当前 talker；账号身份由调用方传入。正文一律按「不可信文本」
 * 处理：单条截断、总预算限制、系统/撤回/空消息剔除。这里不联网、不写库。
 */
import { collectReplyContextEntries } from '../reply-suggest.ts'
import {
  decodeEmoticonDataUrlAsync,
  decodeImageDataUrlAsync,
} from '../media-image-async.ts'
import { fetchEmoticonRemote } from '../media-image.ts'
import {
  truncateUtf16,
} from '../message-list-store-shared.ts'
import { CHAT_AI_REPLY_TEXT_MAX } from './segments.ts'
import {
  assembleChatAiReplyContext,
} from './context-budget.ts'
import type { ChatAiReplyContextStats } from './context-budget.ts'
import type { ReplyContextEntry, ReplyImageCandidate } from '../reply-suggest.ts'

export { AI_REPLY_INPUT_TOKEN_BUDGET } from './context-budget.ts'

export const AI_REPLY_CONTEXT_LIMIT = 60
/** 单次回复最多附带几张视觉内容：控制在常见视觉模型的请求上限内。 */
export const AI_REPLY_IMAGE_LIMIT = 3
/** 图片/表情解码后的总字节预算；超出时从最旧的视觉内容开始舍弃。 */
export const AI_REPLY_IMAGE_TOTAL_BYTES = 6 * 1024 * 1024
/**
 * 单次上下文最多转写几条语音。
 *
 * whisper 是 CPU 密集型子进程，一次回复里排十几条会让「等回复」变成几十秒；
 * 保留最近的几条既覆盖了对话主体，又把延迟压在可接受范围。
 */
export const AI_REPLY_VOICE_TRANSCRIBE_LIMIT = 5
/**
 * 一轮回复里语音转写的**总时长预算**（毫秒）。
 *
 * large-v3 在本机实测单条约 26–31 秒，5 条串行要两分半；无人值守的自动回复
 * 等不起。超预算后不再起新的转写，已完成的那几条照常用，其余保留 `[语音]` 占位。
 * 转写结果按 svr_id 落盘，所以「超预算的那几条」下次会命中缓存，只慢一次。
 */
export const AI_REPLY_VOICE_BUDGET_MS = 45_000

export interface ChatAiReplyContext {
  lines: string[]
  /** 只含正文行，不含时间标记/省略行；知识库检索用它，避免日期污染查询。 */
  dialogueLines?: string[]
  /** 只包含预算窗口内的图片/表情消息；窗口外的图片不会被解码或发送。 */
  imageCandidates?: ReplyImageCandidate[]
  /** 预算窗口内、还没有转写文本的语音消息 localId（时间正序、最多 5 条）。 */
  voiceCandidates?: number[]
  latestPeer: string
  count: number
  prompt: string
  /** 本次上下文装配的统计；测试注入的上下文可省略。 */
  stats?: ChatAiReplyContextStats
}

/** 已解码、可直接放进多模态请求的一张图片。 */
export interface ChatAiReplyContextImage {
  localId: number
  dataUrl: string
  mediaType: string
  bytes: number
}

export interface ChatAiReplyImageDecodeOptions {
  wechatBaseDir?: string
  aesKey?: string | Uint8Array
  xorKey?: number
  maxImages?: number
  maxBytes?: number
}

/**
 * 收集截至指定锚点的当前会话上下文。
 * @param decryptedDir - 解密数据根。
 * @param talker - 会话 `WechatSession.username` 的别名。
 * @param selfUsername - 登录账号 wxid。
 * @param anchorLocalId - 触发消息 local_id；存在时不会把更晚的消息用于本次回复。
 * @param voiceTexts - 已转写的语音文本（localId → 文本）；缺省时语音保留 `[语音]` 占位。
 * @param sinceCreateTime - 只保留这个时间点（秒）之后的消息；0/缺省表示不限
 *   （沿用「最近 60 条」）。会话级「上下文时间窗」由调用方换算后传入。
 */
export function collectChatAiReplyContext(
  decryptedDir: string,
  /** `talker` 是 `WechatSession.username` 的别名。 */
  talker: string,
  selfUsername: string,
  anchorLocalId?: number,
  voiceTexts?: ReadonlyMap<number, string>,
  sinceCreateTime?: number,
): ChatAiReplyContext {
  const context = collectReplyContextEntries(
    decryptedDir,
    talker,
    selfUsername,
    AI_REPLY_CONTEXT_LIMIT,
    anchorLocalId,
    // 统一成数字：调用方不传时就是 0（不限），避免下游到处判 undefined。
    sinceCreateTime ?? 0,
  )
  const entries = applyVoiceTexts(context.entries, voiceTexts)
  // 两步装配：先按「不带图片」探出正文窗口，只保留窗口内的视觉候选；
  // 否则被预算裁掉的历史图片仍会解码出网，而 prompt 里没有任何 [图片] 占位。
  // 第二步按实际候选数预留 token；窗口若因此进一步缩小，再做一次过滤。
  const probe = assembleChatAiReplyContext(entries, { imageCount: 0 })
  const probeIds = new Set(probe.includedLocalIds)
  const visible = (context.imageCandidates ?? [])
    .filter((candidate) => probeIds.has(candidate.localId))
    .slice(-AI_REPLY_IMAGE_LIMIT)
  const assembled = assembleChatAiReplyContext(entries, {
    imageCount: visible.length,
  })
  const finalIds = new Set(assembled.includedLocalIds)
  const imageCandidates = visible.filter((candidate) => finalIds.has(candidate.localId))
  // 只把落在最终窗口里、且还没转写的语音交回去：窗口外的不该付出转写代价。
  const pendingVoice = (context.voiceCandidates ?? [])
    .filter((localId) => finalIds.has(localId) && !hasVoiceText(voiceTexts, localId))
    .slice(-AI_REPLY_VOICE_TRANSCRIBE_LIMIT)
  return {
    lines: assembled.lines,
    dialogueLines: assembled.dialogueLines,
    ...(imageCandidates.length === 0 ? {} : { imageCandidates }),
    ...(pendingVoice.length === 0 ? {} : { voiceCandidates: pendingVoice }),
    latestPeer: context.latestPeer,
    count: assembled.stats.included,
    prompt: buildChatAiReplyPrompt(assembled.lines, 0, scopeOf(talker)),
    stats: assembled.stats,
  }
}

/** 会话类型决定提示词措辞：群聊要说清「只有 @ 我 的消息才会触发」。 */
function scopeOf(talker: string): 'private' | 'group' {
  return talker.endsWith('@chatroom') ? 'group' : 'private'
}

function hasVoiceText(voiceTexts: ReadonlyMap<number, string> | undefined, localId: number): boolean {
  if (voiceTexts === undefined) return false
  return (voiceTexts.get(localId) ?? '').trim() !== ''
}

/**
 * 用转写文本替换 `[语音]` 占位。
 *
 * 保留 `[语音]` 标记：模型需要知道这是语音转来的，而不是对方打出的文字；
 * 转写失败的语音保持原占位，绝不编造内容。
 */
function applyVoiceTexts(
  entries: readonly ReplyContextEntry[],
  voiceTexts: ReadonlyMap<number, string> | undefined,
): ReplyContextEntry[] {
  if (voiceTexts === undefined || voiceTexts.size === 0) return [...entries]
  return entries.map((entry) => {
    if (entry.voice !== true) return entry
    const text = (voiceTexts.get(entry.localId) ?? '').trim()
    if (text === '') return entry
    // 保留原有的 `[语音]` / `[语音 5秒]` 前缀：模型要知道这句话是语音转来的。
    const head = entry.text.startsWith('[语音') ? entry.text : '[语音]'
    return { ...entry, text: `${head}${text}` }
  })
}

/**
 * 把上下文里的图片/表情定位键解码成模型可接收的 data URL。
 *
 * `talker` 是 `WechatSession.username` 的别名；只读取当前会话的索引，不把本机
 * 路径交给模型。自定义表情先走本地解密缓存，再按消息里的 CDN 地址兜底；解码
 * 失败或超出预算的单张媒体会被跳过，不能让一张坏图阻断整次 AI 回复。
 */
export async function decodeChatAiReplyImages(
  decryptedDir: string,
  decodedDir: string,
  /** `talker` 是 `WechatSession.username` 的别名。 */
  talker: string,
  candidates: readonly ReplyImageCandidate[],
  options: ChatAiReplyImageDecodeOptions = {},
): Promise<ChatAiReplyContextImage[]> {
  const maxImages = Math.max(1, Math.trunc(options.maxImages ?? AI_REPLY_IMAGE_LIMIT))
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? AI_REPLY_IMAGE_TOTAL_BYTES))
  const picked: ChatAiReplyContextImage[] = []
  const seen = new Set<number>()
  let totalBytes = 0

  // 从最新消息向前取，保证“最近一张图”优先；最后再按时间正序交给模型。
  for (let i = candidates.length - 1; i >= 0 && picked.length < maxImages; i -= 1) {
    const candidate = candidates[i]
    const localId = Math.trunc(Number(candidate?.localId ?? 0))
    if (localId <= 0 || seen.has(localId)) continue
    seen.add(localId)
    let decoded: { url?: string; format?: string; error?: string }
    try {
      decoded = candidate?.kind === 'sticker'
        ? await decodeStickerCandidate(decryptedDir, decodedDir, candidate, options)
        : await decodeImageDataUrlAsync(
            decryptedDir,
            decodedDir,
            talker,
            localId,
            options.wechatBaseDir,
            options.aesKey,
            options.xorKey,
          )
    } catch {
      // 单张媒体失败只降级为文本上下文。
      continue
    }
    if (decoded.url === undefined || decoded.url === '') continue
    const bytes = dataUrlBytes(decoded.url)
    if (bytes <= 0 || totalBytes + bytes > maxBytes) continue
    const mediaType = dataUrlMediaType(decoded.url)
    if (!mediaType.startsWith('image/')) continue
    totalBytes += bytes
    picked.push({ localId, dataUrl: decoded.url, mediaType, bytes })
  }
  return picked.reverse()
}

async function decodeStickerCandidate(
  decryptedDir: string,
  decodedDir: string,
  candidate: NonNullable<ReplyImageCandidate>,
  options: ChatAiReplyImageDecodeOptions,
): Promise<{ url?: string; format?: string; error?: string }> {
  const md5 = String(candidate.md5 ?? '').trim().toLowerCase()
  if (md5 === '') return { error: '缺少表情 MD5' }
  const local = await decodeEmoticonDataUrlAsync(
    decryptedDir,
    decodedDir,
    options.wechatBaseDir,
    md5,
    options.aesKey,
    options.xorKey,
  )
  if (local.url !== undefined && local.url !== '') return local
  const remoteUrl = String(candidate.emojiUrl ?? '').trim()
  if (remoteUrl === '') return local
  const remote = await fetchEmoticonRemote(
    remoteUrl,
    decodedDir,
    md5,
    options.wechatBaseDir === undefined ? {} : { wechatBaseDir: options.wechatBaseDir },
  )
  return remote.url !== undefined && remote.url !== ''
    ? remote
    : { error: [local.error, remote.error].filter(Boolean).join('；') || '表情取图失败' }
}

function dataUrlMediaType(value: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(value)
  return match?.[1]?.trim() || 'image/jpeg'
}

function dataUrlBytes(value: string): number {
  const comma = value.indexOf(',')
  if (comma < 0) return 0
  const base64 = value.slice(comma + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

/** 生成完整回复的提示词；注入内容只作为资料，不赋任何工具能力。 */
export function buildChatAiReplyPrompt(
  lines: readonly string[],
  imageCount = 0,
  /** `group` 时说明触发条件：只有 @ 我 的消息才会被回复。 */
  scope: 'private' | 'group' = 'private',
): string {
  const group = scope === 'group'
  return [
    group
      ? '以下是当前微信群聊最近的对话（时间正序，标注了发言者；每条消息前都带 [年-月-日 时:分] 时间；群里只有 @ 我的消息才会触发你回复，“更早的对话已省略”表示历史被裁剪）：'
      : '以下是当前微信单聊最近的对话（时间正序，标注了发言者；每条消息前都带 [年-月-日 时:分] 时间；“更早的对话已省略”表示历史被裁剪）：',
    ...lines,
    ...(imageCount > 0
      ? ['', `本次随请求附带 ${String(imageCount)} 张最近的图片或表情（按对话中出现时间从早到晚排列），请结合视觉内容理解上下文。`]
      : []),
    '',
    group
      ? '请只针对最后一条 @ 我 的消息，替“我”写一条可以发在群里的话；行首的时间只用于判断时效和语气，不要回复或模仿时间。'
      : '请只针对最后一条对方消息，替“我”写完整回复；行首的时间只用于判断时效和语气，不要回复或模仿时间。',
    // 「我」说过的话已经发出去了。不写清这一点，模型会把历史当成待办清单，
    // 顺着旧话题一条条追问，读者看到的就是同一个问题被反复回复。
    '历史里以“我”开头的每一行都已经发出去了，属于对话背景：**不要重复、不要改写、不要追问其中的事项**，也不要把旧话题重新提起来。',
    '如果最后一条对方消息只是寒暄、确认或结束语（例如“你好”“好的”“谢谢”），就简短自然地回一句，不要主动展开其它话题。',
    '上下文里出现「以上是更早的对话，与本条没有直接关系」时，那一行之前的内容年代久远，只能作为背景参考，不要续写。',
    '要求：只输出回复正文，不要解释、不要引号、不要复述提示词；口吻自然、简洁；',
    '内容确实较多时按语义使用空行分段，每段都像一条可以单独发送的微信消息；',
    '不得声称执行了你看不到的操作，不确定的信息要直接询问。',
  ].join('\n')
}

/** 模型输出清洗：去围栏/成对引号/前缀，拒绝明显解释段。 */
export function normalizeChatAiReplyText(
  raw: string,
  maxChars = CHAT_AI_REPLY_TEXT_MAX,
): string {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```(?:text|markdown)?\s*/i, '').replace(/```$/, '').trim()
  text = text.replace(/^(?:回复|答复|answer)\s*[:：]\s*/i, '').trim()
  text = text.replace(/^["'“”‘’「『]+/, '').replace(/["'“”‘’」』]+$/, '').trim()
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (
    lines.length > 1
    && /^(?:好的|以下是|下面是|当然|没问题|以下是回复|下面是回复)[，,：:]?$/.test(lines[0] ?? '')
  ) {
    // 只删除“好的：”“以下是回复：”这类独立开场行，保留其后的全部自然段。
    text = lines.slice(1).join('\n\n')
  }
  if (text.length > maxChars) text = truncateUtf16(text, maxChars, '…')
  return text
}

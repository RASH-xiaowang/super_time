/**
 * 人物性格：把一位好友的图片、聊天和朋友圈送到当前配置的模型，写一份四段都在的速写。
 *
 * 推理模型会先消耗输出额度写思考。额度太小（曾经是 700）时正文是空的，界面就只剩
 * 「模型没有返回文字」。这里把额度留到 8192，思考有内容但正文为空时再整理一次，
 * 四段缺任意一段或在上限处截断时再补写一次。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PortraitPersonalityResult } from '../types.ts'
import { rawWechatBase } from '../gateway-support.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'
import { loadPortraitVisionImages, type PortraitVisionImage } from '../query/portrait-personality-images.ts'
import {
  loadPersonalityMaterial,
  mergePortraitText,
  missingPortraitSections,
  personalityLanguageCues,
  personalityMaterialEnough,
  portraitNeedsContinuation,
  PORTRAIT_SECTIONS,
  PORTRAIT_TRAITS,
  type PersonalityMaterial,
} from '../query/portrait-personality.ts'
import { readPortraitPersonality, savePortraitPersonality } from '../query/portrait-personality-store.ts'

const OUTPUT_BUDGET = 8192
const FOLLOWUP_BUDGET = 4096

const SYSTEM = [
  '你要根据一个人发给你的聊天、他发出的图片画面，以及他的朋友圈，写一份让人一眼能认识他的观察。',
  '只写材料里反复出现的现象。偶发的一句话或一张图，不要上升成性格。',
  '用「从这些记录看」。不编造成长经历、家庭、职业、收入、学历、购买意向，也不做心理诊断，不打分数。',
  '聊天能看说话方式和相处；图片能看场景、活动、是否有人同框、色调和能看见的表情，这只是画面印象。',
  '看不见表情、语气、实时肢体时就直说看不出来，不要用文字去补。',
  '聊天、图片、朋友圈互相矛盾时，写在「言行是否一致」，不要抹平。',
  '某一类材料缺失时，对应段落写「这类材料不足，看不出来」，不要省略标题。',
  '直接写正文。必须按顺序写完这些标题，标题原样出现，每段 40 到 140 字，并标明依据来自图片、聊天还是朋友圈：',
  PORTRAIT_SECTIONS.join('\n'),
  `「性格观察」里必须逐项写到这些词，每项一句，看不出来就写看不出来：${PORTRAIT_TRAITS.join('、')}。`,
  '开放看兴趣是否多变；做事看是否有安排和后续；外向看是否主动找人；待人看是否顾及对方；情绪看压力下的用词是否稳定。',
].join('\n')

const REWRITE_SYSTEM = [
  '把已经形成的判断整理成中文正文。不要输出思考过程，不要寒暄。',
  '下面这些标题都必须出现，每段都要有正文：',
  PORTRAIT_SECTIONS.join('\n'),
  `「性格观察」里必须出现：${PORTRAIT_TRAITS.join('、')}。`,
  '没有依据的段落写「这类材料不足，看不出来」。',
].join('\n')

export interface PortraitPersonalityDeps {
  decryptedDir: string
  decodedDir: string
  selfUsername: string
  ctx: Context
  privacyGate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  op: (category: 'task', action: string, status: 'ok' | 'fail', target: string, detail: string) => void
}

interface LlmBridge {
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

interface ModelSelection {
  provider: string
  model: string
}

interface Draft {
  text: string
  reasoning: string
  finish: string
}

function promptOf(material: PersonalityMaterial): string {
  const coverage = material.coverage
  const scope = [
    coverage === undefined
      ? `图片：对方在这段样本里发出了 ${String(material.images)} 张图片。`
      : [
        `覆盖：一对一聊天共 ${String(coverage.messageTotal)} 条，这次读入 ${String(coverage.scannedMessages)} 条，抽出原话 ${String(material.peer.length)} 句。`,
        `图片消息共 ${String(coverage.imageTotal)} 条（含双方），这次样本里对方发出 ${String(material.images)} 张，其中抽样画面会附在请求里。`,
        `朋友圈共 ${String(coverage.momentTotal)} 条，这次读入 ${String(coverage.scannedMoments)} 条。`,
        '下面是从整段记录里均匀抽出的原话，不是只有最近几句。没出现的内容不要编。',
      ].join('\n'),
    languageCueLine(material.peer),
  ].join('\n')
  const peer = material.peer.map((line) => `聊天：${line}`).join('\n')
  const self = material.self.map((line) => `我：${line}`).join('\n')
  const moments = material.moments.map((line) => `朋友圈：${line}`).join('\n')
  return ['请根据聊天原话、图片画面和朋友圈写完全部分块。', scope, peer, self, moments].filter((part) => part !== '').join('\n')
}

function unavailable(text: string, messages: number, moments: number, error?: string): PortraitPersonalityResult {
  return { ok: false, text, messages, moments, ...(error ? { error } : {}) }
}

function hostOf(ctx: Context): { llm?: LlmBridge; agentDefaultModel?: { currentSelection(): ModelSelection | undefined } } {
  return ctx as Context & {
    llm?: LlmBridge
    agentDefaultModel?: { currentSelection(): ModelSelection | undefined }
  }
}

async function streamDraft(
  llm: LlmBridge,
  selected: ModelSelection,
  privacyGate: PortraitPersonalityDeps['privacyGate'],
  stats: { sessions: number; messages: number },
  system: string,
  user: string,
  maxTokens: number,
  images: readonly PortraitVisionImage[] = [],
): Promise<Draft> {
  const [gated] = privacyGate('portrait_personality', stats, [user])
  const outbound = gated !== undefined && gated.trim() !== '' ? gated : user
  const assembler = new BlockAssembler()
  const content: ContentBlock[] = [{ type: 'text', text: outbound }]
  for (const image of images) {
    const comma = image.dataUrl.indexOf(',')
    content.push({
      type: 'image',
      data: comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl,
      mediaType: image.mediaType,
    } as unknown as ContentBlock)
  }
  const options: GenerateOptions = {
    provider: selected.provider,
    model: selected.model,
    messages: [createUserMessage({
      content,
      source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
    })],
    system,
    maxTokens,
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(finish.failure.message || '模型调用失败')
  }
  const blocks = assembler.blocks()
  const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('').trim()
  const reasoning = blocks.map((block) => (block.type === 'reasoning' ? block.text : '')).join('').trim()
  return { text, reasoning, finish: finish.kind }
}

function languageCueLine(lines: readonly string[]): string {
  const cues = personalityLanguageCues(lines)
  return [
    `语言现象（只统计对方原话，不要改这些数字）：`,
    `${String(cues.lines)} 句，平均 ${String(cues.avgChars)} 字，`,
    `问句 ${String(cues.questions)} 句，感叹 ${String(cues.exclaims)} 句，`,
    `提到「我们/一起」${String(cues.together)} 句，`,
    `出现烦、累、难过、生气、焦虑、压力这类词 ${String(cues.strain)} 句。`,
  ].join('')
}
function withImages(prompt: string, images: readonly PortraitVisionImage[]): string {
  const chat = images.filter((image) => image.source === 'chat').length
  const moment = images.filter((image) => image.source === 'moment').length
  if (chat + moment === 0) return prompt
  return `${prompt}\n\n本次随请求附上对方聊天图片 ${String(chat)} 张、朋友圈图片 ${String(moment)} 张。请根据画面里实际看到的场景、活动和能看见的表情来写「生活画面」，看不清的图不要编。`
}

function imageRequestFailed(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /\b(?:400|415|422)\b/.test(text) || /image|vision|multimodal|modality|image_url|图片|视觉/i.test(text)
}

async function loadVision(deps: PortraitPersonalityDeps, talker: string, material: PersonalityMaterial): Promise<PortraitVisionImage[]> {
  if (material.imageLocalIds.length === 0 && material.momentImageRefs.length === 0) return []
  const keys = resolveImageKeyPair(deps.decryptedDir)
  const base = rawWechatBase(deps.decryptedDir)
  try {
    return await loadPortraitVisionImages({
      decryptedDir: deps.decryptedDir,
      decodedDir: deps.decodedDir,
      talker,
      localIds: material.imageLocalIds,
      momentImages: material.momentImageRefs,
      ...(base === '' ? {} : { wechatBaseDir: base }),
      ...(keys.aesKey === undefined ? {} : { aesKey: keys.aesKey }),
      xorKey: keys.xorKey,
    })
  } catch {
    return []
  }
}
function rewriteUser(reasoning: string): string {
  return [
    '下面是已经形成的判断。请整理成四段正文，四个标题都要在。',
    reasoning.slice(0, 6000),
  ].join('\n\n')
}

function continueUser(text: string, reasoning: string, missing: readonly string[]): string {
  const gap = missing.length > 0
    ? `还缺这些段落：${missing.join('、')}。请只补这些段落。`
    : '正文在结尾被截断了。请从断处续写，不要重写已经完整的段落。'
  return [
    gap,
    text === '' ? '' : `已有正文：\n${text}`,
    reasoning === '' ? '' : `已有判断，可用来补缺失段落：\n${reasoning.slice(0, 4000)}`,
  ].filter((part) => part !== '').join('\n\n')
}

/** 生成一位好友的性格速写。未要求重跑时，先返回本机存档。材料不足或没配模型时不调用模型。 */
export async function analyzePortraitPersonality(
  deps: PortraitPersonalityDeps,
  username: string,
  refresh = false,
  cacheOnly = false,
): Promise<PortraitPersonalityResult> {
  const talker = username.trim()
  if (talker === '') return unavailable('没有指定要分析的人。', 0, 0, 'empty-username')
  if (!refresh) {
    const cached = readPortraitPersonality(deps.decryptedDir, talker)
    if (cached !== undefined) {
      deps.op('task', 'portrait_personality', 'ok', talker, '读取已保存')
      return cached
    }
    if (cacheOnly) return { ok: false, text: '', messages: 0, moments: 0, error: 'miss' }
  }
  const material = loadPersonalityMaterial(deps.decryptedDir, talker, deps.selfUsername)
  const messages = material.peer.length + material.self.length
  const moments = material.moments.length
  if (!personalityMaterialEnough(material)) {
    deps.op('task', 'portrait_personality', 'fail', talker, '材料不足')
    return unavailable('图片、聊天和朋友圈里能用来推测的内容还太少，看不出性格。', messages, moments, 'thin')
  }
  const host = hostOf(deps.ctx)
  const selected = host.agentDefaultModel?.currentSelection()
  if (!host.llm || !selected?.provider || !selected.model) {
    deps.op('task', 'portrait_personality', 'fail', talker, '未配置默认模型')
    return unavailable('还没配置默认模型，暂时不能生成性格分析。', messages, moments, 'no-model')
  }
  const stats = { sessions: 1, messages }
  const basePrompt = promptOf(material)
  const vision = await loadVision(deps, talker, material)
  let prompt = withImages(basePrompt, vision)
  let attached = vision
  let draft: Draft
  try {
    try {
      draft = await streamDraft(host.llm, selected, deps.privacyGate, stats, SYSTEM, prompt, OUTPUT_BUDGET, attached)
    } catch (error: unknown) {
      if (attached.length === 0 || !imageRequestFailed(error)) throw error
      attached = []
      prompt = `${basePrompt}\n\n（当前模型没能读取所附图片，这次只根据文字、图片张数和朋友圈描述推测。）`
      draft = await streamDraft(host.llm, selected, deps.privacyGate, stats, SYSTEM, prompt, OUTPUT_BUDGET)
    }
    if (draft.text === '' && draft.reasoning !== '') {
      const rewritten = await streamDraft(
        host.llm, selected, deps.privacyGate, stats, REWRITE_SYSTEM, rewriteUser(draft.reasoning), FOLLOWUP_BUDGET,
      )
      draft = { text: rewritten.text, reasoning: draft.reasoning || rewritten.reasoning, finish: rewritten.finish }
    }
    if (draft.text === '' && draft.finish === 'max-tokens') {
      const again = await streamDraft(host.llm, selected, deps.privacyGate, stats, SYSTEM, prompt, OUTPUT_BUDGET, attached)
      if (again.text !== '') draft = again
    }
    if (portraitNeedsContinuation(draft.text, draft.finish) && (draft.text !== '' || draft.reasoning !== '')) {
      const missing = missingPortraitSections(draft.text)
      const continued = await streamDraft(
        host.llm, selected, deps.privacyGate, stats, REWRITE_SYSTEM, continueUser(draft.text, draft.reasoning, missing), FOLLOWUP_BUDGET,
      )
      draft = {
        text: mergePortraitText(draft.text, continued.text),
        reasoning: draft.reasoning,
        finish: continued.finish,
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    deps.op('task', 'portrait_personality', 'fail', talker, message.slice(0, 120))
    return unavailable('性格分析没有生成：' + message, messages, moments, 'llm')
  }
  const missing = missingPortraitSections(draft.text)
  if (draft.text === '') {
    deps.op('task', 'portrait_personality', 'fail', talker, `模型没有返回文字（${draft.finish}）`)
    return unavailable('性格分析没有写出正文。可以再生成一次。', messages, moments, 'empty')
  }
  if (missing.length > 0) {
    const text = `${draft.text}\n\n这次没有写完：${missing.join('、')}。`
    deps.op('task', 'portrait_personality', 'fail', talker, `缺段 ${missing.join('、')}`)
    return unavailable(text, messages, moments, 'incomplete')
  }
  deps.op('task', 'portrait_personality', 'ok', talker, `原话 ${String(messages)} 条，朋友圈 ${String(moments)} 条`)
  const savedAt = savePortraitPersonality(deps.decryptedDir, talker, { ok: true, text: draft.text, messages, moments })
  return { ok: true, text: draft.text, messages, moments, ...(savedAt === undefined ? {} : { savedAt }), cached: false }
}

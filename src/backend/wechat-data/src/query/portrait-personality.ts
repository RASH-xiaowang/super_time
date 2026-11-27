/**
 * 从一位好友的图片、聊天和朋友圈里抽出可引用的现象。
 *
 * 这里只整理材料，不调用模型。三类都太少时调用方应直接说明看不出来。
 */
import type { MomentItem, WechatMessage } from '../types.ts'
import { queryMessages } from './messages.ts'
import { queryMoments } from './moments.ts'

const PEER_LIMIT = 100
const SELF_LIMIT = 16
const MOMENT_LIMIT = 24
const LINE_LIMIT = 160
const MESSAGE_PAGE = 200
const MESSAGE_PAGES = 5
const MOMENT_PAGE = 40
const MOMENT_PAGES = 3
/** 送给模型看画面的对方聊天图片，从扫过的记录里均匀抽取。 */
const CHAT_IMAGE_SEND_LIMIT = 8
/** 送给模型看画面的朋友圈图片。 */
const MOMENT_IMAGE_SEND_LIMIT = 4

/** 性格速写必须写完的板块。缺任何一块都视为没写全。 */
export const PORTRAIT_SECTIONS = [
  '这个人',
  '说话方式',
  '在意什么',
  '和人相处',
  '生活画面',
  '言行是否一致',
  '性格观察',
  '还不能确定',
] as const

/** 性格观察里必须点名的五个方向。只写标题、不写这五项，也算没写完。 */
export const PORTRAIT_TRAITS = ['开放', '做事', '外向', '待人', '情绪'] as const

export interface PersonalityMomentImageRef {
  md5: string
  timelineId?: string
  mediaId?: string
}

export interface PersonalityMaterial {
  peer: string[]
  self: string[]
  moments: string[]
  /** 这次扫过的样本里，对方发出的图片条数。 */
  images: number
  /** 准备解码并送给模型的对方聊天图片。 */
  imageLocalIds: number[]
  /** 准备解码并送给模型的朋友圈图片。 */
  momentImageRefs: PersonalityMomentImageRef[]
  /** 全量与本次读入量。提示词用它说明覆盖范围，避免把一小段样本说成全部。 */
  coverage?: {
    messageTotal: number
    momentTotal: number
    imageTotal: number
    scannedMessages: number
    scannedMoments: number
  }
}

function oneLine(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= LINE_LIMIT) return clean
  return clean.slice(0, LINE_LIMIT) + '…'
}

function spokenText(message: WechatMessage): string {
  return oneLine(message.displayText || message.strContent || '')
}

function isPeerImage(message: WechatMessage): boolean {
  return message.isSender !== 1 && (message.renderType === 'image' || message.type === 3)
}

function momentLine(moment: MomentItem): string {
  const text = oneLine(moment.text)
  const media = moment.media_count > 0
    ? `${String(moment.media_count)} 个图片或视频${moment.media_desc ? `（${oneLine(moment.media_desc)}）` : ''}`
    : ''
  const place = oneLine(moment.location)
  return [text, media, place].filter((part) => part !== '').join(' · ')
}

/** 在整段样本上均匀取点，保留开头和结尾，而不是只留下最前面几句。 */
function takeSpread<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0 || items.length === 0) return []
  if (items.length <= limit) return items.slice()
  if (limit === 1) return [items[0] as T]
  const out: T[] = []
  for (let index = 0; index < limit; index += 1) {
    const item = items[Math.round((index * (items.length - 1)) / (limit - 1))]
    if (item !== undefined && (out.length === 0 || out[out.length - 1] !== item)) out.push(item)
  }
  return out
}

/** 从已经取出的消息和朋友圈里挑出适合送去推测的句子和图片现象。 */
export function personalityMaterial(messages: readonly WechatMessage[], moments: readonly MomentItem[]): PersonalityMaterial {
  const peer: string[] = []
  const self: string[] = []
  const imageLocalIds: number[] = []
  let images = 0
  const ordered = messages.slice().sort((a, b) => a.createTime - b.createTime || a.localId - b.localId)
  for (const message of ordered) {
    if (message.renderType === 'system' || message.renderType === 'revoke' || message.renderType === 'empty') continue
    if (isPeerImage(message)) {
      images += 1
      if (message.localId > 0) imageLocalIds.push(message.localId)
    }
    const text = spokenText(message)
    if (text === '' || (text.startsWith('[') && text.endsWith(']') && text.length < 12)) continue
    if (message.isSender === 1) self.push(text)
    else peer.push(text)
  }
  const momentLines = moments.map(momentLine).filter((text) => text !== '')
  const momentImageRefs: PersonalityMomentImageRef[] = []
  for (const moment of moments) {
    const image = moment.images.find((item) => item.md5.trim() !== '')
    if (image === undefined) continue
    momentImageRefs.push({
      md5: image.md5.trim(),
      ...(image.timelineId ? { timelineId: image.timelineId } : {}),
      ...(image.id ? { mediaId: image.id } : {}),
    })
  }
  return {
    peer: takeSpread(peer, PEER_LIMIT),
    self: takeSpread(self, SELF_LIMIT),
    moments: takeSpread(momentLines, MOMENT_LIMIT),
    images,
    imageLocalIds: takeSpread(imageLocalIds, CHAT_IMAGE_SEND_LIMIT),
    momentImageRefs: takeSpread(momentImageRefs, MOMENT_IMAGE_SEND_LIMIT),
  }
}

/** 四段标题后是否各有正文。只出现标题不算写完。五项观察缺名字也算性格观察没写完。 */
export function missingPortraitSections(text: string): string[] {
  const missing = PORTRAIT_SECTIONS.filter((title) => !sectionHasBody(text, title))
  const traitsMissing = PORTRAIT_TRAITS.some((label) => !text.includes(label))
  if (traitsMissing && !missing.includes('性格观察')) missing.push('性格观察')
  return missing
}

function sectionHasBody(text: string, title: string): boolean {
  const start = text.indexOf(title)
  if (start < 0) return false
  const after = text.slice(start + title.length)
  const next = PORTRAIT_SECTIONS
    .map((name) => (name === title ? -1 : after.indexOf(name)))
    .filter((index) => index > 0)
  const end = next.length > 0 ? Math.min(...next) : after.length
  const body = after.slice(0, end).replace(/^[\s:：\-—.、]+/, '').trim()
  return body.length >= 8
}

/** 从对方原话里数出可核对的语言现象，供模型引用，不在这里打分。 */
export function personalityLanguageCues(lines: readonly string[]): {
  lines: number
  avgChars: number
  questions: number
  exclaims: number
  together: number
  strain: number
} {
  const usable = lines.map((line) => line.trim()).filter((line) => line !== '')
  const totalChars = usable.reduce((sum, line) => sum + line.length, 0)
  const strain = /烦|累|难过|生气|焦虑|压力|崩溃|委屈/
  return {
    lines: usable.length,
    avgChars: usable.length === 0 ? 0 : Math.round(totalChars / usable.length),
    questions: usable.filter((line) => /[?？]/.test(line)).length,
    exclaims: usable.filter((line) => /[!！]/.test(line)).length,
    together: usable.filter((line) => /我们|一起|咱们/.test(line)).length,
    strain: usable.filter((line) => strain.test(line)).length,
  }
}
export function portraitNeedsContinuation(text: string, finish: string): boolean {
  if (missingPortraitSections(text).length > 0) return true
  return finish === 'max-tokens' && !/[。！？]$/.test(text.trim())
}

/** 把补写接在已有正文后面。补写为空，或正文里已经有这段，就保持原稿。 */
export function mergePortraitText(draft: string, extra: string): string {
  const base = draft.trim()
  const addition = extra.trim()
  if (addition === '') return base
  if (base === '') return addition
  if (base.includes(addition)) return base
  return `${base}\n\n${addition}`
}

/** 读取这个人的一对一聊天和朋友圈。从最近往前翻几页，并记下全量，避免只看最后几句。 */
export function loadPersonalityMaterial(
  decryptedDir: string,
  username: string,
  selfUsername: string,
): PersonalityMaterial {
  const talker = username.trim()
  if (talker === '') return { peer: [], self: [], moments: [], images: 0, imageLocalIds: [], momentImageRefs: [] }
  const messages: WechatMessage[] = []
  let cursor: number | undefined
  let cursorLocalId: number | undefined
  let messageTotal = 0
  let imageTotal = 0
  for (let page = 0; page < MESSAGE_PAGES; page += 1) {
    const snap = queryMessages(decryptedDir, talker, MESSAGE_PAGE, cursor, selfUsername, cursorLocalId)
    if (page === 0) {
      messageTotal = snap.total
      imageTotal = (snap.typeStats ?? [])
        .filter((row) => row.type === 3 || row.label === '图片')
        .reduce((sum, row) => sum + row.count, 0)
    }
    messages.push(...snap.messages)
    if (snap.hasMore !== true || snap.cursor === undefined || snap.cursorLocalId === undefined) break
    if (snap.cursor === cursor && snap.cursorLocalId === cursorLocalId) break
    cursor = snap.cursor
    cursorLocalId = snap.cursorLocalId
  }
  const momentItems: MomentItem[] = []
  let momentTotal = 0
  let offset = 0
  try {
    for (let page = 0; page < MOMENT_PAGES; page += 1) {
      const snap = queryMoments(decryptedDir, offset, MOMENT_PAGE, talker, selfUsername)
      momentTotal = snap.total
      if (snap.moments.length === 0) break
      momentItems.push(...snap.moments)
      offset += snap.moments.length
      if (offset >= snap.total) break
    }
  } catch {
    // 朋友圈读失败时仍用已经拿到的聊天。
  }
  return {
    ...personalityMaterial(messages, momentItems),
    coverage: {
      messageTotal,
      momentTotal,
      imageTotal,
      scannedMessages: messages.length,
      scannedMoments: momentItems.length,
    },
  }
}

/** 图片、聊天、朋友圈三类里要有足够现象，才值得推测性格。 */
export function personalityMaterialEnough(material: PersonalityMaterial): boolean {
  const weight = material.peer.length + material.moments.length * 2 + Math.min(material.images, 12)
  return weight >= 6
}

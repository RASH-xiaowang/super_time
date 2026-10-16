/**
 * 聊天记录卡片（嵌套消息）的**读法**（#19 第六刀，自 `chats-view.tsx` 的那段 map 里抽出）。
 *
 * 一条内层记录怎么变成一行字，规则一共五条，全都"看代码不容易发现、看界面一眼能看出错了"：
 * ① 类型以 `renderType` 为准，没有它时**只有** `isImage` 能顶一下（其余一律当文本）；
 * ② 链接的地址有三个出处（`link` → `url` → 空），没有就不该画成 `<a>`；
 * ③ 语音时长与视频时长的单位**不一样**（语音是 20 毫秒计数、视频是毫秒），拿同一个除数
 *    处理两者是这一族最容易悄悄写反的一条；
 * ④ 嵌套那行的括号里，有内层数据时报条数、没有时报「点击查看」（两者是不同的等待状态）；
 * ⑤ 头像拿不到（含 `<sourceheadurl>` 那 193/360 条 http 原始地址）时回退成首字母，
 *    形状与「本机没有这张头像」一致 —— 渲染层永远不自己去要那个地址（M23 的出网纪律）。
 */
import type { ChatlogRecord } from '@deepseek-ai/dsh-wechat-data/types'

/**
 * 栈里的一层聊天记录（标题 + 该层的内层记录）。
 * 这形状原先在钩子、导出钩子、渲染树各写一遍字面量 —— 收成一份，加字段时不必记着改三处。
 */
export interface ChatlogFrame {
  title: string
  records: ChatlogRecord[]
}

/** 一行的渲染种类（`renderType` 缺省时由 `isImage` 顶一次，其余落文本）。 */
export type ChatlogKind = NonNullable<ChatlogRecord['renderType']>

/** 语音时长的换算：库里存的是 20 毫秒一格的老口径 ⇒ 除以 20 才是秒。 */
const VOICE_TICK_MS = 20
/** 视频时长是毫秒 ⇒ 除以 1000。两者故意不同单位（写反了不会报错，只会看到 40 秒的语音）。 */
const VIDEO_MS = 1000

/**
 * 这条内层记录该按哪种形态画。
 * @param r - 一条内层记录。
 * @returns 渲染种类；`renderType` 缺失时只认 `isImage`，否则一律按文本。
 */
export function chatlogKindOf(r: ChatlogRecord): ChatlogKind {
  return r.renderType ?? (r.isImage ? 'image' : 'text')
}

/** 链接地址的三个出处按优先级收成一个（空串代表"其实没有链接"）。 */
export function chatlogLinkOf(r: ChatlogRecord): string {
  return r.link || r.url || ''
}

/** 嵌套卡片背后有多少条内层消息（没有 `nested` 字段时报 0，不是 undefined）。 */
export function chatlogNestedCount(r: ChatlogRecord): number {
  return (r.nested ?? []).length
}

/** 头像拿不到时顶上那颗字母（名字也为空时用 `?`，不能留空格子）。 */
export function chatlogFallbackChar(r: ChatlogRecord): string {
  return (r.name || '?').slice(0, 1)
}

/** 时长尾巴：没有 `duration` 时是空串（不是 "NaN" 也不是 0）。 */
function durationSuffix(raw: string | undefined, divisor: number, unit: string): string {
  if (!raw) return ''
  return String(Math.round(Number(raw) / divisor)) + unit
}

/**
 * 嵌套那行按钮的整段文案：`📋 标题（N 条）` 或 `📋 标题（点击查看）`。
 * 标题为空时退到「聊天记录」—— 实测确有只有 server id 指针、没有 text 的内层卡片。
 */
export function chatlogNestedLabel(r: ChatlogRecord): string {
  const n = chatlogNestedCount(r)
  return `📋 ${r.text || '聊天记录'}（${n > 0 ? `${n} 条` : '点击查看'}）`
}

/**
 * 一行的正文（链接那一支由 JSX 换成 `<a>`，这里给的是同一个文案）。
 * @param r - 一条内层记录。
 * @returns 带图标前缀的整行文本。
 */
export function chatlogBodyOf(r: ChatlogRecord): string {
  switch (chatlogKindOf(r)) {
    case 'link':
      return r.text || chatlogLinkOf(r)
    case 'voice':
      return `🎤 ${r.text || '[语音]'}${durationSuffix(r.duration, VOICE_TICK_MS, '"')}`
    case 'video':
      return `🎬 ${r.text || '[视频]'}${durationSuffix(r.duration, VIDEO_MS, 's')}`
    case 'emoji':
      return `😀 ${r.text || '[表情]'}`
    case 'image':
      return `🖼️ [图片]${r.datasize ? ` (${r.datasize} 字节)` : ''}`
    default:
      return r.text || ''
  }
}

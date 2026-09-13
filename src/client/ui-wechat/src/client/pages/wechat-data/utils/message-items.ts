/**
 * 消息列表的**渲染项组装**（纯函数，可单元测试）。
 *
 * 从 `Chats.tsx` 的内联 IIFE 里抽出来的原因有两个：
 *  1. 「消息 → 渲染项」这段有真实逻辑（渐进窗口起点、日期分隔、图片组归并），
 *     埋在 JSX 的立即执行函数里既读不清、也没法测；
 *  2. 图片组合并（连拍多图）过去完全没有自动化验证 —— 本机只有 8 条带
 *     `<groupinfo>` 的图片消息，靠 UI 截图「碰运气」不可靠。
 *     抽成纯函数后可以用合成数据把所有分支（同组/不同组/单张/缺失 renderType）
 *     逐条断言。
 *
 * 这里也承载 `renderType` 的**向前兼容兜底**：渲染结果缓存
 * （`readRenderCache`）里可能存着上一版写入的消息对象，它们没有 `renderType`。
 */
import type { MessageRenderKind, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { fmtDividerSec } from './format.ts'

/** 一个渲染项：日期分隔 / 单条消息 / 图片组。 */
export type MessageRenderItem =
  | { kind: 'day'; label: string; key: string }
  | { kind: 'msg'; m: WechatMessage }
  | { kind: 'group'; items: WechatMessage[]; gid: string }

/** 相邻消息间隔超过这个秒数就在中间插日期分隔 —— 微信口径（5 分钟）。 */
export const DIVIDER_GAP_SEC = 300

/** 一天的自然日 key（`YYYY-M-D`），只用于判断「跨天」。 */
function dayKey(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * `m` 之前是否要插日期分隔，需要的话返回分隔标签（微信 `formatTimeDivider` 口径）。
 *
 * 微信**不是**「每跨一天就插一条」，而是**相邻消息间隔 ≥ 5 分钟**才插；
 * 间隔不足 5 分钟的跨天（例如 23:59 → 00:01）也要插，因为标签本身要变成「昨天 …」。
 * @param prev - 前一条消息；列表首条传 undefined（首条总是插，给出一段历史的起点时间）。
 * @param m - 当前消息。
 * @returns 分隔标签；不需要分隔或时间缺失时返回 ''。
 */
export function dividerLabelBefore(prev: WechatMessage | undefined, m: WechatMessage): string {
  if (!m.createTime) return ''
  if (!prev || !prev.createTime) return fmtDividerSec(m.createTime)
  const gap = m.createTime - prev.createTime
  const dayChanged = dayKey(prev.createTime) !== dayKey(m.createTime)
  if (gap < DIVIDER_GAP_SEC && !dayChanged) return ''
  return fmtDividerSec(m.createTime)
}

/**
 * 单条消息的呈现种类（后端 `renderType` 优先，缺失时本地兜底推导）。
 *
 * 后端 `classifyRender` 是权威值；这里只做**向前兼容** —— 渲染缓存里的旧消息
 * 没有 `renderType`，没有兜底的话升级后首屏会把历史消息全画成「未知类型」。
 * @param m - the message.
 * @returns the render kind.
 */
export function renderKindOf(m: WechatMessage): MessageRenderKind {
  if (m.renderType) return m.renderType
  const t = m.type
  if (t === 10000 || t === 10002) return 'system'
  if (t === 1) return 'text'
  if (t === 3) return 'image'
  if (t === 34) return 'voice'
  if (t === 42 || t === 66) return 'contactCard'
  if (t === 43) return 'video'
  if (t === 47) return 'emoji'
  if (t === 48) return 'location'
  if (t === 50) return 'voip'
  if (t === 11000) return 'empty'
  if (t === 859832288 || t === 922746960) return 'pat'
  if (t === 244135593199) return 'miniapp'
  if (t === 244 || t === 246) return 'file'
  const rt = m.rich?.type
  if (rt === 'image') return 'image'
  if (rt === 'voice') return 'voice'
  if (rt === 'video') return 'video'
  if (rt === 'emoji' || rt === 'sticker') return 'emoji'
  if (rt === 'location') return 'location'
  if (rt === 'contact') return 'contactCard'
  if (rt === 'call') return 'voip'
  if (rt === 'quote') return 'quote'
  if (rt === 'file') return 'file'
  if (rt === 'link' || rt === 'newsfeed') return 'link'
  if (rt === 'chatlog') return 'chatlog'
  if (rt === 'transfer') return 'transfer'
  if (rt === 'redpacket') return 'redpacket'
  if (rt === 'solitaire') return 'solitaire'
  if (rt === 'announcement') return 'announcement'
  if (rt === 'pat') return 'pat'
  if (rt === 'unsupported') return 'unsupported'
  if (rt && rt !== 'appmsg') return rt as MessageRenderKind
  if (t === 49) return 'link'
  return 'unknown'
}

/** 图片组声明的张数（`<groupinfo><count>`，≥2 才算组）。 */
function groupCountOf(m: WechatMessage): number {
  const n = m.rich?.groupCount
  return typeof n === 'number' && n >= 2 ? n : 0
}

/**
 * 把消息数组折成渲染项。
 *
 * 规则（每一条都有对应的单元断言）：
 *  - 与**前一条真实消息**间隔 ≥5 分钟（或跨天）时，在其前插入 `day` 分隔项
 *    （微信口径；窗口边界不影响结果，向上加载更多不会让分隔线跳位）；
 *  - **同一 `groupId` 的连续图片**合成一个 `group` 项（连拍多图）；
 *    只出现一次（组内只有 1 条）时不合并 —— 合并成 1 格网格反而看不出是连拍；
 *  - 中间夹了别的东西（文本/不同组）就断开，不会把两段连拍并成一组；
 *  - 其余消息逐条产出 `msg` 项。
 * @param messages - oldest → newest 的完整消息数组。
 * @param start - 渐进窗口起点（只组装 `[start, end)` 这一段）。
 * @returns 渲染项列表。
 */
export function buildMessageItems(messages: readonly WechatMessage[], start = 0): MessageRenderItem[] {
  const items: MessageRenderItem[] = []
  for (let i = Math.max(0, start); i < messages.length; i += 1) {
    const m = messages[i]
    if (!m) continue
    const divider = dividerLabelBefore(i > 0 ? messages[i - 1] : undefined, m)
    if (divider) items.push({ kind: 'day', label: divider, key: `day-${i}` })
    if (renderKindOf(m) === 'image') {
      const gid = m.rich?.groupId ?? ''
      if (gid && groupCountOf(m) > 0) {
        const run: WechatMessage[] = [m]
        let j = i + 1
        while (j < messages.length) {
          const n = messages[j]
          if (!n || renderKindOf(n) !== 'image') break
          if ((n.rich?.groupId ?? '') !== gid) break
          run.push(n)
          j += 1
        }
        if (run.length > 1) {
          items.push({ kind: 'group', items: run, gid })
          i = j - 1
          continue
        }
      }
    }
    items.push({ kind: 'msg', m })
  }
  return items
}

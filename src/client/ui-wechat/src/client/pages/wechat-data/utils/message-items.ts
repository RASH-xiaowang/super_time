/**
 * 消息列表的**渲染项组装**（纯函数，可单元测试）。
 *
 * 从 `Chats.tsx` 的内联 IIFE 里抽出来的原因有两个：
 *  1. 「消息 → 渲染项」这段有真实逻辑（渐进窗口起点、日期分隔、图片组归并），
 *     埋在 JSX 的立即执行函数里既读不清、也没法测；
 *  2. 图片组合并（连拍多图）过去完全没有自动化验证 —— 本机只有 8 条带
 *     `<groupinfo>` 的图片消息，靠 UI 截图「碰运气」不可靠。
 *     抽成纯函数后可以用合成数据把所有分支（同组/不同组/单张/缺失 renderType）
 *     逐条断言，见 `scripts/check-message-items.js`。
 *
 * 这里也承载 `renderType` 的**向前兼容兜底**：渲染结果缓存
 * （`readRenderCache`）里可能存着上一版写入的消息对象，它们没有 `renderType`。
 */
import type { MessageRenderKind, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'

/** 一个渲染项：日期分隔 / 单条消息 / 图片组。 */
export type MessageRenderItem =
  | { kind: 'day'; label: string; key: string }
  | { kind: 'msg'; m: WechatMessage }
  | { kind: 'group'; items: WechatMessage[]; gid: string }

/** 一天的日期分隔标签（`MM-DD`）。 */
export function dayLabelOf(m: WechatMessage): string {
  if (!m.createTime) return ''
  const d = new Date(m.createTime * 1000)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
 *  - 跨天插入 `day` 分隔项（`MM-DD` 变化时）；
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
  let prevDay = ''
  for (let i = Math.max(0, start); i < messages.length; i += 1) {
    const m = messages[i]
    if (!m) continue
    const day = dayLabelOf(m)
    if (day && day !== prevDay) {
      prevDay = day
      items.push({ kind: 'day', label: day, key: `day-${i}` })
    }
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

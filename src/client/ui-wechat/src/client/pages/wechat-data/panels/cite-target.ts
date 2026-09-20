/**
 * 引用 → 点击目标的**唯一判定点**。
 *
 * 为什么必须抽成一个模块：同一个 `AskCitation` 在三个地方被渲染成可点击条目
 * （问答面板 `CiteList`、会话内问答 `SessionAsk`、问答历史 `AskHistoryDialog`），
 * 而两类来源的「点开」去向完全不同：
 *   · 消息来源 → 会话（`username` + `local_id`）；
 *   · 知识库来源 → 「知识库 · 文件」分段（`kbId` + `fileId`）。
 *
 * 两者字段**不可互换**，而且换错的代价是静默的：知识库引用的 `username` 是
 * `kb:<库>:<文件>`（检索侧为了让同文件分块归组而造的合成键），把它喂给会话跳转
 * 会去开一个不存在的会话 —— 不抛错、不报警，界面只是空着或显示「没有这个会话」。
 * 所以「判来源」这件事只能有一份实现，三处调用它。
 *
 * 与检索侧的 `kbDocKey()` 是**两件事**，不要合并：那边是「反馈归因 / 去重」的键
 * （要求逐字节稳定），这边是「用户点了以后去哪」（要求字段齐全、可缺省）。
 */
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'

/** 点击目标。`null` = 这条引用的信息不全（无法安全跳转），界面应渲染成只读块。 */
export type CiteTarget =
  | { kind: 'msg'; username: string; localId?: number }
  | { kind: 'kb'; kbId: number; fileId: number }

/** 判定所需的字段子集（三个调用点的 `AskCitation` 都满足）。 */
export interface CiteLike {
  source?: 'msg' | 'kb'
  username?: string
  local_id?: number
  kb?: { kbId?: number; fileId?: number }
}

/** 正整数化：非有限值 / 非正数一律判非法（id 必须能安全写进 URL 或 SQL）。 */
function posInt(v: unknown): number | null {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 判定一条引用点下去应该去哪。
 *
 * 判别依据是**显式字段 `source`**，不是「`local_id` 是不是 0」：消息域里 `local_id`
 * 的含义由上游决定，靠它反推来源会在上游变化时悄悄失效，而且失效时不报错。
 * @param c - 引用（或任何带这几个字段的对象）。
 * @returns 点击目标；信息不全时返回 `null`。
 */
export function citeTarget(c: CiteLike): CiteTarget | null {
  if (c.source === 'kb') {
    const kbId = posInt(c.kb?.kbId)
    const fileId = posInt(c.kb?.fileId)
    // 缺任一 id 都判不可跳 —— 宁可渲染成只读块，也不要跳到一个错的文件上。
    if (kbId === null || fileId === null) return null
    return { kind: 'kb', kbId, fileId }
  }
  const username = (c.username ?? '').trim()
  // 空 username 是「无来源」而不是「某个会话」：点它会打开空白面板。
  if (username === '') return null
  return typeof c.local_id === 'number' && Number.isFinite(c.local_id)
    ? { kind: 'msg', username, localId: c.local_id }
    : { kind: 'msg', username }
}

/** 引用条目的类型：直接取自 `AskResult` 的引用数组元素，避免又写一份形状。 */
export type CiteItem = NonNullable<AskResult['citations']>[number]

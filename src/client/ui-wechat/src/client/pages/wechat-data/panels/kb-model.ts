/**
 * 知识库面板的**纯逻辑**（不 import react、不碰 DOM —— 本仓库只有这一层能跑单测）。
 *
 * 语义必须与后端 `src/backend/wechat-data/src/query/notes.ts` 逐一对应，否则会出现
 * 「后端认得、界面点不动」这类只在特定数据上复现的问题：
 *   · 标题归一化 = 去首尾空白 + 内部连续空白折叠 + 小写（后端的 `normalizeTitle`）；
 *     `[[目标]]` 的解析目标与标题唯一性**共用同一把尺子**，前端若各写一套，
 *     「保存时判为同名、链接却解析不到」就会只在小写/多空格的数据上冒出来；
 *   · 标签在库里是**逗号分隔的字符串**，取出来才是数组（`parseTags`）——前端只做展示，
 *     不做二次切分，切分口径只有后端一处；
 *   · `[[目标]]` 命中已有标题即成为一条边，命中不到是**待补笔记**（不是错误、
 *     也不该被隐藏）：「先把链接写下来、之后再补那篇」正是这套知识库的用法。
 */

/** 正文切分后的一段：纯文本，或一条 `[[…]]` 链接。 */
export interface WikiSegment {
  kind: 'text' | 'link'
  /** text = 原文；link = 显示文本（`[[目标|显示]]` 取「显示」，`[[目标]]` 取「目标」）。 */
  text: string
  /** 仅 link 有值：**未归一化**的目标写法，用于回填/新建那篇待补笔记的标题。 */
  target: string
}

/** 正文里的 `[[目标]]`（允许 `|显示文本`）。与后端 `parseWikiLinks` 同一形状。 */
const WIKI_RE = /\[\[([^[\]\n]+)\]\]/g

/**
 * 标题解析键。**必须与后端 `normalizeTitle` 行为一致**（见文件头）。
 * @param title - 原始标题或 `[[目标]]`。
 * @returns 可比较的键；空白输入返回 `''`。
 */
export function normalizeTitleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 把正文切成「纯文本 / 链接」交替的片段，供详情页渲染（链接渲染成可点击的 chip）。
 * 空目标的 `[[|x]]` 会被跳过 —— 与后端一致（`parseWikiLinks` 只收非空 target）。
 * @param body - 笔记正文。
 * @returns 片段数组；空正文返回 `[]`。
 */
export function segmentBody(body: string): WikiSegment[] {
  const out: WikiSegment[] = []
  if (!body) return out
  // 全局正则带 lastIndex 状态，逐次调用前必须复位（后端同款注释，踩过一次）。
  WIKI_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null = WIKI_RE.exec(body)
  while (m !== null) {
    const inner = m[1] ?? ''
    const bar = inner.indexOf('|')
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
    const display = (bar >= 0 ? inner.slice(bar + 1) : inner).trim()
    if (m.index > last) out.push({ kind: 'text', text: body.slice(last, m.index), target: '' })
    if (target) out.push({ kind: 'link', text: display || target, target })
    last = m.index + m[0].length
    m = WIKI_RE.exec(body)
  }
  if (last < body.length) out.push({ kind: 'text', text: body.slice(last), target: '' })
  return out
}

/**
 * 把 wiki 标记摊平成纯文本（`[[目标|显示]]` → 「显示」），并折叠空白。
 * 列表行与搜索结果用同一口径，避免「摘要里还带着 `[[`」。
 * @param body - 笔记正文。
 * @returns 单行文本（可能为空串）。
 */
export function flattenWiki(body: string): string {
  return segmentBody(body).map(s => s.text).join('').replace(/\s+/g, ' ').trim()
}

/**
 * 列表行摘要。长度上限与后端 `excerptOf` 同口径（默认 140），
 * 只是可以按行宽调小。
 * @param body - 笔记正文。
 * @param limit - 最大字符数，超出追加省略号。
 * @returns 单行摘要。
 */
export function excerptOf(body: string, limit = 140): string {
  const flat = flattenWiki(body)
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** 标签 + 出现次数（筛选条用）。 */
export interface TagCount {
  tag: string
  count: number
}

/**
 * 统计标签：按出现次数降序，同次数按名称升序。
 *
 * 排序必须是**确定的** —— 否则筛选条每次重载都会重排，用户刚点的那枚标签会跳位置。
 * @param notes - （已按关键词筛过的）条目。
 * @returns 可直接渲染的标签计数，空标签被丢弃。
 */
export function collectTags(notes: readonly { tags: readonly string[] }[]): TagCount[] {
  const m = new Map<string, number>()
  for (const n of notes) {
    for (const t of n.tags) {
      const tag = t.trim()
      if (!tag) continue
      m.set(tag, (m.get(tag) ?? 0) + 1)
    }
  }
  return [...m.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/**
 * 归一化标题 → 条目，用于把 `[[链接]]` 解析成可点击的跳转目标。
 *
 * 按 id 升序取第一条：库里标题唯一（后端 `saveNote` 拦重名），但**旧数据**可能有
 * 历史重复，此时必须与后端 `findIdByTitleKey`（顺序扫描、先遇到先用）落到同一条，
 * 否则界面会跳去另一篇、看着像跳错了。
 * @param notes - 条目集合。
 * @returns 标题键 → 条目的映射。
 */
export function indexByTitle<T extends { id: number; title: string }>(notes: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const n of [...notes].sort((a, b) => a.id - b.id)) {
    const k = normalizeTitleKey(n.title)
    if (k && !map.has(k)) map.set(k, n)
  }
  return map
}

/** 按标签筛选（`null` = 全部）。 */
export function filterByTag<T extends { tags: readonly string[] }>(notes: readonly T[], tag: string | null): readonly T[] {
  if (!tag) return notes
  return notes.filter(n => n.tags.includes(tag))
}

/** 详情页的「链接」清单：目标 + 显示文本 + 解析到的条目 id（缺省 = 待补）。 */
export interface LinkRef {
  target: string
  display: string
  noteId?: number
}

/**
 * 抽取正文里出现过的链接（**去重、保留首次写法**），并标注是否已解析。
 * 与后端建边口径一致：去重按归一化键，展示用原始写法。
 * @param body - 笔记正文。
 * @param byTitle - `indexByTitle` 的结果。
 * @returns 链接数组（保持正文出现顺序）。
 */
export function linkRefs(body: string, byTitle: Map<string, { id: number }>): LinkRef[] {
  const out: LinkRef[] = []
  const seen = new Set<string>()
  for (const seg of segmentBody(body)) {
    if (seg.kind !== 'link') continue
    const key = normalizeTitleKey(seg.target)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const hit = byTitle.get(key)
    out.push(hit ? { target: seg.target, display: seg.text, noteId: hit.id } : { target: seg.target, display: seg.text })
  }
  return out
}

/** `YYYY-MM-DD`（本地时区）。 */
export function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 相对时间（「更新于 …」）。`now` 显式传入，便于单测。
 * 超过 30 天直接给日期 —— 「97 天前」不如 `2026-06-12` 有用。
 * @param ts - 毫秒时间戳。
 * @param now - 当前毫秒时间戳。
 * @returns 人类可读的相对/绝对时间；`ts` 非法时返回 `'—'`。
 */
export function formatRelative(ts: number, now: number): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const diff = now - ts
  // 未来时间（时钟回拨、跨设备同步）不当负数展示。
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return formatDate(ts)
}

/**
 * 列表的计数文案：「共 N 条」/「筛出 M 条 · 共 N 条」。
 * 抽出来是因为它同时被工具栏与空态用 —— 两处写两份必然漂移。
 * @param shown - 当前可见条数。
 * @param total - 库内总条数。
 * @returns 一句中文计数。
 */
export function countText(shown: number, total: number): string {
  return shown === total ? `共 ${total} 条` : `筛出 ${shown} 条 · 共 ${total} 条`
}

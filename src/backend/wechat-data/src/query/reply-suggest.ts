/**
 * 「推荐回复」的上下文收集（**纯数据层，不碰模型**）。
 *
 * 与 `daily-summary.ts` 的 `collectDayMessages` / `collectPeriodMessages` 同一分工：
 * 这里只负责把「该给模型看的东西」取出来，提示词与出站闸门留在 gateway ——
 * 那里是唯一的出网咽喉（见 `privacyGate` 的注释）。
 *
 * 两个来源：
 *   · 会话上下文：当前对话最近若干条（`queryMessages` 已经按时间正序返回，可直接拼）；
 *   · 知识库片段：用户**当前选中的那个库**里与「对方最近那句话」相关的块。
 */
import { queryMessages } from './messages.ts'
import { searchKb } from './kb-search.ts'

/** 单条消息进提示词前截断到这个长度：推荐回复只需要语义，不需要全文。 */
const MAX_LINE_CHARS = 300

/** `collectReplyContext` 的结果。 */
export interface ReplyContext {
  /** 按时间正序的对话行（`我：…` / `对方：…`）；空行已剔除。 */
  lines: string[]
  /** 对方最近的一条非空消息 —— 就是「要回的那句」；没有则为空串。 */
  latestPeer: string
  /** 参与拼装的条数（供隐私审计的 `messages` 计数用）。 */
  count: number
}

/**
 * 取当前会话最近的对话上下文。
 * @param decryptedDir - 解密数据根。
 * @param talker - 会话 username（**范围就是它**，绝不跨会话取）。
 * @param selfUsername - 登录账号 wxid（用于标注「我」，未知时传空）。
 * @param limit - 取最近多少条（默认 20）。
 * @returns 上下文；该会话没有可用文本时 `count` 为 0。
 */
export function collectReplyContext(
  decryptedDir: string,
  talker: string,
  selfUsername?: string,
  limit = 20,
): ReplyContext {
  const cap = Math.max(1, Math.min(limit, 60))
  // `queryMessages` 的第 4、6 个参数才是游标（cursor / cursorLocalId），这里都不传 = 「最新一页」；
  // 第 5 个是 selfUsername，用来把每条标成「我」还是「对方」（也用于判定发送者）。
  const snapshot = queryMessages(decryptedDir, talker, cap, undefined, selfUsername)
  const lines: string[] = []
  let latestPeer = ''
  for (const m of snapshot.messages) {
    const text = messageText(m)
    if (text === '') continue
    const self = m.isSender === 1
    lines.push(`${self ? '我' : '对方'}：${text}`)
    if (!self) latestPeer = text
  }
  return { lines, latestPeer, count: lines.length }
}

/**
 * 取当前选中知识库里与 `query` 相关的片段（用于让推荐回复「有据可依」）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 知识库 id（用户当前选中的那个）。
 * @param query - 检索词（一般传对方最近那句话）。
 * @param topK - 最多取几段。
 * @returns 形如 `《文件名》片段` 的字符串数组；库为空/未命中时返回空数组。
 */
export function collectReplyKbSnippets(
  decryptedDir: string,
  kbId: number,
  query: string,
  topK = 3,
): string[] {
  const q = query.trim()
  if (q === '' || !Number.isFinite(kbId) || kbId <= 0) return []
  const r = searchKb(decryptedDir, Math.trunc(kbId), { query: q, topK: Math.max(1, Math.min(topK, 5)) })
  const out: string[] = []
  for (const hit of r.hits) {
    const snippet = String(hit.snippet ?? '').trim().replace(/\s+/g, ' ')
    if (snippet === '') continue
    out.push(`《${String(hit.fileName ?? '')}》${snippet}`)
  }
  return out
}

/**
 * 拼「推荐回复」的提示词。
 *
 * 几个刻意的取舍：
 *   · **明确告诉模型几条**（`want`），并要求 JSON 数组 —— 但 `parseReplyCandidates` 仍然宽容，
 *     因为小模型未必听话；
 *   · 上下文标注「我 / 对方」，否则模型分不清是谁在问，会生成「替对方回我」的话；
 *   · 知识库片段**标注文件名**：让模型知道依据来自哪份文件，也让用户能核对（配合界面上的
 *     「知识库 N 段」说明）；
 *   · 没选库/没命中时不编造「参考资料」，直接说只有对话上下文。
 * @param lines - `collectReplyContext` 产出的对话行（时间正序）。
 * @param snippets - `collectReplyKbSnippets` 产出的片段。
 * @param want - 要几条候选。
 * @returns 提示词全文。
 */
export function buildReplyPrompt(lines: readonly string[], snippets: readonly string[], want: number): string {
  const parts = ['以下是微信聊天的最近对话（时间正序，标注了每句是谁说的）：', '', ...lines]
  if (snippets.length > 0) {
    parts.push('', '可参考的知识库片段（来自用户当前选中的知识库）：', ...snippets.map((s, i) => `${String(i + 1)}. ${s}`))
  } else {
    parts.push('', '（本次没有可用的知识库片段，只依据上面这段对话。）')
  }
  parts.push(
    '',
    `请以上面「对方」最后那句话为主，给出 ${String(Math.max(1, want))} 条我可以直接发送的回复候选。`,
    '要求：',
    '1) 每条独立成句，口吻自然、像我本人在微信里说话；',
    '2) 三条之间要有差异（例如：直接回答 / 反问确认 / 简短暂缓），不要互相改写；',
    '3) 需要用到知识库信息时按片段里的事实写，不要编造；',
    '4) 只输出 JSON 字符串数组，形如 ["第一条","第二条","第三条"]，不要任何解释。',
  )
  return parts.join('\n')
}

/** 一条消息用于拼提示词的文本：优先展示文本，其次落回原始字段；过长截断。 */
function messageText(m: { displayText?: string; strContent?: string; msgContent?: string }): string {
  const raw = String(m.displayText ?? m.strContent ?? m.msgContent ?? '').trim()
  if (raw === '') return ''
  const flat = raw.replace(/\s+/g, ' ')
  return flat.length > MAX_LINE_CHARS ? flat.slice(0, MAX_LINE_CHARS) + '…' : flat
}

/**
 * 把模型输出解析成候选回复列表。
 *
 * 模型（尤其小模型）不会永远规规矩矩给 JSON：常见形态有 ```json 围栏、编号列表、
 * 每行一句、或在前言后附一段 JSON。解析必须**宽容**，但也不能把解释性文字当回复 ——
 * 所以策略是「先试 JSON 数组，再退化为逐行」，并且逐条清洗：剥编号/项目符号/引号，
 * 丢掉过短或明显是说明文字的行（以「好的」「以下是」这类开场）。
 * @param raw - 模型返回的原始文本。
 * @param want - 最多要几条。
 * @returns 清洗后的候选（可能少于 `want`，也可能为空 —— 空即「这次没产出」）。
 */
export function parseReplyCandidates(raw: string, want = 3): string[] {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  const out: string[] = []

  // ① JSON 数组（含 ```json 围栏、或正文里夹着一段数组）
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const jsonText = (fenced?.[1] ?? text).trim()
  const bracket = /\[[\s\S]*\]/.exec(jsonText)
  if (bracket) {
    try {
      const arr = JSON.parse(bracket[0]) as unknown
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const s = typeof item === 'string'
            ? item
            : (item && typeof item === 'object' ? String((item as { text?: unknown; reply?: unknown }).text ?? (item as { reply?: unknown }).reply ?? '') : '')
          const clean = cleanLine(s)
          if (clean !== '') out.push(clean)
        }
      }
    } catch { /* 不是合法 JSON：落到逐行解析 */ }
  }

  // ② 逐行兜底（编号列表 / 每行一句）
  if (out.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      const clean = cleanLine(line)
      if (clean !== '') out.push(clean)
    }
  }

  return dedupe(out).slice(0, Math.max(1, want))
}

/** 逐条清洗：剥围栏/编号/项目符号/成对引号，丢掉开场白与过短的碎片。 */
function cleanLine(input: string): string {
  let s = String(input ?? '').trim()
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  s = s.replace(/^(?:[-*•]|\d+[.、)]|[(（]\d+[)）])\s*/, '').trim()
  s = s.replace(/^["'“”‘’「『]+/, '').replace(/["'“”‘’」』]+$/, '').trim()
  if (s === '') return ''
  // 开场白/解释性文字不是回复：它们通常是「好的，以下是…」「以下是 3 条…」这种句子。
  if (/^(好的|好[，,]|以下是|下面是|当然|没问题[，,])/.test(s) && /[:：]/.test(s)) return ''
  if (/^[\[{]/.test(s) && /[\]}]$/.test(s)) return ''   // JSON 残片
  // 注意别按「长度 ≥ 2」过滤：中文里「好」「嗯」「行」都是完整回复。
  if (s === '') return ''
  return s
}

/** 去重（模型偶尔把同一句写两遍），保持原顺序。 */
function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of list) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

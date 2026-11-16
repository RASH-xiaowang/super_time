/**
 * 工具循环的确定性兜底查询构造。
 *
 * 模型首轮不调用工具或补查时，这里只根据问题文本与已锁定的范围构造
 * **最小合法参数**。它不读库、不执行工具，也不猜测复杂筛选条件；缺必填项
 * 时返回 `undefined`，由证据层如实记录“未执行”，而不是发一次注定失败的请求。
 *
 * @module query/answer-runtime/fallback-query
 */
import { extractAskTerms, stripTimeExpr } from '../ask.ts'
import type { ToolLoopInput } from './types.ts'

/** 兜底提词时去掉的动作/客套片段，避免它们占用有限的内容词名额。 */
const FALLBACK_STOP_TERMS = new Set([
  '帮我', '我找', '我查', '找一', '找下', '查一', '查下', '看一', '看下',
  '看看', '请问', '麻烦', '帮忙', '给我', '一下', '一个',
])

/**
 * 「最近一次」「上一次」表达排序，不是检索内容。
 *
 * `extractAskTerms` 会把它切成 `最近 / 近一 / 一次 / 次转`，前几个会占满
 * 补查只取前 4 个词的名额，把真正的「转账」挤掉。这里在切词前整段剥离。
 */
const FALLBACK_RECENCY_RE =
  /(?:最近|最新|最后)(?:的)?(?:一|几)?次?|上一次|上一回|上次|前不久|前几天|这两天|这几天|近期|刚刚/g

/** 中文 bigram 容易跨词边界；首/尾落在功能字上的组合不是内容词。 */
const FALLBACK_EDGE_NOISE = new Set(
  '的了是我你他她它们在有和就都也很还要会能可这那么吗呢吧啊呀哦嗯给过把被让使得着地谁哪几多少么什怎和与跟'.split(''),
)

/**
 * 按原顺序去重工具名。
 * @param names - 候选工具名。
 * @returns 去重后的工具名。
 */
export function dedupeNames(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * 从问题中提取确定性兜底查询词。
 *
 * 不把自然语言整句塞给关键词工具：整句在 FTS/文件名匹配里几乎等于一个
 * 超长短语，容易稳定 0 命中。只保留至少 2 字的内容词，并过滤动作/客套词。
 * @param query - 原始问题或兜底查询。
 * @returns 最多 4 个内容词。
 */
export function fallbackTerms(query: string): string[] {
  const content = stripTimeExpr(query.replace(FALLBACK_RECENCY_RE, ' '))
  return extractAskTerms(content)
    .map(term => term.trim())
    .filter(term => term.length >= 2 && !FALLBACK_STOP_TERMS.has(term))
    .filter((term) => {
      const first = term[0] ?? ''
      const last = term[term.length - 1] ?? ''
      return !FALLBACK_EDGE_NOISE.has(first) && !FALLBACK_EDGE_NOISE.has(last)
    })
    .slice(0, 4)
}

/**
 * 从问题里识别要盘点的媒体种类。
 *
 * 只收窄到明确的种类词；识别不出时返回 undefined，让兜底跳过该工具，
 * 而不是猜一个种类去扫全库（猜错会给出「没有图片」这类错误结论）。
 * @param query - 原始问题。
 * @returns `aggregate_media.kind` 或 undefined。
 */
function fallbackMediaKind(query: string): string | undefined {
  if (/视频/.test(query)) return 'video'
  if (/语音|音频/.test(query)) return 'voice'
  if (/表情/.test(query)) return 'emoji'
  if (/位置|定位/.test(query)) return 'location'
  if (/文件|文档|附件/.test(query)) return 'file'
  if (/图片|照片|图像|截图/.test(query)) return 'image'
  return undefined
}

/**
 * 为确定性兜底构造最小合法参数。
 *
 * 只填工具必填项与服务端锁定范围。缺必填项的工具直接跳过，交给证据层
 * 如实报告“未执行”，而不是尝试空查询。
 * @param name - 工具名。
 * @param loop - 工具循环输入。
 * @returns 可执行参数；该工具不适合兜底时为 undefined。
 */
export function fallbackArguments(
  name: string,
  loop: ToolLoopInput,
): Record<string, unknown> | undefined {
  const query = (loop.fallbackQuery ?? loop.question).trim()
  const terms = fallbackTerms(query)
  const termQuery = terms.join(' ')
  const username = loop.toolContext.scope?.username?.trim()
  const from = loop.toolContext.scope?.from?.trim()
  const to = loop.toolContext.scope?.to?.trim()
  const withScope = (base: Record<string, unknown>): Record<string, unknown> => ({
    ...base,
    ...(username ? { username } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  })
  if (name === 'search_messages') {
    return terms.length === 0 ? undefined : withScope({ keywords: terms })
  }
  if (name === 'aggregate_messages') {
    return terms.length === 0 ? undefined : withScope({ question: query, keywords: terms })
  }
  if (name === 'get_session_messages') {
    return username
      ? {
        username,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(loop.recency === true ? { order: 'desc' } : {}),
      }
      : undefined
  }
  if (name === 'get_message_context') return undefined
  if (name === 'list_sessions') return {}
  /*
   * 专用数据域工具：只填问题里能确定的部分（锁定范围、内容词、媒体种类）。
   * 模型首轮没调工具时，这些工具往往是唯一能看到对应数据的入口
   * （通话 / 账单 / 朋友圈不在聊天检索索引里），没有兜底参数等于放弃兜底。
   */
  if (name === 'get_funds_summary') {
    return withScope({})
  }
  if (name === 'get_call_history') {
    return {
      ...(username ? { peer: username } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      order: 'recent',
    }
  }
  if (name === 'aggregate_media') {
    const kind = fallbackMediaKind(query)
    if (kind === undefined) return undefined
    return withScope({ kind })
  }
  if (name === 'get_moments_stats') {
    return {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }
  }
  if (name === 'search_revoked') {
    return {
      ...(termQuery === '' ? {} : { query: termQuery }),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }
  }
  if (name === 'get_group_detail') {
    // 只有锁定范围本身就是群时才敢直接查；部分群名匹配交给模型。
    return username !== undefined && username.endsWith('@chatroom')
      ? { group: username }
      : undefined
  }
  if (name === 'search_files') {
    /*
     * 文件索引没有会话归属：锁定会话时兜底注入 username 只会稳定得到
     * `unsupported_scope`，白占一次调用预算（2026-11-13 审计）。锁定会话
     * 直接不发起这次注定失败的调用；只有日期锁定时仍按关键词兜底。
     */
    if (username !== undefined) return undefined
    return termQuery === ''
      ? undefined
      : {
        query: termQuery,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }
  }
  if (
    name === 'search_hybrid'
    || name === 'search_semantic'
    || name === 'search_contacts'
    || name === 'search_moments'
    || name === 'search_favorites'
    || name === 'search_records'
  ) {
    return termQuery === '' ? undefined : withScope({ query: termQuery })
  }
  // 知识库 FTS 把整句编成连续短语；用内容词缩短查询，原句仍保留在消息工具里。
  if (name === 'search_kb') {
    return termQuery === '' ? undefined : { query: termQuery }
  }
  return undefined
}

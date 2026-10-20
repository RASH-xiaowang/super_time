/**
 * 总结 prompt 构造 —— 每日与周期共用。
 *
 * ## 为什么单独一个文件（2026-10-17）
 *
 * 改前两处各写一句 `'请总结 X 的微信聊天内容，输出简洁的中文要点：'`，问题有三：
 *   ① **没有篇幅约束** —— 模型有时写 3 行、有时写 800 字，用户不知道会得到什么；
 *   ② **没有结构要求** —— 输出是一坨散文，扫不出重点；
 *   ③ **没有防编造约束** —— 素材稀疏时模型会"合理推测"，而这是个人聊天记录，
 *      编出来的内容比没有更糟。
 *
 * 现在统一成：**固定四段结构 + 明确字数区间 + 素材不足就直说**。
 */

/** 总结格式（与前端 `FORMATS` 口径一致）。 */
export type SummaryFormat = 'brief' | 'detailed' | 'bullets' | 'story' | 'custom'

/** 每种格式的字数区间与结构要求。 */
const FORMAT_SPEC: Record<Exclude<SummaryFormat, 'custom'>, { range: string; shape: string }> = {
  brief: {
    range: '150–250 字',
    shape: '一段话，不分点。先一句话说这天/这段的主线，再补两三个具体细节（谁、什么事、什么结论）。',
  },
  detailed: {
    range: '400–700 字',
    shape: '按主题分 3–5 个小节，每节一个短标题（如「工作」「家事」「约饭」），节内 2–3 句。',
  },
  bullets: {
    range: '6–10 条要点',
    shape: '每条一行，以「·」开头，一句话说清一件事。按重要性排序，最重要的在前。',
  },
  story: {
    range: '300–500 字',
    shape: '以第三人称叙述，按时间顺序讲清来龙去脉：起因 → 经过 → 结果。',
  },
}

/**
 * 构造总结 prompt。
 * @param opts.kind - 每日还是周期（决定时间描述与篇幅上限）。
 * @param opts.from - 起始日期（YYYY-MM-DD）。
 * @param opts.to - 结束日期（YYYY-MM-DD，含）。与 `from` 相同即单日。
 * @param opts.lines - 已清洗的消息素材（`【会话名】` + 正文行）。
 * @param opts.stats - 统计（写进 prompt 让模型知道素材规模）。
 * @param opts.format - 输出格式。
 * @param opts.customPrompt - `format === 'custom'` 时的用户模板。
 * @returns 完整 prompt。
 */
export function buildSummaryPrompt(opts: {
  from: string
  to: string
  lines: readonly string[]
  stats: { total: number; sessions: number; messages: number }
  format?: SummaryFormat
  customPrompt?: string
}): string {
  const single = opts.from === opts.to
  const span = single ? opts.from : `${opts.from} 至 ${opts.to}`
  const fmt = opts.format ?? 'brief'

  // 自定义模板：用户自己写，只做占位符替换（不叠加我们的结构要求 —— 那会覆盖用户的意图）。
  if (fmt === 'custom' && opts.customPrompt && opts.customPrompt.trim()) {
    const filled = opts.customPrompt
      .replace(/\{date\}/g, span)
      .replace(/\{group\}/g, '全部会话')
      .replace(/\{targets\}/g, '全部成员')
    return filled + '\n\n以下是聊天素材：\n\n' + opts.lines.join('\n')
  }

  const spec = FORMAT_SPEC[fmt === 'custom' ? 'brief' : fmt]
  const head = [
    `请总结 ${span} 的微信聊天记录。`,
    '',
    `素材规模：${String(opts.stats.total)} 条消息 / ${String(opts.stats.sessions)} 个会话 / ${String(opts.stats.messages)} 行文本。`,
    '',
    '## 输出要求',
    '',
    `1. **篇幅**：${spec.range}。不要超出，也不要只写一两句敷衍。`,
    `2. **结构**：${spec.shape}`,
    '3. **只写素材里有的**：不要推测、不要补充背景、不要编造人名或数字。素材里没提到的事一律不写。',
    '4. **素材不足就直说**：如果素材里没有实质内容（只有寒暄、表情、广告），直接输出「这段时间没有值得总结的对话」，不要硬凑。',
    '5. **用中文**，不要输出 Markdown 标题符号（#），不要加「总结：」这类前缀。',
    '',
    '## 聊天素材',
    '',
  ].join('\n')

  return head + opts.lines.join('\n')
}

/**
 * 素材为空时的固定回复（不调模型，省一次请求）。
 * @param from - 起始日期。
 * @param to - 结束日期。
 * @returns 提示文本。
 */
export function emptyMaterialNotice(from: string, to: string): string {
  const span = from === to ? from : `${from} 至 ${to}`
  return `${span} 没有可总结的对话内容。\n\n可能的原因：这段时间没有聊天、消息都是图片/表情/广告，或本机还没解密到这段数据。`
}

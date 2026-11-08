/**
 * 回答正文 —— 把模型写的 `[n]` 引用标记渲染成**可点击的上标角标**。
 *
 * ## 为什么不再在正文下方平铺「来源 · N 条」列表
 *
 * 旧实现把 14~20 条来源铺成 2 列网格挂在回答下面，占掉整屏高度，而用户真正
 * 想看的只有**正文里提到的那几条**。改成角标之后：
 *   · 正文保持干净（`[1]` 这种方括号在中文里很扎眼，上标 `¹` 才是引用该有的样子）；
 *   · 点角标 → 右侧滑出详情（见 `CiteDetailPanel`），**不离开当前问答**；
 *   · 聊天记录始终留在左侧当上下文 —— 这是「追问」能成立的前提。
 *
 * ## 为什么用「上标数字」而不是「小圆点」
 *
 * 角标要能**对上号**：正文里写 `[3]`，用户点它必须看到第 3 条来源。用圆点就丢了
 * 这个对应关系，而模型在正文里写的编号是它自己算的（`[1]` 指第一条来源），
 * 界面必须尊重这个编号，不能重新排。
 *
 * ## 边界
 *
 * 只认 `[数字]` 这一种写法（模型被提示词约束成这个格式）。`[abc]`、`[1,2]`
 * 这类一律按普通文本渲染 —— 猜错会把正文里的方括号内容变成假链接。
 */
import { useId, useState } from 'react'
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'
import { parseAnswerBlocks, type AnswerBlock } from './answer-blocks.ts'
import { parseAnswerInline, type AnswerInlineToken } from './answer-inline.ts'
import css from './ask-cite-detail.module.css'
import runCss from './answer-run.module.css'

/** 引用条目类型（与 `cite-target.ts` 的 `CiteItem` 同源）。 */
type CiteItem = NonNullable<AskResult['citations']>[number]

/** 正文片段：普通文本 或 引用角标。 */
type Piece = { kind: 'text'; text: string } | { kind: 'cite'; n: number }

/** 完成态回答超过这个体量就默认折叠，避免一屏被长篇回答占满。 */
const COLLAPSE_CHARS = 500
const COLLAPSE_BLOCKS = 6

/**
 * 把正文切成「文本 / 角标」片段。
 *
 * 只认 `[n]`（n 为正整数）。**连续角标**（`[1][2][3]`）会切成三个独立角标 ——
 * 这是刻意的：每个都要能单独点，合并成一个「1,2,3」会让用户没法只点其中一个。
 * @param text - 回答正文。
 * @returns 片段列表（顺序与原文一致）。
 */
export function splitCiteMarks(text: string): Piece[] {
  const out: Piece[] = []
  const re = /\[(\d{1,3})\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    out.push({ kind: 'cite', n: Number(m[1]) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/**
 * 回答正文。
 *
 * @param props.text - 回答正文（含 `[n]` 标记）。
 * @param props.citations - 本次回答的来源（角标编号对应它的下标 +1）。
 * @param props.onOpenCite - 点角标时回调（打开详情面板）。
 * @param props.activeCite - 当前正在看的那条（高亮它，让用户知道「点的是这条」）。
 * @returns 正文元素。
 */
export function AnswerBody({ text, citations, onOpenCite, activeCite, streaming }: {
  text: string
  citations?: CiteItem[]
  onOpenCite?: (n: number) => void
  activeCite?: number
  streaming?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const pieces = splitCiteMarks(text)
  const total = citations?.length ?? 0
  const citationsPending = streaming === true && total === 0
  const blocks = parseAnswerBlocks(text)
  // 流式阶段始终展示最新正文，结束后再按长回答规则折叠。
  const long = !streaming && (text.length > COLLAPSE_CHARS || blocks.length > COLLAPSE_BLOCKS)
  const shown = long && !expanded ? previewBlocks(blocks) : blocks

  const renderCiteGroup = (marks: readonly number[], key: string): React.ReactNode => {
    const children: React.ReactNode[] = []
    marks.forEach((n, index) => {
      const valid = n >= 1 && n <= total
      const markKey = `${key}:${String(index)}:${String(n)}`
      if (citationsPending) {
        children.push(
          <span
            key={markKey}
            className={css.citeMark}
            data-pending
            role="status"
            aria-label={`第 ${n} 条来源正在生成`}
            title="来源正在生成"
          >
            {n}
          </span>,
        )
      } else {
        children.push(
          <button
            key={markKey}
            type="button"
            className={css.citeMark}
            data-valid={valid || undefined}
            data-active={activeCite === n || undefined}
            disabled={!valid}
            title={valid ? `查看第 ${n} 条来源` : `第 ${n} 条来源不存在（AI 标错了编号）`}
            aria-label={valid ? `查看第 ${n} 条来源` : `第 ${n} 条来源不存在`}
            onClick={() => { if (valid) onOpenCite?.(n) }}
          >
            {n}
          </button>,
        )
      }
      if (index < marks.length - 1) {
        children.push(<span key={`${markKey}:sep`} className={css.citeSeparator} aria-hidden="true">,</span>)
      }
    })
    return (
      <span key={key} className={css.citeGroup} data-pending={citationsPending || undefined}>
        {children}
      </span>
    )
  }

  const inline = (value: string, key: string): React.ReactNode[] => (
    renderInlineTokens(parseAnswerInline(value), key, renderCiteGroup)
  )

  return (
    <div
      className={`${css.answerBody} ${runCss.answer}`}
      data-streaming={streaming || undefined}
      data-collapsed={long && !expanded ? true : undefined}
    >
      <div
        id={contentId}
        className={runCss.answerContent}
        data-collapsed={long && !expanded ? true : undefined}
      >
        {shown.map((block, index) => renderBlock(block, index, inline))}
      </div>
      {long && (
        <button
          type="button"
          className={runCss.moreButton}
          onClick={() => { setExpanded(value => !value) }}
          aria-expanded={expanded}
          aria-controls={contentId}
        >
          {expanded ? '收起全文' : `展开全文（共 ${String(text.length)} 字）`}
        </button>
      )}
      {pieces.length === 0 && !streaming && <span className={runCss.emptyAnswer}>（回答为空）</span>}
    </div>
  )
}

function blockLength(block: AnswerBlock): number {
  if (block.type === 'list') return block.items.join('').length
  if (block.type === 'code') return block.code.length
  return block.text.length
}

const PREVIEW_BLOCKS = 4
const PREVIEW_CHARS = 380

/** 展开前只放有界预览；被省略的引用不会留在不可见的 Tab 顺序里。 */
function previewBlocks(blocks: readonly AnswerBlock[]): AnswerBlock[] {
  const out: AnswerBlock[] = []
  let remaining = PREVIEW_CHARS
  for (const block of blocks) {
    if (out.length >= PREVIEW_BLOCKS || remaining <= 0) break
    const preview = previewBlock(block, remaining)
    out.push(preview)
    remaining -= blockLength(preview)
  }
  return out.length > 0 ? out : blocks.slice(0, 1).map(block => previewBlock(block, PREVIEW_CHARS))
}

function clipped(value: string, budget: number): string {
  if (value.length <= budget) return value
  return `${value.slice(0, Math.max(0, budget)).trimEnd()}…`
}

function previewBlock(block: AnswerBlock, budget: number): AnswerBlock {
  if (blockLength(block) <= budget) return block
  if (block.type === 'list') {
    const items: string[] = []
    let remaining = budget
    for (const item of block.items) {
      if (remaining <= 0) break
      const next = clipped(item, remaining)
      items.push(next)
      remaining -= next.length
    }
    return { ...block, items: items.length > 0 ? items : [clipped(block.items[0] ?? '', budget)] }
  }
  if (block.type === 'code') return { ...block, code: clipped(block.code, budget) }
  return { ...block, text: clipped(block.text, budget) }
}

type InlineRenderer = (value: string, key: string) => React.ReactNode[]

type CiteGroupRenderer = (marks: readonly number[], key: string) => React.ReactNode

const LIST_ITEM_DATE_RE = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?)\s*[：:]\s*/

function renderListItemText(
  value: string,
  key: string,
  inline: InlineRenderer,
): React.ReactNode {
  const date = LIST_ITEM_DATE_RE.exec(value)
  if (date === null) return inline(value, key)
  const label = date[1] ?? ''
  const [day = '', time = ''] = label.split(/[ T]/)
  const dateTime = `${day.replaceAll('/', '-')}${time === '' ? '' : `T${time}`}`
  return [
    <time key={`${key}:date`} className={runCss.answerListItemDate} dateTime={dateTime}>
      {label}
    </time>,
    ...inline(value.slice(date[0].length), `${key}:body`),
  ]
}

function renderInlineTokens(
  tokens: readonly AnswerInlineToken[],
  key: string,
  renderCites: CiteGroupRenderer,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]!
    if (token.kind === 'cite') {
      const marks: number[] = []
      let end = index
      while (end < tokens.length) {
        const next = tokens[end]
        if (next?.kind !== 'cite') break
        marks.push(next.n)
        end += 1
      }
      nodes.push(renderCites(marks, `${key}:cite:${String(index)}`))
      index = end
      continue
    }
    if (token.kind === 'text') {
      nodes.push(<span key={`${key}:t:${String(index)}`}>{token.text}</span>)
    } else if (token.kind === 'code') {
      nodes.push(<code key={`${key}:code:${String(index)}`}>{token.text}</code>)
    } else if (token.kind === 'strong') {
      nodes.push(
        <strong key={`${key}:strong:${String(index)}`}>
          {renderInlineTokens(token.children, `${key}:strong:${String(index)}`, renderCites)}
        </strong>,
      )
    } else {
      nodes.push(
        <em key={`${key}:em:${String(index)}`}>
          {renderInlineTokens(token.children, `${key}:em:${String(index)}`, renderCites)}
        </em>,
      )
    }
    index += 1
  }
  return nodes
}

function renderBlock(
  block: AnswerBlock,
  index: number,
  inline: InlineRenderer,
): React.ReactNode {
  const key = `block:${String(index)}`
  if (block.type === 'heading') {
    if (block.level === 1) return <h2 key={key}>{inline(block.text, key)}</h2>
    if (block.level === 2) return <h3 key={key}>{inline(block.text, key)}</h3>
    return <h4 key={key}>{inline(block.text, key)}</h4>
  }
  if (block.type === 'list') {
    const items = block.items.map((item, itemIndex) => (
      <li key={`${key}:${String(itemIndex)}`}>
        {renderListItemText(item, `${key}:${String(itemIndex)}`, inline)}
      </li>
    ))
    return block.ordered
      ? <ol key={key}>{items}</ol>
      : <ul key={key}>{items}</ul>
  }
  if (block.type === 'quote') {
    return <blockquote key={key}>{inline(block.text, key)}</blockquote>
  }
  if (block.type === 'code') {
    return (
      <pre key={key} data-language={block.language || undefined}>
        <code>{block.code}</code>
      </pre>
    )
  }
  return (
    <p key={key} data-answer-lead={index === 0 ? '' : undefined}>
      {inline(block.text, key)}
    </p>
  )
}

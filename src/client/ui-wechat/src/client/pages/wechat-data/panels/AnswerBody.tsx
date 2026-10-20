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
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'
import css from './ask-cite-detail.module.css'

/** 引用条目类型（与 `cite-target.ts` 的 `CiteItem` 同源）。 */
type CiteItem = NonNullable<AskResult['citations']>[number]

/** 正文片段：普通文本 或 引用角标。 */
type Piece = { kind: 'text'; text: string } | { kind: 'cite'; n: number }

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
export function AnswerBody({ text, citations, onOpenCite, activeCite }: {
  text: string
  citations?: CiteItem[]
  onOpenCite?: (n: number) => void
  activeCite?: number
}): React.JSX.Element {
  const pieces = splitCiteMarks(text)
  const total = citations?.length ?? 0
  return (
    <div className={css.answerBody}>
      {pieces.map((p, i) => {
        if (p.kind === 'text') return <span key={i}>{p.text}</span>
        // 编号超出实际来源数 ⇒ 模型编了一个不存在的引用。渲染成**不可点**的角标，
        // 而不是隐藏它 —— 隐藏会让用户以为模型没标引用，而实际是标错了。
        const valid = p.n >= 1 && p.n <= total
        return (
          <button
            key={i}
            type="button"
            className={css.citeMark}
            data-valid={valid || undefined}
            data-active={activeCite === p.n || undefined}
            disabled={!valid}
            title={valid ? `查看第 ${p.n} 条来源` : `第 ${p.n} 条来源不存在（模型标错了编号）`}
            onClick={() => { if (valid) onOpenCite?.(p.n) }}
          >
            {p.n}
          </button>
        )
      })}
    </div>
  )
}

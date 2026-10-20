/**
 * 问答引用来源列表 —— 从 `Ask.tsx` 拆出（该文件已顶到 1000 行上限）。
 *
 * 这里只放「来源怎么渲染」这一件事：编号、两类来源（消息 / 知识库文件）的
 * 展示要素、折叠展开、接地提示、点击去向。**判定「点了去哪」不在本文件** ——
 * 那是 `cite-target.ts` 的 `citeTarget()`，问答面板 / 会话内问答 / 历史弹窗共用一份。
 */
import { useState } from 'react'
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'
import { citeTarget, type CiteItem } from './cite-target.ts'
import { auditAnswerGrounding, groundingWarning } from './utils/grounding.ts'
import css from './ask.module.css'

/** 知识库来源的面包屑：`第 3 页 · 第二章 › 违约条款`（没有的项直接不出现，不留空段）。 */
function kbCrumb(kb: NonNullable<CiteItem['kb']>): string {
  return [kb.page > 0 ? `第 ${kb.page} 页` : '', kb.heading].filter(Boolean).join(' · ')
}

/** 引用条目的展示要素。
 *  两类来源的「第三格」含义不同：消息是**发生时间**（用户靠它认那条聊天），
 *  文件是**文件类型** —— 文件没有发生时间，写成 1970-01-01 才是撒谎。 */
function CiteFacts({ c, index }: { c: CiteItem; index: number }): React.JSX.Element {
  const kb = c.source === 'kb' ? c.kb : undefined
  if (kb) {
    return (
      <>
        <span className={css.citeIdx}>[{index}]</span>
        <span className={css.citeName} title={kb.fileName}>{kb.fileName}</span>
        <span className={css.citeTime}>{kb.fileExt ? kb.fileExt.toUpperCase() : '文件'}</span>
        {/* 面包屑优先于摘要：核对「是不是这一段」靠章节与页码，而摘要在文件里到处都是。 */}
        <span className={css.citeSnippet}>{kbCrumb(kb) || c.snippet}</span>
      </>
    )
  }
  return (
    <>
      <span className={css.citeIdx}>[{index}]</span>
      <span className={css.citeName}>{c.sender ? `${c.name} · ${c.sender}` : c.name}</span>
      <span className={css.citeTime}>{c.time}</span>
      <span className={css.citeSnippet}>{c.snippet}</span>
    </>
  )
}

/** 引用来源：2 列网格 + 默认折叠前 4 条（20 条平铺会吞没整屏）。
 *  回答正文里真正引用过的来源会高亮标记 —— 否则「来源 20 条」里哪些被用到了
 *  只能靠用户在答案里逐个对 [n]，等于没标。
 *
 *  ── 两类来源混在同一个编号里 ───────────────────────────────────
 *  编号仍是**一套**（消息在前、文件在后，顺序由后端决定）：模型在答案里写的 `[3]`
 *  必须只有一个含义，分成两套编号会让 `[3]` 有两种解释。
 *  但渲染上两者要一眼可分 —— 去向不同（消息→会话、文件→知识库·文件），
 *  长得一样会让用户以为点错了地方（`data-src` 上色，见 ask.module.css）。 */
export function CiteList({ items, cited, onOpen, onOpenKbFile, answer }: {
  items: NonNullable<AskResult['citations']>
  cited?: number[]
  onOpen?: (username: string, localId?: number) => void
  /** 知识库来源的跳转（跳到「知识库 · 文件」并选中那个文件）。
   *  不传时文件来源渲染成**只读块**：它的 `username` 是 `kb:<库>:<文件>` 这种合成键
   *  （检索侧为了让同文件分块归组而造的），拿去当会话开会打开一个不存在的会话，
   *  而且**不报错** —— 页面只是空着。 */
  onOpenKbFile?: (kbId: number, fileId: number) => void
  /** 对应的回答正文：用于「回答里的金额在所引原文里找不到」的接地提示（见 utils/grounding.ts）。 */
  answer?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const CAP = 4
  const shown = expanded ? items : items.slice(0, CAP)
  const citedSet = new Set(cited ?? [])
  const groundWarn = answer === undefined ? null : groundingWarning(auditAnswerGrounding(answer, items, cited))
  return (
    <div className={css.citeBlock}>
      <div className={css.citeHead}>
        <span className={css.citeHeadTitle}>
          来源 · {items.length} 条{citedSet.size > 0 ? `（回答引用了 ${citedSet.size} 条，已高亮）` : ''}（点击跳转原文）
        </span>
        {items.length > CAP && (
          <button type="button" className={css.citeMore} onClick={() => { setExpanded(v => !v) }}>
            {expanded ? '收起' : `展开全部 ${items.length} 条`}
          </button>
        )}
      </div>
      {groundWarn ? (
        <div className={css.citeWarn} role="note">⚠ {groundWarn}</div>
      ) : null}
      <div className={css.citeGrid}>
        {shown.map((c, ci) => {
          const citedMark = citedSet.has(ci + 1) || undefined
          const facts = <CiteFacts c={c} index={ci + 1} />
          // 「点了去哪」只由 citeTarget 决定（问答面板 / 会话内问答 / 历史弹窗共用一份判定）。
          const target = citeTarget(c)
          const key = `${c.source ?? 'msg'}:${c.username ?? ''}:${c.local_id ?? 0}:${ci}`
          if (target?.kind === 'kb') {
            const kb = c.kb
            const crumb = kb ? kbCrumb(kb) : ''
            const tip = `知识库文件《${kb?.fileName ?? c.name}》${crumb ? ' · ' + crumb : ''} · ${c.snippet}`
            if (!onOpenKbFile) {
              return (
                <div key={key} className={css.citeBtn} data-src="kb" data-cited={citedMark} title={`${tip}（在「知识库 · 文件」里查看）`}>
                  {facts}
                </div>
              )
            }
            return (
              <button
                key={key}
                type="button"
                className={css.citeBtn}
                data-src="kb"
                data-cited={citedMark}
                onClick={() => { onOpenKbFile(target.kbId, target.fileId) }}
                title={tip}
              >
                {facts}
              </button>
            )
          }
          return (
            <button
              key={key}
              type="button"
              className={css.citeBtn}
              data-cited={citedMark}
              data-src={target === null ? 'unknown' : undefined}
              onClick={() => { if (target?.kind === 'msg') onOpen?.(target.username, target.localId) }}
              title={`${c.sender ? `${c.name} · ${c.sender}` : c.name} · ${c.time} · ${c.snippet}`}
            >
              {facts}
            </button>
          )
        })}
      </div>
    </div>
  )
}

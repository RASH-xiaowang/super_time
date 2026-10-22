/**
 * 问答面板的空态引导卡与日期短格式。
 *
 * 只负责首次进入的提示，不参与提问、检索或生成；从 `Ask.tsx` 拆出是为了让
 * 面板主文件保持在 M21 的单文件行数上限内。
 */
import type { AskExampleCard } from './ask-examples.ts'
import css from './ask.module.css'

/** 空态能力行：三条一句话说明「这个面板能做什么 / 边界在哪」。 */
const CAPABILITIES = ['本机检索，不出网', '引用可跳转原文', '支持多轮追问']

/** 时间 chip 上的短日期显示：2026-09-11 → 09/11。 */
export function fmtShortDate(d: string): string {
  return d.length >= 10 ? d.slice(5).replace('-', '/') : d
}

/**
 * 空态引导卡（图标 + 标题 + 说明 + 能力行 + 示例问题）。
 *
 * @param props.noCorpus - 是否没有可检索的会话（决定说明文案与警示色）。
 * @param props.sessionCount - 可检索会话数（写进说明）。
 * @param props.examples - 按当前真实会话生成的示例卡。
 * @param props.onPick - 点示例问题（填入输入框并聚焦，**不**自动发送）。
 * @returns 引导卡元素。
 */
export function AskEmptyIntro({ noCorpus, sessionCount, examples, onPick }: {
  noCorpus: boolean
  sessionCount: number
  examples: readonly AskExampleCard[]
  onPick: (ex: string) => void
}): React.JSX.Element {
  return (
    <div className={css.emptyIntro}>
      <div className={css.emptyTitle}>向你的聊天记录提问</div>
      <div className={css.emptySub} data-warn={noCorpus || undefined}>
        {noCorpus
          ? '尚未检测到可检索的会话：请先在「数据配置」中设置数据目录并导入解密库'
          : `${sessionCount} 个会话可检索 · 回答会附上可点击跳转的本机来源`}
      </div>
      <div className={css.emptyCaps}>
        {CAPABILITIES.map(cap => (
          <span key={cap} className={css.emptyCap}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="m8.5 12.5 2.4 2.4L15.5 9.5" />
            </svg>
            {cap}
          </span>
        ))}
      </div>
      <div className={css.emptyExHead}>试试这样问</div>
      <div className={css.emptyExGrid}>
        {examples.map(ex => (
          <button key={ex.tag} type="button" className={css.emptyExCard} onClick={() => { onPick(ex.question) }}>
            <span className={css.emptyExTag}>{ex.tag}</span>
            <span className={css.emptyExText}>{ex.question}</span>
          </button>
        ))}
      </div>
      <div className={css.emptyHint}>点一张卡片直接填入，或在下方的输入框里自己写</div>
    </div>
  )
}

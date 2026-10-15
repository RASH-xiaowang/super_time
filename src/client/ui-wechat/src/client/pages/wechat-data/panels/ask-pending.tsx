/**
 * 问答「生成中」的那一块（W3-6.1 从 Ask.tsx 拆出）。
 *
 * 拆出来的直接原因：`AskPanel` 受 `function-size-ratchet.spec.ts` 的棘轮管着（登记 493 行，
 * 一行都不许多），而这一块原本只是「一行 pending 或一段流式正文」—— 加上「停止生成」之后
 * 变成三种状态的分支，留在面板里就要重排版。它不依赖面板状态（只拿 streamText 与 onStop），
 * 独立成件最合适。
 *
 * 三种状态的次序是刻意的：**流式正文 → 停止按钮 → 兜底的「正在分析…」行**。
 * 已经有增量时就展示正在写的正文（尾部光标表示还在写），那句「正在分析」在这时已经过时；
 * 而「停止生成」在两种情况下都要在，否则用户只能等它跑完。
 */
import css from './ask.module.css'

/** 生成中的展示：流式正文 / 兜底说明 + 「停止生成」。 */
export function AskPending({ streamText, onStop }: { streamText: string; onStop: () => void }): React.JSX.Element {
  return (
    <>
      {streamText
        ? (
          <div className={css.chatAi}>
            <div className={css.chatAnswer} data-streaming>
              {streamText}
              <span className={css.streamCaret} aria-hidden="true" />
            </div>
          </div>
        )
        : (
          <div className={css.chatPending}>
            <span className={css.chatDots} />
            正在分析问题意图 → 检索本机记录 → 综合生成回答…
          </div>
        )}
      {/* 停止生成：取消走后端 Remote cancelAsk（jobId 就是本轮的 streamId），
          已生成的部分会保留在界面上，不影响继续提问。 */}
      <button type="button" className={css.stopBtn} onClick={onStop} title="停止本轮回答的生成（已生成的部分会保留）">
        ■ 停止生成
      </button>
    </>
  )
}

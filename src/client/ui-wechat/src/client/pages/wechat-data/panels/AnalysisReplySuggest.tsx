/**
 * 消息分析区里的上下文推荐回复。
 *
 * 与会话级 `ReplySuggest` 的区别是读取边界：这里把分析中的 `localId` 一并交给后端，
 * 只读取截至这条消息的上下文。因此点开一条历史消息时，候选仍然回复当条消息，
 * 不会拿会话最新一句顶上。
 */
import { useEffect, useRef, useState } from 'react'
import { apiSuggestReplies } from '../api.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import css from './chat-analysis-panel.module.css'

/** `AnalysisReplySuggest` 的输入。 */
export interface AnalysisReplySuggestProps {
  /** 当前会话 username（同时也是后端读取范围）。 */
  username: string
  /** 分析面板当前选中的消息；候选回复以它为上下文终点。 */
  targetLocalId: number
}

/** 单批候选数量；产品口径固定为 3 条。 */
const REPLY_COUNT = 3

/**
 * Render three context-aware reply candidates for the analyzed message.
 * @param props - conversation username and the selected message id.
 * @returns the recommendation section.
 */
export function AnalysisReplySuggest(props: AnalysisReplySuggestProps): React.JSX.Element {
  const { username, targetLocalId } = props
  const [round, setRound] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [replies, setReplies] = useState<string[]>([])
  const [messageCount, setMessageCount] = useState<number | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)

  /** 目标/会话/换一批都会推进世代，过期响应不得写进当前面板。 */
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    setReplies([])
    setMessageCount(null)
    setCopied(null)
    setCopyFailed(false)

    if (username.trim() === '' || !Number.isFinite(targetLocalId) || targetLocalId <= 0) {
      setLoading(false)
      setError('缺少有效的会话或分析对象，请重新选择消息')
      return () => {
        if (seqRef.current === seq) seqRef.current += 1
      }
    }

    void apiSuggestReplies({
      username,
      targetLocalId: Math.trunc(targetLocalId),
      count: REPLY_COUNT,
    })
      .then((result) => {
        if (seq !== seqRef.current) return
        if (!result.ok) {
          setError(result.error ?? '生成推荐回复失败')
          return
        }
        setReplies((result.replies ?? []).slice(0, REPLY_COUNT))
        setMessageCount(result.messageCount ?? null)
      })
      .catch((reason: unknown) => {
        if (seq === seqRef.current) setError((reason as Error).message)
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false)
      })

    return () => {
      if (seqRef.current === seq) seqRef.current += 1
    }
  }, [username, targetLocalId, round])

  const copy = (text: string, index: number): void => {
    const seq = seqRef.current
    setCopyFailed(false)
    void copyTextToClipboard(text).then((ok) => {
      if (seq !== seqRef.current) return
      if (ok) setCopied(index)
      else setCopyFailed(true)
    })
  }

  const configHint = error !== null && /(模型|LLM|密钥|provider)/i.test(error)
    ? '请到「数据配置 → AI 大模型」检查默认模型与密钥后重试。'
    : '稍后重试；切换消息时也会自动重新生成。'

  return (
    <section className={css.replySection} aria-label="上下文推荐回复">
      <div className={css.replyHead}>
        <div className={css.replyHeading}>
          <span className={css.cardLabel}>可直接发送</span>
          <strong>{replies.length > 0 ? `${String(replies.length)} 条推荐回复` : '推荐回复'}</strong>
          <p>针对当前分析消息及此前对话生成，三条分别是不同回应方向。</p>
        </div>
        <button
          type="button"
          className={css.textBtn}
          disabled={loading}
          onClick={() => { setRound(value => value + 1) }}
        >
          {loading ? '生成中…' : '换一批'}
        </button>
      </div>

      {loading && (
        <div className={css.replyLoading} role="status">
          <span className={css.replyDot} aria-hidden="true" />
          正在结合这条消息和前后文生成 3 条回复…
        </div>
      )}

      {!loading && error !== null && (
        <div className={css.replyError} role="alert">
          <strong>这次没有生成推荐回复</strong>
          <p>{error}</p>
          <p>{configHint}</p>
          <button type="button" className={css.secondaryBtn} onClick={() => { setRound(value => value + 1) }}>
            重新生成
          </button>
        </div>
      )}

      {!loading && error === null && replies.length > 0 && (
        <>
          <div className={css.replyList}>
            {replies.map((reply, index) => (
              <article className={css.replyCard} key={`${String(index)}:${reply.slice(0, 16)}`}>
                <span className={css.replyIndex} aria-hidden="true">{String(index + 1)}</span>
                <p>{reply}</p>
                <button
                  type="button"
                  className={css.copyBtn}
                  aria-label={`复制第 ${String(index + 1)} 条推荐回复`}
                  onClick={() => { copy(reply, index) }}
                >
                  {copied === index ? '已复制' : '复制'}
                </button>
              </article>
            ))}
          </div>
          {copyFailed && (
            <p className={css.copyError} role="alert">复制失败：剪贴板没有被写入，请手动选中文字后复制。</p>
          )}
          <p className={css.replyBasis}>
            {messageCount === null ? '依据当前会话截至这条消息的对话' : `依据当前会话截至这条消息的 ${String(messageCount)} 条对话`}
            {' '}· 本应用只读，不会替你发送
          </p>
        </>
      )}

      {!loading && error === null && replies.length === 0 && (
        <div className={css.replyError} role="status">
          <strong>模型没有给出可用候选</strong>
          <p>可以直接重试，不会影响左侧消息分析结果。</p>
          <button type="button" className={css.secondaryBtn} onClick={() => { setRound(value => value + 1) }}>
            重新生成
          </button>
        </div>
      )}
    </section>
  )
}

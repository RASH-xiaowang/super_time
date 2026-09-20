/**
 * 单聊的「推荐回复」面板：按当前会话上下文（+ 当前选中的知识库）生成候选回复。
 *
 * 与会话级 AI 面板（`SessionAsk.tsx`）是**姊妹面板**：同一处视觉语言（共用
 * `session-ask.module.css` 的面板外壳与建议卡样式）、同一处挂载位置（消息流右侧第三栏）、
 * 同一个原则 —— **读取范围恒为当前会话**，不跨会话取别处的聊天。
 *
 * 与问答的区别：这里是**一次生成、一次呈现**（不做多轮、不流式），产出物是「可以照着发
 * 的句子」。本应用只读、没有发送微信消息的代码路径，所以唯一的动作是**复制**。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiSuggestReplies } from '../api.ts'
import { useKbScope } from './kb-scope.ts'
import css from './session-ask.module.css'

/** 面板所需的最小会话信息（与 `WechatSession` 的前缀兼容）。 */
export interface ReplyTarget {
  username: string
  displayName?: string
}

/** `ReplySuggestProps` 的字段说明见各成员注释。 */
export interface ReplySuggestProps {
  /** 目标会话（读取范围就是它）。 */
  target: ReplyTarget
  /** 关闭面板。 */
  onClose: () => void
}

/**
 * Render the per-session「推荐回复」panel.
 * @param props - see `ReplySuggestProps`.
 * @returns panel element tree.
 */
export function ReplySuggest(props: ReplySuggestProps): React.JSX.Element {
  const { target, onClose } = props
  const { kbId, kbs } = useKbScope()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replies, setReplies] = useState<string[]>([])
  const [basis, setBasis] = useState<{ messages: number; kb: number; degraded?: string } | null>(null)
  const [copied, setCopied] = useState<number | null>(null)

  const kbName = kbs.find(k => k.id === kbId)?.name ?? ''

  /** 请求世代：切会话/换库/「换一批」都会作废在途请求（过期响应不许写进当前面板）。 */
  const seqRef = useRef(0)

  /** 取一批候选。切会话/换库后也会重取（依赖里都带上了）。 */
  const load = useCallback((): void => {
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    setCopied(null)
    void apiSuggestReplies({ username: target.username, kbId })
      .then((r) => {
        if (seq !== seqRef.current) return
        if (!r.ok) {
          setReplies([])
          setBasis(null)
          setError(r.error ?? '生成失败')
          return
        }
        setReplies(r.replies ?? [])
        setBasis({
          messages: r.messageCount ?? 0,
          kb: r.kbSnippetCount ?? 0,
          ...(r.degraded ? { degraded: r.degraded } : {}),
        })
      })
      .catch((e: unknown) => { if (seq === seqRef.current) setError((e as Error).message) })
      .finally(() => { if (seq === seqRef.current) setLoading(false) })
  }, [target.username, kbId])

  useEffect(() => { load() }, [load])

  const copy = (text: string, index: number): void => {
    try {
      void navigator.clipboard.writeText(text)
      setCopied(index)
    } catch { /* 剪贴板不可用：让用户自己选中复制，不打断流程 */ }
  }

  return (
    <div className={css.panel} aria-label="推荐回复">
      <div className={css.head}>
        <div className={css.title}>推荐回复</div>
        <div className={css.headActions}>
          <button type="button" className={css.iconBtn} title="换一批" aria-label="换一批"
            disabled={loading} onClick={() => { load() }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
            </svg>
          </button>
          <button type="button" className={css.iconBtn} title="关闭推荐回复" aria-label="关闭推荐回复" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 依据（只读）：说清这次到底看了什么 —— 别笼统写「已参考」 */}
      <div className={css.scopeRow}>
        <span className={css.scopeLabel}>依据</span>
        <span className={css.scopeName} title={target.username}>
          {target.displayName || target.username}{basis ? ` · ${String(basis.messages)} 条对话` : ''}
          {basis && basis.kb > 0 ? ` · 知识库「${kbName}」${String(basis.kb)} 段` : ''}
        </span>
      </div>

      <div className={css.body}>
        {loading && <div className={css.introSub}>正在按这段对话生成候选…</div>}
        {!loading && error !== null && (
          <div className={css.introSub}>
            {error}
            <br />
            <span className={css.scopeLabel}>（被隐私设置拦下时，去「数据边界与出网」里关掉「禁止 AI 出网」）</span>
          </div>
        )}
        {!loading && error === null && replies.length > 0 && (
          <>
            <div className={css.sugList}>
              {replies.map((r, i) => (
                <div key={`${String(i)}:${r.slice(0, 12)}`} className={css.sugCard}>
                  <span className={css.sugText}>{r}</span>
                  <button type="button" className={css.iconBtn} title="复制这条回复"
                    aria-label={`复制第 ${String(i + 1)} 条回复`} onClick={() => { copy(r, i) }}>
                    {copied === i ? '已复制' : '复制'}
                  </button>
                </div>
              ))}
            </div>
            <div className={css.introSub}>
              {basis?.degraded ? `${basis.degraded}。` : ''}
              本应用只读，不会替你发消息 —— 复制后到微信里粘贴。
            </div>
          </>
        )}
        {!loading && error === null && replies.length === 0 && (
          <div className={css.introSub}>这个会话还没有可用的对话内容。</div>
        )}
      </div>
    </div>
  )
}

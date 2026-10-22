/**
 * 引用详情面板 —— 点正文角标后从**右侧滑出**的那块。
 *
 * ## 为什么是「滑出面板」而不是「跳走」
 *
 * 用户的原话：「聊条信息默认保留在窗口中充当上下文」。引用详情如果做成跳转
 * （切到会话页 / 知识库页），用户就**丢了当前问答的上下文** —— 回来还得重新找
 * 刚才问的是什么。滑出面板让左侧对话原样留着，右侧只占一块，看完关掉即可继续追问。
 *
 * ## 为什么详情里要能「归档」
 *
 * 面板是**临时视图**（关掉就没了），而有些引用值得留下（「这条转账记录以后还要看」）。
 * 「归档」把它推进历史记录（`AskHistoryDialog`）—— 那是**持久**的那一份。
 * 两者分工：面板 = 此刻看一眼，历史 = 以后还能找回来。
 *
 * ## 为什么消息详情要显示「上下文」
 *
 * 单条消息常常看不懂（「收到转账120.00元」—— 谁转的？前后说了什么？）。
 * 所以详情里给**前后各若干条**，让用户不用跳走就能判断「是不是这条」。
 * 上下文由调用方传入（它已经持有会话数据），本组件不自己取 —— 取数逻辑
 * 只该有一份，放在面板里会让「会话内问答」那条链路再写一遍。
 */
import { useEffect, useState } from 'react'
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'
import { citeTarget, type CiteItem } from './cite-target.ts'
import { readableCiteError, type CiteContextStatus, type ContextMessage } from './use-cite-detail.ts'
import css from './ask-cite-detail.module.css'

/** 知识库来源的面包屑：`第 3 页 · 第二章 › 违约条款`。 */
function kbCrumb(kb: NonNullable<CiteItem['kb']>): string {
  return [kb.page > 0 ? `第 ${kb.page} 页` : '', kb.heading].filter(Boolean).join(' · ')
}

/**
 * 引用详情面板。
 *
 * @param props.item - 当前查看的引用（`null` = 面板关闭）。
 * @param props.index - 它的编号（与正文角标一致）。
 * @param props.context - 消息上下文（仅消息来源有；知识库来源传空数组）。
 * @param props.contextStatus - 上下文加载状态（加载中 / 空 / 失败 / 缺定位）。
 * @param props.contextError - 已归一的失败原因（不含堆栈）。
 * @param props.onRetryContext - 失败后的重试动作。
 * @param props.onClose - 关闭回调。
 * @param props.onOpenSource - 「跳转到原文」回调（离开问答去会话/知识库）。
 * @param props.onArchive - 「归档」回调（推进历史记录）。
 * @param props.overlay - 强制**覆盖式**（不占布局宽度）。
 *   会话内问答的抽屉空间有限，切 320px 给详情会把正文压到不可读 ——
 *   那里必须覆盖。宽屏的「微信问答」面板则并排（不传这个 prop）。
 * @returns 面板元素；`item` 为 null 时返回 null。
 */
export function CiteDetailPanel({
  item, index, context, contextStatus, contextError, onRetryContext,
  onClose, onOpenSource, onOpenKbFile, onArchive, overlay,
}: {
  item: CiteItem | null
  index: number
  context?: ContextMessage[]
  contextStatus?: CiteContextStatus
  contextError?: string | null
  onRetryContext?: () => void
  onClose: () => void
  onOpenSource?: (username: string, localId?: number) => void
  onOpenKbFile?: (kbId: number, fileId: number) => void | Promise<void>
  onArchive?: () => void
  overlay?: boolean
}): React.JSX.Element | null {
  const [kbBusy, setKbBusy] = useState(false)
  const [kbError, setKbError] = useState('')
  const itemKey = item ? `${item.source ?? 'msg'}:${item.username ?? ''}:${item.local_id ?? 0}:${item.kb?.fileId ?? 0}` : ''
  useEffect(() => {
    setKbBusy(false)
    setKbError('')
  }, [itemKey])

  const openKb = async (kbId: number, fileId: number): Promise<void> => {
    if (!onOpenKbFile || kbBusy) return
    setKbBusy(true)
    setKbError('')
    try {
      await onOpenKbFile(kbId, fileId)
    } catch (e) {
      setKbError(readableCiteError(e, '无法打开知识库文件，请确认原文件仍在磁盘上'))
    } finally {
      setKbBusy(false)
    }
  }

  if (!item) return null
  const kb = item.source === 'kb' ? item.kb : undefined
  const target = citeTarget(item)
  const ctx = context ?? []
  const status = contextStatus ?? (ctx.length > 0 ? 'ready' : 'idle')
  return (
    <aside className={css.citeDetail} data-overlay={overlay || undefined} aria-label={`第 ${index} 条来源详情`}>
      <div className={css.citeDetailHead}>
        <span className={css.citeDetailIdx}>[{index}]</span>
        <span className={css.citeDetailTitle}>
          {kb ? kb.fileName : (item.sender ? `${item.name} · ${item.sender}` : item.name)}
        </span>
        <button type="button" className={css.citeDetailClose} onClick={onClose} title="关闭详情（对话仍在左侧）" aria-label="关闭详情">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className={css.citeDetailMeta}>
        {kb ? (
          <>
            <span className={css.citeDetailTag} data-src="kb">{kb.fileExt ? kb.fileExt.toUpperCase() : '文件'}</span>
            {kbCrumb(kb) ? <span className={css.citeDetailTime}>{kbCrumb(kb)}</span> : null}
          </>
        ) : (
          <>
            <span className={css.citeDetailTag}>消息</span>
            <span className={css.citeDetailTime}>{item.time}</span>
          </>
        )}
      </div>

      {/* 被引用的原文：这是「精准跳转」的落点 —— 用户点角标就是为了看它。 */}
      <div className={css.citeDetailBody}>{item.snippet}</div>

      {/* 消息上下文：单条消息常常看不懂，给前后几条让用户自己判断。
          知识库来源完全不进这一区（文件块没有「会话附近消息」这回事）。 */}
      {!kb && status === 'loading' && (
        <div className={css.citeDetailCtx} data-state="loading" role="status">
          <div className={css.citeDetailCtxHead}>上下文</div>
          <div className={css.citeDetailCtxState}>正在读取附近消息…</div>
        </div>
      )}
      {!kb && status === 'empty' && (
        <div className={css.citeDetailCtx} data-state="empty">
          <div className={css.citeDetailCtxHead}>上下文</div>
          <div className={css.citeDetailCtxState}>这条引用附近没有更多消息。</div>
        </div>
      )}
      {!kb && status === 'error' && (
        <div className={css.citeDetailCtx} data-state="error" role="alert">
          <div className={css.citeDetailCtxHead}>上下文</div>
          <div className={css.citeDetailCtxState}>
            {contextError || '附近消息读取失败。可以重试，或直接打开会话原文核对。'}
          </div>
          <div className={css.citeDetailCtxActions}>
            {onRetryContext && (
              <button type="button" className={css.citeDetailCtxRetry} onClick={onRetryContext}>重试</button>
            )}
            <span className={css.citeDetailCtxHint}>也可以先点下方「打开会话原文」核对。</span>
          </div>
        </div>
      )}
      {!kb && status === 'unavailable' && (
        <div className={css.citeDetailCtx} data-state="unavailable">
          <div className={css.citeDetailCtxHead}>上下文</div>
          <div className={css.citeDetailCtxState}>
            这条引用缺少可用的消息定位信息，暂时无法加载附近消息。
          </div>
          <div className={css.citeDetailCtxHint}>可点下方「打开会话原文」，按时间与内容人工核对。</div>
        </div>
      )}
      {!kb && status === 'ready' && ctx.length > 0 && (
        <div className={css.citeDetailCtx}>
          <div className={css.citeDetailCtxHead}>上下文</div>
          <div className={css.citeDetailCtxList}>
            {ctx.map(m => (
              <div key={m.key} className={css.citeDetailCtxRow} data-focus={m.focus || undefined}>
                <span className={css.citeDetailCtxWho}>{m.sender}</span>
                <span className={css.citeDetailCtxTime}>{m.time}</span>
                <span className={css.citeDetailCtxText}>{m.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={css.citeDetailActions}>
        {/* 「跳转到原文」是**离开**问答的动作，所以放次要位；主位留给「归档」。 */}
        {target?.kind === 'msg' && onOpenSource && (
          <button type="button" className={css.citeDetailGhost} onClick={() => { onOpenSource(target.username, target.localId) }}>
            打开会话原文
          </button>
        )}
        {target?.kind === 'kb' && onOpenKbFile && (
          <button
            type="button"
            className={css.citeDetailGhost}
            disabled={kbBusy}
            onClick={() => { void openKb(target.kbId, target.fileId) }}
          >
            {kbBusy ? '正在打开…' : '打开知识库文件'}
          </button>
        )}
        {onArchive && (
          <button type="button" className={css.citeDetailPrimary} onClick={onArchive} title="把这轮问答归档到历史记录">
            归档到历史记录
          </button>
        )}
      </div>
      {kbError !== '' && <div className={css.citeDetailError} role="alert">{kbError}</div>}
    </aside>
  )
}

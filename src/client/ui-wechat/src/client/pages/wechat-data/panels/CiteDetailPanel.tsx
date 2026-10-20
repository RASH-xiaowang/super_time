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
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'
import { citeTarget, type CiteItem } from './cite-target.ts'
import css from './ask-cite-detail.module.css'

/** 知识库来源的面包屑：`第 3 页 · 第二章 › 违约条款`。 */
function kbCrumb(kb: NonNullable<CiteItem['kb']>): string {
  return [kb.page > 0 ? `第 ${kb.page} 页` : '', kb.heading].filter(Boolean).join(' · ')
}

/** 上下文里的一条消息（由调用方从会话数据里切出来）。 */
export interface ContextMessage {
  /** 稳定键（用于 React key）。 */
  key: string
  /** 发送者显示名。 */
  sender: string
  /** 时间（`YYYY-MM-DD HH:mm`）。 */
  time: string
  /** 正文。 */
  text: string
  /** 是不是被引用的那一条（高亮它）。 */
  focus?: boolean
}

/**
 * 引用详情面板。
 *
 * @param props.item - 当前查看的引用（`null` = 面板关闭）。
 * @param props.index - 它的编号（与正文角标一致）。
 * @param props.context - 消息上下文（仅消息来源有；知识库来源传空数组）。
 * @param props.onClose - 关闭回调。
 * @param props.onOpenSource - 「跳转到原文」回调（离开问答去会话/知识库）。
 * @param props.onArchive - 「归档」回调（推进历史记录）。
 * @param props.overlay - 强制**覆盖式**（不占布局宽度）。
 *   会话内问答的面板只有 384px，切 320px 给详情会把正文压到不可读 ——
 *   那里必须覆盖。宽屏的「微信问答」面板则并排（不传这个 prop）。
 * @returns 面板元素；`item` 为 null 时返回 null。
 */
export function CiteDetailPanel({ item, index, context, onClose, onOpenSource, onOpenKbFile, onArchive, overlay }: {
  item: CiteItem | null
  index: number
  context?: ContextMessage[]
  onClose: () => void
  onOpenSource?: (username: string, localId?: number) => void
  onOpenKbFile?: (kbId: number, fileId: number) => void
  onArchive?: () => void
  overlay?: boolean
}): React.JSX.Element | null {
  if (!item) return null
  const kb = item.source === 'kb' ? item.kb : undefined
  const target = citeTarget(item)
  const ctx = context ?? []
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

      {/* 消息上下文：单条消息常常看不懂，给前后几条让用户自己判断。 */}
      {ctx.length > 0 && (
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
        {onArchive && (
          <button type="button" className={css.citeDetailPrimary} onClick={onArchive} title="把这轮问答归档到历史记录">
            归档到历史记录
          </button>
        )}
      </div>
    </aside>
  )
}

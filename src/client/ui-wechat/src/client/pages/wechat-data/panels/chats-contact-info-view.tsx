
/**
 * 单聊「聊天信息」抽屉（P2-6，2026-09-25 补齐——群聊版 chats-group-info 的姊妹件）。
 *
 * 与群抽屉的差异：无成员网格/无公告/无成员搜索，取而代之的是**跨域统计**——
 * 数据来自现成的 `apiGetContact360`（消息总数/首末时间/朋友圈/转账红包/共同群），
 * 面板不新造后端。行结构照搬已审计的「标签左 / 值右」形态（chat-panel-visual-audit P1-8）。
 *
 * 自包含：数据获取在组件内部（open && session 变化时拉取，alive 防竞态），
 * 外部只需要 `open / session / onClose / onExport` 四个 props —— chats-view.tsx
 * 已 960 行（M21 上限 1000），接线面必须保持最小。
 */
import { useEffect, useId, useState } from 'react'
import { apiGetContact360 } from '../api.ts'
import type { Contact360Snapshot, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Avatar } from './chats-support.tsx'
import css from './chats-contact-info.module.css'

function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface ChatsContactInfoViewProps {
  /** 抽屉是否打开。 */
  open: boolean
  /** 当前会话（仅单聊渲染；群聊由 chats-group-info 管）。 */
  session: WechatSession | null
  onClose: () => void
  /** 「导出聊天记录」→ 联动既有的导出对话框（exportSession，真实能力）。 */
  onExport: () => void
}

/**
 * 渲染单聊信息抽屉。
 * @param props - 见 {@link ChatsContactInfoViewProps}。
 * @returns 抽屉元素；非单聊或未打开时为 null。
 */
export function ChatsContactInfoView({ open, session, onClose, onExport }: ChatsContactInfoViewProps): React.JSX.Element | null {
  const [data, setData] = useState<Contact360Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open || !session) return
    let alive = true
    setLoading(true)
    setErr(null)
    setData(null)
    void apiGetContact360(session.username)
      .then((r) => { if (alive) setData(r) })
      .catch((e: unknown) => { if (alive) setErr((e as Error).message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, session])

  if (!open || !session || session.type === 'group') return null

  return (
    <div
      className={css.drawer}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-st-dialog="chats-contactinfo"
    >
      <div className={css.header}>
        <span className={css.title} id={titleId}>聊天信息</span>
        <button type="button" className={css.close} title="关闭" aria-label="关闭" onClick={onClose}><IconCloseOutline16 size={15} /></button>
      </div>
      <div className={css.body}>
        {loading && <div className={css.empty}>加载中…</div>}
        {err && <div className={css.empty}>{err}</div>}
        {!loading && !err && data && (
          <>
            <div className={css.profile}>
              <Avatar name={data.displayName} username={data.username} size={48} />
              <div className={css.profileMeta}>
                <span className={css.profileName}>{data.displayName}</span>
                <span className={css.profileId}>{data.username}</span>
              </div>
            </div>

            <div className={css.rows}>
              <div className={css.row}>
                <span className={css.rowLabel}>消息总数</span>
                <span className={css.rowValue}>{data.messages.count.toLocaleString()}</span>
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>首次联系</span>
                <span className={css.rowValue}>{fmtDate(data.messages.firstTime)}</span>
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>最近联系</span>
                <span className={css.rowValue}>{fmtDate(data.messages.lastTime)}</span>
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>朋友圈</span>
                <span className={css.rowValue}>{data.moments.count.toLocaleString()} 条</span>
              </div>
              {data.funds.transfers > 0 && (
                <div className={css.row}>
                  <span className={css.rowLabel}>转账往来</span>
                  <span className={css.rowValue}>{data.funds.transfers} 次</span>
                </div>
              )}
              {data.funds.redpackets > 0 && (
                <div className={css.row}>
                  <span className={css.rowLabel}>红包往来</span>
                  <span className={css.rowValue}>{data.funds.redpackets} 次</span>
                </div>
              )}
            </div>

            {data.commonGroups.length > 0 && (
              <div className={css.groups}>
                <div className={css.groupsHd}>共同的群（{data.commonGroups.length}）</div>
                {data.commonGroups.map((g) => (
                  <div key={g.username} className={css.groupItem}>
                    <span className={css.groupName}>{g.name || g.username}</span>
                    <span className={css.groupMeta}>{g.memberCount} 人</span>
                  </div>
                ))}
              </div>
            )}

            <div className={css.exportRow}>
              <button type="button" className={css.exportBtn} onClick={onExport}>
                导出聊天记录
              </button>
            </div>
          </>
        )}
        {!loading && !err && !data && <div className={css.empty}>暂无数据</div>}
      </div>
    </div>
  )
}

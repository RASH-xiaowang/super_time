
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
 *
 * 实时刷新（2026-10-13）：抽屉开着时订阅宿主数据事件，**静默**重取 360 统计 ——
 * 不订阅的话，「消息总数 / 最近联系」停在打开那一刻（与群聊抽屉同族缺陷）。
 * 落地前过 `infoRefreshApplies`：期间被关掉或切了会话，旧响应一律丢弃。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { apiGetContact360 } from '../api.ts'
import type { Contact360Snapshot, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { EmptyState, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import { ListSkeleton, useWechatDataUpdated } from './hooks.tsx'
import { infoRefreshApplies } from './chats-info-live.ts'
import { Avatar } from './chats-support.tsx'
import { InfoRow, SectionTitle } from './chats-info-rows.tsx'
import { TaskCreateDialog } from './task-create-dialog.tsx'
import { fmtDateSec } from '../utils/format.ts'
import css from './chats-contact-info.module.css'
import cssrows from './chats-rows.module.css'
import cssshell from './chats-shell.module.css'
import taskCss from './task-create.module.css'

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
  const [taskOpen, setTaskOpen] = useState(false)
  const titleId = useId()
  // 抽屉关掉时收掉弹窗：本组件常驻渲染树，不重置的话下次开抽屉会直接弹出旧弹窗。
  useEffect(() => { if (!open) setTaskOpen(false) }, [open])

  /*
   * Esc 关闭 + 焦点陷阱（R7 补齐，审计 P1-7 的同族缺口）。
   *
   * 这是手写覆盖层，Radix 的 Dialog 那套白送行为一概没有。此前只做了「点遮罩关闭」，
   * 键盘用户按 Esc 没反应、Tab 会跑到抽屉背后的会话列表上（`chats-thread.tsx` 的
   * 群抽屉记录过同一事故）。两条 hook 放在**组件内部**：本组件刻意保持自包含
   * （见文件头注：`chats-view.tsx` 已近 M21 上限，接线面必须最小），
   * 所以不给父级加状态，用已有的 `open` 属性直接驱动。
   */
  useEscapeToClose(open, onClose)
  useDialogFocus(open, '[data-st-dialog="chats-contactinfo"]')

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

  /*
   * 数据事件后的静默重取。静默 = 不置 loading、不清已画的数据（清掉会闪骨架屏）；
   * 失败保留旧值（与缓存后台复验失败同一降级口径）。落地前过 infoRefreshApplies：
   * 响应到达时抽屉已被关掉、或会话已切走（旧请求属于上一个联系人），一律丢弃。
   */
  const openRef = useRef(open)
  openRef.current = open
  const sessionRef = useRef(session)
  sessionRef.current = session
  const refreshContact360 = useCallback((): void => {
    if (!openRef.current) return
    const target = sessionRef.current
    if (!target || target.type === 'group') return
    const fetchedFor = target.username
    void apiGetContact360(fetchedFor)
      .then((r) => {
        const cur = sessionRef.current
        if (!infoRefreshApplies(openRef.current, fetchedFor, cur?.username ?? null)) return
        setData(r)
        setErr(null)
      })
      .catch(() => { /* 静默：保留旧值，下一次事件再试 */ })
  }, [])
  useWechatDataUpdated(refreshContact360)

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
        {loading && <ListSkeleton rows={4} />}
        {err && <div className={kitCss.error} role="alert">⚠️ {err}</div>}
        {!loading && !err && data && (
          <>
            <div className={css.zones}>
              {/* 区① 联系人 tile：与群成员网格同一语法（D5）—— 头像 48 + 名下昵称，取代原 profile 横排块。 */}
              <div className={cssshell.memberGrid}>
                <div className={cssrows.memberTile} data-static="true" title={data.displayName}>
                  <Avatar name={data.displayName} username={data.username} size={48} />
                  <span className={cssrows.memberName}>{data.displayName}</span>
                </div>
              </div>

              {/* 区② 资料行（官方行语法；微信号/朋友圈只读，不给箭头） */}
              <InfoRow first label="微信号" value={data.username} />
              <InfoRow label="朋友圈" value={`${data.moments.count.toLocaleString()} 条`} />

              {/* 区④ 本机统计：工作台自有数据，独立分组、官方行语法（D6） */}
              <SectionTitle>本机统计</SectionTitle>
              <InfoRow first label="消息总数" value={data.messages.count.toLocaleString()} />
              <InfoRow label="首次联系" value={fmtDateSec(data.messages.firstTime)} />
              <InfoRow label="最近联系" value={fmtDateSec(data.messages.lastTime)} />
              {data.funds.transfers > 0 && <InfoRow label="转账往来" value={`${data.funds.transfers} 次`} />}
              {data.funds.redpackets > 0 && <InfoRow label="红包往来" value={`${data.funds.redpackets} 次`} />}

              {/* 区⑤ 关联：共同的群（无则整块不渲染） */}
              {data.commonGroups.length > 0 && (
                <>
                  <SectionTitle>{`共同的群（${data.commonGroups.length}）`}</SectionTitle>
                  {data.commonGroups.map((g, i) => (
                    <InfoRow key={g.username} first={i === 0} label={g.name || g.username} value={`${g.memberCount} 人`} />
                  ))}
                </>
              )}
            </div>

            {/* 区⑥ 底部动作位：全宽贴底（官方底部按钮槽；D7）。2026-10-19 起并排「新建任务」。 */}
            <div className={css.exportRow}>
              <div className={taskCss.drawerActions}>
                <button type="button" className={`${css.exportAction} ${css.exportActionPrimary}`} onClick={() => { setTaskOpen(true) }}>
                  新建任务
                </button>
                <button type="button" className={css.exportAction} onClick={onExport}>
                  导出聊天记录
                </button>
              </div>
            </div>
          </>
        )}
        {!loading && !err && !data && (
          <div className={css.empty}>
            <EmptyState
              icon="🧑"
              title="读不到这个联系人的信息"
              desc="可能是该会话已不在本机库里，或它没有任何可比对的聊天记录。关掉这个抽屉、重新选中会话再试一次。"
            />
          </div>
        )}
      </div>
      {taskOpen && <TaskCreateDialog session={session} onClose={() => { setTaskOpen(false) }} />}
    </div>
  )
}

/**
 * 会话头部的**动作按钮排**（M21 自 `chats-view.tsx` 拆出，2026-09-26）。
 *
 * 为什么要拆：加完右栏两块按钮后 `chats-view.tsx` 涨到 1039 行，越过 M21 的 1000 行上限。
 * 这一块本身内聚（AI 问答 / 推荐回复 / 分析 / 日历 / 群信息 / 聊天信息 / 更多菜单），
 * 道具全是布尔与回调 ⇒ 扁平透传即可，符合本仓展示组件的约定。
 *
 * 三条语义提醒（写在这里免得后人踩）：
 *  · **推荐回复按钮只对单聊出现** —— 「回一句」在群里不成立；
 *  · **「分析」按钮群聊也出现** —— 分析读的是当前会话，群聊同样是会话（2026-09-26 修正）；
 *  · 两个按钮是右栏两块**唯一**的入口（那两块已不再是常驻内容），所以按下时要有 active 态，
 *    并带 `aria-expanded`。
 *
 * AI 回复的**开关与设置**（2026-11-18 按用户要求从「更多」搬到头部，紧跟「AI 问答」）：
 * 它们与 AI 问答是同类动作（都在当前会话上生成内容），所以放在同一个动作带里。
 * 文案沿用菜单叫法；窄列（容器 ≤560px）由 `.calBtnLabel` 收敛规则自动退成纯图标。
 *
 * 宽度纪律：动作区是实测瓶颈（P0-2 审计：960px 时连「群信息」都点不到）⇒ 新增按钮要么
 * 纯图标，要么用 `.calBtnLabel` 包住文字（那一档会在窄列隐藏）。低频动作（导出 /
 * 已编辑 / 清空草稿 / 立即检查 AI 回复）继续收在「更多」里。
 */
import { useEffect, useState } from 'react'
import cssrows from './chats-rows.module.css'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { TaskCreateDialog } from './task-create-dialog.tsx'
import {
  ChatAiReplyHeaderButtons,
  ChatAiReplyMenu,
  ChatAiReplySettingsHost,
  type ChatAiReplyUiState,
} from './chat-ai-reply-menu.tsx'
import { IconCalendar } from './chats-support.tsx'
import {
  IconChevronLeftOutline14, IconDownloadOutline16, IconEllipsisOutline16, IconListPenOutline16,
  IconPlusOutline16, IconTrashOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { EditedMessageRecord, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { useMenuDismiss } from './use-menu-dismiss.ts'

export interface ChatsHeadActionsProps {
  /** 当前会话（动作按单聊/群聊分叉）。 */
  curSession: WechatSession
  /** AI 问答是否可用（单聊/群聊）及其展开态。 */
  aiEligible: boolean
  aiOpen: boolean
  setAiOpen: React.Dispatch<React.SetStateAction<boolean>>
  setAiFull: React.Dispatch<React.SetStateAction<boolean>>
  /** 右栏「推荐回复」（只对单聊出现）。 */
  /** 右栏「分析」（群聊也能单独打开）。 */
  analysisPaneOpen: boolean
  setAnalysisPaneOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 消息日历。 */
  openCalendar: () => void
  /** 群聊信息（只对群聊）。 */
  groupInfoOpen: boolean
  openGroupInfo: () => void
  setGroupInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 单聊「聊天信息」（只对单聊）。 */
  contactInfoOpen: boolean
  setContactInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 溢出菜单：导出 / 已编辑 / 清空草稿。 */
  moreOpen: boolean
  setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>
  exporting: boolean
  editing: boolean
  edits: readonly EditedMessageRecord[]
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>
  openEdits: () => void
  clearAllDrafts: () => void
  clearDraft: () => void
  /**
   * 手机档（≤560）的「返回会话列表」。**不给就不画这枚按钮**。
   *
   * 为什么在这里画而不是在渲染树里另起一处：三栏在手机上塌成单栏栈之后，
   * 「回到列表」是唯一的返回路径，而它要挂在 `.msgHeader` 里 —— 那一格的 JSX 全在
   * `chats-view.tsx#ChatsView`，那个函数在**函数行数棘轮**台账上（376 行、只许变小），
   * 加不了行；这一份不在台账上，所以按钮住这里，桌面端由 CSS 藏掉。
   */
  onBackToList?: () => void
  /** 会话级自动回复：null = 加载中/不可用；单聊与群聊都显示。 */
  aiReply?: ChatAiReplyUiState
  /** 单聊跳到这个联系人的朋友圈。不给就不画按钮；群聊没有「这个人的朋友圈」。 */
  onOpenMoments?: (username: string) => void
}

/**
 * 渲染会话头部的动作按钮排。
 * @param props - 见 {@link ChatsHeadActionsProps}。
 * @returns 动作区元素。
 */
export function ChatsHeadActions(props: ChatsHeadActionsProps): React.JSX.Element {
  const {
    curSession, aiEligible, aiOpen, setAiOpen, setAiFull,
    analysisPaneOpen, setAnalysisPaneOpen, openCalendar, groupInfoOpen, openGroupInfo,
    setGroupInfoOpen, contactInfoOpen, setContactInfoOpen, moreOpen, setMoreOpen, exporting, editing, edits,
    setExportOpen, openEdits, clearAllDrafts, clearDraft, onBackToList, aiReply, onOpenMoments,
  } = props
  /** 「新建任务」弹窗（触发式任务：关键词 + 对象 + 照片档位）只在点开时渲染，不占头部布局。 */
  const [taskOpen, setTaskOpen] = useState(false)
  const [aiReplySettingsOpen, setAiReplySettingsOpen] = useState(false)
  const { rootRef: moreRootRef, triggerRef: moreTriggerRef } = useMenuDismiss(moreOpen, () => { setMoreOpen(false) })
  useEffect(() => {
    setAiReplySettingsOpen(false)
  }, [curSession.username])
  return (
    <>
    <div className={cssshell.msgHeaderActions}>
              {/*
                手机档的「返回会话列表」：绝对定位在头部左上角，桌面端 `display: none`
                （三栏并排，返回不成立）。它排在这一堆按钮**前面**只是为了 DOM 顺序读起来
                像「先返回、再动作」，实际位置由 CSS 决定。
              */}
              {onBackToList && (
                <button
                  type="button"
                  className={cssshell.msgBackBtn}
                  onClick={onBackToList}
                  title="返回会话列表"
                  aria-label="返回会话列表"
                >
                  <IconChevronLeftOutline14 size={16} />
                </button>
              )}
              {/*
                头部动作按微信「简洁克制」收敛：常驻动作只剩
                ① AI 问答（本会话的核心动作，单聊/群聊才有）；
                ② AI 回复开关 + AI 回复设置（单聊与群聊；群聊只回 @我 的消息）。
                其余全部低频动作收进「更多▾」。
                原先 6 个平铺按钮在 1280px 下已经把消息列挤到只剩 ~460px
                （审计 P0-2 / NV-07），低频动作（推荐、分析、日历、群信息、聊天信息、
                导出、已编辑、清空草稿、新建任务）全部走菜单，一个功能都不少。
                窄列下文字标签由 `.calBtnLabel` 自动隐藏，不会顶出消息区。
              */}
              {aiEligible && (
                <button
                  type="button"
                  className={cssrows.calBtn}
                  data-active={aiOpen || undefined}
                  aria-expanded={aiOpen}
                  title="AI 问答：基于本会话聊天记录提问，回答附原文出处"
                  onClick={() => {
                    setAiOpen(v => !v)
                    setAiFull(false)
                    setAnalysisPaneOpen(false)
                    setContactInfoOpen(false)
                    setGroupInfoOpen(false)
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
                  </svg>
                  <span className={cssshell.calBtnLabel}>AI 问答</span>
                </button>
              )}
              {/*
                AI 回复的开关与设置（2026-11-18 按用户要求从「更多」搬到此处，
                紧跟「AI 问答」—— 两者都是「在当前会话上生成内容」的同类动作）。
                纯图标：头部动作区是宽度瓶颈，见 chats-rows.module.css 的 .calBtnIcon。
                组件自身按「aiReply.visible」决定是否渲染。
              */}
              <ChatAiReplyHeaderButtons
                curSession={curSession}
                aiReply={aiReply}
                onOpenSettings={() => { setAiReplySettingsOpen(true) }}
              />
              {curSession.type === 'private' && onOpenMoments && (
                <button
                  type="button"
                  className={cssrows.calBtn}
                  title="查看这个联系人的朋友圈"
                  aria-label="查看朋友圈"
                  onClick={() => { onOpenMoments(curSession.username) }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="8" />
                    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                  </svg>
                  <span className={cssshell.calBtnLabel}>朋友圈</span>
                </button>
              )}
              <div className={cssshell.msgHeaderMoreWrap} data-st-menu="msg-header-more" ref={moreRootRef}>
                <button
                  ref={moreTriggerRef}
                  type="button"
                  className={cssrows.calBtn}
                  title="更多操作"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  data-active={moreOpen || undefined}
                  onClick={() => { setMoreOpen(v => !v) }}
                >
                  <IconEllipsisOutline16 size={14} /><span className={cssshell.calBtnLabel}>更多</span>
                </button>
                {moreOpen && (
                  <div className={csscards.msgHeaderMoreMenu} role="menu" aria-label="更多操作">
                    {/*
                      右栏「回复助手」的唯一入口（2026-09-26 加、2026-10-19 移进「更多」）。
                      2026-11-18：分析 + 推荐回复合并成一个面板，因此入口合成一条 ——
                      点它打开/收起右栏，面板里同时有「这条消息怎么理解」与「可以这样回」。
                      群聊没有「回一句」的语义，标题随之变成「消息分析」。
                    */}
                    <button
                      type="button"
                      role="menuitem"
                      className={csscards.msgHeaderMoreItem}
                      data-active={analysisPaneOpen || undefined}
                      aria-expanded={analysisPaneOpen}
                      title={curSession.type === 'group'
                        ? '消息分析：打开右栏看待分析结论（点消息切换分析对象）'
                        : '回复助手：打开右栏，同时看这条消息怎么理解与可以怎么回'}
                      aria-label="回复助手"
                      onClick={() => {
                        setMoreOpen(false)
                        if (!analysisPaneOpen) {
                          setAiOpen(false)
                          setAiFull(false)
                          setContactInfoOpen(false)
                          setGroupInfoOpen(false)
                        }
                        setAnalysisPaneOpen(v => !v)
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.2A7.5 7.5 0 1 1 20 11.5Z" />
                        <path d="M8.6 10.4h6.8M8.6 13.4h4" />
                      </svg>
                      {curSession.type === 'group' ? '消息分析' : '回复助手'}
                    </button>
                    <ChatAiReplyMenu
                      curSession={curSession}
                      aiReply={aiReply}
                      onCloseMenu={() => { setMoreOpen(false) }}
                    />
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem} title="消息日历（每日消息数热力图）" onClick={() => { setMoreOpen(false); void openCalendar() }}>
                      <IconCalendar />消息日历
                    </button>
                    {curSession.type === 'group' && (
                      <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem} data-active={groupInfoOpen || undefined} title="群聊信息" onClick={() => { setMoreOpen(false); setAiOpen(false); setAiFull(false); setAnalysisPaneOpen(false); setContactInfoOpen(false); openGroupInfo() }}>
                        <IconUserOutline16 size={14} />群聊信息
                      </button>
                    )}
                    {curSession.type !== 'group' && (
                      <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem} data-active={contactInfoOpen || undefined} title="聊天信息" onClick={() => { setMoreOpen(false); setAiOpen(false); setAiFull(false); setAnalysisPaneOpen(false); setGroupInfoOpen(false); setContactInfoOpen(true) }}>
                        <IconUserOutline16 size={14} />聊天信息
                      </button>
                    )}
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem}
                      onClick={() => { setMoreOpen(false); setTaskOpen(true) }}>
                      <IconPlusOutline16 size={14} />新建任务
                    </button>
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem} disabled={exporting || desktopAction()}
                      onClick={() => { setMoreOpen(false); setExportOpen(true) }} {...desktopActionProps()}>
                      <IconDownloadOutline16 size={14} />{desktopAction() ? '导出消息（仅电脑）' : '导出消息'}
                    </button>
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem} disabled={editing}
                      onClick={() => { setMoreOpen(false); void openEdits() }}>
                      <IconListPenOutline16 size={14} />已编辑消息{edits.length > 0 ? ` (${String(edits.length)})` : ''}
                    </button>
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem}
                      onClick={() => { setMoreOpen(false); void clearAllDrafts() }}>
                      <IconTrashOutline16 size={14} />清空所有会话草稿
                    </button>
                    {curSession.draft && (
                      <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem}
                        onClick={() => { setMoreOpen(false); void clearDraft() }}>
                        <IconTrashOutline16 size={14} />清空本会话草稿
                      </button>
                    )}
                  </div>
                )}
              </div>
    </div>
    {taskOpen && <TaskCreateDialog session={curSession} onClose={() => { setTaskOpen(false) }} />}
    <ChatAiReplySettingsHost
      curSession={curSession}
      aiReply={aiReply}
      open={aiReplySettingsOpen}
      onClose={() => { setAiReplySettingsOpen(false) }}
    />
    </>
  )
}

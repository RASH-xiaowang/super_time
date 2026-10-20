/**
 * 群聊信息抽屉（#19 第五刀切出；D0/D1 微信对齐重排，2026-10-13）。
 *
 * 六区骨架（docs/CHATS-INFO-WECHAT-ALIGN.html §3）：
 *  区⓪ 头部（标题 16/600 + 关闭 ≥32×32，保持）→ 区① 成员网格（头像 48 · 名单行省略 · 群主标 ·
 *  ＋ 死控件）→ 区② 资料行（群聊名称 / 群公告 / 群主 / 群成员数，标签 12 值 14 · 1px 分隔 · 48px 行）
 *  → 区⑥ 底部动作位（导出贴底）。
 *
 * 切这一屏的原始理由不变：只在群聊且打开时才存在、加载中/失败/有数据三态互斥、搜索无结果必须有空态
 * （审计 P0-3）、成员头像懒挂载（P2-4）、行结构「标签左 / 值右」（P1-8）。
 * 那颗**故意的死控件**也不变：网格末尾「＋ 添加」方块为布局保真保留，刻意不是 <button>、
 * 不挂 onClick、aria-disabled + title 说明（L13）。
 * 原区③ 四条只读开关行（免打扰 / 置顶 / 存通讯录 / 显成员昵称）已按用户要求移除：它们全是
 * 「本机只读」的死控件，四行排在一起既不给动作也不给真相，只占抽屉半屏。
 *
 * 「查看更多 / 收起」口径收在 `chats-member-view.ts#hasMoreMembers`（搜索态拿过滤结果比上限，
 * 不再出现「展开后按钮消失、收不回来」的洞）。
 */
import { useEffect, useState } from 'react'
import kitCss from '../ui/kit.module.css'
import { ErrorState, LoadingState } from '../ui/kit.tsx'
import type { GroupInfo, GroupMember } from '@deepseek-ai/dsh-wechat-data/types'
import { IconCloseOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { LazyMount } from './hooks.tsx'
import { Avatar } from './chats-support.tsx'
import { InfoRow } from './chats-info-rows.tsx'
import { hasMoreMembers, memberMoreLabel, showsAddTile } from './chats-member-view.ts'
import { TaskCreateDialog } from './task-create-dialog.tsx'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'
import taskCss from './task-create.module.css'

export interface ChatsGroupInfoViewProps {
  annCanExpand: boolean
  annExpanded: boolean
  annRef: React.MutableRefObject<HTMLDivElement | null>
  filteredMembers: GroupMember[]
  groupInfo: GroupInfo | null
  groupInfoErr: string | null
  groupInfoLoading: boolean
  groupInfoTitleId: string
  hideMemberProfile: () => void
  isGroup: boolean
  memberExpanded: boolean
  memberQuery: string
  memberSearch: string
  memberTotal: number
  open: boolean
  setAnnExpanded: React.Dispatch<React.SetStateAction<boolean>>
  setGroupInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
  setMemberExpanded: React.Dispatch<React.SetStateAction<boolean>>
  setMemberSearch: React.Dispatch<React.SetStateAction<string>>
  setProfileMember: React.Dispatch<React.SetStateAction<GroupMember | null>>
  showMemberProfile: (m: GroupMember, el: HTMLElement) => void
  shownMembers: GroupMember[]
  /** 区⑥ 底部动作位：联动既有导出对话框（与单聊抽屉同一出口）。 */
  onExport: () => void
}

/** 群公告行内预览：首行截断（全文在展开块里；官方行语法值域单行）。 */
function annPreview(ann: string): string {
  const line = ann.split('\n')[0] ?? ''
  return line.length > 16 ? `${line.slice(0, 16)}…` : line
}

/** 群主显示名：成员表里能对上就用昵称，对不上给 wxid（不谎称昵称）。 */
function ownerName(info: GroupInfo): string {
  const owner = info.owner ?? ''
  return info.members.find((m) => m.username === owner)?.name ?? owner
}

/** 公告署名行：编辑者 / 时间，缺哪个省哪个（都不存在时整行不渲染）。 */
function annMeta(info: GroupInfo): string {
  const parts: string[] = []
  if (info.announcementEditor !== undefined && info.announcementEditor !== '') parts.push(info.announcementEditor)
  if (info.announcementTime !== undefined && info.announcementTime > 0) {
    parts.push(new Date(info.announcementTime).toLocaleString('zh-CN', { hour12: false }))
  }
  return parts.join(' · ')
}

/**
 * 群聊信息抽屉。
 * @param props - 抽屉要读的表单/数据与写回它们的 setter（都来自 `useChatsGroupInfo`）。
 * @returns 只在「打开着」且「当前会话是群聊」时渲染，否则整块不出现。
 */
export function ChatsGroupInfoView(props: ChatsGroupInfoViewProps): React.JSX.Element | null {
  const {
    annCanExpand, annExpanded, annRef, filteredMembers, groupInfo, groupInfoErr, groupInfoLoading,
    groupInfoTitleId, hideMemberProfile, isGroup, memberExpanded, memberQuery, memberSearch, memberTotal,
    open, onExport, setAnnExpanded, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setProfileMember,
    showMemberProfile, shownMembers,
  } = props
  /** 底部动作位「新建任务」的弹窗开关（只在点开时渲染，抽屉本身不关心它）。 */
  const [taskOpen, setTaskOpen] = useState(false)
  // 抽屉关掉时顺手收掉弹窗：本组件常驻在渲染树里，不重置的话下次开抽屉会直接弹出旧弹窗。
  useEffect(() => { if (!open) setTaskOpen(false) }, [open])
  if (!open || !isGroup) return null
  return (
    <div
      className={csscards.groupInfo}
      role="dialog"
      aria-modal="true"
      aria-labelledby={groupInfoTitleId}
      data-st-dialog="chats-groupinfo"
    >
      <div className={csscards.groupInfoHeader}>
        <span className={cssshell.groupInfoTitle} id={groupInfoTitleId}>群聊信息</span>
        <button type="button" className={csscards.groupInfoClose} title="关闭" aria-label="关闭" onClick={() => { setGroupInfoOpen(false); setProfileMember(null) }}><IconCloseOutline16 size={15} /></button>
      </div>
      <div className={cssshell.groupInfoBody}>
        {groupInfoLoading && <LoadingState variant="compact" label="加载中…" />}
        {groupInfoErr && <ErrorState message={groupInfoErr} />}
        {/* 报错时**不画**成员网格：`groupInfo` 是上一次成功打开那个群的快照，
            把它留在错误下面，等于在 B 群的抽屉里显示 A 群的人（与消息流「归属不符只给骨架」同一条规矩）。 */}
        {!groupInfoLoading && !groupInfoErr && groupInfo && (
          <div className={csscards.groupZones}>
            <div className={cssrows.memberSearchBox}>
              <div className={cssrows.searchIcon}><IconSearchOutline16 size={13} /></div>
              <input
                type="text"
                placeholder="搜索群成员"
                value={memberSearch}
                onChange={(e) => { setMemberSearch(e.target.value) }}
              />
            </div>
            {memberQuery && filteredMembers.length === 0 ? (
              /* 搜索无结果必须给空态：此前网格直接渲染成 0 高度，界面只剩一片空白（审计 P0-3） */
              <div className={csscards.memberEmpty}>
                <div className={cssshell.memberEmptyIcon}><IconSearchOutline16 size={22} /></div>
                <div className={cssshell.memberEmptyTitle}>未找到相关成员</div>
                <div className={cssshell.memberEmptyDesc}>
                  群里共 {memberTotal} 位成员，试试昵称或微信号的其它片段
                </div>
                <button type="button" className={csscards.memberEmptyClear} onClick={() => { setMemberSearch('') }}>
                  清空搜索
                </button>
              </div>
            ) : (
              <>
                <div className={cssshell.memberGrid}>
                  {shownMembers.map(m => (
                    <button
                      type="button"
                      key={m.username}
                      className={cssrows.memberTile}
                      title={m.name}
                      onMouseEnter={(e) => { showMemberProfile(m, e.currentTarget) }}
                      onMouseLeave={hideMemberProfile}
                    >
                      {/* 与会话列表同一套懒挂载：展开到 200 人时不再一次性发起 200 个头像请求（审计 P2-4） */}
                      <LazyMount placeholder={<span className={css.avatarStub} style={{ width: 48, height: 48 }} />} rootMargin="300px 0px">
                        <Avatar name={m.name} username={m.username} size={48} />
                      </LazyMount>
                      {groupInfo.owner === m.username && <span className={cssrows.memberBadge}>群主</span>}
                      <span className={cssrows.memberName}>{m.name}</span>
                    </button>
                  ))}
                  {/*
                    故意的死控件（L13）：微信「聊天信息」页的成员网格末尾就是这个「＋ 添加」方块，
                    而本应用只**读**本机聊天库，没有可用的邀请/入群通道。保留它的理由是布局保真。
                    因此它刻意不可交互：不是 <button>、不挂 onClick、aria-disabled + title 说明原因，
                    并且不给任何 hover 反馈让外观也不像可点。
                  */}
                  {showsAddTile(memberQuery) && (
                    <div className={cssrows.memberTile} data-disabled="true" title="暂不支持邀请" aria-disabled="true">
                      <div className={cssrows.memberAdd}><span>＋</span></div>
                      <span className={cssrows.memberName}>添加</span>
                    </div>
                  )}
                </div>
                <div className={csscards.memberCount}>共 {memberTotal} 位成员</div>
              </>
            )}
            {/* 有查询词时不再用「256 人」这个与过滤结果无关的数字（审计 P1-4） */}
            {hasMoreMembers(filteredMembers.length, memberTotal, memberQuery) && (
              <button type="button" className={csscards.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                {memberMoreLabel(memberExpanded, filteredMembers.length, memberTotal, memberQuery)}
              </button>
            )}
            <div className={cssshell.groupInfoRows}>
              <InfoRow first label="群聊名称" value={groupInfo.name} />
              {groupInfo.announcement !== '' && (
                <div className={cssshell.groupInfoRowStack}>
                  <div className={cssrows.infoRow}>
                    <span className={cssrows.infoLabel}>群公告</span>
                    <span className={cssrows.infoValueWrap}>
                      {!annExpanded && <span className={cssrows.infoValue}>{annPreview(groupInfo.announcement)}</span>}
                      {annCanExpand && (
                        <button
                          type="button"
                          className={cssrows.infoChevronBtn}
                          onClick={() => { setAnnExpanded(v => !v) }}
                          aria-label={annExpanded ? '收起群公告' : '展开群公告'}
                        >
                          <span className={cssrows.infoChevron} aria-hidden="true">{annExpanded ? '︿' : '﹀'}</span>
                        </button>
                      )}
                    </span>
                  </div>
                  <div ref={annRef} className={csscards.groupInfoAnn} data-clamp={!annExpanded || undefined}>
                    {groupInfo.announcement}
                  </div>
                  {annMeta(groupInfo) !== '' && <div className={csscards.groupInfoAnnMeta}>{annMeta(groupInfo)}</div>}
                </div>
              )}
              {groupInfo.owner !== undefined && groupInfo.owner !== '' && (
                <InfoRow label="群主" value={ownerName(groupInfo)} />
              )}
              <InfoRow label="群成员数" value={String(memberTotal)} />
            </div>
          </div>
        )}
      </div>
      {/* 区⑥ 底部动作位：固定在抽屉底部的独立 footer，**不再放进滚动内容区**。
          2026-10-19 用户截图显示它压在成员名/「查看更多」上：滚动区里 auto 边距只在
          内容不足一屏时才把按钮推到底，内容一高就失效。现在它是 `groupInfo` 的第三个
          直接子元素（header / 滚动 body / footer），任何内容高度下都不与资料行重叠。 */}
      <div className={cssshell.groupExport}>
        {/* 2026-10-19：动作位从「只有导出」变成「新建任务 + 导出」。新建任务依赖群成员表，
            所以群信息还没读到时禁用（而不是弹一个选不了人的弹窗）。 */}
        <div className={taskCss.drawerActions}>
          <button
            type="button"
            className={`${csscards.groupExportBtn} ${csscards.groupExportPrimary}`}
            disabled={groupInfo === null}
            title={groupInfo === null ? '群信息加载中，暂不能新建任务' : '新建任务：关键词命中时记录并回调'}
            onClick={() => { setTaskOpen(true) }}
          >
            新建任务
          </button>
          <button type="button" className={csscards.groupExportBtn} onClick={onExport}>
            导出聊天记录
          </button>
        </div>
      </div>
      {taskOpen && groupInfo !== null && (
        <TaskCreateDialog
          session={{ username: groupInfo.username, displayName: groupInfo.name, type: 'group' }}
          onClose={() => { setTaskOpen(false) }}
        />
      )}
    </div>
  )
}

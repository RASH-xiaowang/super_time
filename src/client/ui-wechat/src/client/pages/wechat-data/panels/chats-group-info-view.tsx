/**
 * 群聊信息抽屉（#19 第五刀，自 `chats-view.tsx` 那棵渲染树里切出）。
 *
 * 切这一屏的理由有两层。表层是它整块 110 行、零用例，而它管的都是"看得见对不对"的规矩：
 * 只在群聊且打开时才存在、加载中/失败/有数据三态互斥、搜索无结果必须有空态（审计 P0-3，
 * 原先是 0 高度的一片空白）、成员头像走懒挂载（展开到 200 人时不再一次发 200 个头像请求，审计 P2-4）、
 * 公告默认夹住并给出展开入口（审计 P1-5）、行结构是「标签左 / 值右」（审计 P1-8）。
 * 深层是那颗**故意的死控件**：网格末尾的「＋ 添加」方块为了布局保真而保留，
 * 但它刻意不是 `<button>`、不挂 `onClick`、带 `aria-disabled` —— 这类"看着像 bug 其实是设计"的代码
 * 最需要被用例钉住，否则下一次清理死代码的顺手一改就把理由抹平了。
 *
 * 顺带修一处不对称：「查看更多 / 收起」在搜索态原先拿"当前上限"当门槛，展开后上限从 24 涨到 200 ⇒
 * 命中 100 位时按钮整颗消失、用户收不回来（非搜索态一直比总数，没这个洞）。口径现收在
 * `chats-member-view.ts#hasMoreMembers`。
 */
import kitCss from '../ui/kit.module.css'
import { ErrorState, LoadingState } from '../ui/kit.tsx'
import type { GroupInfo, GroupMember } from '@deepseek-ai/dsh-wechat-data/types'
import { IconCloseOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { LazyMount } from './hooks.tsx'
import { Avatar } from './chats-support.tsx'
import { hasMoreMembers, memberMoreLabel, showsAddTile } from './chats-member-view.ts'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'

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
    open, setAnnExpanded, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setProfileMember,
    showMemberProfile, shownMembers,
  } = props
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
          <>
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
                    <LazyMount placeholder={<span className={css.avatarStub} style={{ width: 40, height: 40 }} />} rootMargin="300px 0px">
                      <Avatar name={m.name} username={m.username} size={40} />
                    </LazyMount>
                    <span className={cssrows.memberName}>{m.name}</span>
                  </button>
                ))}
                {/*
                  故意的死控件（L13）：微信「聊天信息」页的成员网格末尾就是这个「＋ 添加」方块，
                  而本应用只**读**本机聊天库，没有可用的邀请/入群通道（往群里加人要么走微信协议、
                  要么直接改对方数据库，两者都不该做）。保留它的理由是布局保真 —— 去掉会让
                  成员网格与官方形态不一致（视觉审计 P1-8 行结构）。
                  因此它刻意不可交互：不是 <button>（键盘/焦点不进来）、不挂 onClick、
                  aria-disabled + title 说明原因，并且不给任何 hover 反馈让外观也不像可点
                  （见 chats-rows.module.css 的 `.memberTile[data-disabled='true']` 规则）。
                  若将来真要做邀请，这里应换成打开确认对话框的按钮，而不是给它挂 onClick。
                */}
                {showsAddTile(memberQuery) && (
                  <div className={cssrows.memberTile} data-disabled="true" title="暂不支持邀请" aria-disabled="true">
                    <div className={cssrows.memberAdd}><span>＋</span></div>
                    <span className={cssrows.memberName}>添加</span>
                  </div>
                )}
              </div>
            )}
            {/* 有查询词时不再用「256 人」这个与过滤结果无关的数字（审计 P1-4） */}
            {hasMoreMembers(filteredMembers.length, memberTotal, memberQuery) && (
              <button type="button" className={csscards.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                {memberMoreLabel(memberExpanded, filteredMembers.length, memberTotal, memberQuery)}
              </button>
            )}
            {/* 微信的聊天信息是「标签左 / 值右」的列表行，不是「标签上 / 值下」的块（审计 P1-8 行结构） */}
            <div className={cssshell.groupInfoRows}>
              <div className={csscards.groupInfoRow}>
                <span className={cssshell.groupInfoRowLabel}>群聊名称</span>
                <span className={csscards.groupInfoRowValue}>{groupInfo.name}</span>
              </div>
              {groupInfo.announcement && (
                <div className={cssshell.groupInfoRowStack}>
                  <span className={cssshell.groupInfoRowLabel}>群公告</span>
                  <div ref={annRef} className={csscards.groupInfoAnn} data-clamp={!annExpanded || undefined}>
                    {groupInfo.announcement}
                  </div>
                  {annCanExpand && (
                    <button type="button" className={csscards.groupInfoAnnToggle} onClick={() => { setAnnExpanded(v => !v) }}>
                      {annExpanded ? '收起' : '展开'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

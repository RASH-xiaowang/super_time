
/**
 * Chats 面板的「群信息与成员」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import type { ChatlogFrame } from './chats-chatlog.ts'
import { useId, useRef, useState } from 'react'
import type { GroupInfo, GroupMember } from '@deepseek-ai/dsh-wechat-data/types'
import { filterMembers, memberLimitOf, memberQueryOf, profileAnchor } from './chats-member-view.ts'

export interface useChatsGroupInfoInputs {
}

export function useChatsGroupInfo(inputs: useChatsGroupInfoInputs) {
  const {  } = inputs
const [groupInfoOpen, setGroupInfoOpen] = useState(false)
const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null)
const [groupInfoLoading, setGroupInfoLoading] = useState(false)
const [groupInfoErr, setGroupInfoErr] = useState<string | null>(null)
const [memberSearch, setMemberSearch] = useState('')
const [memberExpanded, setMemberExpanded] = useState(false)
/**
 * 群公告展开态。公告是自由文本（实测样本 5 行）。
 * 原先 `.groupInfoValue` 用 -webkit-line-clamp:3 **静默**截断且没有展开入口 ——
 * 用户不知道内容被吃掉了（审计 P1-5）。这里给可展开的行内开关。
 */
const [annExpanded, setAnnExpanded] = useState(false)
const groupInfoTitleId = useId()
const [profileMember, setProfileMember] = useState<GroupMember | null>(null)
const [profilePos, setProfilePos] = useState<{ left: number; top: number } | null>(null)
const [chatlogStack, setChatlogStack] = useState<ChatlogFrame[]>([])
const profileHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

const showMemberProfile = (m: GroupMember, el: HTMLElement): void => {
  if (profileHideTimer.current) clearTimeout(profileHideTimer.current)
  setProfileMember(m)
  const rect = el.getBoundingClientRect()
  setProfilePos(profileAnchor({ left: rect.left, right: rect.right, top: rect.top }, window.innerHeight))
}

const hideMemberProfile = (): void => {
  if (profileHideTimer.current) clearTimeout(profileHideTimer.current)
  profileHideTimer.current = setTimeout(() => {
    setProfileMember(null)
    setProfilePos(null)
  }, 150)
}
const memberQuery = memberQueryOf(memberSearch)
const memberTotal = groupInfo ? groupInfo.members.length : 0
const filteredMembers = groupInfo ? filterMembers(groupInfo.members, memberQuery) : []
const memberLimit = memberLimitOf(memberExpanded)
const shownMembers = filteredMembers.slice(0, memberLimit)

  return { annExpanded, chatlogStack, filteredMembers, groupInfo, groupInfoErr, groupInfoLoading, groupInfoOpen, groupInfoTitleId, hideMemberProfile, memberExpanded, memberLimit, memberQuery, memberSearch, memberTotal, profileMember, profilePos, setAnnExpanded, setChatlogStack, setGroupInfo, setGroupInfoErr, setGroupInfoLoading, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setProfileMember, showMemberProfile, shownMembers }
}

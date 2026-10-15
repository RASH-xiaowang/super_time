/**
 * 群成员资料浮层（点头像后悬浮在旁），从 `chats-view.tsx` 拆出（#19 第八刀）。
 *
 * 值得单独一格的只有一件事：**没有的字段整行不画**，而不是画一行空的。
 * 微信的群成员资料里地区与签名经常是空的，若按"有键就渲染"写，浮层会出现
 * 「地区：（什么都没有）」这种行 —— 用户会以为对方填了又删了，而实际是从来没填。
 *
 * D2（2026-10-13 微信对齐）：头像**居左**、昵称在头像右侧（官方桌面端成员卡形态），
 * 取代原先「头像居中 + 昵称居中其下」；签名这类长文本的值域**占满行宽左对齐**，
 * 不再挤进右列窄槽折成三行（实测截图）。宽度 232px 不动（check:wx-tokens 钉住）。
 */
import { Avatar } from './chats-support.tsx'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'

/** 浮层要展示的那位群成员（缺失字段就是空/未定义）。 */
export interface MemberProfile {
  name: string
  username: string
  region?: string
  signature?: string
}

export interface ChatsMemberProfileProps {
  member: MemberProfile | null
  pos: { left: number; top: number } | null
}

/**
 * 渲染群成员资料浮层（`member` 或 `pos` 缺任一个都不画 —— 没有位置就不知道浮在哪）。
 * @returns 浮层元素或 null。
 */
export function ChatsMemberProfile({ member, pos }: ChatsMemberProfileProps): React.JSX.Element | null {
  if (!member || !pos) return null
  return (
    <div className={csscards.memberProfilePop} style={{ left: pos.left, top: pos.top }} data-st-member-profile={member.username}>
      <div className={cssshell.memberProfileBody}>
        <div className={cssshell.memberProfileHead}>
          <Avatar name={member.name} username={member.username} size={56} />
          <div className={cssshell.memberProfileName}>{member.name}</div>
        </div>
        <div className={csscards.memberProfileItem}>
          <span>微信号</span><span className={cssshell.memberProfileMono}>{member.username}</span>
        </div>
        {member.region && (
          <div className={csscards.memberProfileItem}>
            <span>地区</span><span className={cssshell.memberProfileMono}>{member.region}</span>
          </div>
        )}
        {member.signature && (
          <div className={`${csscards.memberProfileItem} ${csscards.memberProfileStack}`}>
            <span>签名</span><span className={cssshell.memberProfileSig}>{member.signature}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 「一条消息渲染项」的行组件工厂（#19 第二刀，自 `chats-thread.tsx#useChatsThread` 拆出）。
 *
 * 为什么要单独成文件：这一小段里藏着本面板**最容易静默变坏**的一条规则 —— 头像的身份键。
 * 它错了不会报错，只会「两个人显示同一张头像」或「某人头像永远占位」，
 * 而键错的具体那一支（用自己 ↔ 用对方 ↔ 用 sender wxid）在三条分支里各不同。
 * 拆出来之后它是**纯的**：给一份 item + 六份依赖，回一个元素，不碰任何 state。
 *
 * 虚拟化后每项要单独套一层定位容器，而**行内结构必须保持原样**
 * （`id="msg-<localId>"`、头像身份键、悬停时间戳这些都被守卫与深链依赖）。
 */
import { fmtMsgClockSec } from '../utils/format.ts'
import { renderKindOf } from '../utils/message-items.ts'
import type { MessageRenderItem } from '../utils/message-items.ts'
import { MessageBody } from './chats-cards.tsx'
import { MessageImageGroup } from './chats-media.tsx'
import { Avatar } from './chats-support.tsx'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import type { MessageRenderKind, MessageRich, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

export interface MsgRowDeps {
  curSession: WechatSession | null
  editedIds: ReadonlySet<number>
  openChatlog: (rich: MessageRich) => void
  openMsgMenu: (ev: React.MouseEvent, m: WechatMessage, kind: MessageRenderKind) => void
  openViewer: (m: WechatMessage) => void
  selfWxid: string
}

/** 系统提示（含撤回）/ 拍一拍 / 无内容：居中行，没有头像与气泡。 */
const CENTERED_KINDS: readonly string[] = ['system', 'revoke', 'pat', 'empty']

/**
 * 造出面板要的那个 `renderMsgItem`。
 * @param deps - 会话与回调（每次渲染重建一份，与拆前「内联函数捕获闭包」同形）。
 * @returns 渲染函数：日期分隔 / 系统行 / 普通气泡 / 图片组。
 */
export function makeMsgRow(deps: MsgRowDeps): (item: MessageRenderItem) => React.JSX.Element | null {
  const { curSession, editedIds, openChatlog, openMsgMenu, openViewer, selfWxid } = deps
  return function renderMsgItem(item: MessageRenderItem): React.JSX.Element | null {
    if (item.kind === 'day') {
      return <div className={cssrows.msgDayDivider}><span>{item.label}</span></div>
    }
    const head = item.kind === 'group' ? item.items[0] : item.m
    if (!head || !curSession) return null
    const kind = renderKindOf(head)
    if (CENTERED_KINDS.includes(kind)) {
      return (
        <div id={`msg-${head.localId}`} className={cssrows.msgRowSystem}>
          <MessageBody m={head} selfName={curSession.username} onOpenImage={openViewer} />
        </div>
      )
    }
    const isSelf = head.isSender === 1
    const isGroup = curSession.type === 'group'
    /*
     * 头像的身份键必须是真实 wxid，拿不到就留空（只渲染首字母占位）。
     *
     *  - 自己：用登录账号的 wxid。以前 fallback 到 `curSession.username`，
     *    那会把「我」键成**对方**的 username，于是自己和对方显示同一个头像；
     *    账号 wxid 未知时宁可不取头像，也不要取错。
     *  - 群成员：用消息里的 sender wxid；解析不出来时留空，
     *    绝不用昵称当键（群里同名成员会互相顶掉头像）。
     *  - 私聊对方：就是会话 username 本身。
     */
    const avUsername = isSelf
      ? selfWxid
      : (isGroup ? (head.sender ?? '') : curSession.username)
    const avName = isSelf ? '我' : (isGroup ? (head.senderName || head.sender || '') : curSession.displayName)
    const isEdited = editedIds.has(head.localId)
    return (
      <div
        id={`msg-${head.localId}`}
        className={`${css.msgRow} ${isSelf ? css.msgRowSelf : ''}`}
        onContextMenu={(ev) => { openMsgMenu(ev, head, kind) }}
      >
        <Avatar name={avName} username={avUsername} size={34} />
        <div className={css.msgCol}>
          {/* 悬停才出现的完整时间戳（微信行为）；已编辑折进同一枚气泡提示里 */}
          <span className={css.msgTimeChip}>
            {fmtMsgClockSec(head.createTime)}{isEdited ? ' · 已编辑' : ''}
          </span>
          {isGroup && !isSelf && head.sender && <div className={cssrows.msgSender}>{avName}</div>}
          {item.kind === 'group' ? (
            <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
              <MessageImageGroup items={item.items} username={curSession.username} onOpenAt={openViewer} />
            </div>
          ) : (
            <MessageBody
              m={item.m}
              selfName={curSession.username}
              onOpenImage={openViewer}
              onOpenChatlog={openChatlog}
            />
          )}
        </div>
      </div>
    )
  }
}

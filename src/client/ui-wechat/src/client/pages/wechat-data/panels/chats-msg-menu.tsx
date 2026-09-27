/**
 * 消息右键菜单（微信同款），从 `chats-view.tsx` 拆出（#19 第八刀）。
 *
 * 拆出来是因为这里有一条**顺序**规则，散在面板那 400 多行里最容易被人改反：
 * 点菜单项必须**先关菜单、再执行动作**。反过来的话，动作里任何一次 `setState`
 * （比如"复制成功"的提示、打开详情抽屉）都会和还挂着的菜单抢位置 ——
 * 用户看到的是菜单盖在新开的界面上，关都关不掉。
 * 「点空白处关掉」在这一格里；Esc 与滚动那两条在 `Chats.tsx` 里（那里已经有统一的关法，
 * 这一份**不再自己加一份** —— 两处各监听一次 Esc 会让共享的弹窗栈多算一层）。
 */
import type { MsgMenuItem } from './chats-support.tsx'
import type { MessageRenderKind as RenderKind, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import csscards from './chats-cards.module.css'

/** 菜单的开态：哪条消息、什么渲染类型、在屏幕上的位置。 */
export interface MsgMenuState {
  m: WechatMessage
  kind: RenderKind
  x: number
  y: number
}

export interface ChatsMsgMenuProps {
  msgMenu: MsgMenuState | null
  items: MsgMenuItem[]
  /** 关掉菜单（不执行任何动作）。 */
  onClose: () => void
  /** 执行某一项；调用方负责保证菜单已经先关掉。 */
  onPick: (item: MsgMenuItem, m: WechatMessage) => void
}

/**
 * 渲染消息右键菜单（`msgMenu` 为空时什么都不画）。
 * @returns 菜单元素或 null。
 */
export function ChatsMsgMenu({ msgMenu, items, onClose, onPick }: ChatsMsgMenuProps): React.JSX.Element | null {
  if (!msgMenu) return null
  const msg = msgMenu.m
  return (
    <div className={csscards.msgCtxOverlay} onMouseDown={() => { onClose() }}>
      <div
        className={csscards.msgCtxMenu}
        style={{ left: msgMenu.x, top: msgMenu.y }}
        role="menu"
        data-st-msg-menu={String(msg.localId)}
        onMouseDown={(e) => { e.stopPropagation() }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={csscards.msgCtxItem}
            onClick={() => { onClose(); onPick(item, msg) }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}

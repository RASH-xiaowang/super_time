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

/** 桌面菜单的估算尺寸（打开前的视口夹取与 CSS 的 min-width 保持同一口径）。 */
export const MSG_MENU_WIDTH = 228
export const MSG_MENU_ITEM_HEIGHT = 36

/** 菜单的开态：哪条消息、什么渲染类型、在屏幕上的位置。 */
export interface MsgMenuState {
  m: WechatMessage
  kind: RenderKind
  x: number
  y: number
}

/**
 * 「在哪儿打开菜单」的最小面：一个屏幕坐标 + 能取消默认行为。
 *
 * 为什么要抽出来：菜单有两个入口 —— 桌面端的右键（`React.MouseEvent`）与手机端的长按
 * （`React.PointerEvent`）。两者都天然满足这个形状，按最小面收就能共用同一个 `openMsgMenu`，
 * 不必在长按那一侧伪造一个 MouseEvent、也不必让面板那头写两个入口。
 */
export interface MsgMenuAnchor {
  preventDefault(): void
  clientX: number
  clientY: number
}

export interface ChatsMsgMenuProps {
  msgMenu: MsgMenuState | null
  items: MsgMenuItem[]
  /** 关掉菜单（不执行任何动作）。 */
  onClose: () => void
  /** 执行某一项；调用方负责保证菜单已经先关掉。 */
  onPick: (item: MsgMenuItem, m: WechatMessage) => void
}

/** 与菜单动作一一对应的 18px 线性图标（形状沿用微信右键菜单的视觉语言）。 */
function MsgMenuGlyph({ action }: { action: MsgMenuItem['action'] }): React.JSX.Element {
  const common = { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true } as const
  switch (action) {
    case 'poster':
      return (
        <svg {...common}>
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="7" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.3" />
          <path d="m3.8 14.5 3.8-3.8 2.7 2.7 2.4-2.4 3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      )
    case 'viewSource':
      return (
        <svg {...common}>
          <path d="M6 2.8h5.5l3 3V17H6a1.3 1.3 0 0 1-1.3-1.3V4.1A1.3 1.3 0 0 1 6 2.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M11.4 3v3.2h3.2M8.2 10 6.8 11.4l1.4 1.4m4.4-2.8 1.4 1.4-1.4 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'messageInfo':
    case 'openLink':
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="7.3" stroke="currentColor" strokeWidth="1.4" />
          {action === 'messageInfo'
            ? <><path d="M10 8.7v4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="10" cy="6.2" r=".9" fill="currentColor" /></>
            : <path d="M8.4 8a2 2 0 1 1 2.5 1.9c-.7.3-.9.8-.9 1.4m0 2.2v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
        </svg>
      )
    case 'editMessage':
      return (
        <svg {...common}>
          <path d="m4 15.9.8-3.5L13.3 4a1.7 1.7 0 0 1 2.4 0l.3.3a1.7 1.7 0 0 1 0 2.4l-8.4 8.5-3.6.7Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="m12.3 5 2.7 2.7" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )
    case 'editSource':
      return (
        <svg {...common}>
          <path d="m7.7 5.2-4.3 4.7 4.3 4.7M12.3 5.2l4.3 4.7-4.3 4.7M11.4 3.8 8.6 16" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'copyText':
      return (
        <svg {...common}>
          <rect x="6.2" y="6.2" width="10.2" height="10.2" rx="1.7" stroke="currentColor" strokeWidth="1.4" />
          <path d="M13.6 6V5A1.5 1.5 0 0 0 12.1 3.5H5A1.5 1.5 0 0 0 3.5 5v7.1A1.5 1.5 0 0 0 5 13.6h1" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      )
    case 'copyJson':
      return (
        <svg {...common}>
          <path d="M7.1 3.8c-2 0-2.5 1-2.5 2.5v1.3c0 1.2-.5 2-1.5 2.4 1 .4 1.5 1.2 1.5 2.4v1.3c0 1.5.5 2.5 2.5 2.5M12.9 3.8c2 0 2.5 1 2.5 2.5v1.3c0 1.2.5 2 1.5 2.4-1 .4-1.5 1.2-1.5 2.4v1.3c0 1.5-.5 2.5-2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'openViewer':
      return (
        <svg {...common}>
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="7" cy="8" r="1.5" fill="currentColor" />
          <path d="m3.8 14.5 3.8-3.8 2.7 2.7 2.4-2.4 3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      )
    case 'openFile':
      return (
        <svg {...common}>
          <path d="M5 2.8h6L15 7v10.2H5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M11 2.8V7h4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      )
    case 'openChatlog':
      return (
        <svg {...common}>
          <path d="M3 4.2h14v9.1H9l-4.2 3v-3H3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M6.4 7.4h7.2M6.4 10.3h5.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    default:
      return <svg {...common} />
  }
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
            data-action={item.action}
            onClick={() => { onClose(); onPick(item, msg) }}
          >
            <span className={csscards.msgCtxIcon}><MsgMenuGlyph action={item.action} /></span>
            <span className={csscards.msgCtxLabel}>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

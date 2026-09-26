/**
 * 聊天记录卡片查看器（#19 第六刀，自 `chats-view.tsx` 那棵渲染树里切出）。
 *
 * 这一屏是**栈式**的：一条嵌套卡片可以层层点进去，标题与返回按钮都跟着栈走。
 * 三条只有渲染才看得见的规矩：
 * ① 「返回上一级」只在栈深大于 1 时出现（一级时点了会把整个抽屉弄没）；
 * ② 「关闭」与点遮罩都是**清整个栈**，不是弹一层 —— 留着下层的话，下次打开这个会话
 *    会直接落在三层深的卡片里，用户不知道自己在哪里；
 * ③ 头像走 `RemoteImg`（后端代理），**不许**直接 `<img src={r.head}>` —— `<sourceheadurl>`
 *    是未校验的原始地址（实测 360 条内层记录里 193 条是 http），渲染层自己去要它就把 M23
 *    那套主机白名单 / 出网开关 / 操作记录整个绕过了。
 * 一条记录怎么读成一行字，在 `chats-chatlog.ts`。
 */
import kitCss from '../ui/kit.module.css'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatlogRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { RemoteImg } from './remote-img.tsx'
import { openLink } from './chats-support.tsx'
import { chatlogBodyOf, chatlogFallbackChar, chatlogKindOf, chatlogLinkOf, chatlogNestedLabel, type ChatlogFrame } from './chats-chatlog.ts'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'

export type { ChatlogFrame }

export interface ChatsChatlogViewProps {
  /** 当前栈深：>1 才给「返回上一级」。 */
  depth: number
  /** 栈顶那一层（null = 没打开，整块不渲染）。 */
  frame: ChatlogFrame | null
  onCloseAll: () => void
  onBack: () => void
  openNestedChatlog: (rec: ChatlogRecord) => Promise<void>
  resolving: boolean
}

/**
 * 嵌套聊天记录抽屉。
 * @param props - 栈顶内容、栈深、退出方式与取数回调。
 * @returns 没有栈顶时什么都不渲染。
 */
export function ChatsChatlogView(props: ChatsChatlogViewProps): React.JSX.Element | null {
  const { depth, frame, onCloseAll, onBack, openNestedChatlog, resolving } = props
  if (!frame) return null
  const records = frame.records
  return (
    <div className={csscards.calOverlay} data-st-dialog="chats-chatlog" onClick={(e) => { if (e.target === e.currentTarget) onCloseAll() }} role="dialog" aria-modal="true">
      <div className={csscards.chatlogDialog}>
        <div className={cssshell.calHeader}>
          <span className={csscards.calTitle}>{frame.title}</span>
          <span className={cssshell.calHeaderActions}>
            {depth > 1 && (
              <button type="button" className={csscards.calClose} title="返回上一级" onClick={onBack} aria-label="返回上一级">‹</button>
            )}
            <button type="button" className={csscards.calClose} title="关闭" aria-label="关闭" onClick={onCloseAll}><IconCloseOutline16 size={15} /></button>
          </span>
        </div>
        <div className={cssshell.chatlogBody}>
          {resolving && <div className={kitCss.emptyInline}>解析聊天记录…</div>}
          {records.length === 0 && !resolving && <div className={kitCss.emptyInline}>暂无内层消息</div>}
          {records.map((r, idx) => {
            const kind = chatlogKindOf(r)
            const link = chatlogLinkOf(r)
            // head 是**未校验的原始地址**（见文件头第 ③ 条）：只交给后端代理，取不到就回退首字母。
            const headFallback = <span>{chatlogFallbackChar(r)}</span>
            return (
              <div key={idx} className={cssshell.chatlogRow}>
                <div className={csscards.chatlogAvatar}>
                  <RemoteImg src={r.head || ''} alt="" loading="lazy"
                    pending={headFallback} failed={headFallback} />
                </div>
                <div className={cssshell.chatlogMain}>
                  <div className={cssshell.chatlogTop}>
                    <span className={cssshell.chatlogName}>{r.name}</span>
                    <span className={cssshell.chatlogTime}>{r.time}</span>
                  </div>
                  {kind === 'chatHistory' && (
                    <button type="button" className={csscards.chatlogNested} onClick={() => { void openNestedChatlog(r) }}>
                      <span>{chatlogNestedLabel(r)}</span>
                    </button>
                  )}
                  {kind === 'link' && link ? (
                    <div className={cssshell.chatlogText}><a href={link} target="_blank" rel="noopener noreferrer"
                      onClick={(e) => { e.preventDefault(); openLink(link) }} className={csscards.msgTextLink}>{chatlogBodyOf(r)}</a></div>
                  ) : (
                    <div className={cssshell.chatlogText}>{chatlogBodyOf(r)}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

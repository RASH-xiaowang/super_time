/**
 * 切会话时的「浮层归属」复位。
 *
 * 消息列表本身有 `sessionAlive` / `messagesMatchSession` 两道令牌，切走后到达的响应
 * 写不进当前会话；但这些**浮层**各自持有着上一会话的行/图片/记录，不在同一条防线上：
 *  · 全屏图片查看器存的是上一个会话的图片与 localId；
 *  · 聊天记录弹窗（合并转发卡片）装的是上一个会话的消息；
 *  · 消息右键菜单指向的是一行具体的消息（编辑/回复都以它为目标）；
 *  · 消息信息 / 查看源码 / 修改消息对话框直接装着上一会话的**某一条消息**；
 *  · 「已编辑的消息」列表是上一会话的编辑记录；
 *  · 分析选中靠 `localId` 匹配 —— 而 `local_id` 只在会话内唯一；
 *  · 正在播放的语音也是上一个会话的消息。
 *
 * 不收起它们，新会话的聊天窗口上就会盖着上一个会话的内容 —— 用户看到的是
 * 「这个会话的窗口里有别的会话的消息」。这里把复位动作收成一处，便于单测与变异反证。
 *
 * 两条口径：
 *  · 消息对话框用 `closeNow`，不用「保存中拒绝关闭」的 `onClose` —— 那一刻对话框里
 *    装的仍是上一个会话的消息，必须先收起；进行中的保存有自己的会话归属令牌。
 *  · 两块右栏（分析/AI）的开/关**不**在此列：默认关、头部按钮是唯一入口，
 *    用户的选择跟着人走，而不是每换一个会话就被强行打开一次（2026-10-13 反转）。
 *
 * @module chats-session-scope
 */
import type { ChatlogFrame } from './chats-chatlog.ts'

/** 复位需要的状态出口（注入真实 React setter，单测里用假函数断言调用）。 */
export interface SessionOverlayResetSink {
  setAnalysisTarget: (value: null) => void
  setViewer: (value: null) => void
  setChatlogStack: (value: ChatlogFrame[]) => void
  setMsgMenu: (value: null) => void
  /** 消息信息 / 查看源码 / 修改消息对话框（不做「保存中」拦截：里面是上一会话的消息）。 */
  closeMessageTool: () => void
  /** 「已编辑的消息」列表弹窗。 */
  setEditedOpen: (value: false) => void
  stopVoice: () => void
}

/**
 * 收起所有绑定在上一个会话上的浮层与媒体。
 * @param sink - 当前面板的状态出口。
 */
export function resetSessionOverlays(sink: SessionOverlayResetSink): void {
  sink.setAnalysisTarget(null)
  sink.setViewer(null)
  sink.setChatlogStack([])
  sink.setMsgMenu(null)
  sink.closeMessageTool()
  sink.setEditedOpen(false)
  sink.stopVoice()
}

/**
 * 切会话时浮层必须跟着走。
 *
 * 2026-11 报障：「在会话对象的聊天窗口里有其他会话对象的消息」。消息列表本身有归属令牌，
 * 但图片查看器/聊天记录弹窗/右键菜单/分析选中/语音各自装着上一会话的内容，不随
 * `messages` 复位 —— 留在新会话窗口上就是串会话。这条守卫钉住五个出口都被复位。
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { resetSessionOverlays, type SessionOverlayResetSink } from './chats-session-scope.ts'

function sink(): SessionOverlayResetSink & {
  setAnalysisTarget: ReturnType<typeof vi.fn>
  setViewer: ReturnType<typeof vi.fn>
  setChatlogStack: ReturnType<typeof vi.fn>
  setMsgMenu: ReturnType<typeof vi.fn>
  closeMessageTool: ReturnType<typeof vi.fn>
  setEditedOpen: ReturnType<typeof vi.fn>
  stopVoice: ReturnType<typeof vi.fn>
} {
  return {
    setAnalysisTarget: vi.fn(),
    setViewer: vi.fn(),
    setChatlogStack: vi.fn(),
    setMsgMenu: vi.fn(),
    closeMessageTool: vi.fn(),
    setEditedOpen: vi.fn(),
    stopVoice: vi.fn(),
  }
}

describe('resetSessionOverlays', () => {
  it('分析选中 / 图片查看器 / 聊天记录 / 右键菜单都清空', () => {
    const s = sink()
    resetSessionOverlays(s)
    expect(s.setAnalysisTarget).toHaveBeenCalledWith(null)
    expect(s.setViewer, '上一个会话的图片会盖在新会话的聊天窗口上').toHaveBeenCalledWith(null)
    expect(s.setChatlogStack, '上一个会话的聊天记录弹窗会留在新会话上').toHaveBeenCalledWith([])
    expect(s.setMsgMenu, '右键菜单指向上一会话的消息，编辑/回复会作用于别人').toHaveBeenCalledWith(null)
  })

  it('消息信息/源码/编辑对话框与「已编辑的消息」列表一起收起', () => {
    const s = sink()
    resetSessionOverlays(s)
    expect(s.closeMessageTool, '对话框里装着上一会话的一条消息，会以新会话的窗口画出旧消息').toHaveBeenCalledTimes(1)
    expect(s.setEditedOpen, '编辑记录列表是上一会话的').toHaveBeenCalledWith(false)
  })

  it('上一个会话的语音一并停止（音频也是那条会话的内容）', () => {
    const s = sink()
    resetSessionOverlays(s)
    expect(s.stopVoice).toHaveBeenCalledTimes(1)
  })
})

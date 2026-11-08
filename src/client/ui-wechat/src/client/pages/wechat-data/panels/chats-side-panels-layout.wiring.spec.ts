/**
 * 会话页右侧功能栏的布局守卫。
 *
 * 回归背景：推荐/分析曾用绝对定位浮在消息流上，窗口一窄就直接盖住聊天记录。
 * 这里钉住四个入口共用同一套布局契约：
 *   · 推荐/分析等辅助右栏在桌面端参与 flex 排版，与消息流并排；
 *   · AI 问答接管消息流，避免问答与聊天五五分；全屏时再收起会话列表；
 *   · 900px 以下由功能栏接管会话区，列表/消息流让位；
 *   · 打开任一侧栏时关闭其他入口，避免两块面板同时挤占宽度。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atRuleBlock, classBlock, readStripped, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const read = (name: string): string => readText(join(HERE, name))

const view = readStripped(join(HERE, 'chats-view.tsx'))
const right = readStripped(join(HERE, 'ChatRightPanel.tsx'))
const ask = readStripped(join(HERE, 'SessionAsk.tsx'))
const contact = readStripped(join(HERE, 'chats-contact-info-view.tsx'))
const group = readStripped(join(HERE, 'chats-group-info-view.tsx'))
const head = readStripped(join(HERE, 'chats-head-actions.tsx'))
const analysis = readStripped(join(HERE, 'chats-analysis.ts'))
const shellCss = read('session-ask.module.css')
const chatsShellCss = read('chats-shell.module.css')
const rowsCss = read('chats-rows.module.css')
const cardsCss = read('chats-cards.module.css')

const compactShell = atRuleBlock(chatsShellCss, '@media (max-width: 900px)')

describe('右侧功能栏不覆盖聊天记录', () => {
  it('四个右栏组件都带统一标记', () => {
    for (const [name, source] of [
      ['ChatRightPanel.tsx', right],
      ['SessionAsk.tsx', ask],
      ['chats-contact-info-view.tsx', contact],
      ['chats-group-info-view.tsx', group],
    ] as const) {
      expect(source, `${name} 没有 data-side-panel-view，900px 档无法统一接管宽度`).toContain('data-side-panel-view=""')
    }
  })

  it('右边栏参与 flex 排版，基础态不再绝对定位', () => {
    const panel = classBlock(shellCss, 'panel')
    expect(panel).toContain('position: relative')
    expect(panel).toContain('container-type: inline-size')
    expect(panel).toMatch(/flex:\s*0 0 clamp\(320px,\s*34vw,\s*420px\)/)
    expect(panel).not.toContain('position: absolute')
    expect(compactShell, '900px 档没有让消息流/会话列表给右栏').toContain('[data-side-panel][data-has-session] [data-chat-sidebar]')
    expect(compactShell, '900px 档没有同时隐藏消息流').toContain('[data-side-panel][data-has-session] [data-chat-messages]')
    expect(compactShell, '右栏没有在窄档吃满可用宽度').toContain('[data-side-panel][data-has-session] [data-side-panel-view]')
  })

  it('AI 问答接管消息流，不与聊天记录做五五分栏', () => {
    expect(chatsShellCss, 'AI 问答没有隐藏并排的消息流').toContain(
      "[data-side-panel='ai'][data-has-session] [data-chat-messages]",
    )
    expect(chatsShellCss, 'AI 问答没有吃满消息流让出的宽度').toContain(
      "[data-side-panel='ai'][data-has-session] [data-side-panel-view]",
    )
    expect(chatsShellCss, 'AI 全屏没有进一步收起会话列表').toContain(
      '[data-ai-full] [data-chat-sidebar]',
    )
    expect(chatsShellCss, 'AI 视图的会话列表仍显示滚动条').toContain(
      "[data-side-panel='ai'] [data-chat-sidebar] * { scrollbar-width: none; }",
    )
    expect(shellCss, 'AI 阅读轴没有设置 720px 上界').toContain('max-width: 720px')
  })

  it('切换会话不重建 SessionAsk，线程由 threadKey 继续保留', () => {
    expect(view).toContain('<SessionAsk')
    expect(view).toContain('target={aiTarget}')
    expect(view).not.toContain('key={aiTarget.username}')
    expect(view).toContain('hidden={!aiOpen || groupInfoOpen || contactInfoOpen}')
    expect(ask).toContain('threadKey: target.username')
    expect(ask).toContain('hidden={hidden || undefined}')
    expect(ask).toContain('scopeUsername={target.username}')
    expect(ask).toContain('useEffect(() => {\n    setQuestion(\'\')')
    expect(shellCss).toContain('.panel[hidden] { display: none; }')
  })

  it('根节点把 AI / 群聊信息 / 聊天信息 / 推荐分析都汇总为 side-panel 信号', () => {
    const root = view.slice(view.indexOf('<div className={cssrows.panel}'), view.indexOf('>', view.indexOf('<div className={cssrows.panel}')))
    expect(root).toContain('data-side-panel={sidePanel}')
    expect(view).toContain("aiOpen && aiEligible && aiTarget ? 'ai'")
    expect(view).toContain("groupInfoOpen ? 'group'")
    expect(view).toContain("contactInfoOpen ? 'contact'")
    expect(view).toContain("chatRightMode !== undefined ? 'chat'")
    expect(view, '会话列表缺少让位标记').toContain('data-chat-sidebar=""')
    expect(view, '消息流缺少让位标记').toContain('data-chat-messages=""')
  })

  it('入口互斥：打开 AI / 推荐 / 分析 / 聊天信息 / 群聊信息时关闭其余右栏', () => {
    expect(head, 'AI 问答入口没有关闭推荐分析').toContain('setSuggestOpen(false)')
    expect(head, 'AI 问答入口没有退出全屏').toContain('setAiFull(false)')
    expect(head, '推荐回复入口没有关闭聊天信息').toContain('setContactInfoOpen(false)')
    const analysisAt = head.indexOf('aria-label="分析"')
    expect(analysisAt, '找不到分析入口').toBeGreaterThan(-1)
    expect(head.slice(analysisAt, analysisAt + 900), '分析入口没有关闭推荐回复').toContain('setSuggestOpen(false)')
    expect(head, '群聊信息入口没有关闭推荐分析').toContain('setAnalysisPaneOpen(false)')
    expect(analysis, '点消息分析时没有关闭推荐回复').toContain('setSuggestOpen(false)')
    expect(analysis, '点消息分析时没有关闭聊天信息').toContain('setContactInfoOpen(false)')
    expect(analysis, '点消息分析时没有关闭群聊信息').toContain('setGroupInfoOpen(false)')
  })

  it('右栏只渲染一个内容域，不能把推荐回复和分析上下叠在一起', () => {
    expect(right).toContain("mode: 'suggest' | 'analysis'")
    expect(right).toContain("{mode === 'suggest' && (")
    expect(right).toContain("{mode === 'analysis' && (")
    expect(right).not.toContain('showSuggest && showAnalysis')
    expect(right).not.toContain('推荐回复与消息分析')
  })

  it('右栏窄到 390px 以下时分析卡按面板宽度降为单列', () => {
    const panelCss = readText(join(HERE, 'chat-analysis-panel.module.css'))
    expect(atRuleBlock(panelCss, '@container (max-width: 390px)')).toMatch(/\.findingGrid,[\s\S]*\.signalGrid[\s\S]*grid-template-columns:\s*1fr/)
  })

  it('哨兵：TSX 与 CSS 都真读到了内容', () => {
    expect(right.length).toBeGreaterThan(1000)
    expect(ask.length).toBeGreaterThan(1000)
    expect(shellCss.length).toBeGreaterThan(1000)
    expect(rowsCss.length).toBeGreaterThan(1000)
    expect(cardsCss.length).toBeGreaterThan(1000)
    expect(compactShell.length).toBeGreaterThan(20)
  })
})

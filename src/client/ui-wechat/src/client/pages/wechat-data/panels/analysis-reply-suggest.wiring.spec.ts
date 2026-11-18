/**
 * 「推荐回复 / 分析」板块分界的接线守卫。
 *
 * 产品口径（2026-11-13）：右栏两块内容互不掺杂 —— 分析面板只做研判，
 * 不再内嵌任何可直接发送的候选回复；候选回复只属于独立的「推荐回复」模式。
 * 这份守卫钉住四条边界，防止以后又把推荐区塞回分析面板：
 *   ① 分析面板不导入 / 不渲染推荐组件，也不接收回复所需的会话 username；
 *   ② 组合层 `ChatRightPanel` 不再把 `target.username` 递给分析面板；
 *   ③ 旧的内嵌组件文件已经删除，不会以「暂时不用」的名义复活；
 *   ④ 分析面板样式表不残留推荐区块的类名，同时保留「重新分析」按钮的 `.textBtn`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (path: string): string => readFileSync(join(HERE, path), 'utf8')
const PANEL = read('ChatAnalysisPanel.tsx')
const RIGHT = read('ChatRightPanel.tsx')
const PANEL_CSS = read('chat-analysis-panel.module.css')

describe('推荐回复与分析的功能板块分界', () => {
  it('分析面板不导入、不渲染推荐回复组件', () => {
    expect(PANEL).not.toContain('AnalysisReplySuggest')
    expect(PANEL).not.toContain('apiSuggestReplies')
    expect(PANEL).not.toContain('上下文推荐回复')
  })

  it('分析面板不接收推荐回复所需的会话 username', () => {
    expect(PANEL).not.toContain('replyUsername')
    expect(RIGHT).not.toContain('replyUsername')
  })

  it('旧的内嵌推荐组件文件已删除', () => {
    expect(existsSync(join(HERE, 'AnalysisReplySuggest.tsx'))).toBe(false)
  })

  it('组合层把两段放进同一个面板，且各段仍是独立组件', () => {
    // 2026-11-18：合并的是**壳**，不是内容 —— 分析段仍用 `ChatAnalysisPanel`，
    // 候选段仍用 `ReplySuggest`；两块不互相 import，也不共享状态。
    expect(RIGHT).toContain('onTrace={setReplyTrace}')
    expect(RIGHT).toContain('<ChatAnalysisPanel')
    expect(RIGHT).toContain('aria-label="这条消息怎么理解"')
    expect(RIGHT).toContain('aria-label="可以这样回"')
    // 群聊没有「回一句」的对象 ⇒ 候选段必须能被整体关掉。
    expect(RIGHT).toContain('{allowSuggest && (')
    // 分析对象也传下去了：下段推荐的是回「上段研判的那条」。
    expect(RIGHT).toContain('targetLocalId={analysisTargetId}')
  })

  it('分析面板样式不残留推荐区块类名，但保留重新分析按钮', () => {
    expect(PANEL_CSS).not.toContain('.replySection')
    expect(PANEL_CSS).not.toContain('.replyCard')
    expect(PANEL_CSS).not.toContain('.copyBtn')
    expect(PANEL_CSS).toContain('.textBtn')
  })
})

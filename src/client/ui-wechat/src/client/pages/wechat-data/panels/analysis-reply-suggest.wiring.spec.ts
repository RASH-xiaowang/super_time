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

  it('推荐回复仍由组合层在 suggest 模式单独渲染', () => {
    expect(RIGHT).toContain("mode === 'suggest'")
    expect(RIGHT).toContain('<ReplySuggest target={target} />')
    expect(RIGHT).toContain("mode === 'analysis'")
    expect(RIGHT).toContain('<ChatAnalysisPanel')
  })

  it('分析面板样式不残留推荐区块类名，但保留重新分析按钮', () => {
    expect(PANEL_CSS).not.toContain('.replySection')
    expect(PANEL_CSS).not.toContain('.replyCard')
    expect(PANEL_CSS).not.toContain('.copyBtn')
    expect(PANEL_CSS).toContain('.textBtn')
  })
})

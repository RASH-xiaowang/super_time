// @vitest-environment node
/**
 * keep-alive 接线判据：函数写好了但没挂进面板，是这类试点最常见的“假完成”。
 *
 * - WechatDataPanel 必须用 useKeepAlivePanel，并且渲染它（不是仍渲染 activePanel）；
 * - KEEP_ALIVE_PANES wrapper 必须用 display: contents / none + 稳定 key，
 *   否则 React 会在切 tab 时按 wrapper 类型重建子树，state 照样丢。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(join(HERE, '..', 'WechatDataPanel.tsx'), 'utf8')
const keepAlive = readFileSync(join(HERE, 'keep-alive.tsx'), 'utf8')

describe('keep-alive 接线', () => {
  it('WechatDataPanel 使用 keep-alive 钩子，并渲染它的返回值', () => {
    expect(panel).toContain("import { useKeepAlivePanel } from './panels/keep-alive.tsx'")
    expect(panel).toContain('const keepAlivePanel = useKeepAlivePanel(active, activePanel)')
    expect(panel).toContain('{keepAlivePanel}')
  })

  it('试点 wrapper 用稳定 key + display:contents/none（不能用 hidden 属性）', () => {
    expect(keepAlive).toContain('key={tab}')
    expect(keepAlive).toContain("display: tab === active ? 'contents' : 'none'")
    expect(keepAlive).not.toMatch(/<div[^>]*hidden=\{tab !== active\}/)
  })

  it('试点范围只有 chats/taskinfo（不是把 39 个面板全部常驻）', () => {
    expect(keepAlive).toMatch(/KEEP_ALIVE_TABS = new Set\(\['chats', 'taskinfo'\]\)/)
  })
})

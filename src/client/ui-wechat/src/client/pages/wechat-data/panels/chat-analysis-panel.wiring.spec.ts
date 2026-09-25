/**
 * 「分析」面板（左）+ 「推荐回复」常驻右栏 的接线守卫。
 *
 * 四条不变量的由来（2026-09-25 产品决策）：
 *
 * ① **分析在左、推荐回复在右**：分析面板必须落在「会话列表之后、消息流之前」——
 *    放错位置就成了第三栏，与「左面板」这个约定不符。
 * ② **右栏默认是推荐回复**：`suggestOpen` 初值 true（进会话就能看到候选回复），
 *    而 AI 问答打开时**顶替**它（两块并排会把 960px 窗口下的消息列挤到不可用）。
 * ③ **旧的切换按钮要移除**：面板改常驻之后，「推荐回复」按钮没有存在意义，
 *    留着会让同一功能出现两个入口（一个按钮 + 一个常驻面板）。
 * ④ **无边框滚动条**：面板内容长了要能滚，但**不能是带轨道的默认样式** ——
 *    轨道/corner 透明、thumb 无边框、宽 6px（用户明确要求「保持整体视觉简洁」）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

const VIEW = read('chats-view.tsx')
const CHATS = read('Chats.tsx')
const SHELL = read('session-ask.module.css')
const PANEL = read('ChatAnalysisPanel.tsx')

describe('分析面板 / 推荐回复面板', () => {
  it('① 分析面板落在「会话列表之后、消息流之前」', () => {
    const listAt = VIEW.indexOf('{/* left: session list */}')
    const panelAt = VIEW.indexOf('<ChatAnalysisPanel')
    const streamAt = VIEW.indexOf('{/* right: message stream */}')
    expect(listAt).toBeGreaterThan(-1)
    expect(panelAt, '找不到分析面板的挂载').toBeGreaterThan(-1)
    expect(streamAt, '找不到消息流的注释锚点').toBeGreaterThan(-1)
    expect(panelAt, '分析面板要在消息流之前（否则就成了第三栏）').toBeLessThan(streamAt)
    expect(panelAt, '分析面板要在会话列表之后').toBeGreaterThan(listAt)
  })

  it('② 右栏默认推荐回复，AI 问答打开时顶替它', () => {
    expect(CHATS, '推荐回复改常驻：初值必须是 true').toContain('const [suggestOpen, setSuggestOpen] = useState(true)')
    expect(VIEW, 'AI 问答打开时不该同时挂推荐回复（两块并排会挤爆消息列）').toMatch(/suggestOpen[\s\S]{0,120}!\(aiOpen && aiEligible && aiTarget\)/)
    expect(CHATS, '换会话要重置（否则 × 关掉后再也没有恢复入口）').toContain('setSuggestOpen(true)')
  })

  it('③ 旧的「推荐回复」切换按钮已移除', () => {
    expect(VIEW, '按钮留着会让同一功能出现两个入口').not.toContain('data-active={suggestOpen')
    expect(VIEW, '按钮上的标题文案也该一起消失').not.toContain('title="推荐回复：按这段对话')
  })

  it('④ 点消息选中：虚拟行上挂 onClick 写 analysisTarget', () => {
    expect(VIEW, '点选要挂在虚拟行上（不改 renderMsgItem，避免多包一层 DOM）').toContain('setAnalysisTarget(item.m.localId)')
    expect(VIEW, '只有对方的消息才分析：自己的消息没有「意图」可判').toContain("item.m.isSender !== 1")
  })

  it('⑤ 面板滚动区是显式的无边框细条', () => {
    const body = SHELL.slice(SHELL.indexOf('.body::-webkit-scrollbar'))
    expect(body, '要显式声明宽度（6px 细条）').toMatch(/\.body::-webkit-scrollbar\s*\{\s*width:\s*6px/)
    expect(body, '轨道必须透明（默认样式就是轨道有底色）').toMatch(/track\s*\{\s*background:\s*transparent/)
    expect(body, 'thumb 不能带边框').toMatch(/thumb\s*\{[^}]*border:\s*none/)
  })

  it('⑥ 分析面板不自己发请求（只读 useInlineAnalysis 的缓存）', () => {
    expect(PANEL, '面板应当是纯展示：数据从外面传进来').not.toContain('apiAnalyze')
    expect(PANEL, '复用内嵌卡的答案块，避免两处渲染长歪').toContain("import { AnswerBlock } from './InlineMessageAnalysis.tsx'")
  })
})

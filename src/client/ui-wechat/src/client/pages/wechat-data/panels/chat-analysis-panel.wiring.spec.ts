/**
 * 右栏「推荐回复 + 分析」合并面板的接线守卫。
 *
 * 不变量的由来（2026-09-25，含当日二次调整）：
 *
 * ① **两块共用一个容器**：分析原本是独立面板（左栏），产品调整为「合并到推荐回复下方」
 *    —— 于是外壳上提到组合层 `ChatRightPanel`，**推荐回复在上、分析在下**。
 *    合并的意义就在于消掉双层边框与两个头部：两个子面板各自都**不许再带外壳**。
 * ② **右栏默认是推荐回复**：`suggestOpen` 初值 true（进会话就能看到候选回复），
 *    而 AI 问答打开时**顶替**整个右栏（两块并排会把 960px 窗口下的消息列挤到不可用）。
 * ③ **旧的切换按钮要移除**：面板改常驻之后，「推荐回复」按钮没有存在意义，
 *    留着会让同一功能出现两个入口（一个按钮 + 一个常驻面板）。
 * ④ **无边框滚动条**：面板内容长了要能滚，但**不能是带轨道的默认样式** ——
 *    轨道/corner 透明、thumb 无边框、宽 6px（用户明确要求「保持整体视觉简洁」）。
 *    合并后**两块各有自己的滚动区**，否则上半一长就把下半挤没。
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
const RIGHT = read('ChatRightPanel.tsx')

describe('分析面板 / 推荐回复面板', () => {
  it('① 两块共用一个容器：推荐回复在上、分析在下，外壳只有组合层一份', () => {
    const mergeAt = RIGHT.indexOf('<ReplySuggest')
    const analysisAt = RIGHT.indexOf('<ChatAnalysisPanel')
    expect(mergeAt, '组合层必须挂推荐回复').toBeGreaterThan(-1)
    expect(analysisAt, '组合层必须挂分析').toBeGreaterThan(-1)
    expect(mergeAt, '用户要求：分析在推荐回复**下方**（DOM 顺序即视觉顺序）').toBeLessThan(analysisAt)
    expect(RIGHT, '组合层是唯一的面板外壳').toContain('className={shell.panel}')
    // 双层边框 + 两个头部就是「没真合并」的样子：两个子面板都不许再自带外壳。
    expect(read('ReplySuggest.tsx'), '推荐回复不该再管关闭（面板级动作归组合层）').not.toContain('onClose')
    for (const f of ['ReplySuggest.tsx', 'ChatAnalysisPanel.tsx']) {
      expect(read(f), `${f} 不该再自带面板外壳（合并后会出双层边框与两个头部）`).not.toContain('shell.panel')
    }
    expect(VIEW, 'chats-view 不该再单独挂分析面板（它现在在组合层内部）').not.toContain('<ChatAnalysisPanel')
    expect(VIEW, 'chats-view 只挂组合层').toContain('<ChatRightPanel')
  })

  it('⑦ 两块各有自己的滚动区，中间一条分隔线', () => {
    expect(read('ReplySuggest.tsx'), '上半（推荐回复）要有自己的滚动区').toContain('className={css.body}')
    expect(PANEL, '下半（分析）要有自己的滚动区').toContain('className={shell.body}')
    const dividerAt = RIGHT.indexOf('css.divider')
    expect(dividerAt, '两块之间要有分隔线（不靠共享的 .head 加 border-top，那会波及 AI 问答面板）').toBeGreaterThan(-1)
    expect(RIGHT.indexOf('<ReplySuggest'), '分隔线在推荐回复之后').toBeLessThan(dividerAt)
    expect(dividerAt, '分隔线在分析之前').toBeLessThan(RIGHT.indexOf('<ChatAnalysisPanel'))
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
    expect(PANEL, '复用答案块（AnalysisBlocks），避免渲染逻辑分叉').toContain("import { AnswerBlock } from './AnalysisBlocks.tsx'")
  })
})

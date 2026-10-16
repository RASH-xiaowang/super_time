/**
 * 右栏「推荐回复 + 分析」合并面板的接线守卫。
 *
 * 不变量的由来（2026-09-25，含当日二次调整）：
 *
 * ① **两块共用一个容器**：分析原本是独立面板（左栏），产品调整为「合并到推荐回复下方」
 *    —— 于是外壳上提到组合层 `ChatRightPanel`，**推荐回复在上、分析在下**。
 *    合并的意义就在于消掉双层边框与两个头部：两个子面板各自都**不许再带外壳**。
 * ② **右栏默认关**（2026-10-13 反转，用户要求「进入聊天框后推荐回复面板和分析面板默认不显示」）：
 *    `suggestOpen` / `analysisPaneOpen` 初值 false，换会话也不强行打开；
 *    头部「推荐回复 / 分析」按钮是唯一入口，AI 问答打开时顶替整个右栏
 *    （两块并排会把 960px 窗口下的消息列挤到不可用）。
 * ③ **两块各有自己的展开/折叠按钮**（2026-09-26 **反转**）：原先（2026-09-25）移除过
 *    「推荐回复」切换按钮，理由是它成了右栏的常驻内容、留按钮会让同一功能有两个入口。
 *    现在两块都能独立收起 ⇒ 按钮是它们**唯一**的入口，不再是冗余。
 *    这条于是从「不许有」改成「必须有且接对线」。
 * ⑤' **右栏挂载只看两块**：不再写死「只有单聊才挂」—— 群聊不显示推荐回复块（「回一句」
 *    在群里不成立），但仍可**单独打开分析**（分析读的是当前会话，群聊同样是会话）。
 * ④ **无边框滚动条**：面板内容长了要能滚，但**不能是带轨道的默认样式** ——
 *    轨道/corner 透明、thumb 无边框、宽 6px（用户明确要求「保持整体视觉简洁」）。
 *    合并后**两块各有自己的滚动区**，否则上半一长就把下半挤没。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readChatsSource } from '../../../test-helpers/chats-source.ts'
import { sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

/**
 * 会话那块功能的**联合源码**（`Chats.tsx` + `chats-*.tsx`）。
 *
 * 用联合而不是单文件：2026-09-26 把头部动作区拆进 `chats-head-actions.tsx` 之后，
 * 「按钮接对线」这类断言问的是「会话这一块功能」，不该关心那段代码住在哪个文件里
 * —— 这正是 `chats-source.ts` 存在的理由（它的注释就写着「下次再拆一刀不必回来补名字」）。
 */
const VIEW = readChatsSource()
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

  it('② 右栏两块默认都关（2026-10-13 反转）、AI 问答打开时顶替它', () => {
    // 反转记录：原断言守「初值 true + 换会话重置为 true」。用户要求进入聊天框后两块默认不显示；
    // 头部「推荐回复 / 分析」按钮是它们唯一的入口（③），可恢复性不再依赖重置，
    // 且换会话强行打开会覆盖用户自己的选择。
    expect(CHATS, '推荐回复进会话就展开（用户要求默认不显示）').toContain('const [suggestOpen, setSuggestOpen] = useState(false)')
    expect(CHATS, '分析区进会话就展开（用户要求默认不显示）')
      .toContain('const [analysisPaneOpen, setAnalysisPaneOpen] = useState(false)')
    const reset = sliceBetween(CHATS, 'useEffect(() => {\n    setAnalysisTarget(null)', '}, [curSession?.username])', '换会话重置块')
    expect(reset, '换会话又把推荐回复强行打开（默认关被绕过）').not.toContain('setSuggestOpen(true)')
    expect(reset, '换会话又把分析区强行打开（默认关被绕过）').not.toContain('setAnalysisPaneOpen(true)')
    // **精确切到挂载条件那一段**：原先用「锚点往后 120 字符」的窗口写法，
    // 会把邻近的无关代码圈进来 —— 本仓为这种写法吃过假阳性的亏。
    const mount = sliceBetween(VIEW, '{curSession !== null && (suggestVisible || analysisPaneOpen)',
      '<ChatRightPanel', '右栏挂载条件')
    expect(mount, 'AI 问答打开时不该同时挂右栏（两块并排会挤爆消息列）').toContain('!(aiOpen && aiEligible && aiTarget)')
    expect(mount, '右栏不该再写死「只有单聊才挂」—— 群聊也要能单独看分析')
      .not.toContain("curSession.type === 'private'")
  })

  it('③ 两块各有自己的展开/折叠按钮，且真的接上了状态', () => {
    // 整段切片（从我的注释到「日历」按钮）：两个按钮一起断言。
    // 不要从 `title=` 起切 —— `data-active` / `aria-expanded` 都写在 title **之前**，
    // 那样切出来的片段里根本没有它们（第一版就是这么误报的）。
    const btns = sliceBetween(VIEW, '右栏两块的展开/折叠（2026-09-26 按用户要求加在这排）',
      '消息日历（每日消息数热力图）', '两个切换按钮')

    expect(btns, '推荐回复按钮没接线').toContain('setSuggestOpen(v => !v)')
    expect(btns, '推荐回复按钮的 active 状态没跟着走').toMatch(/data-active=\{suggestOpen/)
    expect(btns, '推荐回复按钮缺少 aria-expanded（无障碍）').toMatch(/aria-expanded=\{suggestOpen\}/)

    expect(btns, '分析按钮没接线').toContain('setAnalysisPaneOpen(v => !v)')
    expect(btns, '分析按钮的 active 状态没跟着走').toMatch(/data-active=\{analysisPaneOpen/)
    expect(btns, '分析按钮缺少 aria-expanded（无障碍）').toMatch(/aria-expanded=\{analysisPaneOpen\}/)

    // 群聊没有推荐回复（「回一句」在群里不成立）⇒ 那个按钮也不该出现
    expect(btns, '推荐回复按钮没有限定在单聊').toMatch(/\{curSession\.type === 'private' && \(\s*\n\s*<button/)
  })

  it('⑧ 组合层按可见性渲染两块，标题跟着实际内容走', () => {
    expect(RIGHT, '推荐回复块没有条件渲染').toMatch(/\{showSuggest && \(\s*\n\s*<div className=\{css\.top\}>/)
    expect(RIGHT, '分析块没有条件渲染').toMatch(/\{showAnalysis && \(\s*\n\s*<ChatAnalysisPanel/)
    expect(RIGHT, '分隔线只在两块都显示时才画（单块面板里一条孤线会让人以为下面还有内容）')
      .toContain('{showSuggest && showAnalysis && <div className={css.divider} />}')
    expect(RIGHT, '标题没跟着可见性走').toMatch(/showSuggest && showAnalysis \? '推荐回复与分析' : showSuggest \? '推荐回复' : '分析'/)
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

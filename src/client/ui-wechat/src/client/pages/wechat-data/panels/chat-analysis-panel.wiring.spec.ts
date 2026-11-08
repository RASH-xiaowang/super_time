/**
 * 右栏「推荐回复 + 消息分析」的接线守卫。
 *
 * 重设计保留了右栏与默认关闭，但推荐回复/分析严格二选一，分析区不再显示六项模型问卷，而是：
 * 分析对象 → 研判结论 → 意图 / 温度 / 建议动作 → 可展开的底层判断。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readChatsSource } from '../../../test-helpers/chats-source.ts'
import { sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (path: string): string => readFileSync(join(HERE, path), 'utf8')
const VIEW = readChatsSource()
const CHATS = read('Chats.tsx')
const SHELL = read('session-ask.module.css')
const PANEL = read('ChatAnalysisPanel.tsx')
const RIGHT = read('ChatRightPanel.tsx')
const HEAD = read('chats-head-actions.tsx')

describe('消息分析面板', () => {
  it('① 推荐回复与消息分析严格二选一，共用组合层外壳', () => {
    const suggestAt = RIGHT.indexOf('<ReplySuggest')
    const analysisAt = RIGHT.indexOf('<ChatAnalysisPanel')
    expect(suggestAt).toBeGreaterThan(-1)
    expect(analysisAt).toBeGreaterThan(suggestAt)
    expect(RIGHT).toContain('className={shell.panel}')
    expect(PANEL, '分析区不该再自带一层面板外壳').not.toContain('shell.panel')
    expect(RIGHT).toContain("mode: 'suggest' | 'analysis'")
    expect(RIGHT).toContain("{mode === 'suggest' && (")
    expect(RIGHT).toContain("{mode === 'analysis' && (")
    expect(RIGHT, '右栏不能同时渲染推荐回复和分析').not.toContain('推荐回复与消息分析')
    expect(RIGHT, '单模式下不再需要两块之间的分隔线').not.toContain('css.divider')
  })

  it('② 默认关闭、AI 问答打开时顶替，群聊仍可单独分析', () => {
    expect(CHATS).toContain('const [suggestOpen, setSuggestOpen] = useState(false)')
    expect(CHATS).toContain('const [analysisPaneOpen, setAnalysisPaneOpen] = useState(false)')
    const mount = sliceBetween(
      VIEW,
      '{curSession !== null && chatRightMode !== undefined',
      '<ChatRightPanel',
      '右栏挂载条件',
    )
    expect(mount).toContain('!(aiOpen && aiEligible && aiTarget)')
    expect(mount).not.toContain("curSession.type === 'private'")
  })

  it('分析入口真的切换开关，并在打开时退出 AI 问答', () => {
    expect(HEAD, '分析按钮没有切换 analysisPaneOpen').toContain('setAnalysisPaneOpen(v => !v)')
    const analysisAt = HEAD.indexOf('aria-label="分析"')
    expect(analysisAt, '找不到分析入口').toBeGreaterThan(-1)
    const analysisEntry = HEAD.slice(analysisAt, analysisAt + 900)
    expect(analysisEntry, '打开分析时没有让出 AI 问答右栏').toContain('setAiOpen(false)')
    expect(analysisEntry, '打开分析时没有关闭推荐回复').toContain('setSuggestOpen(false)')
  })

  it('③ 分析区拿到发送者与原文，不把群昵称当 username', () => {
    expect(RIGHT).toContain('message={analysisMessage}')
    expect(RIGHT).toContain('speaker={analysisSpeaker}')
    expect(RIGHT).toContain('isGroup={analysisIsGroup}')
    expect(VIEW, '群聊消息用 senderName 显示、sender 作为真实 username')
      .toContain('name: targetMessage.senderName || targetMessage.sender')
    expect(VIEW).toContain('username: targetMessage.sender ||')
    expect(PANEL).toContain('<Avatar')
  })

  it('④ 面板先给结论，原始判断收进可展开区域', () => {
    expect(PANEL).toContain("import { buildAnalysisBrief } from './analysis-brief.ts'")
    expect(PANEL).toContain('研判结论')
    expect(PANEL).toContain('对方意图')
    expect(PANEL).toContain('对话温度')
    expect(PANEL).toContain('建议动作')
    expect(PANEL).toContain('<details')
    expect(PANEL).toContain('查看底层判断')
    expect(PANEL).toContain("import { AnswerBlock } from './AnalysisBlocks.tsx'")
  })

  it('⑤ 面板纯展示，不在组件内发分析请求', () => {
    expect(PANEL).not.toContain('apiAnalyze')
    expect(PANEL).not.toContain('useInlineAnalysis({')
  })

  it('⑥ 对话与分析滚动区统一隐藏可见滚动条', () => {
    expect(SHELL).toMatch(/\.body\s*\{[\s\S]*?scrollbar-width:\s*none/)
    expect(SHELL).toMatch(/\.body::-webkit-scrollbar\s*\{\s*display:\s*none;\s*width:\s*0/)
  })
})

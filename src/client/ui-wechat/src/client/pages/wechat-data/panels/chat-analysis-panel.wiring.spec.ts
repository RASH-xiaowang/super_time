/**
 * 消息分析的接线守卫（源码字符串 + 结构）。
 *
 * 这里钉的是**四根容易静默断掉的线**，每一根都对应一条变异：
 *  ① 「分析」按钮真的会 toggle 面板（M27）；
 *  ② 组合层按模式条件渲染分析块（M28）；
 *  ③ 右栏挂载不退回「只有单聊」（M29）；
 *  ④ 进会话时右栏默认不摊开（M491）。
 *
 * 另外钉新版设计的两条硬约束：
 *  ⑤ 单聊与群聊走**两套**展示（群聊必须有「是否在找你」与接话渠道）；
 *  ⑥ 面板只做研判，不生成可直接发送的回复，也不自己发请求。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('消息分析：入口与挂载', () => {
  it('① 唯一入口「回复助手」会切换面板，而不是空操作', () => {
    const head = read('chats-head-actions.tsx')
    expect(head).toContain('setAnalysisPaneOpen(v => !v)')
    // 合并后不该再有独立的「推荐回复」「分析」两个菜单项。
    expect(head).not.toContain('aria-label="推荐回复"')
    expect(head).not.toContain('aria-label="分析"')
    expect(head).toContain('aria-label="回复助手"')
  })

  it('② 组合层始终渲染分析段（它是这个面板的主体）', () => {
    const right = read('ChatRightPanel.tsx')
    expect(right).toContain('aria-label="这条消息怎么理解"')
    expect(right).toContain('<ChatAnalysisPanel')
    // 候选段才是可选的（群聊没有）。
    expect(right).toContain('{allowSuggest && (')
  })

  it('③ 右栏挂载不退回「只有单聊」', () => {
    const view = read('chats-view.tsx')
    // 挂载条件里不许出现 private-only 短路（群聊也要能单独打开分析）。
    const mount = view.slice(view.indexOf('{curSession !== null && chatRightMode !== undefined'))
    expect(mount.slice(0, 200)).not.toContain("curSession.type === 'private'")
  })

  it('④ 进会话时右栏默认不摊开', () => {
    const panel = read('Chats.tsx')
    // 合并后只有一个开关；此前是 suggestOpen + analysisPaneOpen 两个。
    expect(panel).toContain('const [analysisPaneOpen, setAnalysisPaneOpen] = useState(false)')
    expect(panel).not.toContain('const [suggestOpen, setSuggestOpen]')
  })

  it('⑤ 再次点击已选中的那条消息 ⇒ 收起面板（开关式）', () => {
    const analysis = read('chats-analysis.ts')
    // 判据：面板开着 且 点的就是当前目标 ⇒ 收起，而不是重新打开同一个目标。
    expect(analysis).toContain('if (analysisPaneOpen && selectedLocalId === message.localId) {')
    expect(analysis).toContain('setAnalysisPaneOpen(false)')
    // 收起分支必须能拿到这两个值，否则判据恒假（永远走「打开」）。
    expect(analysis).toContain('analysisPaneOpen,')
    expect(analysis).toContain('selectedLocalId,')
  })

  it('⑥ 面板收起时视为没有选中：高亮不会留在消息行上', () => {
    const analysis = read('chats-analysis.ts')
    // 收起有多个入口（点消息 / ✕ / 切 AI 问答 / 群聊信息 / 聊天信息），逐处清目标必漏；
    // 因此在派生处按面板开关统一收敛。
    expect(analysis).toMatch(/const selectedLocalId = analysisPaneOpen\s*\n?\s*&& analysisTarget !== null/)
    // 消息行的选中态与详情的高亮都读同一个值。
    expect(read('chats-view.tsx')).toContain('data-analysis-target={item.kind === \'msg\' && selectedLocalId === item.m.localId')
  })
})

describe('消息分析：单聊与群聊两套展示', () => {
  it('⑤ 群聊有「是否在找你」与接话渠道，单聊没有这些字段', () => {
    const panel = read('ChatAnalysisPanel.tsx')
    // 群聊专属区块由 scope 判定，不能靠 isGroup prop 猜。
    expect(panel).toContain("analysis.scope === 'group'")
    expect(panel).toContain('是否在找你')
    expect(panel).toContain('在找你')
    expect(panel).toContain('要不要接话')
    expect(panel).toContain("action.channel === 'public'")
    // 单聊那套仍然在。
    expect(panel).toContain('对方意图')
    expect(panel).toContain('建议动作')
    // 旧实现把同一套「对方意图 / 对话温度」硬套到群聊，这里不允许回退。
    // 断言的是「不再作为卡片标题渲染」，注释里解释历史仍然允许提到它。
    expect(panel).not.toContain('>对话温度</div>')
    expect(panel).toContain('群里氛围')
  })

  it('⑥ 只做研判：不生成候选回复、不自己发请求', () => {
    const panel = read('ChatAnalysisPanel.tsx')
    expect(panel).not.toContain('apiSuggestReplies')
    expect(panel).not.toContain('AnalysisReplySuggest')
    expect(panel).not.toContain('apiAnalyzeMessage')
    // 状态由 hook 提供，面板只消费。
    expect(read('use-inline-analysis.ts')).toContain('apiAnalyzeMessage(')
  })
})

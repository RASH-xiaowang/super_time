/**
 * 「微信问答」UI 改动的离线冒烟（SSR，无浏览器）。
 *
 * 为什么这么做：本环境无法启动 Electron 窗口，但新加的 UI 里有两处**有分支的逻辑**
 * 值得真跑一遍而不是只看代码：
 *   ① `splitMarks`：把逐条标注拆成 useful/useless —— 一旦错位，反馈方向会正好相反；
 *   ② `RetrMeta` / `AnswerFeedback` 的条件渲染 —— 降级告警、已反馈态、无引用时不渲染。
 * 用 react-dom/server 把这些组件渲染成静态 HTML 并断言关键内容，能真实捕捉
 * 「条件写反 / 提前 return 把内容吃掉 / JSX 崩」这类问题。
 *
 * 由 scripts/ui-ask-smoke.js 负责 bundling 后执行。
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerFeedback, CiteList, RetrMeta, splitMarks, type AskTurn } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/Ask.tsx'
import { auditAnswerGrounding, groundingWarning } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/utils/grounding.ts'
import { RetrievalPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/RetrievalPanel.tsx'
import { SessionAsk } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/SessionAsk.tsx'
import { AiModelConfig } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/AiModelConfig.tsx'

let passed = 0
let failed = 0
/** 断言块。 */
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    console.error(`  ❌ ${name}\n     ${(e as Error).message}`)
  }
}
/** 极简断言。 */
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/** 构造一条助手轮次。 */
function turn(over: Partial<AskTurn> = {}): AskTurn {
  return {
    role: 'assistant',
    text: '上个月你一共转了 4 笔账。',
    citations: [
      { name: '房东老陈', time: '2026-09-05 20:12', snippet: '微信转账 收到转账3500.00元', username: 'wxid_chen', local_id: 3 },
      { name: '李四', time: '2026-09-04 09:30', snippet: '收到转账2000.00元', username: 'wxid_lisi', local_id: 14 },
    ],
    citedIndexes: [1],
    retrieval: {
      candidates: 42, kept: 2, scope: '全库', recency: false,
      intent: 'aggregation', denseActive: true, elapsedMs: 88,
      channels: [{ channel: 'sparse', count: 30, active: true }, { channel: 'dense', count: 12, active: true }],
      funnel: { recalled: 42, fused: 20, ranked: 20 }, chunks: 2, windowMessages: 9,
    },
    retrievalId: 'rabc123',
    ...over,
  }
}

console.log('splitMarks（反馈标注拆分）')
check('有用/没用分组正确且升序', () => {
  const r = splitMarks({ 3: 'useful', 1: 'useful', 2: 'useless' })
  ok(JSON.stringify(r.useful) === '[1,3]', `useful=${JSON.stringify(r.useful)}`)
  ok(JSON.stringify(r.useless) === '[2]', `useless=${JSON.stringify(r.useless)}`)
})
check('空标注返回空数组（不是 undefined）', () => {
  const r = splitMarks({})
  ok(Array.isArray(r.useful) && r.useful.length === 0, 'useful 应为空数组')
  ok(Array.isArray(r.useless) && r.useless.length === 0, 'useless 应为空数组')
})

console.log('RetrMeta（检索漏斗行）')
check('无统计时不渲染', () => {
  ok(RetrMeta({ retrieval: undefined }) === null, 'retrieval 为空应返回 null')
})
check('展示意图 / 通道 / 漏斗 / 耗时', () => {
  const html = renderToStaticMarkup(h(RetrMeta, { retrieval: turn().retrieval }))
  ok(html.includes('路由 聚合统计'), `缺少意图标签：${html}`)
  ok(html.includes('稀疏 30'), `缺少稀疏通道：${html}`)
  ok(html.includes('稠密 12'), `缺少稠密通道：${html}`)
  ok(html.includes('召回 42'), `缺少漏斗：${html}`)
  ok(html.includes('88ms'), `缺少耗时：${html}`)
  ok(!html.includes('稠密通道未生效'), '正常情况不该显示降级告警')
})
check('稠密通道降级时显式告警', () => {
  const t = turn()
  const html = renderToStaticMarkup(h(RetrMeta, { retrieval: { ...t.retrieval!, denseActive: false } }))
  ok(html.includes('稠密通道未生效'), `应显示降级告警：${html}`)
})

console.log('AnswerFeedback（回答反馈）')
check('有引用时渲染赞/踩按钮', () => {
  const html = renderToStaticMarkup(h(AnswerFeedback, { turn: turn(), patch: () => {} }))
  ok(html.includes('有帮助'), '缺少 👍 按钮')
  ok(html.includes('待改进'), '缺少 👎 按钮')
})
check('无引用且无追踪 id 时不渲染', () => {
  const html = renderToStaticMarkup(h(AnswerFeedback, { turn: turn({ citations: [], retrievalId: undefined }), patch: () => {} }))
  ok(html === '', `应渲染为空：${html}`)
})
check('已反馈态显示结果而非按钮', () => {
  const html = renderToStaticMarkup(h(AnswerFeedback, { turn: turn({ feedback: 'up' }), patch: () => {} }))
  ok(html.includes('已反馈：有帮助'), `缺少已反馈文案：${html}`)
  ok(!html.includes('待改进'), '已反馈后不该再显示 👎 按钮')
})
check('已反馈（踩）显示结果而非按钮', () => {
  const html = renderToStaticMarkup(h(AnswerFeedback, { turn: turn({ feedback: 'down' }), patch: () => {} }))
  ok(html.includes('已反馈：待改进'), `缺少待改进文案：${html}`)
})

console.log('RetrievalPanel（检索设置）')
check('关闭时不渲染', () => {
  // 注意：必须走 renderToStaticMarkup 而不是直接调用组件 —— 组件内部有 hooks，
  // 直接调用会触发「Invalid hook call」。（这也说明用 SSR 断言比肉眼审查更严格。）
  const html = renderToStaticMarkup(h(RetrievalPanel, { open: false, onClose: () => {} }))
  ok(html === '', `open=false 应渲染为空：${html}`)
})
check('打开时渲染面板骨架（未读到状态时给出占位）', () => {
  const html = renderToStaticMarkup(h(RetrievalPanel, { open: true, onClose: () => {} }))
  ok(html.includes('检索设置（RAG）'), '缺少面板标题')
  ok(html.includes('正在读取检索状态') || html.includes('向量库'), `面板内容异常：${html.slice(0, 200)}`)
})

console.log('SessionAsk（会话级 AI 面板）')
/** 造一个最小会话对象。 */
const sess = (username: string, displayName: string, type: 'private' | 'group'): never =>
  ({ username, displayName, type } as never)
check('空态渲染：标题/读取范围（只读）/引导问题/输入区/出处说明', () => {
  const html = renderToStaticMarkup(h(SessionAsk, {
    target: sess('123@chatroom', '项目组', 'group'),
    onClose: () => {},
    onOpenMessage: () => {},
    full: false,
    onToggleFull: () => {},
  }))
  ok(html.includes('新对话'), '缺少面板标题「新对话」')
  ok(html.includes('读取范围'), '缺少「读取范围」')
  ok(html.includes('项目组'), '范围里应显示当前会话名')
  ok(html.includes('想从聊天里了解什么？'), '缺少引导标题')
  for (const s of ['最近讨论了哪些重要的事？', '帮我找一下之前提过的报价', '有哪些事情还没确认？']) {
    ok(html.includes(s), `缺少引导问题：${s}`)
  }
  ok(html.includes('继续追问这段聊天'), '缺少输入框占位')
  ok(html.includes('回答附原文出处'), '缺少出处说明')
  ok(!html.includes('data-full'), '非全屏不该带 data-full')
  // 读取范围必须是只读展示；模型配置已迁到「数据配置」，面板内也不该再有模型下拉
  const combos = (html.match(/role="combobox"/g) || []).length
  ok(combos === 0, `会话 AI 面板内不该有任何下拉（范围只读、模型已迁出），实际 ${combos} 个 combobox`)
  ok(!html.includes('跟随聊天'), '范围锁定后不该再有「跟随聊天」这个只能取单值的控件')
  ok(html.includes('数据配置'), '应提示模型在「数据配置」中设置')
})
check('全屏态带 data-full（消息流让位）', () => {
  const html = renderToStaticMarkup(h(SessionAsk, {
    target: sess('wxid_a', '李四', 'private'),
    onClose: () => {}, onOpenMessage: () => {}, full: true, onToggleFull: () => {},
  }))
  ok(html.includes('data-full'), '全屏应带 data-full')
})

console.log('AiModelConfig（数据配置里的 AI 大模型卡片）')
check('渲染为「数据配置」里的卡片（标题 + 状态徽标）', () => {
  const html = renderToStaticMarkup(h(AiModelConfig, {}))
  ok(html.includes('AI 大模型'), '缺少卡片标题')
  ok(html.includes('全应用共用一份配置'), '缺少说明文案')
  // SSR 下 apiGetLlmConfig 的 effect 不执行 → 停在读取态
  ok(html.includes('读取配置中') || html.includes('模型供应商'), `卡片内容异常：${html.slice(0, 200)}`)
})

console.log('回答接地审计（回答里的金额 vs 所引原文）')
const cites: NonNullable<AskTurn['citations']> = [
  { name: '暴富群', time: '2026-03-16 21:34', snippet: '微信转账 收到转账13.00元。如需收钱，请点此升级至最新版本', username: 'g1', local_id: 1, sender: '小何' },
]
check('编造的金额被标出', () => {
  const a = auditAnswerGrounding('根据本机记录，最近一次转账来自王五，金额 5000.00 元 [1]。', cites, [1])
  ok(a.citedCount === 1, `citedCount=${a.citedCount}`)
  ok(a.ghostAmounts.length === 1 && a.ghostAmounts[0] === '5000.00元', `ghostAmounts=${JSON.stringify(a.ghostAmounts)}`)
  const w = groundingWarning(a)
  ok(!!w && w.includes('5000.00元'), `警示文案应点名金额：${w}`)
})
check('金额就在原文里时不告警', () => {
  const a = auditAnswerGrounding('最近一次收到转账 13.00 元 [1]。', cites, [1])
  ok(a.ghostAmounts.length === 0, `不该有 ghost：${JSON.stringify(a.ghostAmounts)}`)
  ok(groundingWarning(a) === null, '不该有警示')
})
check('只拿「被引用的那几段」当证据', () => {
  const two = [...cites, { name: '李四', time: '2026-09-04 09:30', snippet: '收到转账2000.00元', username: 'u2', local_id: 2 }]
  ok(auditAnswerGrounding('收到转账 2000.00 元 [2]。', two, [2]).ghostAmounts.length === 0, '引用了第 2 段就该认它')
  ok(auditAnswerGrounding('收到转账 2000.00 元 [2]。', two, [1]).ghostAmounts.length === 1, '没引用第 2 段就不该认它')
})
check('计数与合计不误报（只查金额）', () => {
  const a = auditAnswerGrounding('一共 3 笔转账，合计 13.00 元 [1]。', cites, [1])
  ok(a.ghostAmounts.length === 0, `「3 笔」是模型可以正当算出的，不该报：${JSON.stringify(a.ghostAmounts)}`)
})
check('一条来源都没引用时给「无引用」警示', () => {
  const a = auditAnswerGrounding('最近一次转账来自某人。', cites, [])
  ok(a.citedCount === 0, 'citedCount 应为 0')
  const w = groundingWarning(a)
  ok(!!w && w.includes('没有引用任何检索来源'), `文案不对：${w}`)
})
check('CiteList 端到端渲染出接地警示', () => {
  const t = turn({ text: '根据本机记录，最近一次转账来自王五，金额 5000.00 元 [1]。', citedIndexes: [1] })
  const html = renderToStaticMarkup(h(CiteList, { items: t.citations!, cited: t.citedIndexes, answer: t.text }))
  ok(html.includes('在它引用的原文里没有出现'), `缺少接地警示：${html.slice(0, 300)}`)
})
check('接地正常时 CiteList 不渲染警示', () => {
  const t = turn({ text: '最近一笔是 3500.00 元 [1]。', citedIndexes: [1] })
  const html = renderToStaticMarkup(h(CiteList, { items: t.citations!, cited: t.citedIndexes, answer: t.text }))
  ok(!html.includes('在它引用的原文里没有出现'), `不该有警示：${html.slice(0, 300)}`)
})

console.log(`\n${failed ? '❌' : '✅'} UI 冒烟：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`)
if (failed > 0) process.exitCode = 1

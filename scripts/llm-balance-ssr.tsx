/**
 * AI 大模型「三块可折叠面板 + 四条探针」的离屏冒烟（SSR，无浏览器）。
 *
 * 为什么需要它：2026-09-30 的重做（用户要求三块独立、每块可折叠、结构清晰）里有两件事
 * **只有真渲染一次才看得到**：
 *   ① 收起时内容是不是**真的没渲染**（CSS 隐藏的话输入框仍在 DOM 里、仍参与表单语义）；
 *   ② 三块各自的测试按钮是不是挂在**自己那一块**上（锚点 `data-test-llm` 的取值）。
 * 本环境没有 DOM 测试环境（M13/M15 的结论），所以用 react-dom/server 渲染成静态 HTML 断言。
 *
 * 运行：`node scripts/ui-ask-smoke.js scripts/llm-balance-ssr.tsx`
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AiModelPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/ai-model-panel.tsx'
import { LlmBalanceButton, LlmProbeButton } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/llm-probe.tsx'
import { SidebarBalance } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/SidebarBalance.tsx'

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

/** 一份填好的草稿配置（对话走 DeepSeek，向量与精排走 SiliconFlow —— 真实里常见的那种组合）。 */
const CFG = {
  provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-x', apiUrl: 'https://api.deepseek.com/v1', apiPath: '/chat/completions', timeoutMs: 20000,
  embeddingModel: 'Qwen/Qwen3-VL-Embedding-8B', embeddingApiUrl: 'https://api.siliconflow.cn/v1', embeddingApiKey: 'sk-y',
  rerankModel: 'Qwen/Qwen3-VL-Reranker-8B', rerankApiUrl: 'https://api.siliconflow.cn/v1',
}
/** 一块都没配的草稿（三条测试都该点不动）。 */
const EMPTY_CFG = { provider: '', model: '', apiKey: '', apiUrl: '', apiPath: '', timeoutMs: 20000 }

const openPanel = renderToStaticMarkup(h(AiModelPanel, {
  id: 'embed', title: '嵌入模型', subtitle: '知识库与问答的语义索引用它', status: { text: '跟随对话模型', tone: 'idle' }, open: true, onToggle: () => {},
  children: h('input', { 'data-probe-child': 'embed-body', readOnly: true }),
}))
const closedPanel = renderToStaticMarkup(h(AiModelPanel, {
  id: 'rerank', title: '重排序模型', subtitle: '留空则用本地加权排序', status: { text: '未启用（本地排序）', tone: 'idle' }, open: false, onToggle: () => {},
  children: h('input', { 'data-probe-child': 'rerank-body', readOnly: true }),
}))
const probes = (['chat', 'embed', 'rerank'] as const).map((kind) => renderToStaticMarkup(h(LlmProbeButton, { kind, cfg: CFG, label: `测试${kind}` })))
const emptyProbes = (['chat', 'embed', 'rerank'] as const).map((kind) => renderToStaticMarkup(h(LlmProbeButton, { kind, cfg: EMPTY_CFG, label: `测试${kind}` })))
const balance = renderToStaticMarkup(h(LlmBalanceButton, { cfg: CFG }))
const sidebarOpen = renderToStaticMarkup(h(SidebarBalance, { collapsed: false }))
const sidebarCollapsed = renderToStaticMarkup(h(SidebarBalance, { collapsed: true }))

console.log('AI 大模型：三块面板 / 四条探针 SSR 冒烟')

check('展开态：标题栏是按钮、aria-expanded=true、内容真的渲染出来', () => {
  ok(openPanel.includes('data-model-panel="embed"'), '缺面板锚点')
  ok(openPanel.includes('aria-expanded="true"'), '展开态没标 aria-expanded')
  ok(openPanel.includes('data-model-panel-toggle="embed"'), '标题栏不是可点的切换按钮')
  ok(openPanel.includes('嵌入模型') && openPanel.includes('知识库与问答的语义索引用它'), '标题/副标题没渲染')
  ok(openPanel.includes('跟随对话模型'), '状态徽标没渲染')
  ok(openPanel.includes('data-probe-child="embed-body"'), '展开时内容没渲染')
})

check('收起态：**内容一个字节都不在 DOM 里**（不是 CSS 隐藏），且 aria-expanded=false', () => {
  ok(closedPanel.includes('aria-expanded="false"'), '收起态没标 aria-expanded=false')
  ok(!closedPanel.includes('data-probe-child="rerank-body"'), '收起时内容仍被渲染 —— CSS 隐藏会让输入框仍参与表单语义')
  ok(closedPanel.includes('未启用（本地排序）'), '收起时状态徽标仍要在（那正是让人知道这块是什么状态的唯一线索）')
})

check('三条探针各挂自己那一块：锚点 data-test-llm 取值分别 chat / embed / rerank', () => {
  ;['chat', 'embed', 'rerank'].forEach((kind, i) => {
    ok(probes[i]!.includes(`data-test-llm="${kind}"`), `第 ${String(i + 1)} 条探针的锚点不是 ${kind}`)
    ok(probes[i]!.includes('测试'), '探针按钮没文案')
  })
})

check('配好之后按钮可点；一块都没配时三条都点不动（点了也没意义）', () => {
  ok(!/data-test-llm="(chat|embed|rerank)"[^>]*disabled/.test(probes.join('')), '配好了却仍被禁用')
  const disabledCount = emptyProbes.join('').split('disabled').length - 1
  ok(disabledCount >= 3, `空配置应三条都禁用，实际 ${String(disabledCount)} 条`)
})

check('余额按钮挂在三块之外（账户级信息），带稳定锚点', () => {
  ok(balance.includes('data-balance-llm=""'), '余额按钮缺锚点')
  ok(balance.includes('查询余额'), '余额按钮缺文案')
})

check('左下角余额条：首帧显示占位；收起态只留图标且文案仍在 DOM 里', () => {
  ok(sidebarOpen.includes('data-status="loading"') && sidebarOpen.includes('余额'), '首帧占位不对')
  ok(sidebarOpen.includes('每 5 分钟自动刷新'), '悬浮提示没写刷新口径')
  ok(sidebarCollapsed.includes('data-collapsed') && sidebarCollapsed.includes('余额'), '收起态把文案结构删了')
})

console.log(`\n${failed ? '❌' : '✅'} AI 大模型面板冒烟：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`)
if (failed > 0) process.exitCode = 1

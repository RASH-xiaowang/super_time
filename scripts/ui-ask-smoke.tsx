/**
 * 「微信问答」UI 改动的离线冒烟（SSR，无浏览器）。
 *
 * 为什么这么做：本环境无法启动 Electron 窗口，但这些地方的逻辑值得真跑一遍而不是只看代码：
 *   ① `splitMarks`：把逐条标注拆成 useful/useless —— 一旦错位，反馈方向会正好相反；
 *   ② `RetrMeta` / `AnswerFeedback` 的条件渲染 —— 降级告警、已反馈态、无引用时不渲染；
 *   ③ 「检索设置」面板已下线（参数固化为产品默认值），这里额外承担**源码级回归闸门**：
 *      文件是否真被删、问答页是否还有人把入口挂回来。见下方「检索设置」段。
 * 用 react-dom/server 把这些组件渲染成静态 HTML 并断言关键内容，能真实捕捉
 * 「条件写反 / 提前 return 把内容吃掉 / JSX 崩」这类问题。
 *
 * 由 scripts/ui-ask-smoke.js 负责 bundling 后执行。
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerFeedback, CiteList, RetrMeta, splitMarks, type AskTurn } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/Ask.tsx'
import { auditAnswerGrounding, groundingWarning } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/utils/grounding.ts'
import { SessionAsk } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/SessionAsk.tsx'
import { ReplySuggest } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/ReplySuggest.tsx'
import { AiModelConfig } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/AiModelConfig.tsx'
import { NoticeList } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/NoticeBanner.tsx'
import { buildNotices } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/notice.ts'
import { SetupGuideCard } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/SetupGuide.tsx'
import { DailySummaryPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/DailySummary.tsx'
import { PeriodSummaryPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/PeriodSummary.tsx'
import { AnnualPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/Annual.tsx'
import { GraphPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/Graph.tsx'
import { MomentsPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/Moments.tsx'
import { SettingsPanel } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/Settings.tsx'
import { emptyFacts, type SetupFacts } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/setup-guide.ts'
import { ProgressBar } from '../src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.tsx'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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

console.log('检索设置（产品决策：面板已移除，界面不再暴露任何可调参数）')
/**
 * 这一段是**回归闸门**，不是功能用例。
 *
 * 背景：检索层参数（通道开关 / 阈值 / 权重 / 容量 / 学习率）已固化为产品默认值，
 * 统一由后端 `query/retrieval/config.ts` 提供，且首次提问时网关会**自动**增量构建
 * 稠密向量索引 —— 也就是说界面上从来不需要一个「让用户自己调参」的地方。
 *
 * 这里断言的是**源码事实**（文件在不在、Ask 里还有没有引用），而不是渲染结果：
 * 渲染断言只有在面板真被挂回来、且默认展开时才会报警，太容易蒙混过关。
 */
const PAGES = join(
  dirname(fileURLToPath(import.meta.url)),
  'src/client/ui-wechat/src/client/pages/wechat-data',
)
/** 读该目录下的源码（相对 PAGES）。 */
const src = (rel: string): string => readFileSync(join(PAGES, rel), 'utf8')
/** 递归收集目录下的界面源码（.ts/.tsx，排除测试）。 */
function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourcesUnder(p))
    else if (/\.tsx?$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

check('面板组件文件已删除', () => {
  const panel = join(PAGES, 'panels/RetrievalPanel.tsx')
  ok(!existsSync(panel), `RetrievalPanel.tsx 应已删除：${panel}`)
})

check('问答页不再引用检索面板、不再有「检索」入口', () => {
  const ask = src('panels/Ask.tsx')
  for (const dead of ['RetrievalPanel', 'retrOpen', 'setRetrOpen', 'retrChipRef', 'kind="retrieval"']) {
    ok(!ask.includes(dead), `Ask.tsx 不该再出现 ${dead}（入口/面板被挂回来了？）`)
  }
  // 单栏布局：两栏侧开用的 data-side-open 也应一并消失
  ok(!ask.includes('data-side-open'), 'Ask.tsx 不该再有侧栏开合标记 data-side-open')
})

check('头部不再有「实时」开关（实时推送默认开启，2026-09-20 移除）', () => {
  // 先剥注释再断言：这段代码的注释里正解释着「原先那个开关写 localStorage.wc_realtime」，
  // 不剥的话守卫会被自己的说明文字打死（与本仓 privacy-statement.spec.ts 同一写法）。
  const chats = src('panels/Chats.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  for (const dead of ['toggleRealtime', 'wc_realtime', 'realtimeDot']) {
    ok(!chats.includes(dead), `Chats.tsx 不该再出现 ${dead}（「实时」开关被挂回来了？）`)
  }
  // 开关没了，轮询条件里就不该再有任何变量挡着它 —— 出现 realtime 变量即为回退。
  ok(!/\brealtime\b/i.test(chats), 'Chats.tsx 里不该再有 realtime 变量（实时推送应无条件开启）')
  // 防空转：剥注释后若把整份源码也剥没了，上面几条会恒真。
  ok(chats.length > 5000, `剥注释后剩下的源码只有 ${chats.length} 字符，stripComments 可能把代码也剥掉了`)
})

check('界面不再调用任何检索配置类接口（只保留回答反馈）', () => {
  // 反馈用过就删属于正常 UX，必须留；这些是"调参/运维"面，界面一律不碰。
  const forbidden = [
    'apiGetRetrievalStatus',
    'apiSaveRetrievalConfig',
    'apiBuildRagVectorIndex',
    'apiListRetrievalFeedback',
    'apiResetRetrievalWeights',
    'apiEvaluateRetrieval',
  ]
  const hits: string[] = []
  const files = sourcesUnder(PAGES)
  // 防空转：路径算错会让 sourcesUnder 返回空数组，从而「一条都没命中」而假通过。
  ok(files.length > 30, `扫描到的界面源码只有 ${files.length} 个，PAGES 路径可能算错了：${PAGES}`)
  for (const f of files) {
    // 跳过 API 层本身：它是这些包装的**定义处**，不是调用处。
    // M21 把 `api.ts` 拆成转发桶 + 8 个域模块（`api-core/api-read/api-kb/api-search/
    // api-media/api-export-ops/api-config/api-status`），所以按**前缀**整层跳过 ——
    // 只跳 `api.ts` 会让「定义搬去了 api-config.ts」被误报成「界面又在调这些接口」。
    if (/^api(-[a-z-]+)?\.ts$/.test(relative(PAGES, f).replace(/\\/g, '/'))) continue
    const body = readFileSync(f, 'utf8')
    for (const name of forbidden) {
      if (body.includes(name)) hits.push(`${relative(PAGES, f)} -> ${name}`)
    }
  }
  ok(hits.length === 0, `检索配置类接口不该再被界面调用：\n     ${hits.join('\n     ')}`)
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

console.log('ReplySuggest（单聊「推荐回复」面板）')
check('首帧只说「正在生成」，且下拉不许是空白', () => {
  // SSR 渲染的就是挂载那一帧（effect 不跑），所以这里能真实复现「首帧到底说了什么」。
  // 两条判别式都做过变异验证：`loading` 初值改回 false → 第三条变红；把 `Select` 的 value
  // 改回 `String(kbId)`（Radix 在选中项未挂载时渲染空白，连 placeholder 都不给）→ 第四条变红。
  // 库名本身**不在这里断言**：Radix 要把选中项渲染过一次才拿得到文字，静态渲染测不到真实浏览器
  // 挂载后的那一帧 —— 拿 SSR 的空白当「用户看到的空白」是个假结论。
  const html = renderToStaticMarkup(h(ReplySuggest, {
    target: { username: 'wxid_a', displayName: '李四' },
    onClose: () => {},
  }))
  ok(html.includes('推荐回复'), '缺少面板标题')
  ok(html.includes('正在按这段对话生成候选'), '首帧应显示「正在生成」')
  ok(!html.includes('这个会话还没有可用的对话内容'), '首帧还没有任何数据，那句「没有可用对话」在当时必然是假话')
  ok(html.includes('李四'), '「依据」一行应显示当前会话名')
  ok((html.match(/role="combobox"/g) || []).length === 1, `面板里应有且只有一个知识库下拉，实际 ${String((html.match(/role="combobox"/g) || []).length)} 个`)
  ok(html.includes('读取知识库…'), '库列表还没到位时，触发器要说明在读，而不是留一块空白')
  ok(!html.includes('请选择…'), '触发器不该停在共享组件那句通用的「请选择…」上')
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

console.log('NoticeList（右下角悬浮的主动提醒卡片）')
/** 提醒卡片是纯展示层（不碰 IPC），这里喂判定结果直接断言渲染事实。 */
const noticeHtml = (facts: Parameters<typeof buildNotices>[0]) =>
  renderToStaticMarkup(h(NoticeList, { notices: buildNotices(facts), onAction: () => {}, onDismiss: () => {} }))

check('没有该提醒的事时一个字都不渲染', () => {
  // 静默是最重要的默认：提醒条一旦「常驻」，用户就会开始无视它
  const html = noticeHtml({
    update: { phase: 'up-to-date' },
    license: { licensed: true, state: 'licensed', daysToExpiry: null },
  })
  ok(html === '', `应渲染为空：${html.slice(0, 160)}`)
})

check('新版本已下载：说清楚并给出「重启并安装」', () => {
  const html = noticeHtml({ update: { phase: 'downloaded', version: '1.4.0' } })
  ok(html.includes('v1.4.0 已下载'), `缺少版本提示：${html.slice(0, 200)}`)
  ok(html.includes('重启并安装'), '缺少安装动作')
  ok(html.includes('data-tone="warn"'), '未按 warn 强度渲染')
  ok(html.includes('data-notice="update:downloaded:1.4.0"'), '缺少稳定锚点（会话内关闭靠它去重）')
})

check('许可证只剩 3 天：强提醒 + 导出/去设置两条动作', () => {
  const html = noticeHtml({ license: { licensed: true, state: 'licensed', daysToExpiry: 3 } })
  ok(html.includes('只剩 3 天'), `缺少剩余天数：${html.slice(0, 200)}`)
  ok(html.includes('导出激活请求') && html.includes('去软件授权'), '动作不全')
  ok(html.includes('data-tone="danger"'), '未按 danger 强度渲染')
})

check('还剩 20 天：只浅提醒，不上强提醒色', () => {
  const html = noticeHtml({ license: { licensed: true, state: 'licensed', daysToExpiry: 20 } })
  ok(html.includes('20 天后到期'), `缺少提醒：${html.slice(0, 200)}`)
  ok(html.includes('data-tone="warn"') && !html.includes('data-tone="danger"'), '20 天不该用 danger')
})

check('两条同时冒出来：更新在前，各有独立关闭按钮', () => {
  const html = noticeHtml({
    update: { phase: 'downloaded', version: '1.4.0' },
    license: { licensed: true, state: 'licensed', daysToExpiry: 20 },
  })
  ok(html.indexOf('v1.4.0') < html.indexOf('20 天'), '更新的动作更即时，应排在授权之前')
  ok((html.match(/aria-label="关闭提醒/g) ?? []).length === 2, '每条都要能单独关掉')
})

console.log('SetupGuideCard（首次进入系统的配置向导卡）')
/** 向导卡同样是纯展示层，喂事实夹具直接断言。 */
const guideHtml = (facts: Partial<SetupFacts>) =>
  renderToStaticMarkup(h(SetupGuideCard, { facts: { ...emptyFacts(), ...facts }, onOpenStep: () => {}, onLater: () => {} }))

check('全未配置：四项都在、四项都有「去配置」、进度 0/4', () => {
  const html = guideHtml({})
  ok(html.includes('首次配置向导'), '缺少标题')
  ok(html.includes('已完成 0/4'), `进度不对：${html.slice(0, 120)}`)
  for (const t of ['检测账号', '数据库密钥', '图片密钥', '图片解码']) ok(html.includes(t), `缺少步骤：${t}`)
  ok((html.match(/去配置/g) ?? []).length === 5, '四个必做 + 一个可选，都该有「去配置」')
})

check('配好两项：进度 2/4，已完成的项不再给「去配置」', () => {
  const html = guideHtml({ accounts: 2, keysLoaded: true, keyCount: 22 })
  ok(html.includes('已完成 2/4'), `进度不对：${html.slice(0, 120)}`)
  ok((html.match(/data-done="true"/g) ?? []).length === 2, '应有两项标为已完成')
  ok((html.match(/去配置/g) ?? []).length === 3, '剩下两项必做 + 可选一项')
})

check('语音转写是可选：没就绪不影响「完成」的计数口径', () => {
  const html = guideHtml({ accounts: 1, keysLoaded: true, keyCount: 1, imgAes: 'a', cdnEnabled: true, voiceReady: false })
  ok(html.includes('已完成 4/4'), '四项必做齐了就该是 4/4（语音不计入）')
  ok(html.includes('语音转文字（可选）'), '可选行仍在，标为可选')
  ok(!html.includes('data-step="voice" data-done'), '语音没就绪时不该显示为已完成')
})

console.log('总结三页（紧凑改版的 SSR 落地）')
check('每日总结：面板壳 + 页签 + 空态落地卡都能渲染', () => {
  const html = renderToStaticMarkup(h(DailySummaryPanel, {}))
  ok(html.includes('每日总结'), '缺少面板标题')
  for (const t of ['总结任务栏', '总结阅览', '手动生成']) ok(html.includes(t), `缺少页签：${t}`)
  ok(html.includes('三步拿到第一份总结'), '缺少空态落地卡')
})
check('周期总结：表单与落地卡都能渲染', () => {
  const html = renderToStaticMarkup(h(PeriodSummaryPanel, {}))
  ok(html.includes('周期总结'), '缺少面板标题')
  ok(html.includes('生成总结') && html.includes('复制结果'), '缺少生成/复制动作')
  ok(html.includes('当前区间'), '缺少当前区间说明')
  ok(html.includes('还没有这一段的总结'), '缺少空态落地卡')
})
check('年度报告：面板头能渲染（无数据时停在骨架，不崩）', () => {
  const html = renderToStaticMarkup(h(AnnualPanel, {}))
  ok(html.includes('年度报告'), '缺少面板标题')
  ok(html.includes('导出报告'), '缺少导出动作')
})

console.log('社交图谱（本轮改的是连线挑选与布局，这里抓渲染期崩溃）')
check('社交图谱：无数据时面板头与右侧控制栏都能渲染', () => {
  const html = renderToStaticMarkup(h(GraphPanel, {}))
  ok(html.includes('社交图谱'), '缺少面板标题')
  ok(html.includes('好友网络'), '缺少模式名')
  for (const t of ['节点', '连线', '圈子', '重新布局', '节点间距', '圈子分离度']) {
    ok(html.includes(t), `缺少控制项：${t}`)
  }
})
check('知识图谱：同一组件换 variant 也能渲染', () => {
  const html = renderToStaticMarkup(h(GraphPanel, { variant: 'knowledge' }))
  ok(html.includes('知识图谱'), '缺少知识图谱标题')
})

// M21 要拆 Moments.tsx（1696 行）前先补的**渲染兜底**：这一屏此前只有源码级守卫、
// 没有任何一处真的把它渲染出来（拆 JSX 时最容易出的错是运行期崩溃，源码断言看不见）。
console.log('朋友圈（M21 拆 Moments 前的渲染兜底）')
check('朋友圈：无数据时面板头与工具栏都能渲染（不崩）', () => {
  const html = renderToStaticMarkup(h(MomentsPanel, { author: null }))
  ok(html.includes('朋友圈'), '缺少面板标题')
  ok(html.includes('本机朋友圈动态'), '缺少面板说明（desc）')
  for (const t of ['搜索作者 / 内容 / 位置 / 评论', '隐私', '导出', '排序']) {
    ok(html.includes(t), `缺少工具栏项：${t}`)
  }
})
check('朋友圈：带 author 过滤时给出「仅看 X」与返回入口', () => {
  const html = renderToStaticMarkup(h(MomentsPanel, { author: '某人', onClearAuthor: () => {} }))
  ok(html.includes('仅看 某人'), '缺少「仅看 X」入口')
  ok(html.includes('返回全部动态'), '缺少返回全部动态入口')
})

console.log('设置（M21 拆 Settings 前的渲染兜底）')
check('设置：左导航与右内容都能渲染（不崩）', () => {
  const html = renderToStaticMarkup(h(SettingsPanel, {}))
  ok(html.includes('设置'), '缺少面板标题')
  for (const t of ['智能与隐私', '高级', 'AI 大模型', '数据边界与出网']) {
    ok(html.includes(t), `缺少导航项：${t}`)
  }
})

/**
 * M3 真机验收发现的第四个断链（`scripts/export-progress-e2e.mjs` / `backup-progress-e2e.mjs`
 * 也在真应用里钉着同一条）：「导全部」时后端**故意**报 `total=0`（总量未知），客户端若仍按
 * 百分比画，就是一根钉在 0% 的空条，用户眼里等于卡死。组件层面的口径钉在这里 ——
 * 界面上两条入口（导出 / 加密备份）共用同一个 ProgressBar。
 */
console.log('进度条：定量与不定量（M3）')
check('总量未知时走不定量态：不给 aria-valuenow，也不写内联宽度', () => {
  const html = renderToStaticMarkup(h(ProgressBar, { value: 0, indeterminate: true }))
  ok(html.includes('role="progressbar"'), '进度条失去了 role')
  ok(html.includes('data-indeterminate'), 'indeterminate 没落到 DOM 上（CSS 就没法画扫动）')
  ok(!html.includes('aria-valuenow'), '总量未知却报了 aria-valuenow ⇒ 读屏会念「0%」')
  ok(!html.includes('width:'), '总量未知却写了内联宽度 ⇒ 那正是「钉在 0%」的成因')
})
check('总量已知时按百分比画，并且不披不定量态', () => {
  const html = renderToStaticMarkup(h(ProgressBar, { value: 42.6 }))
  ok(!html.includes('data-indeterminate'), '总量已知却走了不定量态')
  ok(html.includes('aria-valuenow="43"'), `aria-valuenow 应当是四舍五入的整数：${html}`)
  ok(html.includes('width:42.6%'), `宽度应当按百分比画：${html}`)
})
check('百分比越界要夹住（负数与超过 100 都不该画崩）', () => {
  ok(renderToStaticMarkup(h(ProgressBar, { value: -5 })).includes('width:0%'), '负值没夹到 0')
  ok(renderToStaticMarkup(h(ProgressBar, { value: 130 })).includes('aria-valuenow="100"'), '超界没夹到 100')
})

console.log(`\n${failed ? '❌' : '✅'} UI 冒烟：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`)
if (failed > 0) process.exitCode = 1

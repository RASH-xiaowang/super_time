/**
 * 「问答历史记录」入口的**接线**守卫。
 *
 * 为什么需要源码级守卫：仓库没有 DOM/hook 测试环境（M13/M14 的既定结论），
 * 「按钮有没有真的挂上、点击有没有真的开弹窗」在用例里观测不到。而这条链路里
 * 最容易静默断掉的两处是：
 *   ① 面板头渲染了按钮、但 onClick 没接到开关（界面表现：点了没反应）；
 *   ② 弹窗组件写好了、但面板没渲染它（界面表现：功能整个不存在，既有用例全绿）。
 *
 * 另外把三条**行为契约**钉住（它们都是产品取舍，不是实现细节）：
 *   · 「再问一次」只把问题填回输入框，**不自动发送**（用户要先有机会改措辞）；
 *   · 引用点击必须走面板传下来的同一条跳转回调（否则历史里的引用点了没反应）；
 *   · 「清空全部」必须过应用内确认框（不可恢复 + 影响面大）。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 读源码并去掉注释 —— 否则注释里提到旧做法会让断言误判。 */
function codeOf(file: string): string {
  const src = readFileSync(join(HERE, file), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

const ask = codeOf('Ask.tsx')
const dialog = codeOf('AskHistoryDialog.tsx')
const dialogCss = codeOf('ask-history.module.css')
const runtimeTrace = codeOf('AskHistoryRuntimeTrace.tsx')
const runtimeAdapter = codeOf('ask-history-runtime-trace.ts')

describe('问答历史：入口挂在「微信问答」面板头', () => {
  it('弹窗组件存在且被 Ask.tsx import', () => {
    expect(existsSync(join(HERE, 'AskHistoryDialog.tsx'))).toBe(true)
    expect(ask).toContain("from './AskHistoryDialog.tsx'")
    expect(ask).toContain('<AskHistoryDialog')
  })

  it('面板头有入口按钮，且点击真的把开关置为 true', () => {
    // 入口标记（自动化/审计可据此定位）
    expect(ask).toContain('data-open-ask-history')
    // 不是只渲染了按钮而 onClick 没接上
    expect(ask).toMatch(/setHistoryOpen\(true\)/)
    expect(ask).toMatch(/useState\(false\)/)
    expect(ask).toMatch(/<AskHistoryDialog[^>]*open=\{historyOpen\}/)
    expect(ask).toMatch(/onClose=\{\(\) => \{ setHistoryOpen\(false\) \}\}/)
  })

  it('入口常驻可见（不受「有没有问过」影响）：按钮不在 userTurnCount 的条件里', () => {
    // 「清空对话」是条件渲染的（有轮次才出现），历史入口不该跟着一起消失 ——
    // 刚打开面板还没提问时，恰恰是最想回看上次问过什么的时刻。
    const btnAt = ask.indexOf('data-open-ask-history')
    expect(btnAt).toBeGreaterThan(-1)
    const condAt = ask.indexOf('{userTurnCount > 0 && (')
    expect(condAt).toBeGreaterThan(-1)
    // 入口出现在那个条件**之前** ⇒ 它不在 `{userTurnCount > 0 && …}` 块内
    expect(btnAt).toBeLessThan(condAt)
  })

  it('调用的三个后端接口都在弹窗里接上了（只画界面不取数 = 空壳）', () => {
    for (const marker of ['apiGetAskHistory', 'apiDeleteAskHistory', 'apiClearAskHistory']) {
      expect(dialog, `问答历史弹窗缺少 ${marker}`).toContain(marker)
    }
    // 读接口不能被缓存住：刚问完就打开必须能看到那一条
    expect(dialog).toContain('usePagedList')
  })

  it('展开记录时接入持久化执行轨迹，旧记录 undefined 时静默不渲染', () => {
    expect(dialog).toContain("from './AskHistoryRuntimeTrace.tsx'")
    expect(dialog).toContain('<AskHistoryRuntimeTraceView trace={it.runtimeTrace} />')
    expect(dialog).toMatch(/\{expanded && <AskHistoryRuntimeTraceView/)
    expect(runtimeTrace).toContain('askHistoryTraceViewOf(trace)')
    expect(runtimeTrace).toContain('if (view === null) return null')
    expect(runtimeTrace).toContain('<RunTraceTimeline')
    expect(runtimeTrace).toContain('streaming={false}')
    expect(runtimeTrace).toContain('过程记录已按本机存储预算截断')
  })

  it('历史轨迹复用实时轮次分组，而不是另写一份 reasoning 平铺', () => {
    expect(runtimeAdapter).toContain('traceGroupsOf({ stages, tools, reasoning })')
    expect(runtimeAdapter).toContain('normalizeAskStage')
    expect(runtimeAdapter).toContain('normalizeAskReasoningSegment')
    expect(runtimeAdapter).toContain('toolViewsOf')
    expect(dialogCss).toContain('.runtimeTrace')
    expect(dialogCss).toContain('.traceNotice')
  })

  it('吸顶筛选条盖住滚动区顶部内边距，避免列表内容从上方缝隙露出', () => {
    expect(dialogCss).toMatch(
      /\.head\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?box-shadow:\s*0\s+calc\(-1\s*\*\s*var\(--nm-s-4\)\)\s+0\s+var\(--nm-bg-card\)/,
    )
  })
})

describe('问答历史：三条行为契约', () => {
  it('「再问一次」只填回输入框，不自动发送', () => {
    expect(ask).toMatch(/onAskAgain=\{\(q\) => \{[^}]*setQuestion\(q\)/)
    // 箭头函数体内不得出现提问调用（自动发送会让用户失去改措辞的机会）
    const handler = /onAskAgain=\{\(q\) => \{([^}]*)\}/.exec(ask)
    expect(handler, '未找到 onAskAgain 接线').not.toBe(null)
    expect(handler![1]).not.toContain('ask(')
  })

  it('引用点击走面板传下来的同一条跳转回调', () => {
    // 逐属性断言（不能用 `<AskHistoryDialog[^>]*…` —— props 里的箭头函数 `=>` 会提前截断匹配）
    expect(ask).toContain('onOpenCitation={onOpenChat}')
    // 「点了去哪」由 citeTarget 统一判定 —— 历史弹窗不自己看 local_id（那份判定只在 cite-target.ts 有一份）
    expect(dialog).toContain('citeTarget(c)')
    // 只有**消息来源**才跳会话，且参数取自 citeTarget 的结果（不是裸 c.username / c.local_id）
    expect(dialog).toMatch(/target\?\.kind === 'msg'\) onOpenCitation\?\.\(target\.username, target\.localId\)/)
    // 知识库来源是独立按钮：它必须走 onOpenKbFile(kbId, fileId)，绝不能把合成 username
    // 喂给会话跳转 —— 那会静默地去开一个不存在的会话（不抛错、界面只是空着）。
    expect(dialog).toContain('data-src="kb"')
    expect(dialog).toContain('onOpenKbFile(kbId, fileId)')
    expect(ask).toContain('onOpenKbFile={onOpenKbFile}')
    expect(dialog).not.toMatch(/onOpenCitation\?\.\(c\.username/)
  })

  it('「清空全部」过应用内确认框，且不放在筛选行里', () => {
    expect(dialog).toContain('useConfirm')
    expect(dialog).toMatch(/clearAll/)
    expect(dialog).toMatch(/const ok = await confirm\(/)
    // 危险动作单独一行（避免用户筛着筛着顺手点掉全库历史）
    expect(dialog).toContain('data-clear-ask-history')
  })
})

describe('问答历史：会话范围带企业名', () => {
  it('Ask 写入范围名、历史列表读取范围名都统一追加企业', () => {
    expect(ask).toContain("import { identityLabel, sessionDisplayNameWithEnterprise } from './enterprise-identity.ts'")
    expect(ask, 'Ask 的检索范围名没带企业').toContain(
      'sessionDisplayNameWithEnterprise(sessions, scopeUsername)',
    )
    expect(ask, '企业后缀破坏了空态示例的会话匹配').toContain(
      'buildAskExamples(sessions, scopeUsername || scopeDisplayName)',
    )
    expect(dialog).toContain("import { identityLabel, withEnterprise } from './enterprise-identity.ts'")
    expect(dialog, '问答历史范围仍是裸 usernameName').toContain(
      'withEnterprise(item.usernameName || item.username, item.usernameEnterpriseName)',
    )
  })
})

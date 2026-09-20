/**
 * 「社交图谱并入通讯录」的接线守卫（源码级）。
 *
 * 为什么这类断言必须看源码：本仓库没有 DOM/React 测试环境（vitest 只跑纯逻辑模块），
 * 导航项、分段条、路由分支都渲染不起来。而这次迁移的退化方式**界面照样能开**，只是入口坏了：
 *   ① `graph` 忘了标 `hidden` —— 侧栏会同时出现「通讯录」与「社交图谱」两个入口，
 *      而段条里也有「社交图谱」，同一个视图有了两条路（用户会以为是两件不同的事）；
 *   ② `graph` 被从 `WechatTab` 或 `TAB_LABELS` 里删掉 —— 深链 `#graph` 直接落回「数据总览」，
 *      段条第二段也点不出东西（`WechatDataPanel` 用 `initialHash in TAB_LABELS` 判初始页签）；
 *   ③ `case 'graph'` 没跟着 `case 'contacts'` 一起进 MergedSections ——
 *      深链 `#graph` 落进 `default` 分支，显示「面板正在重构中」，而测试不会红；
 *   ④ 合并时把 `seedQuery` / `onNavigate` / `onOpenMoments` 这些 props 漏掉 ——
 *      全局搜索命中「联系人」跳过来时关键词种不进去，资料卡里的「TA 的朋友圈 / 发消息」失效。
 *
 * 反过来也钉一条**防过度合并**：知识图谱不属于通讯录语义（它是「我的笔记」），
 * 不能顺手并进 contacts|graph 这一段 —— 2026-09-18 起它有自己的合并（knowledge|kb，
 * 「笔记」的文档视图与网络视图），与通讯录这次合并互不相干。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, TAB_LABELS, type WechatTab } from '../nav-config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const panelShell = readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx'), 'utf8')
const kbShellSrc = readFileSync(join(HERE, 'KbShell.tsx'), 'utf8')
const graphCss = readFileSync(join(HERE, 'graph.module.css'), 'utf8')
const contactsCss = readFileSync(join(HERE, 'contacts.module.css'), 'utf8')

const ALL = NAV_GROUPS.flatMap(g => g.items)
const item = (tab: string): (typeof ALL)[number] | undefined => ALL.find(it => it.tab === tab)

/** 去注释后读源码：`case 'contacts'` 与 `case 'knowledge'` 之间夹着的是**给下一个分支
 *  看的说明注释**，负向断言不剥注释就会把「注释里提到 KbShell」当成违规（本仓库别处
 *  踩过同一个坑，故这里显式剥）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

/** 摘出 `case 'contacts':` 到 `case 'knowledge':` 之间那段（本次迁移的落点）。 */
function mergedBranch(): string {
  const from = panelShell.indexOf("    case 'contacts':")
  const to = panelShell.indexOf("    case 'knowledge':")
  expect(from, '找不到 contacts 的 case 分支').toBeGreaterThan(0)
  expect(to, '找不到 knowledge 的 case 分支').toBeGreaterThan(from)
  return panelShell.slice(from, to)
}

/** 摘出 `case 'knowledge':` 到「下一个**不是 kb / kbfiles 的** case」之间那段。
 *  不能用 `indexOf('    case ', from + 10)` —— 那会命中紧邻的 `case 'kb'` 自己。
 *  ⚠️ 负向断言必须把 `kbfiles` 也排除：`kbfiles` 不以 `kb'` 开头，只写 `(?!kb')`
 *  会把 `case 'kbfiles':` 当成分支外的 case，切片被**静默截短** —— 旧断言照样成立，
 *  新加的「第三段」断言却看不见它（假绿）。T2 加文件视图时踩过一次。 */
function kbBranch(from: number): string {
  const rest = panelShell.slice(from)
  const stop = rest.search(/\r?\n {4}case '(?!kb'|kbfiles')/)
  return stop > 0 ? rest.slice(0, stop) : rest
}

describe('导航项：通讯录是唯一入口，社交图谱转为可路由的隐藏项', () => {
  it('contacts 仍是可见的侧栏条目', () => {
    expect(item('contacts')?.hidden, 'contacts 不该被隐藏').toBeFalsy()
    expect(item('contacts')?.label).toBe('通讯录')
  })

  it('graph 标为 hidden（不再占侧栏条目，但仍是合法 tab）', () => {
    expect(item('graph'), 'nav-config 里找不到 graph 条目').toBeDefined()
    expect(item('graph')?.hidden, 'graph 必须标 hidden，否则与段条重复入口').toBe(true)
  })

  it('侧栏可见条目里不再有「社交图谱」，且通讯录可见（防重复 / 防空转）', () => {
    const visible = ALL.filter(it => !it.hidden).map(it => it.tab)
    expect(visible, 'graph 不应再是可见条目').not.toContain('graph')
    expect(visible, 'contacts 必须是可见条目').toContain('contacts')
    // 计数口径：侧栏分组内**实际渲染**的条目 = 未标 hidden 且不是「设置」
    // （`settings` 固定渲染在侧栏底部，分组循环用 `it.tab !== 'settings'` 排掉它，
    //  它仍留在 NAV_GROUPS 里只为提供图标）。
    // 精确钉住而不是写 `>= 15`：README 那个数字就是靠模糊口径长期停在错误值上。
    const inGroups = visible.filter(t => t !== 'settings')
    expect(inGroups.length, '侧栏分组内可见条目数变了 —— 请同步 README 与 OnboardingShell 的 MODULES').toBe(16)
    expect(visible, '「设置」仍应作为底部入口留在 NAV_GROUPS 里（图标来源）').toContain('settings')
  })

  it('graph 仍是合法深链目标：留在 WechatTab 联合类型与 TAB_LABELS 里', () => {
    // 这是 `#graph` 深链能落到图谱段的**前提**（WechatDataPanel 用 `initialHash in TAB_LABELS`
    // 判初始页签）：从联合类型里删掉 graph 会在 typecheck 阶段红；从 NAV_GROUPS 里删掉条目
    // 则 TAB_LABELS 会缺这个键 —— 深链静默落回「数据总览」，不会有任何报错。
    // TAB_LABELS 是**由 NAV_GROUPS 构建**的（含 hidden 条目），所以后者能被这条断言钉住。
    expect(TAB_LABELS.contacts).toBe('通讯录')
    expect(TAB_LABELS.graph, 'TAB_LABELS 丢了 graph，深链会落回数据总览').toBe('社交图谱')
    const routable: WechatTab[] = ['contacts', 'graph']
    for (const t of routable) expect(TAB_LABELS[t], `TAB_LABELS 缺 ${t}`).toBeTruthy()
  })

  it('知识图谱不跟着并进通讯录：它有自己的合并（knowledge|kb）', () => {
    // 2026-09-18：知识图谱并入「知识库」，因此它**是** hidden（侧栏只留「知识库」一个
    // 笔记入口）—— 但这条断言的重点是「与通讯录无关」：联系人与社交组下只有一次合并。
    expect(item('knowledge'), 'nav-config 里找不到 knowledge 条目').toBeDefined()
    expect(item('knowledge')?.hidden, 'knowledge 应标 hidden：已并入知识库').toBe(true)
    expect(item('knowledge')?.label).toBe('知识图谱')
    const group = NAV_GROUPS.find(g => g.items.some(it => it.tab === 'knowledge'))
    expect(group?.label, 'knowledge 被挪到别的分组了').toBe('联系人与社交')
    expect(mergedBranch(), "knowledge 被并进了通讯录分段").not.toContain("case 'knowledge'")
  })
})

describe('路由：contacts 与 graph 走同一个合并外壳', () => {
  it('两个 case 落进同一段 MergedSections（不是各自 return）', () => {
    const branch = mergedBranch()
    expect(branch, "case 'contacts' 与 case 'graph' 没有并列").toMatch(/case 'contacts':\s*\n\s*case 'graph':/)
    expect(branch).toContain('<MergedSections')
    expect(branch).toContain('initial={tab}')
  })

  it('分段条两段齐全：通讯录 + 社交图谱（key 必须等于 tab id，深链才对得上）', () => {
    const branch = mergedBranch()
    expect(branch).toContain("{ key: 'contacts', label: '通讯录'")
    expect(branch).toContain("{ key: 'graph', label: '社交图谱'")
    // ariaLabel 是 Segmented 的无障碍标签，合并组都要求有
    expect(branch).toMatch(/ariaLabel="[^"]+"/)
  })

  it('图谱段仍是 variant="social"（不能顺手改成 knowledge）', () => {
    const branch = mergedBranch()
    expect(branch).toMatch(/<GraphPanel variant="social"/)
  })

  it('知识图谱不混进通讯录分支：它走自己的 knowledge|kb 合并外壳', () => {
    const branch = mergedBranch()
    expect(branch, '图谱面板被并进通讯录分段').not.toContain('variant="knowledge"')
    // 三栏重排（2026-09-19）之后，通讯录那一段也不许引用知识库外壳（先去注释：
    // 这一段末尾紧跟着的就是给下一个分支看的说明注释）。
    expect(stripComments(branch), '通讯录分段不该出现知识库外壳').not.toContain('KbShell')
    const from = panelShell.indexOf("    case 'knowledge':")
    expect(from, '找不到 knowledge 的 case 分支').toBeGreaterThan(0)
    const kb = kbBranch(from)
    expect(kb, "knowledge 没与 kb / kbfiles 并列成同一个外壳").toMatch(/case 'knowledge':\s*\n\s*case 'kb':\s*\n\s*case 'kbfiles': return \(/)
    // 2026-09-19：三个分段与它们的面板搬进了 `KbShell.tsx`（rail + 分段 + 面板体），
    // `WechatDataPanel` 这里只剩一个分支。**语义没变**：三个 tab 仍共用同一个外壳，
    // 所以这里钉「分支指向 KbShell 且带上当前 tab」，把「三段齐全」下移到 KbShell 的源码上。
    expect(kb).toContain('<KbShell')
    expect(kb).toContain('initial={tab}')
    expect(kbShellSrc, 'KbShell 里图谱不再是 knowledge 变体').toMatch(/<GraphPanel variant="knowledge"/)
    expect(kbShellSrc, 'KbShell 丢了笔记库面板').toContain('<KnowledgeBasePanel')
    // T2 并入的第三段（文件）也在这**同一个**外壳里；别顺手挂到通讯录那一段去
    // （笔记与文件都不属于「联系人与社交」的语义）。
    expect(kbShellSrc).toContain("{ key: 'kbfiles', label: '文件'")
    expect(kbShellSrc).toContain('<KbFilesPanel')
  })
})

describe('无功能丢失：通讯录原有的四个 props 全部透传', () => {
  it('onNavigate / onOpenChat / onOpenMoments / seedQuery 一个都不能少', () => {
    const branch = mergedBranch()
    const contactsLine = branch.slice(branch.indexOf('<ContactsPanel'), branch.indexOf('<ContactsPanel') + 600)
    for (const p of ['onNavigate', 'onOpenChat', 'onOpenMoments', 'seedQuery']) {
      expect(contactsLine, `ContactsPanel 少了 ${p}`).toContain(p)
    }
    // seedQuery 仍按 tab 判来源（否则文件/收藏的种子会误种到通讯录）
    expect(contactsLine).toContain("seed?.tab === 'contacts'")
  })

  it('图谱段仍把 onOpenChat 传下去（详情面板的「查看聊天」）', () => {
    const branch = mergedBranch()
    const gLine = branch.slice(branch.indexOf('<GraphPanel'), branch.indexOf('<GraphPanel') + 200)
    expect(gLine).toContain('onOpenChat={onOpenChat}')
  })

  it('图谱面板内部零改动：画布 / 图例 / 右侧控制栏 / 三类导出仍在自己文件里', () => {
    const graphPanel = readFileSync(join(HERE, 'Graph.tsx'), 'utf8')
    // 迁移只动导航与外壳；这些是「功能没丢」的锚点。知识笔记编辑器（variant='knowledge'
    // 才用得到）与社交侧同在 Graph.tsx 里，一并留在锚点里 —— 顺带证明这次没有把 Graph.tsx
    // 按 variant 拆成两个文件（拆了就会让两套面板各有一份状态，社交侧的历史布局缓存也会分叉）。
    for (const anchor of ['<GraphCanvas', 'legendLineBlueDash', 'doExportPoster', 'doExportSvg', 'KnowledgeNoteEditor', '最亲近 · 消息量']) {
      expect(graphPanel, `Graph.tsx 少了 ${anchor}`).toContain(anchor)
    }
  })
})

describe('小屏适配：并入后补的两条断点仍在', () => {
  it('图谱主体在 ≤900px 纵向堆叠，且控制栏允许收缩（否则把画布顶出容器）', () => {
    const block = graphCss.slice(graphCss.indexOf('@media (max-width: 900px)'))
    expect(block, '缺少 900px 断点').not.toBe('')
    expect(block).toMatch(/\.body \{ flex-direction: column; \}/)
    expect(block, '控制栏缺 max-height 会按内容高度溢出').toMatch(/max-height: 45%/)
    expect(block, '控制栏 flex-shrink 必须放开（原为 0）').toMatch(/flex-shrink: 1;/)
    expect(block, '画布需要高度地板').toMatch(/\.stage \{ min-height: 260px; \}/)
  })

  it('通讯录的 A–Z 索引栏在 ≤700px 隐藏（窄屏网格退化后它会压住卡片）', () => {
    const block = contactsCss.slice(contactsCss.indexOf('@media (max-width: 700px)'))
    expect(block).not.toBe('')
    expect(block).toMatch(/\.indexBar \{ display: none; \}/)
  })

  it('宽屏行为不受影响：900px 断点是 max-width，桌面档不命中', () => {
    // 断言用的是 max-width 而非 min-width —— 写反会让桌面档吃到纵向堆叠
    expect(graphCss).toContain('@media (max-width: 900px)')
    expect(graphCss).not.toContain('@media (min-width: 900px)')
  })

  it('画布内两个底部浮层在窄屏不互压：图例换行占满宽、小地图挪到右上', () => {
    // 实测（430px × 900，CDP 探针 + 截图）：并入之后画布能从 ~108px 恢复到整宽，
    // 但底部两个绝对定位浮层会撞在一起 —— 图例（单行胶囊、无 flex-wrap）被压成
    // 「一个字一行」的竖条，148px 的小地图（z-index:5）正压在上面。
    // 只改 .body 的纵排解决不了：它们是 .stage 的子元素，与两栏/一栏无关。
    const block = graphCss.slice(graphCss.indexOf('@media (max-width: 820px)'))
    expect(block, '缺少 820px 的浮层避让断点').not.toBe('')
    // 只取**规则体**，不要把注释也算进来 —— 注释里引用了被否掉的写法（`width: 104px`），
    // 直接对整块做「不含 width」的断言会被自己的注释误伤（本轮实测踩过）。
    const ruleBody = (sel: string): string => {
      const at = block.indexOf(`${sel} {`)
      expect(at, `820px 断点里找不到 ${sel} 规则`).toBeGreaterThan(-1)
      return block.slice(at, block.indexOf('}', at))
    }
    const legend = ruleBody('.legend')
    // `right` 是这组改动的关键：只给 flex-wrap 而不约束宽度，flex 行仍会被无限压缩
    expect(legend, '图例缺 right，flex 行仍会把中文压成逐字折行').toMatch(/right:\s*8px/)
    expect(legend, '图例缺 flex-wrap，单行胶囊换不了行').toMatch(/flex-wrap:\s*wrap/)
    const mini = ruleBody('.minimap')
    expect(mini, '小地图仍留在底部会压住图例').toMatch(/bottom:\s*auto/)
    expect(mini, '小地图需要换到上部（top）').toMatch(/top:\s*8px/)
    // 小地图的**尺寸**不能在这里改：GraphCanvas.tsx 把 148×96（连同 dpr 位图）
    // 写成行内样式，行内优先级高于选择器 → 这里写 width/height 是死代码（实测量到仍是 148×96）。
    // 这条断言是防「下一个人以为是漏写了尺寸、又加回来」。
    expect(mini, '小地图尺寸由 JS 行内样式决定，CSS 里写 width/height 是死代码').not.toMatch(/width:/)
    expect(mini, '小地图尺寸由 JS 行内样式决定，CSS 里写 width/height 是死代码').not.toMatch(/height:/)
    // 两个浮层都必须保留（这是避让，不是隐藏 —— 隐藏会丢信息）
    expect(block, '图例被隐藏了：这是避让改动，不该丢信息').not.toMatch(/\.legend\s*\{[^}]*display:\s*none/)
    expect(block, '小地图被隐藏了：这是避让改动，不该丢信息').not.toMatch(/\.minimap\s*\{[^}]*display:\s*none/)
  })
})

describe('用户可见的计数声明不再静默漂移（这次迁移会改到它）', () => {
  /**
   * 口径必须与渲染侧一致：`WechatDataPanel` 的分组循环是
   * `g.items.filter(it => !it.hidden && it.tab !== 'settings')`。
   * `settings` 仍是 NAV_GROUPS 的条目，但固定渲染在侧栏底部、不进分组计数。
   */
  const renderedInGroups = NAV_GROUPS.flatMap(g => g.items).filter(it => !it.hidden && it.tab !== 'settings')

  it('启动页的 MODULES 数 = nav-config 里实际渲染的侧栏条目数', () => {
    // 手法与 `api-docs.spec.ts` 守 REMOTE API 那个数字相同：**按文本读**。
    // 为什么只能这样钉：`src/client/ui-app/**` 既不在 `typecheck:client` 的 include
    // （它只收 `src/client/ui-wechat/src/**`）里，也不被任何用例 import —— 于是这个数字
    // 一直没人守。实测它在本轮之前是 17、而真值 17（巧合对齐）；2026-09-15 那次重写时
    // README 写 16 而真值已是 17，漂了一整版无人发现。本用例就是那个「人」。
    const shell = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'onboarding', 'OnboardingShell.tsx'), 'utf8')
    const m = /k:\s*'MODULES'\s*,\s*v:\s*'(\d+)'/.exec(shell)
    expect(m, '启动页里找不到 MODULES 的计数（若已改版请同步本用例）').toBeTruthy()
    expect(
      m![1],
      '启动页的侧栏入口数已过期：改成 nav-config 里未标 hidden 且非 settings 的条目数',
    ).toBe(String(renderedInGroups.length))
  })

  it('历次导航变更的净效果是 16（钉住这个数字，不用范围）', () => {
    // 口径沿革：并入社交图谱前 17（含独立可见的 graph）
    // → 2026-09-17 并入后 16 → 新增「知识库」(kb) 后 17
    // → 2026-09-18 知识图谱并入知识库（knowledge 转 hidden）后 **16**。
    // 写成精确值而不是范围 —— 范围断言正是这个数字上次能长期漂着的原因。
    expect(renderedInGroups.length).toBe(16)
    for (const t of ['graph', 'knowledge'] as const) {
      expect(renderedInGroups, `${t} 不该再出现在侧栏分组里`).not.toContain(t)
      // 但两者必须仍是**合法 tab** —— 这是深链与段条第二段的前提
      expect(TAB_LABELS[t], `TAB_LABELS 丢了 ${t}，深链会落回数据总览`).toBeTruthy()
    }
  })
})

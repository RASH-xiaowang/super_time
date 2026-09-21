/**
 * 「知识库」页签（tab: `kb`）的接线守卫（源码级）。
 *
 * 为什么这类断言必须看源码：本仓库没有 DOM/React 测试环境（vitest 只跑纯逻辑模块），
 * 而这个功能的退化方式**界面照样能打开**，只是入口或关键分支坏了：
 *   ① nav-config 里漏了 `kb` 条目 / 标成了 hidden —— 侧栏根本没有「知识库」，
 *      而深链 `#kb` 也落不回（`WechatDataPanel` 用 `initialHash in TAB_LABELS` 判初始页签）；
 *   ② `case 'kb'` 忘了注册 —— 页面显示「面板正在重构中」，测试不会红；
 *   ③ 把 `case 'kb'` 顺手并进 contacts|graph 的 MergedSections —— 笔记不属于通讯录语义，
 *      并进去会让「知识库」变成「通讯录」的一个分段（入口还在，语义已错）。
 *      它**应该**并进的是 `case 'knowledge'` 那一段：2026-09-18 起「知识图谱」并入
 *      「知识库」（同一批笔记的文档视图与网络视图），两个 tab 共用一个 MergedSections；
 *   ④ 缓存 key 前缀不是 `kb-` —— `api.ts` 的 saveNote/deleteNote 只失效 `kb-` 前缀，
 *      换个前缀就会出现「保存了、列表还是旧的」这种半刷新状态；
 *   ⑤ 删条目退回 `window.confirm` —— 原生对话框不跟主题，在全深色界面里跳个白框；
 *   ⑥ 读失败与「确无条目」不再区分（N1），或读失败时把空列表写进渲染缓存 ——
 *      下次打开会先渲染「知识库还是空的」，正好复现 N1 要消除的那个假象；
 *   ⑦ 两栏布局改用 `@media` 窗口查询 —— 侧栏折叠会改变面板宽度而**窗口尺寸不变**，
 *      媒体查询不触发，左栏 240px 的下限会把详情压成细缝。必须用容器查询。
 *
 * 2026-09-18 多知识库落地后，又多了四种「界面能开、旧断言全绿」的退化方式：
 *   ⑧ 面板取数时不传当前 kbId —— 图谱与列表永远停在默认库，而切换器上的库名还在变
 *      （用户看到的就是「切了没反应」）；
 *   ⑨ 渲染缓存的键不带库 id —— 切库后的首帧画的是**上一个库**的笔记 / 节点
 *      （首帧是同步读缓存渲染的，真数据要等一次 RPC 才到）；
 *   ⑩ 切库时不清选中 / 固定 / 聚焦 —— 节点 id 不带库前缀，右栏详情与画布会指向两张图；
 *   ⑪ 编辑器漏传 kbId（或给它默认值）—— 笔记静默落进默认库。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, TAB_LABELS } from '../nav-config.ts'

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
const SHELL_DIR = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
const panelShell = readFileSync(join(SHELL_DIR, 'WechatDataPanel.tsx'), 'utf8')
const panel = readFileSync(join(HERE, 'KnowledgeBase.tsx'), 'utf8')
const panelCss = readFileSync(join(HERE, 'knowledge-base.module.css'), 'utf8')
const editor = readFileSync(join(HERE, 'KnowledgeNoteEditor.tsx'), 'utf8')
/**
 * M21：`api.ts` 拆成转发桶 + 8 个域模块（core / read / kb / search / media / export-ops / config / status）——
 * 这里读它们的**联合**（断言一条没放宽；拆出去的边界不该影响任何一条守卫的结论）。
 */
const apiSrc = ['api.ts', 'api-core.ts', 'api-read.ts', 'api-kb.ts', 'api-search.ts', 'api-media.ts', 'api-export-ops.ts', 'api-config.ts', 'api-status.ts'].map((f) => readFileSync(join(SHELL_DIR, f), 'utf8')).join('\n')
const graphSrc = readFileSync(join(HERE, 'Graph.tsx'), 'utf8')
const askSrc = readFileSync(join(HERE, 'Ask.tsx'), 'utf8')
const railSrc = readFileSync(join(HERE, 'KbRail.tsx'), 'utf8')
const shellSrc = readFileSync(join(HERE, 'KbShell.tsx'), 'utf8')
const scopeSrc = readFileSync(join(HERE, 'kb-scope.ts'), 'utf8')
const scopeKeysSrc = readFileSync(join(SHELL_DIR, 'kb-scope-keys.ts'), 'utf8')
const eventsSrc = readFileSync(join(SHELL_DIR, 'notes-events.ts'), 'utf8')

/** 去注释后读源码 —— 注释里会引用旧写法/被否掉的方案，不能让断言误判。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}
const panelCode = stripComments(panel)

const ALL = NAV_GROUPS.flatMap(g => g.items)
const kbItem = ALL.find(it => it.tab === 'kb')

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

describe('导航：知识库是「联系人与社交」组下的可见条目', () => {
  it('条目存在、可见、标签正确', () => {
    expect(kbItem, 'nav-config 里找不到 kb 条目').toBeDefined()
    expect(kbItem?.hidden, 'kb 标了 hidden —— 侧栏就不会出现「知识库」').toBeFalsy()
    expect(kbItem?.label).toBe('知识库')
  })

  it('挂在「联系人与社交」组里（这是需求指定的位置）', () => {
    const group = NAV_GROUPS.find(g => g.items.some(it => it.tab === 'kb'))
    expect(group?.label).toBe('联系人与社交')
  })

  it('TAB_LABELS 有 kb —— 深链 #kb 能落到这一页', () => {
    // WechatDataPanel 用 `initialHash in TAB_LABELS` 判初始页签：缺这个键就会静默落回「数据总览」
    expect(TAB_LABELS.kb, 'TAB_LABELS 缺 kb，深链会落回数据总览').toBe('知识库')
  })

  it('知识图谱转为隐藏项：不再占侧栏条目，但仍是合法 tab（深链 #knowledge 能落）', () => {
    const knowledge = ALL.find(it => it.tab === 'knowledge')
    expect(knowledge, 'knowledge 条目消失了 —— 深链 #knowledge 会落回数据总览').toBeDefined()
    expect(knowledge?.hidden, 'knowledge 必须标 hidden：侧栏只留「知识库」一个笔记入口').toBe(true)
    expect(knowledge?.label).toBe('知识图谱')
    expect(TAB_LABELS.knowledge, 'TAB_LABELS 丢了 knowledge').toBe('知识图谱')
    // 侧栏可见项里不能再有第二个「笔记」入口（防重复入口，也防空转）
    expect(ALL.filter(it => !it.hidden).map(it => it.tab)).not.toContain('knowledge')
    expect(ALL.filter(it => !it.hidden).map(it => it.tab)).toContain('kb')
  })
})

describe('图标：走填充口径，且不与「知识图谱」撞形', () => {
  it('是 filled() 分组（与同排其它填充字形一个口径）', () => {
    expect(kbItem?.icon ?? '').toContain('<g fill="currentColor" stroke="none">')
    expect(kbItem?.icon ?? '').toContain('</g>')
    // 填充分组之外不得再有绘制元素（有就说明有人把描边图标塞回来了）
    const outside = (kbItem?.icon ?? '').replace(/<g fill="currentColor" stroke="none">[\s\S]*?<\/g>/g, '')
    expect(outside).not.toMatch(/<(circle|line|polyline|rect|path|polygon)\b/)
  })

  it('绝对坐标不越出 24×24 视框', () => {
    const icon = kbItem?.icon ?? ''
    const coords: number[] = []
    const re = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g
    let m: RegExpExecArray | null = re.exec(icon)
    while (m !== null) {
      if (/^[MLHVCSQTAZ]$/.test(m[1] ?? '')) {
        coords.push(...(m[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number))
      }
      m = re.exec(icon)
    }
    expect(coords.length, '没有可检查的绝对坐标').toBeGreaterThan(0)
    expect(coords.filter(v => v < -2 || v > 26), '出现越界绝对坐标').toEqual([])
  })

  it('与「知识图谱」不是同一枚图标（同排两枚读成同一个就是形制事故）', () => {
    const knowledge = ALL.find(it => it.tab === 'knowledge')?.icon ?? ''
    expect(knowledge).not.toBe('')
    expect(kbItem?.icon).not.toBe(knowledge)
  })
})

describe('路由：kb 与 knowledge 同走一个合并外壳，且没有并进通讯录那一段', () => {
  it('外壳导入了三个面板组件', () => {
    expect(shellSrc).toContain("import { KnowledgeBasePanel } from './KnowledgeBase.tsx'")
    expect(panelShell).toContain("import { KbShell } from './panels/KbShell.tsx'")
  })

  it("renderTab 里 case 'kb' 与 case 'knowledge' 并列，落进同一个知识库外壳", () => {
    // 2026-09-18：知识图谱并入知识库，两个 tab 必须都列全 —— 深链 #kb / #knowledge 要落到
    // 正确分段（外壳用 `initial={tab}` 同步，内部 useState 只在首次 mount 生效）。
    // 2026-09-19：分段数组搬进 `KbShell.tsx`，但**三个 tab 并列进同一个外壳**这件事没变，
    // 所以这里仍钉并列的三个 case + 一个 KbShell，把「分段齐全」下移到 KbShell 源码。
    const from = panelShell.indexOf("    case 'knowledge':")
    expect(from, '找不到 knowledge 的 case 分支').toBeGreaterThan(0)
    const branch = kbBranch(from)
    expect(branch, "case 'kb' 没与 knowledge 并列").toMatch(/case 'knowledge':\s*\n\s*case 'kb':\s*\n\s*case 'kbfiles': return \(/)
    expect(branch).toContain('<KbShell')
    expect(branch).toContain('initial={tab}')
    // 三段齐全，且 key 必须等于 tab id（深链才对得上）
    expect(shellSrc).toContain('ariaLabel="知识库视图"')
    expect(shellSrc).toContain("{ key: 'kb', label: '笔记库'")
    expect(shellSrc).toContain("{ key: 'knowledge', label: '知识图谱'")
    expect(shellSrc).toMatch(/\{ key: '(kb|knowledge|kbfiles)', label: '[^']+'/g)
    expect(shellSrc).toContain('<KnowledgeBasePanel')
    expect(shellSrc).toContain('<GraphPanel variant="knowledge"')
  })

  it("第三段：case 'kbfiles' 与 kb / knowledge 并列（深链 #kbfiles 才落得到）", () => {
    // 2026-09-18（KB-RAG 计划的 T2）：文件是知识库的**第三类内容**。三个 tab 少一个
    // 都不会红 —— 深链 #kbfiles 会落进 default 分支显示「面板正在重构中」，
    // 而 typecheck / build / 其余全部用例照样是绿的。
    expect(shellSrc).toContain("import { KbFilesPanel } from './KbFiles.tsx'")
    const from = panelShell.indexOf("    case 'knowledge':")
    expect(from, '找不到 knowledge 的 case 分支').toBeGreaterThan(0)
    const branch = kbBranch(from)
    expect(branch, '文件分段的聚焦参数没透传进外壳').toMatch(/focusFileId=\{kbFocus\?\.fileId \?\? null\}/)
    expect(shellSrc).toContain("{ key: 'kbfiles', label: '文件'")
    expect(shellSrc).toContain('<KbFilesPanel')
    // key 必须等于 tab id：外壳用 `initial`（= 当前 tab，经 `landing` 映射）找分段，
    // key 写错会让 #kbfiles 落进**别的**分段，而界面上看起来「就是打开了」。
    expect(shellSrc).toMatch(/\{ key: 'kbfiles', label: '[^']+'/)
  })

  it("case 'kb' 不在 contacts|graph 的合并分支里（笔记不属于通讯录语义）", () => {
    const from = panelShell.indexOf("    case 'contacts':")
    const to = panelShell.indexOf("    case 'knowledge':")
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const mergedBranch = stripComments(panelShell.slice(from, to))
    expect(mergedBranch, 'kb 被顺手并进了通讯录分段').not.toContain("case 'kb'")
    expect(mergedBranch, '笔记库面板被搬进通讯录分段').not.toContain('KnowledgeBasePanel')
    expect(mergedBranch, '知识库外壳被搬进通讯录分段').not.toContain('KbShell')
  })

  it('外壳把 onOpenChat 透传给笔记库面板（问答沉淀的笔记要能跳回来源会话）', () => {
    expect(panelShell).toMatch(/<KbShell[\s\S]{0,200}?onOpenChat=\{onOpenChat\}/)
    expect(shellSrc).toMatch(/<KnowledgeBasePanel onOpenChat=\{onOpenChat\}/)
  })
})

describe('主界面：列表 / 详情 / 新建编辑 / 标签 / 搜索 / 空态与加载态', () => {
  it('页头有 desc（R7 的 U12 口径：有 PanelHeader 就要有一句「这页是什么」）', () => {
    const at = panelCode.indexOf('<PanelHeader')
    expect(at, '找不到 PanelHeader').toBeGreaterThan(-1)
    expect(panelCode.slice(at, at + 500)).toContain('desc=')
  })

  it('关键词搜索走公共 SearchInput + 防抖', () => {
    expect(panel).toContain('SearchInput')
    expect(panel).toContain('useDebouncedValue')
    // 搜索词变化要真的重新取数（不是只在本地过滤）；
    // 第一个位置参数是**当前库**（多库后漏传会永远读默认库，见文末「多知识库」一节）
    expect(panelCode).toMatch(/apiGetNotes\(kbId, debounced \? \{ query: debounced \} : undefined\)/)
  })

  it('标签筛选条由标签统计渲染（含「全部」档）', () => {
    expect(panel).toContain('collectTags')
    expect(panel).toContain('tagStats')
    expect(panel).toContain('按标签筛选')
    expect(panelCode).toMatch(/tag === null \? '1' : undefined/)
  })

  it('新建与编辑共用一个编辑器（编辑要回填标题/正文/标签）', () => {
    expect(panel).toContain('KnowledgeNoteEditor')
    expect(panelCode).toMatch(/initialTitle=\{editor\.title \?\? ''\}/)
    expect(panelCode).toMatch(/initialBody=\{editor\.body \?\? ''\}/)
    expect(panelCode).toMatch(/initialTags=\{editor\.tags \?\? ''\}/)
  })

  it('加载态用骨架屏，空态分「筛选无结果」与「库是空的」两种文案（都带下一步动作）', () => {
    expect(panel).toContain('ListSkeleton')
    expect(panel).toContain('<EmptyState')
    expect(panel).toContain('没有匹配的条目')
    expect(panel).toContain('知识库还是空的')
    expect(panel, '空态缺少下一步动作').toMatch(/清除筛选|新建第一条/)
  })

  it('详情区在没选中时给落地提示（不是一片空白）', () => {
    expect(panel).toContain('选一条看正文')
  })

  it('删条目走公共确认框，不用原生 window.confirm', () => {
    expect(panel).toContain("from '../ui/confirm.tsx'")
    expect(panelCode).toMatch(/const confirm = useConfirm\(\)/)
    expect(panelCode).toMatch(/tone: 'danger'/)
    expect(panelCode, '不能退回原生 confirm').not.toMatch(/window\.confirm/)
  })
})

describe('N1：读失败与「确无条目」必须分开说', () => {
  it('readError 收进独立状态', () => {
    expect(panelCode).toContain('setReadError(r.readError ?? null)')
  })

  it('读失败时有独立提示、带库名，且明确否认「暂无条目」这个解读', () => {
    expect(panelCode).toMatch(/\{readError && \(/)
    // 多库之后「笔记库读取失败」这句话说不清是哪一个库，所以要带上库名；
    // 库列表还没回来时退化成「笔记库」（兜底说法，不能变成一个空主语）。
    expect(panelCode, '读失败提示没带库名').toContain("{kbLabel || '笔记库'}读取失败")
  })

  it('读失败时**不写**渲染缓存（否则下次首帧会假报「知识库还是空的」）', () => {
    expect(panelCode).toMatch(/if \(!r\.readError && !debounced\) writeRenderCache\(kbCacheKey\('kb-list', kbId\)/)
    // 反例：无条件写缓存、或写一个不带库 id 的裸键
    expect(panelCode).not.toMatch(/^\s*writeRenderCache\('kb-/m)
  })

  it('渲染缓存的 key 前缀是 kb- 且带库 id —— 与 api.ts 的失效口径一致', () => {
    expect(panelCode).toContain("readRenderCache<KbCache>(kbCacheKey('kb-list', kbId))")
    // api.ts 侧：saveNote / deleteNote 都要清 kb- 前缀，两处必须对得上
    expect(apiSrc).toContain("invalidateWechatCache('kb-')")
    expect(apiSrc).toMatch(/apiSaveNote[\s\S]{0,400}?invalidateKnowledgeCaches\(\)/)
    expect(apiSrc).toMatch(/apiDeleteNote[\s\S]{0,400}?invalidateKnowledgeCaches\(\)/)
  })
})

describe('编辑器：编辑时必须回填标签（否则保存会把标签静默清空）', () => {
  it('KnowledgeNoteEditor 收 initialTags 并用于初始化与重置', () => {
    expect(editor).toContain('initialTags')
    expect(editor).toMatch(/const \[tags, setTags\] = useState\(initialTags\)/)
    // 组件常驻挂载、靠 open 显隐：打开时必须重置，否则残留上一篇的标签
    expect(editor).toMatch(/setTags\(initialTags\)/)
  })

  it('保存回调把后端返回的 id 交回调用方（新建后要能切到这一篇）', () => {
    expect(editor).toMatch(/onSaved\(r\.id\)/)
  })
})

describe('响应式：两栏靠容器查询退化，不吃窗口媒体查询', () => {
  it('有承接容器查询的包裹层，且查询的是面板自身宽度', () => {
    expect(panelCss).toMatch(/container-type:\s*inline-size/)
    expect(panelCss).toMatch(/container-name:\s*kb/)
    expect(panelCss).toMatch(/@container kb \(max-width:/)
  })

  it('窄容器下两栏改单栏，且列表自带高度上限与滚动', () => {
    const block = panelCss.slice(panelCss.indexOf('@container kb (max-width:'))
    expect(block).not.toBe('')
    expect(block).toMatch(/\.body \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    // max-height 与 overflow 必须落在**同一个元素**上：给 .listPane（kit 的 Card，
    // 带 `overflow: hidden`）写 max-height 只会把列表裁掉，不会产生滚动条。
    expect(block, '列表没有高度上限').toMatch(/\.list \{[^}]*max-height:/)
    expect(block, '列表没有滚动').toMatch(/\.list \{[^}]*overflow-y: auto/)
    expect(block, 'max-height 写在 .listPane 上只会裁掉列表、滚不动').not.toMatch(/\.listPane \{[^}]*max-height/)
  })

  it('没有用窗口媒体查询来做这件事（侧栏折叠不改变窗口尺寸，媒体查询不会触发）', () => {
    expect(panelCss).not.toMatch(/@media[^{]*\{[^}]*\.body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('超长正文与长串不会把详情撑破（pre-wrap + 断词）', () => {
    expect(panelCss).toMatch(/\.text \{[^}]*white-space:\s*pre-wrap/)
    expect(panelCss).toMatch(/\.text \{[^}]*word-break:\s*break-word/)
  })

  it('列表行标题单行省略、摘要在两行截断（长标题不撑高行）', () => {
    const body = (sel: string): string => {
      const at = panelCss.indexOf(sel + ' {')
      expect(at, `找不到 ${sel}`).toBeGreaterThan(-1)
      return panelCss.slice(at, panelCss.indexOf('}', at))
    }
    expect(body('.rowTitle')).toMatch(/text-overflow:\s*ellipsis/)
    expect(body('.rowExcerpt')).toMatch(/-webkit-line-clamp:\s*2/)
  })
})

describe('CSS Module 引用一致性：TSX 里用到的类名必须真的在样式表里', () => {
  /** 取 `css.xxx` / `kitCss.xxx` 形式的静态引用（本面板没有动态索引写法）。 */
  function refs(src: string, ns: string): string[] {
    const out = new Set<string>()
    const re = new RegExp('\\b' + ns + '\\.([A-Za-z_$][\\w$]*)', 'g')
    let m: RegExpExecArray | null = re.exec(src)
    while (m !== null) {
      if (m[1]) out.add(m[1])
      m = re.exec(src)
    }
    return [...out]
  }

  /** 样式表里定义的类名集合。 */
  function defined(css: string): Set<string> {
    const out = new Set<string>()
    const re = /\.([A-Za-z_][\w-]*)/g
    let m: RegExpExecArray | null = re.exec(css)
    while (m !== null) {
      if (m[1]) out.add(m[1])
      m = re.exec(css)
    }
    return out
  }

  const kitCssSrc = readFileSync(join(SHELL_DIR, 'ui', 'kit.module.css'), 'utf8')

  it('本面板的 css.xxx 都有定义（写错/删掉规则后剩下的引用是死代码，不会报错）', () => {
    const own = defined(panelCss)
    const missing = refs(panelCode, 'css').filter(n => !own.has(n))
    expect(missing, `这些 css 类名在 knowledge-base.module.css 里不存在：${missing.join(', ')}`).toEqual([])
  })

  it('借用 kit 的 kitCss.xxx 也都有定义', () => {
    const missing = refs(panelCode, 'kitCss').filter(n => !defined(kitCssSrc).has(n))
    expect(missing, `这些 kit 类名不存在：${missing.join(', ')}`).toEqual([])
  })

  it('防空转：上面两个集合本身不能是空的', () => {
    expect(refs(panelCode, 'css').length, '没抽到任何 css 引用，守卫在空转').toBeGreaterThan(10)
    expect(defined(panelCss).size).toBeGreaterThan(10)
  })
})


describe('空态去重：列表为空时只渲染一个空态', () => {
  /*
   * 这条守卫来自一次**截图**发现、而所有静态断言与探针都没抓到的缺陷：
   * 空库时左右两个 Card 各渲染一个 EmptyState ——
   *   左「知识库还是空的 / 手写笔记与「微信问答」的沉淀…」，
   *   右「左侧还没有条目 / 新建一条，或在右上角的搜索框里换个关键词」。
   * 同一件事说两遍只是观感问题，更要紧的是**右栏那句在库为空时是错的指引**
   * ——一条笔记都没有，没有东西可搜。
   *
   * 修法：两个 Card 各带 `data-empty`（判据用 visible.length 而不是 notes.length，
   * 这样搜索/标签过滤到空结果时同样收成一栏），CSS 让左栏跨满两格、右栏隐藏。
   * 断言必须钉住**两边**（含 CSS 里的具体属性），否则只写 JSX 那一半，
   * 下一次有人把 CSS 规则删掉后仍然全绿，界面却又变回两个空态。
   */
  it('左右两个 Card 都用 className 组合表达「空」，判据是 visible.length（不是 notes.length）', () => {
    expect(panel).toMatch(/clsx\(css\.listPane,\s*visible\.length === 0 && css\.listPaneWide\)/)
    expect(panel).toMatch(/clsx\(css\.detailPane,\s*visible\.length === 0 && css\.detailPaneHidden\)/)
  })

  it('CSS：左栏跨满两格、右栏隐藏', () => {
    expect(panelCss).toMatch(/\.listPaneWide\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/)
    expect(panelCss).toMatch(/\.detailPaneHidden\s*\{[^}]*display:\s*none/)
  })

  it('不许用 data-* 标记：kit 的 Card 不透传额外 props 到 DOM', () => {
    /*
     * 这条来自实测的**静默失效**：第一版写成 `<Card … data-empty={…}>`，
     * 而 Card 只接受 title/extra/footer/children/flush/className ——
     * 额外 props 被整块丢掉，属性不存在、CSS 的 `[data-empty]` 永不命中，
     * 右栏照旧渲染出第二个空态。typecheck 与全部静态断言都不报（源码里确实写了），
     * 只有运行期探针量 getAttribute 才看得出来。
     * 所以这里反向钉住：面板里出现 data-* 就要转红，逼下一个人改用 className。
     */
    expect(panel).not.toMatch(/<Card[^>]*\sdata-[a-z]/)
    expect(panelCss).not.toContain('[data-empty]')
  })

  it('右栏那句「库为空时的错指引」已经删掉', () => {
    // 判断空态分支不能用 visible.length 去分「库空 / 有列表未选中」——
    // 库空的分支已经由 data-empty 接管，这里只留「有列表但还没选中」一种。
    expect(panel).not.toContain('左侧还没有条目')
    expect(panel).not.toContain('在右上角的搜索框里换个关键词')
    expect(panel).toContain('title="选一条看正文"')
    // 且只剩这一处（注释里会引用这句文案，所以只数 JSX 的 title 属性）
    expect(panel.match(/title="选一条看正文"/g)?.length).toBe(1)
  })

  it('防空转：确认抽到的是真面板源码', () => {
    expect(panel.length).toBeGreaterThan(4000)
    expect(panelCss.length).toBeGreaterThan(2000)
  })
})


describe('多知识库：作用域（看哪个库）接进两个面板与编辑器', () => {
  /*
   * 见文件头 ⑧~⑪。这一组全部是「多库」引入的新退化方式：界面能开、旧断言全绿，
   * 只有源码级 gate 挡得住。
   */
  const code = (src: string): string => stripComments(src)

  it('两个面板都订阅当前作用域（切换器在合并外壳里，props 传不过去）', () => {
    expect(panelCode, '笔记库没订阅作用域').toContain('useKbScope()')
    expect(graphSrc, '知识图谱没订阅作用域').toContain('useKbScope()')
  })

  it('取数一律带当前库（漏一处 =「切了没反应」：面板停在默认库、切换器上的名字却在变）', () => {
    expect(panelCode).toContain('apiGetNotes(kbId,')
    expect(panelCode).toContain('apiDeleteNote(kbId,')
    expect(code(graphSrc)).toContain('apiGetKnowledgeGraph(kbId)')
    expect(code(graphSrc)).toContain('apiGetNotes(kbId)')
    expect(code(graphSrc)).toContain('apiDeleteNote(kbId,')
  })

  it('两个视图的渲染缓存键都带库 id（不带就会「切库后首帧画上一个库」）', () => {
    // 读与写分别钉：**读**决定首帧画哪个库的数据，**写**决定下一个库能不能命中。
    // 只写 `toContain("kbCacheKey('kb-graph', kbId)")` 是抓不住错的 —— 读写两行
    // 含同一个子串，改掉其中一行仍然全绿（变异测试实测存活，故拆成四条）。
    expect(panelCode, '笔记库首帧读的不是本库缓存').toContain("readRenderCache<KbCache>(kbCacheKey('kb-list', kbId))")
    expect(panelCode, '笔记库写的不是本库缓存键').toMatch(/writeRenderCache\(kbCacheKey\('kb-list', kbId\)/)
    expect(code(graphSrc), '知识图谱首帧读的不是本库缓存').toContain(
      "readRenderCache<KnowledgeSnapshot>(kbCacheKey('kb-graph', kbId))")
    expect(code(graphSrc), '知识图谱写的不是本库缓存键').toMatch(/writeRenderCache\(kbCacheKey\('kb-graph', kbId\)/)
  })

  it('切库时清掉视图状态：图谱清选中/固定/聚焦，笔记库清选中/关键词/标签', () => {
    // 节点 id 里不带库前缀（设计如此），所以选中态与固定集合跨库后指向的可能是另一条笔记
    expect(code(graphSrc), '图谱切库没清选中/固定/聚焦').toMatch(
      /setSelectedId\(null\)[\s\S]{0,200}?setPinned\(new Set\(\)\)[\s\S]{0,200}?setFocusCommunity\(null\)[\s\S]{0,140}?\}, \[kbId\]\)/)
    expect(panelCode, '笔记库切库没清选中/关键词/标签').toMatch(
      /setSelectedId\(null\)[\s\S]{0,160}?setQuery\(''\)[\s\S]{0,80}?setTag\(null\)[\s\S]{0,60}?\}, \[kbId\]\)/)
  })

  it('知识图谱的两个加载器分开：社交图谱不该为「切库」付费', () => {
    // 并成一个 effect 的话，每次切库都会白拉一次通讯录大快照（几百毫秒级）
    expect(code(graphSrc)).not.toMatch(/useEffect\(\(\) => \{ void load\(\); void loadKnowledge\(\) \}/)
    expect(code(graphSrc)).toMatch(/useEffect\(\(\) => \{ void load\(\) \}, \[load\]\)/)
    expect(code(graphSrc)).toMatch(/useEffect\(\(\) => \{ void loadKnowledge\(\) \}, \[loadKnowledge\]\)/)
  })

  it('三个编辑器调用点都传 kbId（编辑器上它是必填项，漏传 typecheck 会红）', () => {
    expect(code(editor), 'kbId 不是必填项').toMatch(/kbId: number/)
    expect(panelCode, '笔记库的编辑器没传 kbId').toContain('kbId={kbId}')
    expect(code(graphSrc), '图谱的编辑器没传 kbId').toContain('kbId={kbId}')
    // 问答沉淀：默认=当前作用域，但可见且可就地改（沉淀时才发现该归到另一个库是常见补正）
    expect(code(askSrc), '问答沉淀没传 kbId').toContain('kbId={kbId}')
    expect(code(askSrc), '问答沉淀不能改目标库').toContain('allowKbPick')
    expect(code(editor)).toMatch(/allowKbPick && <KbTargetPicker/)
  })

  it('图谱把作用域一路透传到画布的坐标落盘（否则切库后形状会互相污染）', () => {
    const g = code(graphSrc)
    expect(g, '图谱没算 positionScope').toContain('const positionScope = isKnowledgeMode ? kbScope(kbId) : SOCIAL_SCOPE')
    expect(g, '图谱没把 positionScope 透传给画布').toContain('positionScope={positionScope}')
    expect(g, '用来拼作用域名的 kbScope 不是从 kb-scope.ts 拿的').toMatch(/import \{[^}]*kbScope[^}]*\} from '\.\/kb-scope\.ts'/)
  })

  it('编辑器保存写进「目标库」而不是默认库（笔记 id 不带库前缀，写错库=凭空消失）', () => {
    const ed = code(editor)
    expect(ed, '保存没带库（会写回默认库，在别的库里看不到）').toContain('apiSaveNote(targetKb,')
    // 目标库的初值必须来自作用域；写死数字 = 沉淀到不存在的库
    expect(ed, '目标库初值不是当前作用域').toMatch(/useState\(kbId\)/)
    expect(ed, '保存的目标库是字面量（绕过了作用域）').not.toMatch(/apiSaveNote\(\s*\d/)
  })

  it('库作用域挂在 KbShell 的左栏（跨三个分段常驻），而不是分段里的一条', () => {
    // 2026-09-19：原先它是分段条右侧的一个下拉（KbSwitcher）。抬成 rail 之后
    // 「当前在哪个库 / 一共几个库 / 各库多少条」同时可见，管理动作就近落到各自的行上。
    // 语义一点没变：它仍在三个分段**之上** —— 所以既不能变成一个分段，
    // 也不能搬进某个面板里面（那样另两个视图就看不见当前库了）。
    expect(shellSrc).toContain('<KbRail />')
    expect(shellSrc, 'rail 被搬进分段容器里了（它必须在 MergedSections 外面）').toMatch(
      /<KbRail \/>\s*\n\s*<div className=\{css\.main\}>/)
    expect(shellSrc, 'rail 退化成了一个分段（库是上一层的作用域，不是第四种看法）').not.toContain("{ key: 'rail'")
    expect(panelShell, 'rail 不该由 WechatDataPanel 直接挂').not.toContain('KbRail')
    // 挂在壳上而不是面板内：三个视图（笔记库 / 知识图谱 / 文件）共用同一个「当前库」
    expect(code(railSrc)).toContain('useKbScope()')
  })

  it('库管理三件套只有 rail 一个调用点；失效与广播收在 api.ts', () => {
    for (const fn of ['apiCreateKb', 'apiRenameKb', 'apiDeleteKb']) {
      expect(railSrc, `KbRail 没调用 ${fn}`).toContain(fn)
    }
    for (const [name, src] of [['KnowledgeBase.tsx', panel], ['Graph.tsx', graphSrc], ['Ask.tsx', askSrc]] as const) {
      expect(src, `${name} 不该直接建/改名/删库`).not.toContain('apiCreateKb')
      expect(src, `${name} 不该直接建/改名/删库`).not.toContain('apiRenameKb')
      expect(src, `${name} 不该直接建/改名/删库`).not.toContain('apiDeleteKb')
    }
    expect(apiSrc).toMatch(/function invalidateKbCaches[\s\S]{0,600}?notifyKbsUpdated\(\)/)
    // 库**内容**变了清 kb-，库**表**变了清 kbs-：两条失效路径不许合成一条。
    // ⚠ 必须用**去注释后**的源码 + **按函数体定位**：原样文本里那段文档注释
    //   也写着 `invalidateWechatCache('kbs-')`，用 toContain 会「把注释当实现」——
    //   把函数体里的 kbs- 改成 kb- 依然全绿（变异测试实测存活，才有下面这段）。
    const apiBody = stripComments(apiSrc)
    expect(apiBody, '库内容失效没清 kb-（笔记库/图谱不刷新）')
      .toMatch(/function dropKnowledgeCaches\(\)\s*:\s*void\s*\{[\s\S]{0,240}?invalidateWechatCache\('kb-'\)/)
    expect(apiBody, '库表失效没清 kbs-（切换器显示旧名字）')
      .toMatch(/function invalidateKbCaches\(\)\s*:\s*void\s*\{[\s\S]{0,240}?invalidateWechatCache\('kbs-'\)/)
    expect(apiBody, '库表失效误用了内容失效的前缀（切换器与两个面板各清一半）')
      .not.toMatch(/function invalidateKbCaches\(\)\s*:\s*void\s*\{[\s\S]{0,240}?invalidateWechatCache\('kb-'\)/)
  })

  it('删库弹层/回执拿的是 fileCount（拿成 noteCount 就会对「0 笔记 / 5 文件」的库说「这个库是空的」）', () => {
    // 这条链的退化方式是**静默**的：字段传错不会让任何既有用例变红，界面只是又开始对用户
    // 说谎（真机探针修前实测到过：库里有 2 个文件，弹层一个字没提）。文案本体有单测
    // （kb-delete-copy.spec.ts），这里钉的是**接线**：值有没有从 KbMeta 走到那三个调用点。
    const body = stripComments(railSrc)
    expect(body, 'openDelete 没把 k.fileCount 带进 DeleteState（拿成 noteCount 就静默说谎）')
      .toMatch(/setDel\(\{[^}]*fileCount:\s*k\.fileCount/)
    expect(body, '弹层正文没吃 delCounts').toContain('deleteDialogLead(delCounts)')
    expect(body, '危险按钮没把条数写进标签').toContain('purgeButtonLabel(delCounts)')
    expect(body, '删库成功没有回执（破坏性且不可撤销，必须留一句话）')
      .toMatch(/flash\(deleteReceipt\(/)
    // 「移到…」不能只看笔记：后端连文件一起迁移（设计稿 §7.1）
    expect(body, '「移到别的库」只按笔记判，纯文件库只剩「一并删除」一个出口')
      .toContain('canMoveInstead(delCounts)')
    // 反面：不许退回修前那句只数笔记的写法
    expect(body, '删库弹层又退回「只数笔记」了').not.toContain('这个库是空的')
  })

  it('库表变化用独立事件广播，且仍是「无载荷」的 new Event 形状', () => {
    expect(eventsSrc).toContain("export const KBS_UPDATED_EVENT = 'dsh-wechat-kbs-updated'")
    expect(eventsSrc).toMatch(/window\.dispatchEvent\(new Event\(KBS_UPDATED_EVENT\)\)/)
    expect(eventsSrc).not.toMatch(/KBS_UPDATED_EVENT[\s\S]{0,200}?CustomEvent/)
    expect(scopeSrc, '库表事件没人订阅').toContain('KBS_UPDATED_EVENT')
  })

  it('作用域键只有一处定义（kb-scope-keys.ts），别处不许手写带库 id 的字面量', () => {
    expect(scopeKeysSrc).toContain("export const KB_SCOPE_PREFIX = 'kb:'")
    expect(scopeKeysSrc).toContain('export function kbCacheKey(')
    // 反面：带库 id 的键字面量。出现在别处就是「两套拼法」——
    // 症状是「模型里有节点、图上没有」这类只在切库后才现形的偏差。
    const forbidden = ["'kb:'", "'kb-list:'", "'kb-graph:'", "'kb:graph:'",
      '`kb-list:', '`kb-graph:', '`kb:graph:']
    const scanned: ReadonlyArray<readonly [string, string]> = [
      ['api.ts', apiSrc],
      ['KnowledgeBase.tsx', panel],
      ['Graph.tsx', graphSrc],
      ['Ask.tsx', askSrc],
      ['KbRail.tsx', railSrc],
    ]
    for (const [name, src] of scanned) {
      const body = stripComments(src)
      for (const bad of forbidden) {
        expect(body, `${name} 手写了带库 id 的缓存键 ${bad}`).not.toContain(bad)
      }
    }
  })

  it('防空转：确认上面读到的确实是那几个文件', () => {
    expect(scopeKeysSrc.length).toBeGreaterThan(400)
    expect(graphSrc.length).toBeGreaterThan(20000)
    expect(railSrc.length).toBeGreaterThan(4000)
    expect(askSrc).toContain('AskPanel')
  })
})

describe('内容更新 → 图谱节点同步刷新（笔记写入必须广播事件）', () => {
  /*
   * 「节点必须全部来源于知识库」的前半句由 graph-model.stub.spec.ts 从输出反查来源锁住，
   * 后半句「内容更新时节点要同步生成与刷新」在这里接线：
   *   · 节点是快照的**投影**（buildKnowledgeNetwork 在 useMemo 里按 knowledge 重建），
   *     所以刷新快照就等于刷新节点 —— 不需要额外写一套增量更新；
   *   · 但 `invalidate*` 只保证「**下一次**取数拿新的」，**不会**叫醒已挂载的面板。
   * 两个视图（知识图谱 / 笔记库）共用同一个 notes 表，因此写入方必须广播一次。
   */
  const events = readFileSync(join(SHELL_DIR, 'notes-events.ts'), 'utf8')
  const graph = readFileSync(join(HERE, 'Graph.tsx'), 'utf8')

  it('事件名与广播函数在独立模块里，且收在 api.ts 唯一的笔记失效入口', () => {
    expect(events).toContain("export const NOTES_UPDATED_EVENT = 'dsh-wechat-notes-updated'")
    expect(events).toMatch(/window\.dispatchEvent\(new Event\(NOTES_UPDATED_EVENT\)\)/)
    // saveNote / deleteNote 都经过 invalidateKnowledgeCaches，广播只写在它里面
    expect(apiSrc).toMatch(/apiSaveNote[\s\S]{0,400}?invalidateKnowledgeCaches\(\)/)
    expect(apiSrc).toMatch(/apiDeleteNote[\s\S]{0,400}?invalidateKnowledgeCaches\(\)/)
    expect(apiSrc).toMatch(/function invalidateKnowledgeCaches[\s\S]{0,600}?notifyNotesUpdated\(\)/)
  })

  it('两个视图都订阅它并重载（否则「缓存清了、页面还是旧的」）', () => {
    expect(graph).toContain('NOTES_UPDATED_EVENT')
    expect(graph, '图谱没有订阅笔记变更事件').toMatch(/useWechatDataUpdated\([\s\S]{0,240}?loadKnowledge\(\)/)
    expect(graph, '社交视图不该为笔记变更付费').toMatch(/if \(isKnowledgeMode\) void loadKnowledge\(\)/)
    expect(panel).toContain('NOTES_UPDATED_EVENT')
    expect(panel, '笔记库没有订阅笔记变更事件').toMatch(/useWechatDataUpdated\([\s\S]{0,240}?void load\(\)/)
  })
})

describe('2026-09-19 三栏重排：吸顶骨架、按钮层级与库 rail', () => {
  /*
   * 这一组钉的是**重设计之后**的新约定，同样是源码级的 —— 因为它们的退化方式与上面
   * 那些老断言要防的一模一样：界面照样能开，只是坏了。
   *   · 吸顶一旦写回单类名，打包顺序一变页头就又跟着滚走（本仓库为 CSS 注入顺序记过事故）；
   *   · rail 一旦被搬进分段容器，另外两个视图就看不见「当前在哪个库」；
   *   · 编辑器一旦退回手写覆盖层，× / Esc / 焦点收口又会一起丢掉 —— 那正是它当初的毛病。
   */
  const code = (src: string): string => stripComments(src)

  it('笔记库：页头与工具栏被吸住，唯一的滚动区是主从两栏那一层', () => {
    expect(panelCode).toMatch(/<div className=\{clsx\(kitCss\.panelShell, css\.shell\)\}>/)
    expect(panelCode).toMatch(/<div className=\{css\.head\}>\s*<PanelHeader/)
    // 双类名提权不是排版洁癖：kit 的 .panelShell 与本地 .shell 同为单类选择器，
    // 同特异度下谁在打包顺序后面谁赢 —— 只写一条 `.shell` 会随构建翻转。
    expect(panelCss).toMatch(/\.shell\.shell\s*\{[^}]*overflow:\s*hidden/)
    expect(panelCss).toMatch(/\.head\s*\{[^}]*flex:\s*0 0 auto/)
    // 滚动区必须落在主从两栏那层：否则「吸顶」只是把下面的内容裁掉，而不是让它滚。
    expect(panelCss).toMatch(/\.bodyWrap\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('一个面板只有一个视觉主角：新建是 primary，刷新降为 ghost', () => {
    // ⚠ 不能用 `[^>]*` 去跳过属性：onClick 里的箭头函数 `=>` 自带一个 `>`，
    // 单类字符类会在那里就截断，于是断言永远匹配不上（写成 `[\s\S]{0,80}?` 才看得见整行）。
    expect(panelCode).toMatch(/<Button variant="primary"[\s\S]{0,80}?＋ 新建条目</)
    expect(panelCode).toMatch(/<Button variant="ghost"[\s\S]{0,80}?disabled=\{loading\}>/)
    // 反面：页头之外不许再长出第二个「＋ 新建条目」（空态那个写的是「新建第一条」，
    // 它是「库里一条都没有」时的出路，与页头的常驻入口不是重复按钮）。
    expect(panelCode.match(/＋ 新建条目/g)?.length, '「＋ 新建条目」的按钮数变了').toBe(1)
  })

  it('命名收口：面板标题叫「笔记库」，「知识库」这个名字留给侧栏与 rail', () => {
    // 改前是侧栏「知识库」→ 分段「笔记库」→ 面板标题「知识库」，同一个词指两层东西。
    expect(panelCode).toMatch(/<PanelHeader\s+title="笔记库"/)
    expect(code(shellSrc)).toContain("{ key: 'kb', label: '笔记库'")
    expect(code(railSrc)).toMatch(/railHd[\s\S]{0,120}知识库/)
  })

  it('库 rail：弹层走 kit Dialog，且不再有「管理全部知识库」那一层', () => {
    const rail = code(railSrc)
    expect(rail).toContain('<Dialog')
    // 手写的 role="dialog" 覆盖层回来了 = × / Esc / 焦点收口 / z-index 撞级又一起丢了
    expect(rail, '库弹层退回了手写覆盖层').not.toMatch(/role="dialog"/)
    // 改名 / 删除已就近挂到各自的库行上，那个「先看全表再选一个」的中间层随之作废。
    expect(rail, 'rail 里不该再有「管理全部知识库」这一层').not.toContain('管理全部知识库')
  })

  it('编辑器：弹层骨架交给 kit Dialog，按钮交给 kit Button', () => {
    const ed = code(editor)
    expect(ed).toContain("import { Button, Dialog, Select } from '../ui/kit.tsx'")
    expect(ed).toMatch(/<Dialog\b/)
    expect(ed, '编辑器退回手写覆盖层（只支持点遮罩关闭，键盘用户会被困住）').not.toMatch(/role="dialog"/)
    expect(ed, '编辑器又用回自制的 miniBtn 了').not.toContain('miniBtn')
    expect(ed).toContain("import css from './note-editor.module.css'")
  })

  it('CSS Module 引用一致性：这次新建的三个文件里用到的类名都必须存在', () => {
    // 与上面「本面板的 css.xxx 都有定义」同一口径。写错一个类名不会报错、不会红，
    // 只会让那块东西静默没有样式 —— 本仓库为这类事故专门留过一条守卫。
    const pairs: ReadonlyArray<readonly [string, string, string]> = [
      ['KbRail.tsx', railSrc, 'kb-rail.module.css'],
      ['KbShell.tsx', shellSrc, 'kb-shell.module.css'],
      ['KnowledgeNoteEditor.tsx', editor, 'note-editor.module.css'],
    ]
    for (const [name, src, cssName] of pairs) {
      const defined = new Set<string>()
      for (const m of readFileSync(join(HERE, cssName), 'utf8').matchAll(/\.([A-Za-z_][\w-]*)/g)) {
        if (m[1]) defined.add(m[1])
      }
      const used: string[] = []
      for (const m of code(src).matchAll(/\bcss\.([A-Za-z_$][\w$]*)/g)) {
        if (m[1]) used.push(m[1])
      }
      expect(used.length, `${name} 没抽到 css 引用，守卫在空转`).toBeGreaterThan(1)
      const missing = [...new Set(used)].filter(n => !defined.has(n))
      expect(missing, `${name} 用了 ${cssName} 里不存在的类名：${missing.join(', ')}`).toEqual([])
    }
  })
})

describe('2026-09-19 布局：两栏必须铺满滚动区（不许退回按内容收缩）', () => {
  /*
   * 真机截图上「读一份 142 字的配置，屏幕下半截约 36% 是空的」的成因只有一个：
   * `.body` 用了 `align-items: start` —— 网格项按内容定高，视口剩下的部分没人占。
   * 这不是排版偏好而是缺陷，所以把它钉成断言：改回 start 就转红。
   * 窄容器（@container）那一段**允许**退回 start/auto（堆叠成两行后铺满会把视口对半分），
   * 所以判据只看 @container 之前的部分。
   */
  const base = panelCss.slice(0, panelCss.indexOf('@container kb'))

  /** 抽出所有 `.body { … }` 规则体并去掉注释。
   *  必须去注释：解释「原来是 start」的那句话本身就写着 start，不剥就等于把自己的
   *  说明文字当成违规（本仓库别处为这个踩过，见同文件里的 stripComments）。 */
  function bodyRules(src: string): string {
    return [...src.matchAll(/\.body\s*\{([^}]*)\}/g)].map(m => stripComments(m[1] ?? '')).join('\n')
  }

  it('.body 是 stretch + 至少铺满，且 .body 自己没有 align-items: start', () => {
    // ⚠ 判据只能落在 `.body` 这一条规则上：`.row` 里也有 `align-items: start`
    // （列表行的标题与时间要顶对齐），那是合法的，一刀切扫全文会把它误判成违规。
    const rules = bodyRules(base)
    expect(rules).toMatch(/align-items:\s*stretch/)
    expect(rules).toMatch(/min-height:\s*100%/)
    expect(rules).not.toMatch(/align-items:\s*start/)
  })

  it('窄容器里显式退回 start/auto（否则两行各占半屏，长正文读不动）', () => {
    const block = panelCss.slice(panelCss.indexOf('@container kb'))
    expect(block).toMatch(/\.body\s*\{[^}]*align-content:\s*start/)
    expect(block).toMatch(/\.body\s*\{[^}]*min-height:\s*auto/)
  })

  it('分段顺序：文件 · 笔记库 · 知识图谱，且笔记库与知识图谱相邻', () => {
    // 顺序按「原料 → 加工 → 总览」。相邻这条是要守的语义：笔记库与知识图谱是
    // 同一批笔记的两种看法，被文件插开就读不出这层关系了。
    const order = [...shellSrc.matchAll(/\{ key: '(\w+)'/g)].map(m => m[1])
    expect(order).toEqual(['kbfiles', 'kb', 'knowledge'])
    expect(order.indexOf('kb') + 1).toBe(order.indexOf('knowledge'))
  })

  it('侧栏「知识库」(tab `kb`) 默认落在**文件**分段，另两个深链仍直达各自分段', () => {
    // 2026-09-19：进入知识库先看原料（文件）。落点从 `initial` 映射一次再交给分段条。
    const shell = stripComments(shellSrc)
    expect(shell).toMatch(/const landing = initial === 'kb' \? 'kbfiles' : initial/)
    expect(shell, '分段条没吃到映射后的落点').toMatch(/initial=\{landing\}/)
    // 反向：映射不许写成「一律 kbfiles」—— 那会让 #knowledge 深链落进文件分段，
    // 界面上看不出任何异常（段条就在那儿），只有从问答/图谱跳过来的人才撞得上。
    expect(shell).not.toMatch(/const landing = 'kbfiles'/)
    expect(shell).not.toMatch(/initial=\{'kbfiles'\}/)
  })
})

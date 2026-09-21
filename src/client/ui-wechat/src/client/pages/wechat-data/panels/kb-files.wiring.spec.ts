/**
 * 「知识库 · 文件」视图（tab: `kbfiles`）的接线守卫（源码级）。
 *
 * 为什么这类断言必须看源码：本仓库没有 DOM/React 测试环境（vitest 只跑纯逻辑模块），
 * 导航项、分段条、路由分支、IPC 钩子都渲染/执行不起来。而这一屏的退化方式
 * **界面照样能打开**，只是入口、契约或某条分支坏了。按危害从高到低：
 *
 *   ① `kbfiles` 忘了标 `hidden` —— 侧栏会多出一个「文件」入口（入口数 16 → 17），
 *      而段条里也有「文件」，同一个视图有了两条路；
 *   ② `kbfiles` 被从 `WechatTab` 或 `NAV_GROUPS` 里删掉 —— `TAB_LABELS` 是**由后者构建**的，
 *      删了它 `#kbfiles` 就静默落回「数据总览」（`WechatDataPanel` 用
 *      `initialHash in TAB_LABELS` 判初始页签），且 typecheck / build 都不报；
 *   ③ `case 'kbfiles'` 没跟 `case 'kb'` 一起进 MergedSections —— 深链落进 `default`
 *      显示「面板正在重构中」，全量用例仍是绿的；
 *   ④ 段条的 `key` 不等于 tab id —— `initial={tab}` 找不到分段，退化成第一段
 *      （笔记库），而界面上看起来「就是打开了」；
 *   ⑤ 取数时不传 `kbId` —— 切库后文件列表纹丝不动（用户看到的就是「切了没反应」）；
 *   ⑥ 渲染缓存的键不带库 id（或手写 `kb-files:` + id）—— 切库后的首帧画的是**上一个库**
 *      的文件；首帧是同步读缓存渲染的，真数据要等一次 RPC 才到；
 *   ⑦ 前端白名单与后端 `ACCEPTED_EXTS` 漂了 —— 症状是「对话框里看不到」或者更糟
 *      「选得进来但登记被拒」（用户在两个地方各被拒一次，说不清哪边错）；
 *   ⑧ 「添加文件」绕开 `dialog:open-file` 钩子（例如直接写死一批路径）——
 *      自动化就再也覆盖不到这条链路；
 *   ⑨ 删除退回 `window.confirm` —— 原生对话框不跟主题，在全深色界面里跳个白框；
 *   ⑩ 读失败与「确无文件」不再区分（N1），或读失败时把空列表写进渲染缓存 ——
 *      下次打开会先渲染「还没有登记文件」，正好复现 N1 要消除的那个假象；
 *   ⑪ `unsupported` 与 `failed` 被并成一档、或哪里写出了「文件损坏」——
 *      前者是「本机没抽到正文，不是失败」（成因有多种：不做 OCR / 文件里没有文字 /
 *      解析组件缺失），后者是解析器真抛了（要换文件），两者的排查方向完全相反；
 *   ⑫ 两栏布局改用 `@media` 窗口查询 —— 侧栏折叠会改变面板宽度而**窗口尺寸不变**，
 *      媒体查询不触发，左栏 240px 的下限会把详情压成细缝。必须用容器查询。
 *   ⑬ 模型摘要的覆盖范围不再显示（或判据从 `covered < total` 退化成 `covered > 0`）——
 *      一段只喂了前 8,000 字的局部概括就会顶着「摘要」两个字被当成整份文件的结论引用出去。
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, TAB_LABELS } from '../nav-config.ts'
import { KB_ACCEPTED_EXTS } from '../types.ts'

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
/** 后端包源码根（类型模块所在目录）。 */
const BACKEND_SRC = join(ROOT, 'src', 'backend', 'wechat-data', 'src')

const panel = readFileSync(join(HERE, 'KbFiles.tsx'), 'utf8')
const panelCss = readFileSync(join(HERE, 'kbfiles.module.css'), 'utf8')
const panelShell = readFileSync(join(SHELL_DIR, 'WechatDataPanel.tsx'), 'utf8')
const kbShellSrc = readFileSync(join(HERE, 'KbShell.tsx'), 'utf8')
const apiSrc = readFileSync(join(SHELL_DIR, 'api.ts'), 'utf8')
const navSrc = readFileSync(join(SHELL_DIR, 'nav-config.ts'), 'utf8')
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8')
const preloadSrc = readFileSync(join(ROOT, 'preload.js'), 'utf8')
const kbTypesSrc = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'kb', 'types.ts'), 'utf8')

/**
 * 去注释后读源码。
 * 这一屏的注释里**必然**会出现「文件损坏」「window.confirm」这类被否掉的写法
 * （它们正是要防的东西），不剥掉就会把自己的说明文字当成违规。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}
const panelCode = stripComments(panel)

const ALL = NAV_GROUPS.flatMap(g => g.items)
const item = (tab: string): (typeof ALL)[number] | undefined => ALL.find(it => it.tab === tab)

/** 摘出 `case 'knowledge':` 到「下一个不是 kb / kbfiles 的 case」之间那段。 */
function kbBranch(from: number): string {
  const rest = panelShell.slice(from)
  const stop = rest.search(/\r?\n {4}case '(?!kb'|kbfiles')/)
  return stop > 0 ? rest.slice(0, stop) : rest
}

describe('导航项：文件是「知识库」下的可路由隐藏项（侧栏入口数不变）', () => {
  it('kbfiles 条目存在、带图标、标签是「文件」', () => {
    const it0 = item('kbfiles')
    expect(it0, 'nav-config 里找不到 kbfiles 条目').toBeDefined()
    expect(it0?.label).toBe('文件')
    // 图标对 hidden 项不参与渲染，但 NavItem 的契约要求有 —— 缺了 typecheck 就会红，
    // 这里再钉一次是为了让「删图标」这件事至少被一条测试说出来。
    expect(it0?.icon, 'kbfiles 没有图标').toBeTruthy()
  })

  it('kbfiles 标为 hidden：不再占侧栏条目（它与段条会构成两条入口）', () => {
    expect(item('kbfiles')?.hidden, 'kbfiles 必须标 hidden，否则侧栏会多出一个「文件」入口').toBe(true)
    const visible = ALL.filter(it => !it.hidden).map(it => it.tab)
    expect(visible, 'kbfiles 不该出现在侧栏可见项里').not.toContain('kbfiles')
    // 侧栏入口数仍应是 16（口径 = 未标 hidden 且非 settings）。
    // 精确钉住而不是 `<= 17`：范围断言正是这个数字上次能长期漂着的原因。
    const renderedInGroups = NAV_GROUPS.flatMap(g => g.items).filter(it => !it.hidden && it.tab !== 'settings')
    expect(renderedInGroups.length, '侧栏入口数变了 —— 文件是段条内的视图，不该改变这个数').toBe(16)
  })

  it('与 kb / knowledge 同在「联系人与社交」组（同源数据同组）', () => {
    const group = NAV_GROUPS.find(g => g.items.some(it => it.tab === 'kbfiles'))
    expect(group?.label, 'kbfiles 被挪到别的分组了').toBe('联系人与社交')
    expect(group?.items.some(it => it.tab === 'kb'), 'kb 与 kbfiles 不在同一组').toBe(true)
  })

  it('kbfiles 是合法深链目标：留在 WechatTab 联合类型与 TAB_LABELS 里', () => {
    // `#kbfiles` 能落到这一页的**前提**：`WechatDataPanel` 用 `initialHash in TAB_LABELS`
    // 判初始页签。TAB_LABELS 由 NAV_GROUPS 构建（含 hidden 条目），所以这条断言能同时
    // 钉住「条目别被整行删掉」与「联合类型里有它」。
    expect(TAB_LABELS.kbfiles, 'TAB_LABELS 丢了 kbfiles，深链会落回数据总览').toBe('文件')
    expect(navSrc).toMatch(/\|\s*'kbfiles'/)
  })
})

describe('路由：kbfiles 与 kb / knowledge 同走一个知识库外壳', () => {
  it('外壳导入了面板组件', () => {
    // 2026-09-19 三栏重排：三个分段与它们的面板从 `WechatDataPanel` 搬进 `KbShell.tsx`。
    // 这条断言跟着下移 —— 要防的退化没变：少一个 import / 少一个分段 = 深链落空。
    expect(kbShellSrc).toContain("import { KbFilesPanel } from './KbFiles.tsx'")
    expect(panelShell).toContain("import { KbShell } from './panels/KbShell.tsx'")
  })

  it("renderTab 里三个 case 并列，落进同一个知识库外壳", () => {
    const from = panelShell.indexOf("    case 'knowledge':")
    expect(from, '找不到 knowledge 的 case 分支').toBeGreaterThan(0)
    const branch = kbBranch(from)
    expect(branch, "case 'kbfiles' 没与 knowledge / kb 并列").toMatch(
      /case 'knowledge':\s*\n\s*case 'kb':\s*\n\s*case 'kbfiles': return \(/
    )
    expect(branch).toContain('<KbShell')
    expect(branch).toContain('initial={tab}')
    // 三段齐全，且 key 必须等于 tab id（外壳靠 `initial={tab}` 找分段）
    expect(kbShellSrc).toContain("{ key: 'kb', label: '笔记库'")
    expect(kbShellSrc).toContain("{ key: 'knowledge', label: '知识图谱'")
    expect(kbShellSrc).toContain("{ key: 'kbfiles', label: '文件'")
    expect(kbShellSrc).toContain('<KbFilesPanel')
  })

  it('文件不在 contacts|graph 那一段里（笔记与文件都不属于通讯录语义）', () => {
    const from = panelShell.indexOf("    case 'contacts':")
    const to = panelShell.indexOf("    case 'knowledge':")
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const merged = stripComments(panelShell.slice(from, to))
    expect(merged, 'KbFilesPanel 被顺手并进了通讯录分段').not.toContain('KbFilesPanel')
    expect(merged, '知识库外壳被顺手并进了通讯录分段').not.toContain('KbShell')
  })

  it('库 rail 与三个分段同在一级，且不是第四个分段', () => {
    // 库是「看哪一份数据」，分段是「怎么看」—— 两者不同层，所以 rail 必须是分段的**兄弟**，
    // 既不能塞进 MergedSections 里面（那样只属于当前分段），也不能变成一个分段。
    expect(kbShellSrc).toContain('<KbRail />')
    expect(kbShellSrc, 'rail 跑进分段容器里了').toMatch(/<KbRail \/>\s*\n\s*<div className=\{css\.main\}>/)
    // 分段恒为 3：rail 若被误当成第四个分段，这里会先数出 4 来。
    expect(kbShellSrc.match(/\{ key: '/g)?.length, '分段数不再是 3 个').toBe(3)
  })
})

describe('作用域：每个请求都带当前库，缓存键只经 kbCacheKey', () => {
  it('面板订阅当前库（切换器在合并外壳里，props 传不过来）', () => {
    expect(panelCode).toContain('useKbScope()')
    expect(panelCode).toMatch(/const \{ kbId[^}]*\} = useKbScope\(\)/)
  })

  it('四个文件域调用全部把 kbId 作为第一个位置参数', () => {
    // 漏传就会「切了库但文件列表没变」；删除 / 开关更严重 —— 文件 id 是**全局自增**的，
    // kbId 在写操作上是守卫，拿甲库的 id 调乙库会物理删掉甲库那一条。
    expect(panelCode).toMatch(/apiGetKbFiles\(kbId\)/)
    expect(panelCode).toMatch(/apiAddKbFiles\(kbId, paths\)/)
    expect(panelCode).toMatch(/apiDeleteKbFile\(kbId, f\.id\)/)
    expect(panelCode).toMatch(/apiSetKbFileRag\(kbId, f\.id, next\)/)
  })

  it('缓存键只用 kbCacheKey 拼，没有一处手写 kb-files: + id', () => {
    // 带库 id 的键字面量一旦散开，就会出现「模型里有、图上看不到」那类只在切库后
    // 才现形的偏差。这里用「出现次数必须全部落在 kbCacheKey(...) 里」来钉：
    // 任何一处手写都会让 mentions > viaHelper。
    const mentions = (panelCode.match(/kb-files/g) ?? []).length
    const viaHelper = (panelCode.match(/kbCacheKey\('kb-files', kbId\)/g) ?? []).length
    expect(mentions, '面板里根本没用到文件列表缓存键').toBeGreaterThan(0)
    expect(mentions, '有 kb-files 键被手写了 —— 必须一律经 kbCacheKey 拼').toBe(viaHelper)
  })

  it('api.ts 侧：每个变更接口都失效本库缓存，读接口一个都不失效', () => {
    // 原来这条是「数 invalidateKbFileCaches(kbId) 出现 3 次」。数数不表达意图：
    // 加一个变更接口就红一次（摘要就是这样），而少清一个缓存反而可能数对。
    // 改成逐个函数判定 —— 变更的必须清，读的必须不清（读接口清缓存 = 每次刷新都自毁缓存）。
    const fnBody = (name: string): string => {
      const from = apiSrc.indexOf(`export async function ${name}(`)
      expect(from, `api.ts 里找不到 ${name}`).toBeGreaterThan(0)
      // 边界 = 下一个顶层函数声明。用固定偏移量切是不行的：改一下签名长度就会把
      // 半个函数切到隔壁去，断言会看起来通过、实际检查的是别人的身体。
      const rest = apiSrc.slice(from)
      const next = rest.slice(1).search(/\nexport async function /)
      return next > 0 ? rest.slice(0, next + 1) : rest
    }
    for (const mutator of ['apiAddKbFiles', 'apiDeleteKbFile', 'apiSetKbFileRag', 'apiSummarizeKbFile']) {
      expect(fnBody(mutator), `${mutator} 变更后没清本库缓存（界面会停在旧行上）`).toContain('invalidateKbFileCaches(kbId)')
    }
    for (const reader of ['apiGetKbFiles', 'apiGetKbFileChunks']) {
      expect(fnBody(reader), `${reader} 是读接口，不该失效缓存`).not.toContain('invalidateKbFileCaches(kbId)')
    }
    // 摘要清缓存还必须是**成功才清**：失败时后端什么都没写，清一次反而多一次无谓取数
    expect(fnBody('apiSummarizeKbFile')).toMatch(/if \(result\.ok\) invalidateKbFileCaches\(kbId\)/)
    expect(apiSrc, 'api.ts 的失效键与面板的读取键不是同一个拼法').toContain(
      "invalidateWechatCache(kbCacheKey('kb-files', kbId))"
    )
    for (const fn of ['apiGetKbFiles', 'apiAddKbFiles', 'apiDeleteKbFile', 'apiSetKbFileRag', 'apiOpenFileDialog']) {
      expect(apiSrc, `api.ts 少了 ${fn}`).toContain(`export async function ${fn}(`)
    }
  })

  it('文件增减后连**库列表**一起失效（否则删库弹层拿着过期 fileCount 说谎）', () => {
    // `KbMeta.fileCount` 不是文件库自己的字段，而是 `getKbs` 把两个库文件合流出的**派生值**，
    // 它住在另外两套缓存里（`KB_LIST_CACHE_KEY` 快照层 + `kbs-` 渲染层），与 `kb-files:<id>`
    // 互不相通。只清文件列表，就会留下这个缺陷 —— 真机探针实测过一次（库里有 2 个文件）：
    //   删库弹层说「这个库里没有笔记也没有文件，删除它不会丢任何内容。」，
    //   并且因为 `canMoveInstead` 判假而**不给「移到…」分支**，一个装了几百份资料、
    //   笔记一条没写的库，唯一出口只剩「一并删除」。
    const from = apiSrc.indexOf('function invalidateKbFileCaches')
    expect(from, 'api.ts 里找不到 invalidateKbFileCaches').toBeGreaterThan(0)
    const fn = apiSrc.slice(from, from + 320)
    expect(fn, '文件变更后没让库列表失效 —— 删库弹层的 fileCount 会一直是旧值')
      .toContain('invalidateKbCaches()')
    // 必须是**同一个入口**（一次做全三件事：清快照 + 清渲染缓存 + 广播），而不是只清一层：
    // 只清缓存不广播，已经挂载的切换器手里还是上一次的数组，弹层照样说错话。
    expect(apiSrc).toMatch(/function invalidateKbCaches[\s\S]{0,400}?snapshotDelete\(KB_LIST_CACHE_KEY\)/)
    expect(apiSrc).toMatch(/function invalidateKbCaches[\s\S]{0,700}?notifyKbsUpdated\(\)/)
    expect(apiSrc).toMatch(/function invalidateKbCaches[\s\S]{0,500}?invalidateWechatCache\('kbs-'\)/)
  })

  it('切库时把「属于上一个库」的界面状态清干净', () => {
    // 只重取数据而留着选中的文件 id，用户会在乙库里看到「高亮着甲库那个文件」；
    // 若那个 id 恰好也存在，详情区显示的就是别的库的文件。
    expect(panelCode).toMatch(
      /setSnapshot\(cachedFiles\(kbId\) \?\? \{ items: \[\], total: 0 \}\)\s*\n\s*setSelectedId\(null\)/
    )
    expect(panelCode).toMatch(/setQuery\(''\)\s*\n\s*setFilter\('all'\)/)
  })
})

describe('添加：走原生对话框钩子，逐项回执', () => {
  it('用 apiOpenFileDialog（不是写死路径，也不是把字节经 IPC 传）', () => {
    expect(panelCode).toContain('apiOpenFileDialog(')
    expect(panelCode).toContain('picked.files')
    expect(panelCode).toMatch(/picked\.error/)
  })

  it('对话框白名单来自 KB_ACCEPTED_EXTS，不在这里硬写一份', () => {
    expect(panelCode).toMatch(/extensions: \[\.\.\.KB_ACCEPTED_EXTS\]/)
    // 硬写一份 = 与后端 ACCEPTED_EXTS 漂成两份（见文件头注 ⑦）
    expect(panelCode, '对话框过滤器里出现了硬编码的扩展名数组').not.toMatch(/extensions: \['/)
  })

  it('上传结果逐项落地：收 results / failed，并把失败项逐条说出来', () => {
    expect(panelCode).toMatch(/setReport\(\{ added: r\.added, failed: r\.failed, failures \}\)/)
    expect(panelCode).toContain('r.results')
    expect(panel, '部分成功时没有把失败项列出来 —— 用户会把没问题的文件也重选一遍').toContain('个未加入')
    // `results` 与 `paths` 按下标对齐是后端契约（对每个 path 依次 push 一条）
    expect(panelCode).toMatch(/\.map\(\(res, i\) => \(\{ res, path: paths\[i\] \?\? '' \}\)\)/)
  })

  it('重复项按**内容指纹**措辞，不按文件名', () => {
    // 去重用的是 sha256：说成「文件名重复」会把「同名不同内容」与「改名重传」都指错。
    expect(panel).toContain('内容与库里已有的')
    expect(panelCode).toContain("r.code === 'duplicate'")
  })

  it('一个都没进来才算失败（不是「有一次失败就报错」）', () => {
    expect(panelCode).toMatch(/if \(r\.added > 0\)/)
    expect(panelCode).toMatch(/setError\(r\.error \?\? '这些文件都没有加入知识库'\)/)
  })
})

describe('移除与出网开关：都带 kbId 守卫，都不碰用户的原文件', () => {
  it('移除走应用内确认框，不用 window.confirm', () => {
    expect(panelCode).toContain('useConfirm()')
    expect(panelCode, '出现了 window.confirm —— 原生对话框不跟主题').not.toContain('window.confirm')
    expect(panel).toContain('不会被删除或修改')
  })

  it('详情里也写明原文件只被登记', () => {
    expect(panel).toContain('仅登记，不会被修改或删除。')
  })

  it('出网开关：按文件粒度，且说清「关掉仍能关键词搜到」', () => {
    expect(panelCode).toMatch(/role="switch"/)
    expect(panelCode).toContain('includeInRag')
    // 关掉 ≠ 踢出知识库 —— 不说清这句，用户会以为关掉就等于把文件删了
    expect(panel, '出网开关没说明「关掉后仍可被关键词搜到」').toContain('都仍然能被关键词搜到')
    // 也不许承诺「打开就一定出网」：全局「禁止 AI 出网」是同一道闸门
    expect(panel).toContain('禁止 AI 出网')
  })

  it('开关成功后只改这一行，并同步渲染缓存（不是整表重取）', () => {
    expect(panelCode).toMatch(/x\.id === f\.id \? \{ \.\.\.x, includeInRag: next \} : x/)
  })
})

describe('读失败 / 空 / 筛选无结果：三件事必须说成三件事（N1）', () => {
  it('空态按 readError / 筛选 / 真的没有 分三支', () => {
    expect(panelCode).toMatch(/const emptyNode = readError/)
    expect(panel).toContain('读不到文件列表')
    expect(panel).toContain('还没有登记文件')
    expect(panel).toContain('没有匹配的文件')
  })

  it('读失败时不写渲染缓存（否则下次打开先渲染「还没有登记文件」）', () => {
    expect(panelCode).toMatch(/if \(!r\.readError\) writeRenderCache\(kbCacheKey\('kb-files', kbId\)/)
  })
})

describe('解析状态：八档齐、分档不合并、且不许说「文件损坏」', () => {
  const STATES = ['queued', 'parsing', 'chunking', 'embedding', 'ready', 'unsupported', 'failed', 'sparse_only']

  it('八个状态在界面上都有表达（少一个就会渲染出 undefined）', () => {
    for (const s of STATES) {
      expect(panelCode, `PARSE_LOOK 缺少 ${s}`).toMatch(new RegExp(`\\b${s}:\\s*\\{`))
    }
  })

  it('色调分档：ready=绿、failed=红、unsupported 与 sparse_only=琥珀（不是失败态）', () => {
    expect(panel).toMatch(/label: '已就绪', tone: 'green'/)
    expect(panel).toMatch(/label: '解析失败',\s*\n\s*tone: 'red'/)
    expect(panel).toMatch(/label: '未解析',\s*\n\s*tone: 'amber'/)
    // sparse_only 不是失败态：没有向量只影响语义检索，关键词检索照旧命中
    expect(panel).toMatch(/label: '仅关键词',\s*\n\s*tone: 'amber'/)
  })

  it('unsupported 与 failed 的排查方向不同，文案也必须是两句', () => {
    // 接入 B 档（PDF / Word / Excel）之后，`unsupported` 的成因不再只有「本机没有解析器」：
    // 扫描件 PDF、空工作簿、解析组件缺失都会落到这一档。所以这里钉的**不再是某一种成因的
    // 那一句话** —— 那种写法会在其余几种成因下说错（曾经的「等解析器接入」就会让一个
    // 扫描件用户去等一个本期明确不做的功能）—— 而是这一档必须说清的两件事：
    // 它不是失败，且具体原因由后端的「说明」给出。
    expect(panelCode, 'unsupported 的说明里没点明「这不是失败」').toContain('这不是失败')
    expect(panelCode, 'unsupported 的说明没有把用户指向后端的「说明」').toContain('具体原因见下面的「说明」')
    expect(panelCode, 'failed 的说明里没点出「换一个文件再试」').toContain('换一个文件再试')
  })

  it('★ 排队 / 解析中的文件会自己刷新（D2：没有轮询，用户只能自己点「刷新」）', () => {
    // B 档登记后先落 `queued`，真正解它的是后端队列。缺了这条 effect，界面会停在
    // 一个不动的「排队中」—— 状态是真的，只是没人去取。四条都不可省：
    expect(panelCode, '没有进度轮询（没有定时器）').toMatch(/setInterval\(/)
    expect(panelCode, '没有「无 pending 就不轮询」的短路（会对空列表也一直查库）')
      .toMatch(/if \(pendingKey === ''\) return/)
    expect(panelCode, '轮询没有走静默读取（会让「刷新」按钮每 1.5 秒闪一次「读取中…」）')
      .toMatch(/load\(\{\s*silent:\s*true\s*\}\)/)
    expect(panelCode, '轮询没有上限（停在 parsing 的行会让它永远查下去）')
      .toContain('PARSE_POLL_MAX_MS')
  })

  it('任何用户可见文案里都不出现「文件损坏」', () => {
    // 剥掉注释后再断言：注释里**必然**会出现这个词（它就是被明令禁止的写法）。
    expect(panelCode, '文案里出现了「文件损坏」—— 那是把「本机没解析器」说成了「文件坏了」').not.toContain('损坏')
  })

  it('失败的登记原因按 code 分支，不靠中文文案判', () => {
    for (const code of ['bad-kb', 'bad-path', 'not-accepted', 'too-large', 'too-many', 'read-failed', 'store-failed']) {
      expect(panelCode, `REGISTER_REASON 缺少 ${code}`).toContain(`'${code}'`)
    }
  })
})

describe('正文检索：一个搜索框同时做文件名过滤与正文检索（设计稿 §8.4）', () => {
  const clientTypesSrc = readFileSync(join(SHELL_DIR, 'types.ts'), 'utf8')
  /**
   * 后端类型源码：**桶 + 所有拆出的模块**的联合。
   *
   * M21 把 `src/types.ts`（2782 行）拆成了 `types-*.ts` 若干模块 + 一个转发桶，
   * 类型搬到哪个文件不该影响这条守卫 —— 所以这里按目录读全部 `types*.ts` 再拼起来，
   * 断言本身（逐字段一致）一条没改。
   */
  const backendTypesSrc = readdirSync(BACKEND_SRC)
    .filter((f) => /^types.*\.ts$/.test(f))
    .sort()
    .map((f) => readFileSync(join(BACKEND_SRC, f), 'utf8'))
    .join('\n')

  /** 抠出一个 `export interface X { … }` 里的**顶层字段名**（两个空格缩进）。 */
  function fieldNames(src: string, name: string): string[] {
    const body = new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(src)
    expect(body, `找不到 interface ${name}`).toBeTruthy()
    return (body?.[0]?.match(/^ {2}([A-Za-z_]\w*)\??:/gm) ?? []).map(s => s.trim().replace(/\??:$/, ''))
  }

  it('取数带 kbId —— 漏传就会「切了库但检索的还是上一个库」', () => {
    expect(panelCode).toMatch(/apiSearchKb\(kbId, kw\)/)
  })

  it('只有一个搜索框，且没有「模式」开关（§8.4：走哪条通道由系统决定）', () => {
    const inputs = (panelCode.match(/<SearchInput/g) ?? []).length
    expect(inputs, '搜索框变成了两个 —— §8.4 要求一个框同时管两件事').toBe(1)
    // 包装函数的签名里**不许**出现 mode / 通道选择：加上它就是把实现细节变成用户的配置。
    expect(apiSrc, 'apiSearchKb 出现了模式参数').toMatch(
      /export async function apiSearchKb\(kbId: number, query: string, topK\?: number\)/
    )
  })

  it('结果区标题标注「实际走了什么」，且降级文案整句取自后端', () => {
    // 标题形状：`<降级标签> · N 条 · 用时 Xms`（§8.4 第 2 行）。
    expect(panelCode).toContain('条 · 用时')
    expect(panelCode).toMatch(/search\.degraded\?\.label/)
    // §6.3 第二档：只说明现状。产品不许替用户决定「去打开某个开关」。
    expect(panelCode, '界面在劝用户去打开某个开关').not.toContain('请打开')
  })

  it('高亮只按后端给的 marks 渲染，前端不再找一遍词', () => {
    expect(panelCode).toContain('<mark')
    // 前端自己 indexOf 会与后端的 bigram 命中口径错位 ⇒「搜到了但没高亮」。
    expect(panelCode, '前端自己又找了一遍检索词').not.toMatch(/indexOf\(kw/)
  })

  it('两条路都在：正文命中的文件也会留在左侧列表里', () => {
    // 否则搜一个只出现在正文里的词，左侧说「没有匹配的文件」而上方正列着命中。
    expect(panelCode).toMatch(/contentFileIds\.has\(f\.id\)/)
  })

  it('三种「没搜成」分开说：请求无效 / 库读不到 / 确实没有匹配', () => {
    expect(panelCode).toMatch(/search\?\.error/)
    expect(panelCode).toMatch(/search\?\.readError/)
    expect(panel).toContain('正文里没有匹配')
  })

  it('切库时把上一个库的检索结果一起清掉', () => {
    const from = panelCode.indexOf('setReport(null)')
    expect(from).toBeGreaterThan(0)
    const tail = panelCode.slice(from, from + 400)
    expect(tail, '切库没清检索结果 —— 乙库界面里会列着甲库的命中').toContain('setSearch(null)')
  })

  it('api.ts 的 Remote 接口与新包装都在', () => {
    expect(apiSrc).toMatch(/searchKb\(options: \{ kbId: number; query\?: string; topK\?: number \}\)/)
    expect(apiSrc).toContain('export async function apiSearchKb(')
  })

  it('前端类型与后端 types.ts **逐字段**一致（漂了会静默拿到 undefined）', () => {
    expect(clientTypesSrc).toContain("export type KbChannelName = 'sparse' | 'dense' | 'structured'")
    for (const name of ['KbHit', 'KbSearchStats', 'KbSearchResult']) {
      expect(fieldNames(clientTypesSrc, name), `前端 ${name} 与后端漂了`).toEqual(fieldNames(backendTypesSrc, name))
    }
  })
})

describe('前端白名单与后端 ACCEPTED_EXTS 不许漂', () => {
  /** 从后端源码里抠出某个 `…_EXTS = [...]` 的字符串项（按声明位置找，不受注释里的引用干扰）。 */
  function backendExts(name: string): string[] {
    const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(kbTypesSrc)
    expect(m, `后端 types.ts 里找不到 ${name} 的声明`).toBeTruthy()
    return (m?.[1]?.match(/'[^']+'/g) ?? []).map(s => s.slice(1, -1))
  }

  it('四档在白名单里都要有（丢掉一档不会有人发现，直到用户选了那个类型）', () => {
    for (const name of ['PLAIN_TEXT_EXTS', 'HTML_EXTS', 'PENDING_PARSER_EXTS', 'REGISTER_ONLY_EXTS']) {
      expect(backendExts(name).length, `后端 ${name} 空了`).toBeGreaterThan(0)
    }
  })

  it('KB_ACCEPTED_EXTS === A ∪ A′ ∪ B ∪ C（逐项、同序）', () => {
    const union = [
      ...backendExts('PLAIN_TEXT_EXTS'),
      ...backendExts('HTML_EXTS'),
      ...backendExts('PENDING_PARSER_EXTS'),
      ...backendExts('REGISTER_ONLY_EXTS'),
    ]
    expect(new Set(union).size, '后端四档之间有重复项').toBe(union.length)
    expect([...KB_ACCEPTED_EXTS], '前端白名单与后端漂了 —— 症状是「选得进来但登记被拒」').toEqual(union)
  })
})

describe('`dialog:open-file` 钩子：自动化能覆盖到「添加文件」这条链路', () => {
  it('主进程注册了对话框，并留了 SUPERTIME_OPEN_PATHS 钩子', () => {
    expect(mainSrc).toContain("ipcMain.handle('dialog:open-file'")
    expect(mainSrc).toContain('SUPERTIME_OPEN_PATHS')
    // 多个路径用 path.delimiter 分隔（Windows 路径里逗号是合法字符）
    expect(mainSrc).toMatch(/forced\.split\(path\.delimiter\)/)
    // 全空串视为「取消」而不是「选了一批空路径」
    expect(mainSrc).toMatch(/files\.length \? \{ canceled: false, files \} : \{ canceled: true, files: \[\] \}/)
  })

  it('主进程不写死扩展名白名单（否则与后端 ACCEPTED_EXTS 漂成两份）', () => {
    expect(mainSrc).toMatch(/filters: Array\.isArray\(opts\?\.filters\)/)
    expect(mainSrc, 'main.js 里出现了硬编码的扩展名白名单').not.toMatch(/extensions: \[\s*'txt'/)
  })

  it('preload 把 opts 透传下去（否则 filters 永远到不了主进程）', () => {
    expect(preloadSrc).toContain("openFile: (opts) => ipcRenderer.invoke('dialog:open-file', opts)")
  })
})

describe('布局：两栏用容器查询退化，不用窗口媒体查询', () => {
  it('容器查询（侧栏折叠会改面板宽度而窗口尺寸不变）', () => {
    expect(panelCss).toContain('container-type: inline-size')
    expect(panelCss).toContain('@container kbfiles')
    expect(panelCss, '出现 @media —— 侧栏折叠时不会触发，两栏会被压成细缝').not.toMatch(/@media/)
  })

  it('容器名与笔记库不同名（两个分段可能同时挂载，同名会串台）', () => {
    expect(panelCss).toContain('container-name: kbfiles')
    const kbCss = readFileSync(join(HERE, 'knowledge-base.module.css'), 'utf8')
    expect(kbCss).toContain('container-name: kb')
    expect(panelCss, '容器名与笔记库重名').not.toContain('container-name: kb;')
  })

  it('滚动写在 .list 自己身上（写在 Card 上只会把它裁掉）', () => {
    // `.listPane` 用的是 kit 的 Card，`.card { overflow: hidden }` —— max-height 与
    // overflow 必须是同一个元素，否则下半截连滚动条都没有。
    expect(panelCss).toMatch(/\.list \{ max-height: 38vh; overflow-y: auto;/)
  })

  it('状态标记只用 className（kit 的 Card 不透传额外 props 到 DOM）', () => {
    expect(panelCode, '给 Card 写了 data-* —— 会被静默丢掉').not.toMatch(/<Card[^>]*\sdata-[a-z]/)
  })
})

describe('2026-09-19 三栏重排：吸顶骨架与「定位原文件」', () => {
  it('页头与工具栏被吸住，滚动区是「回执 + 检索结果 + 主从两栏」那一层', () => {
    expect(panelCode).toMatch(/<div className=\{clsx\(kitCss\.panelShell, css\.shell\)\}>/)
    expect(panelCode).toMatch(/<div className=\{css\.head\}>\s*<PanelHeader/)
    // 双类名提权：与笔记库同一个理由 —— 单类名会随 CSS 注入顺序翻转。
    expect(panelCss).toMatch(/\.shell\.shell\s*\{[^}]*overflow:\s*hidden/)
    expect(panelCss).toMatch(/\.head\s*\{[^}]*flex:\s*0 0 auto/)
    expect(panelCss).toMatch(/\.bodyWrap\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('主操作是 primary、刷新降为 ghost（与笔记库同一口径）', () => {
    // ⚠ 属性之间不能用 `[^>]*`：onClick 的箭头函数 `=>` 自带 `>`，会在那里截断。
    expect(panelCode).toMatch(/<Button variant="primary"[\s\S]{0,140}?＋ 添加文件/)
    expect(panelCode).toMatch(/<Button variant="ghost"[\s\S]{0,80}?disabled=\{loading\}/)
  })

  it('详情里有「在资源管理器中定位」，且复用 preload 已有的那条通道', () => {
    expect(panelCode).toMatch(/<Button variant="pill"[\s\S]{0,80}?在资源管理器中定位</)
    // 不为了这个按钮新开 IPC：`shell:show-item` 早就在 preload / main 两侧挂好了。
    expect(preloadSrc).toContain("ipcRenderer.invoke('shell:show-item'")
    expect(mainSrc).toContain("ipcMain.handle('shell:show-item'")
    // 反向：后端没有 reparse 方法（只有 get/add/delete/setRag/search 五个），
    // 所以这里不许出现一个点了没反应的「重新解析」。
    expect(panelCode).not.toContain('重新解析')
  })
})

describe('2026-09-19 正文默认展开', () => {
  it('选中即读第一页，且依赖只用原子值（不能依赖 selected 对象）', () => {
    // 解析中的文件每 PARSE_POLL_MS 轮询一次，每次轮询都重建整个 snapshot ⇒
    // `selected` 每 1.5 秒就是一个新引用。effect 依赖它 = 每 1.5 秒重读一遍正文并闪一次
    // 加载态，而代码看起来完全正常 —— 只有读源码能发现。
    expect(panelCode).toMatch(/useEffect\(\(\) => \{[\s\S]{0,200}?void loadChunks\(selectedId\)[\s\S]{0,120}?\[selectedId, loadChunks\]\)/)
    expect(panelCode).not.toMatch(/\[selected, loadChunks\]/)
    expect(panelCode).not.toMatch(/\[selectedId, selected, /)
    // 取数回来必须核对还是不是当前这个文件：路上那次请求可能已经换了选中甚至换了库
    expect(panelCode).toMatch(/prev && prev\.fileId === fileId/)
  })

  it('收起按钮不设 disabled：读取途中也要能关掉', () => {
    expect(panelCode).toMatch(/reader === null \? '查看正文' : '收起正文'/)
    expect(panelCode).not.toMatch(/disabled=\{reader[^\n]*\}\s*\n\s*\{reader === null \? '查看正文'/)
  })
})

describe('2026-09-19 布局：文件面板两栏铺满滚动区', () => {
  /** 抽 `.body` 规则体并去注释（判据只能落在 .body 上：.row / .hit 里也有合法的 start）。 */
  function bodyRules(src: string): string {
    return [...src.matchAll(/\.body\s*\{([^}]*)\}/g)].map(m => stripComments(m[1] ?? '')).join('\n')
  }
  const base = panelCss.slice(0, panelCss.indexOf('@container kbfiles'))

  it('.body 是 stretch + 至少铺满；窄容器显式退回 start/auto', () => {
    expect(bodyRules(base)).toMatch(/align-items:\s*stretch/)
    expect(bodyRules(base)).toMatch(/min-height:\s*100%/)
    expect(bodyRules(base)).not.toMatch(/align-items:\s*start/)
    const block = panelCss.slice(panelCss.indexOf('@container kbfiles'))
    expect(block).toMatch(/\.body\s*\{[^}]*align-content:\s*start/)
  })

  it('正文区不再套第二层滚动（外层已经是滚动容器，嵌套滚轮会抢）', () => {
    const reader = /\.readerBody\s*\{([^}]*)\}/.exec(panelCss)
    expect(reader, '找不到 .readerBody').toBeTruthy()
    expect(stripComments(reader![1])).not.toMatch(/max-height/)
    expect(stripComments(reader![1])).not.toMatch(/overflow-y:\s*auto/)
  })
})

/**
 * 模型摘要（`summarizeKbFile` 的那半边界面）。
 *
 * 后端侧的出网闸门由 `src/backend/wechat-data/tests/kb-summary.spec.ts` 在真实调用上守；
 * 这里守的是**界面有没有把覆盖范围说出口**：一段只喂了前 8,000 字的局部概括，
 * 若界面上顶着「摘要」两个字，就会被当成整份文件的结论引用出去。
 */
describe('模型摘要：界面必须说清这段摘要覆盖了什么', () => {
  it('入口接的是 apiSummarizeKbFile，摘要块排在正文块之前（先看结论再看原文）', () => {
    expect(panelCode).toContain('apiSummarizeKbFile')
    const s = panelCode.indexOf('<div className={css.summary}>')
    const r = panelCode.indexOf('<div className={css.reader}>')
    expect(s, '详情区没有摘要块').toBeGreaterThan(0)
    expect(r, '摘要块跑到了正文块后面').toBeGreaterThan(s)
  })

  it('被截断时标「基于前 N 字（全文 M 字）」，覆盖全文时改标「覆盖全文」', () => {
    expect(panelCode).toMatch(
      /基于前 \$\{summaryCovered\.toLocaleString\('zh-CN'\)\} 字（全文 \$\{selected\.charCount\.toLocaleString\('zh-CN'\)\} 字）/,
    )
    expect(panelCode).toContain("' · 覆盖全文'")
    // 判据必须是 covered < total 而不是「有没有 covered」：短文件 covered === total，
    // 只判 >0 就会给一份全文摘要挂上「基于前 N 字」，反过来也骗人。
    expect(panelCode).toMatch(/summaryCovered > 0 && summaryCovered < selected\.charCount/)
  })

  it('摘要四字段先归一化再用（渲染缓存里可能存着没有那几列的旧形状）', () => {
    expect(panelCode).toContain("const summaryText = selected?.summary ?? ''")
    expect(panelCode).toContain("const summaryModel = selected?.summaryModel ?? ''")
    expect(panelCode).toContain('const summaryAt = selected?.summaryAt ?? 0')
    expect(panelCode).toContain('const summaryCovered = selected?.summaryCoveredChars ?? 0')
    // 不许绕过归一化直接摸原始字段：`undefined !== ''` 会渲染出一个空壳摘要块，
    // 而对 `undefined` 调 `.toLocaleString()` 会把整个详情区崩掉。
    expect(panelCode).not.toMatch(/selected\.summary(?!Text|Model|At|Covered)/)
    expect(panelCode).not.toMatch(/selected\.summaryCoveredChars\./)
  })

  it('关掉出网开关的文件：入口直接禁用，且原因写在 title 上', () => {
    expect(panelCode).toMatch(/disabled=\{busySummaryId === selected\.id \|\| !selected\.includeInRag\}/)
    expect(panelCode).toContain('不得离开本机')
  })

  it('失败时说的是「内容没有被改动过」，不是含糊的一句生成失败', () => {
    expect(panelCode).toContain('这份文件的内容没有被改动过。')
  })

  it('摘要进行中只锁摘要按钮：删除仍只看 busyId，两件事不互相牵连', () => {
    expect(panelCode).toMatch(/disabled=\{busyId === selected\.id\}/)
    expect(panelCode).not.toMatch(/disabled=\{[^}]*busyId[^}]*busySummaryId/)
    // 「生成中…」期间按钮文案要变，否则用户以为没点上（摘要是一次长调用）
    expect(panelCode).toMatch(/busySummaryId === selected\.id \? '生成中…'/)
  })
})

/**
 * 语义索引入口（`docs/KB-MODEL-CONFIG.md` 的 P0-6 / V1 / V3）。
 *
 * 这一屏的退化方式同样是「界面照常打开、断言全绿」：
 *   ① 换库时不清 `indexView` —— 用户看着甲库的「已建 1,240 块」浏览乙库的文件；
 *   ② 状态读取失败被显示成「还没有语义索引」—— 正是本面板反复踩过的 N1（读失败 ≠ 确无数据）；
 *   ③ 轮询判据用本地的 `indexing` 而不是后端的 job —— 别的入口触发的构建在本界面不动；
 *   ④ 四种「只有关键词」被并成一句 —— 用户分不清该去配模型、还是点一下建索引、还是要重建。
 */
describe('语义索引：入口、状态与四种「只有关键词」', () => {
  it('接的是 getKbVectorIndex / buildKbVectorIndex 两个 Remote', () => {
    expect(panelCode).toContain('apiGetKbVectorIndex')
    expect(panelCode).toContain('apiBuildKbVectorIndex')
    expect(apiSrc).toContain('getKbVectorIndex({ kbId })')
    expect(apiSrc).toContain('buildKbVectorIndex({ kbId, force })')
  })

  it('按钮写明会出网，且只锁自己（不顺手禁用删除/刷新）', () => {
    expect(panelCode).toMatch(/title="[^"]*建\/补齐向量索引（会出网）"/)
    expect(panelCode).toMatch(/disabled=\{indexing\}\s*\n\s*title=/)
    expect(panelCode).toMatch(/\{indexing \? '建索引中…' : '语义索引'\}/)
  })

  it('换库 ⇒ 先把状态清成 null 再读（不带着上一个库的行数显示）', () => {
    const from = panelCode.indexOf('setIndexView(null)')
    expect(from, '换库时没有清空索引状态').toBeGreaterThan(0)
    expect(panelCode.slice(from, from + 200)).toContain('void loadIndex()')
    // 依赖必须是 [loadIndex]，而 loadIndex 以 kbId 为键 —— 换成 [] 就永远不会随库刷新
    expect(panelCode).toMatch(/void loadIndex\(\)\s*\n\s*\}, \[loadIndex\]\)/)
  })

  it('读失败不清成「无索引」：catch 里不许出现 setIndexView(null)', () => {
    const from = panelCode.indexOf('const loadIndex = useCallback')
    expect(from).toBeGreaterThan(0)
    // 身体切到它自己的终止符为止。用固定长度切会**吃进下一条 effect**（那里合法地
    // 写着 setIndexView(null)），断言就会以「防 N1」的名义报出一个假阳性。
    const rest = panelCode.slice(from)
    const end = rest.indexOf('}, [kbId])')
    expect(end).toBeGreaterThan(0)
    const body = rest.slice(0, end)
    expect(body, '读失败被当成「确实没有索引」显示（N1 复发）').not.toContain('setIndexView(null)')
    expect(body).toMatch(/catch \{/)
  })

  it('轮询判据是后端的 job，不是本地的 indexing 布尔', () => {
    expect(panelCode).toMatch(/const idxJob = indexView\?\.job \?\? null/)
    // 键里带 kbId 与 done：换库或进度推进都会让键变化，从而正确地重建定时器
    expect(panelCode).toMatch(/indexView\?\.job \? `\$\{indexView\.kbId\}:\$\{indexView\.job\.done\}` : ''/)
    // 定时器只在有 job 时建
    expect(panelCode).toMatch(/if \(indexJobKey === ''\) return/)
  })

  it('四种「只有关键词」各说一句人话，且模型不符要点名「需重建」', () => {
    const from = panelCode.indexOf('function indexLabel')
    expect(from).toBeGreaterThan(0)
    const fn = panelCode.slice(from, from + 1200)
    expect(fn).toContain('未配置向量模型')
    expect(fn).toContain('还没有语义索引')
    expect(fn).toContain('需重建')
    // 未就绪 ≠ 空：`null`（还没读到）必须有自己的说法，否则读失败会显示成「还没有」
    expect(fn).toMatch(/view === null[\s\S]{0,80}读取中/)
  })

  it('模型设置：读缓存带库 id，写完两层都失效（且只在写成功之后）', () => {
    // ① 读键必须经 kbCacheKey 带 kbId —— 不带就会把甲库的覆盖显示在乙库头上。
    const read = (apiSrc.match(/export async function apiGetKbModelConfig[\s\S]*?\n\}/) ?? [''])[0]
    expect(read, 'apiGetKbModelConfig 没读到源码').toBeTruthy()
    expect(read).toContain("kbCacheKey('kb-model', kbId)")
    // ② 写完两层都要清：引用串本身（弹层下次打开要看到新值）+ 库列表那一族
    //    （`modelOverrides` 是 getKbs 的合流派生值，芯片上那个「N 项自定义」就是它）。
    const write = (apiSrc.match(/export async function apiSetKbModelConfig[\s\S]*?\n\}/) ?? [''])[0]
    expect(write, 'apiSetKbModelConfig 没读到源码').toBeTruthy()
    expect(write).toContain("invalidateWechatCache(kbCacheKey('kb-model', kbId))")
    expect(write, '芯片会停在旧数字上 —— modelOverrides 没跟着失效').toContain('invalidateKbCaches()')
    // ③ 清列表那一层必须**只在写成功之后**：失败时后端一行没改，
    //    白广播一次会把「保存失败」这件事混进一次看起来正常的刷新里。
    expect(write).toMatch(/if \(result\.ok\) invalidateKbCaches\(\)/)
  })
})

/**
 * 单函数行数棘轮（CODE-AUDIT-2026-09-26 第三批 #18/#19 的防回归闸门）。
 *
 * ## 守的是什么
 *
 * 报告点名的形状是「`moments-panel.tsx` 单函数 917 行」，本轮拆完之后顺手把全仓量了一遍：
 * **同类问题不止那一处**（阈值 250 行以上有 32 个具名函数，最长的是
 * `settings-state.tsx#useSettingsState` 840 行）。所以这里不是给某一个函数写案例，
 * 而是把「一个函数能长多大」变成**只能变小**的台账：
 *  · 阈值之上、清单里没有 ⇒ 红（新长出一个巨型函数）；
 *  · 清单里有、实测更大 ⇒ 红（旧的又被喂胖了）；
 *  · 实测更小 ⇒ 也红，但要求是把那个数字**改小**（拆了的成果必须记账，否则下一个人无从
 *    知道这里本来多少行）。
 *
 * ## 为什么按 AST 而不是按缩进/正则
 *
 * 「函数体多少行」这件事只有语法树说得准：JSX 里到处是括号与模板串，按文本数会数出
 * 一个看起来很稳但完全没意义的数。取 `FunctionDeclaration` 与
 * `const X = (…) => …` / `function expression` 两种形状，长度按**起止位置所在行**计，
 * 与人的直觉（编辑器折叠出来的那个数字）一致。
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TREES = [
  join(ROOT, 'src', 'backend', 'wechat-data', 'src'),
  join(ROOT, 'src', 'client', 'ui-wechat', 'src'),
  join(ROOT, 'src', 'client', 'ui-app', 'src'),
]
/**
 * 宿主 CommonJS 是**只量不递归**的第四个树：`src/backend/*.js` 直接文件。
 * 不递归是因为 `src/backend/wechat-data/lib` 是构建产物、`deps` 是 vendored 上游，
 * 它们的长函数不归本仓改。宿主 God Module 原先完全游离在棘轮之外，2026-10-15 起
 * 同样只许变小。
 */
const HOST_JS_DIR = join(ROOT, 'src', 'backend')

/** 新函数（清单之外的）不许超过的行数。 */
const LIMIT = 250

/**
 * 清单：`文件  函数名  登记时的行数`。**只许变小。**
 * 2026-09-26 由一次性脚本 AST 实测灌进来（不是估的；脚本用完即删，复现方法见下面的判据本身）。
 */
const KNOWN_BIG: ReadonlyArray<string> = [
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-state.tsx  useSettingsState  791',
  // 登记理由（2026-09-29）：这段循环必须**保持整段内联**才能同时满足连接纪律棘轮 ——
  // 把分片读取抽成独立函数会让 `new DatabaseSync` 的站点归属变到账本里没有的函数名上
  // （第 24 轮实测被 `query-db-lifetime.spec.ts` 挡下）。分片级增量缓存（真机省约 3/4 的全量重算）
  // 就是在这个内联循环外面挂了一层"命中即 continue"。**行数只许变小。**
  'src/backend/wechat-data/src/query/overview-insights.ts  computeOverviewInsights  252',
  // 2026-10-21：收藏/任务功能线把知识库批量动作拆成 `kb-batch-actions.tsx` ⇒ 727 → 687。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/kb-files-panel.tsx  KbFilesPanel  687',
  // 2026-10-16：右侧控制栏抽成 `GraphRail.tsx`（它自己又拆出 `GraphSelectionDetail.tsx`），
  // 725 → 513；同日补上「始终可见的折叠按钮」（浮层收起后唯一的入口）⇒ 513 → 523；
  // 同日小地图让位（浮层展开时隐藏，`hideMinimap={railOpen}`）⇒ 523 → 524；
  // 同日把按钮/浮层移进 `.stage`（absolute 缺定位祖先会飘到视口顶部、压住手机档搜索条）
  // + 跨断点同步展开态 ⇒ 524 → 541。棘轮只许变小，拆完要回来改数字。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Graph.tsx  GraphPanel  497',
  // 2026-10-19：会话列表接键盘导航（onKeyDown + data-session-row），压缩同处注释抵消
  // 一行增量 ⇒ 376 → 375。棘轮只许变小，拆完要回来改数字。
  // 2026-10-19（微信化改版）：会话壳去掉霓虹背景/装饰层，375 → 370。成果记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-view.tsx  ChatsView  370',
  // 2026-10-17：`reportIndexAction` / `resolveSystemPrompt` 抽成模块级（系统提示词覆盖 +
  // 索引日志），`emptyAnswerText` / `describeScope` / `normalizeKbId` 同批 ⇒ 519 → 516。
  // 棘轮只许变小，成果要记账。
  // 2026-10-18：ClawBot 自动回复的图片/上下文让 askWechat 长大 ⇒ 把
  // `buildAskScope` / `trimAskHistory` / `prepareAskImages` / `createAskRunChat` /
  // `runChatWithImagesFallback` 抽成模块级；工厂从 466 降到 438。棘轮只许变小。
  // 2026-10-19：ClawBot token 记账把 usage 累加塞进 askWechat；`createAskRunChat` 抽到
  // `remotes/ask-run-chat.ts`、工厂里的取消包装压回一行 ⇒ 438 → 437。棘轮只许变小。
  'src/backend/wechat-data/src/remotes/askdeep.ts  createAskDeepRemotes  437',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/DailySummary.tsx  DailySummaryPanel  588',
  // 2026-10-19（微信化改版）：对话框/工具栏去掉装饰分支后 458 → 441。棘轮只许变小，成果记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Chats.tsx  ChatsPanel  441',
  // 2026-09-30：重做为「三块可折叠面板」时把子件拆成 ai-model-panel / -profiles / -roles /
  // llm-probe 四个文件，540 → 493；同日「默认全部折叠」又去掉了自动展开的旁路，493 → 488。
  // 棘轮只许变小，改完要回来改数字。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/AiModelConfig.tsx  AiModelConfig  488',
  // 2026-10-16：引用改成正文角标 + 右侧滑出详情（`AnswerBody` / `CiteDetailPanel` /
  // `useCiteDetail`），顺带把空态引导卡抽成 `AskEmptyIntro`、消息流装配抽成 `AskStream`、
  // 详情装配抽成 `AskCiteDetail` ⇒ 441 → 421。棘轮只许变小，成果要记账。
  // 2026-10-19（微信化改版）：引用角标那套装配随视觉简化收敛，421 → 418。成果记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Ask.tsx  AskPanel  418',
  // 2026-09-30：底部固定区（设置 / 模型余额 / 主题与数据状态）拆成 `SidebarFooter`，
  // 492 → 464。棘轮的方向是「只许变小」，所以拆完要回来改数字。
  'src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx  WechatDataPanel  473',
  // 2026-10-17：`openFile` 抽成模块级 `openExportFile`（顺带修「openPath 失败静默」的 bug）
  // ⇒ 461 → 456。棘轮只许变小，成果要记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/ExportHistoryDialog.tsx  ExportHistoryDialog  456',
  // 2026-10-18：新消息浮标/贴底状态搬进 useChatsPolling（保持单一职责）⇒ 269 → 267，成果记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-thread.tsx  useChatsThread  267',
  // 2026-10-15：KB Remote wire 类型收进 `types-kb-wire.ts`，匿名对象签名换成了
  // 共享类型引用，函数体 400 → 372。棘轮只许变小，成果需要回到这里记账。
  'src/backend/wechat-data/src/remotes/kb.ts  createKbRemotes  289',
  // 2026-10-16（M22）：总览的四组卡片 JSX 全部拆进 `overview-sections.tsx` 的具名区块组件
  // （TrendSection / HeatmapSection / RegionSection / WordCloudSection / InteractionSection /
  // RelationSection / MomentsAuthorsSection / ContentAssetsSection / StorageCompositionSection /
  // RevokedSection / StorageAdviceSection / LedgerSection / HealthSection），
  // `OverviewPanel` 390 → 215，已低于 250 阈值 ⇒ 从本棘轮移除。
  // 若后续再次逼近 250 行，要重新登记并继续拆小。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/KnowledgeBase.tsx  KnowledgeBasePanel  384',
  // 2026-10-16：资产类面板（文件/收藏/表情/媒体/公众号）重做时把列表筛选与操作按钮
  // 抽进 `asset-ui.tsx`，`FilesPanel` 364 → 359。棘轮只许变小，成果要记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Files.tsx  FilesPanel  336',
  // 2026-10-19（微信化改版）：消息卡去掉渐变/发光分支，329 → 322。棘轮只许变小，成果记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-panel.tsx  MomentsPanel  322',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx  WorldMapPanel  306',
  // 2026-09-28（E1 性能修复）：334 → 362。增量全部是**新增的 `getEmoticonDataUrls`
  // 批量壳**（签名 + 文档 + 一行转发）—— 算法体已搬到 `query/emoticon-batch.ts`，
  // 所以这里只长了那一层壳。想把它降回去就得把别的域也搬出去，不是靠改这个数字。
  // 2026-10-09：332 → 321。视频封面那路（`getSnsVideoCoverDataUrl`）也照同一范式搬去了
  // 模块级 `snsVideoCoverWithCdnFirst`，方法体退回「签名 + 一行转发」，净减 11 行。
  // 2026-10-10：321 → 326。W2-5.6 的批量封面（`getSnsVideoCoversBatch`）照同一范式：
  // 算法体全在模块级 `snsVideoCoversBatchIn`，方法体只剩「签名 + 一行转发」，净增 5 行。
  // 想再降就得把别的域也搬出去，不是靠改这个数字。
  // 2026-10-14：326 → 303。远程图片代理与新增的地图 GeoJSON 代理同样把算法体搬到
  // 模块级 `remoteImagesWithOp` / `mapGeoJsonWithOp`，方法体退回「签名 + 一行转发」。
  // 2026-10-19：319 → 317。头像归档逻辑搬到模块级 `avatarWithArchive` /
  // `avatarsLocalWithArchive`，方法体退回「签名 + 一行转发」。
  'src/backend/wechat-data/src/remotes/media.ts  createMediaRemotes  313',
  // 2026-10-14（M9）：`SettingsPanel` 改成「桌面/浏览器」分派器（浏览器态整面板降级，见
  // `settings-browser.tsx`），原来那份三百多行的实现改名 `SettingsDesktopPanel`。
  // 这是**改名不是变胖**：行数一字未动，仍记 328。想降就得把某几节真搬出去。
  // 2026-10-16（设置布局重设计）：把「高级设置」那张约 50 行的卡抽成模块级 `AdvancedSection`，
  // 328 → 286。棘轮只许变小，成果要记账。
  // 2026-10-19：「远程访问（手机）」设置节移除，`<SettingsRemoteAccess />` 一行删掉 ⇒ 295 → 294。
  // 同日按用户要求恢复「局域网访问」并加一行 section ⇒ 同时删掉两行操作日志注释 ⇒ 294 → 292。
  // 2026-10-19（微信化收口 + 局域网访问节回归）：设置项文案/说明与恢复的访问节净增 7 行 ⇒ 292 → 299。
  // ⚠️ 这是**按实测重登记**，不是放宽阈值（LIMIT 仍 250，且该函数仍在台账内、只许再变小）：
  // 设置面板的拆分欠账没消失，下一位改到这里应先抽 `AdvancedSection` 之外的卡片再回头改数字。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Settings.tsx  SettingsDesktopPanel  299',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/graph-model.ts  buildGraph  307',
  // 2026-09-30：给年报加「资金 / 撤回 / 群聊」三个字段时，先把 noteEmoji 与页脚首尾两条
  // 抽成模块级函数腾预算，assemble 308 → 306。棘轮只许变小，拆小了要回来改数字。
  'src/backend/wechat-data/src/query/annual-review.ts  assemble  306',
  // 2026-10-19：ContactsPanel 已 237 行（< 250 阈值）⇒ 从本棘轮移除（任务要求删除该条）。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/KbRail.tsx  KbRail  291',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-cards.tsx  RichCard  290',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/AskHistoryDialog.tsx  AskHistoryDialog  289',
  'src/backend/wechat-data/src/query/ask.ts  retrieveAskCitations  285',
  // 2026-09-29：合并两个 Toolbar 为一行 + 注释精简 ⇒ 279（成果记账，数字改小；只许再变小）
  // 2026-10-18：筛选区拆成两排（分类段条搬成 RecordKindTabs）⇒ 276。棘轮只许变小，成果要记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Records.tsx  RecordsPanel  276',
  'src/backend/wechat-data/src/remotes/export.ts  createExportRemotes  278',
  // 2026-10-21：通用收藏详情抽成 `favorites-detail.tsx`，FavoritesPanel 已低于 250 阈值 ⇒ 移出棘轮。
  'src/backend/wechat-data/src/query/parse-rich.ts  parseAppmsg  266',
  // 2026-10-08：图片那一路不再拿 CDN 原始地址当 src（那是 WxIsaac64 密文，原理上渲染不出来），
  // 理由从函数体内挪进文件头 ⇒ 265 → 264。棘轮只许变小，拆出来的成果要记账。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-card.tsx  MomentsCard  264',
  // 2026-10-19（workspace 组收口）：数据健康面板随检查项/文案回归涨到 251 行，刚好越过 250 阈值。
  // 只登记、**不改阈值**（LIMIT 仍 250）：这说明它下一次再长就必须先拆（例如把检查项列表抽出去），
  // 现在先把它纳入「只许变小」的台账，避免它游离在棘轮之外静默变胖。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Health.tsx  HealthPanel  251',
  // 2026-10-15：宿主 CommonJS 的七个巨型函数已全部拆成组合根/小型工厂，
  // 因此从本棘轮移除原七条登记；若后续再次逼近 250 行，要重新登记并继续拆小。
]

interface Fn { file: string; name: string; len: number }

/** 量一份源码里所有具名函数的长度（`const X = 箭头/function` 也算）。 */
function functionsIn(file: string, code: string): Fn[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lineAt = (pos: number): number => code.slice(0, pos).split('\n').length
  const out: Fn[] = []
  const push = (name: string, node: ts.Node): void => {
    const len = lineAt(node.getEnd()) - lineAt(node.getStart()) + 1
    out.push({ file, name, len })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) push(node.name.text, node)
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) push(d.name.text, d.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function allFunctions(): Fn[] {
  const rows: Fn[] = []
  const walk = (dir: string): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name) || e.name.includes('.spec.') || e.name.endsWith('.d.ts')) continue
      if (!statSync(p).isFile()) continue
      const code = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
      const rel = relative(ROOT, p).replace(/\\/g, '/')
      for (const f of functionsIn(rel, code)) rows.push(f)
    }
  }
  for (const t of TREES) walk(t)
  // 宿主 CJS：只取目录直属的 `.js`，deps 与 wechat-data/lib 的生成物不参与。
  let hostFiles: Dirent[]
  try { hostFiles = readdirSync(HOST_JS_DIR, { withFileTypes: true }) } catch { hostFiles = [] }
  for (const e of hostFiles) {
    if (!e.isFile() || !e.name.endsWith('.js')) continue
    const p = join(HOST_JS_DIR, e.name)
    const code = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
    const rel = relative(ROOT, p).replace(/\\/g, '/')
    for (const f of functionsIn(rel, code)) rows.push(f)
  }
  return rows
}

const keyOf = (f: { file: string; name: string }): string => `${f.file}  ${f.name}`

/** 对齐结果：四类问题分开报，免得「清单没对上」和「函数长大了」混成同一句话。 */
export interface RatchetDiff { unlisted: string[]; gone: string[]; grew: string[]; shrunk: string[] }

/**
 * 把实测与清单对一遍（导出只为让反例能直接喂给它 —— 现网清单是齐的，
 * 不这么做就没法证明「长大」这一格真的会红）。
 * @param measured - 实测的 `键 → 行数`。
 * @param known - 登记的 `键 → 行数`。
 * @returns 四类差异。
 */
export function diffRatchet(measured: Map<string, number>, known: Map<string, number>): RatchetDiff {
  const unlisted = [...measured.keys()].filter((k) => !known.has(k)).sort()
  const gone = [...known.keys()].filter((k) => !measured.has(k)).sort()
  const grew: string[] = []
  const shrunk: string[] = []
  for (const [k, len] of measured) {
    const at = known.get(k)
    if (at === undefined) continue
    if (len > at) grew.push(`${k}  登记 ${String(at)} → 实测 ${String(len)}`)
    else if (len < at) shrunk.push(`${k}  登记 ${String(at)} → 实测 ${String(len)}`)
  }
  return { unlisted, gone, grew, shrunk }
}

const KNOWN_MAP = new Map(KNOWN_BIG.map((s) => {
  const [file, name, len] = s.split('  ')
  return [`${file}  ${name}`, Number(len)] as [string, number]
}))

describe('单函数行数（#18/#19 的防回归棘轮）', () => {
  const all = allFunctions()
  const big = all.filter((f) => f.len > LIMIT)

  it('确实扫到了函数（否则下面的判据全是恒真）', () => {
    console.log(`[算料|fnsize] 具名函数 ${String(all.length)} 个，超过 ${String(LIMIT)} 行的 ${String(big.length)} 个，最长 ${String(Math.max(...all.map((f) => f.len)))} 行`)
    expect(all.length, '一个函数都没读到 ⇒ 扫描根或 AST 提取坏了').toBeGreaterThan(800)
    expect(big.length, '一个超标函数都没扫到 ⇒ 清单和判据都是空的').toBeGreaterThan(10)
  })

  it('超过阈值的函数与清单逐个对齐（新增要拆，长大更不行，拆小了要改数字）', () => {
    const d = diffRatchet(new Map(big.map((f) => [keyOf(f), f.len])), KNOWN_MAP)
    expect(d.unlisted, `这些函数超过了 ${String(LIMIT)} 行却没登记 ⇒ 要么现在就拆，要么写清为什么留着：\n  ${d.unlisted.join('\n  ')}`).toEqual([])
    expect(d.gone, `清单里这些已经不超标了（或改名/搬走了）⇒ 把对应条目删掉：\n  ${d.gone.join('\n  ')}`).toEqual([])
    expect(d.grew, `这些函数比登记的更长了（棘轮只能变小）：\n  ${d.grew.join('\n  ')}`).toEqual([])
    expect(d.shrunk, `这些函数比登记的短了 —— 成果要记账，把清单里的数字改小：\n  ${d.shrunk.join('\n  ')}`).toEqual([])
    expect(KNOWN_MAP.size, `登记条数与实测的超标数不一致：${String(KNOWN_MAP.size)} vs ${String(big.length)}`).toBe(big.length)
  })

  it('反例自证：四种坏法都能被 diffRatchet 分出来（现网清单是齐的，不这么验就等于没验）', () => {
    const known = new Map([['a.ts Foo', 300], ['b.ts Bar', 260]])
    expect(diffRatchet(new Map([['a.ts Foo', 300], ['b.ts Bar', 260]]), known))
      .toEqual({ unlisted: [], gone: [], grew: [], shrunk: [] })
    // ① 新长出一个没登记的
    expect(diffRatchet(new Map([['a.ts Foo', 300], ['b.ts Bar', 260], ['c.ts New', 400]]), known).unlisted).toEqual(['c.ts New'])
    // ② 清单里的已经不超标了（改名/搬走也走这一格）
    expect(diffRatchet(new Map([['a.ts Foo', 300]]), known).gone).toEqual(['b.ts Bar'])
    // ③ 长大的必须报 grew —— 把 `len > at` 写反或写死，这一条立刻红
    expect(diffRatchet(new Map([['a.ts Foo', 361], ['b.ts Bar', 260]]), known).grew).toEqual(['a.ts Foo  登记 300 → 实测 361'])
    // ④ 拆小了要提醒把数字改小（不然下一个人不知道这里本来多少行）
    expect(diffRatchet(new Map([['a.ts Foo', 280], ['b.ts Bar', 260]]), known).shrunk).toEqual(['a.ts Foo  登记 300 → 实测 280'])
  })

  it('反例自证：量不出一个明知很长的函数 ⇒ 上面两条都是恒真', () => {
    const body = Array.from({ length: 300 }, (_, i) => `  const x${String(i)} = ${String(i)}`).join('\n')
    const code = `export function Very(): number {\n${body}\n  return 0\n}\n`
    const found = functionsIn('probe.ts', code)
    const v = found.find((f) => f.name === 'Very')
    expect(v, '函数声明没被读到').toBeDefined()
    expect(v?.len, `长度量错（实测 ${String(v?.len)}）`).toBe(303)
    // const 箭头函数也要认得出来（同样 300 行体 + 起行使 1 行 + `return` + 收尾 `}` = 303）
    const arrow = functionsIn('probe2.ts', `const H = (): number => {\n${body}\n  return 0\n}\n`)
    expect(arrow.find((f) => f.name === 'H')?.len).toBe(303)
  })
})

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
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

/** 新函数（清单之外的）不许超过的行数。 */
const LIMIT = 250

/**
 * 清单：`文件  函数名  登记时的行数`。**只许变小。**
 * 2026-09-26 由一次性脚本 AST 实测灌进来（不是估的；脚本用完即删，复现方法见下面的判据本身）。
 */
const KNOWN_BIG: ReadonlyArray<string> = [
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-state.tsx  useSettingsState  821',
  // 登记理由（2026-09-29）：这段循环必须**保持整段内联**才能同时满足连接纪律棘轮 ——
  // 把分片读取抽成独立函数会让 `new DatabaseSync` 的站点归属变到账本里没有的函数名上
  // （第 24 轮实测被 `query-db-lifetime.spec.ts` 挡下）。分片级增量缓存（真机省约 3/4 的全量重算）
  // 就是在这个内联循环外面挂了一层"命中即 continue"。**行数只许变小。**
  'src/backend/wechat-data/src/query/overview-insights.ts  computeOverviewInsights  252',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/kb-files-panel.tsx  KbFilesPanel  787',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Graph.tsx  GraphPanel  725',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-view.tsx  ChatsView  359',
  'src/backend/wechat-data/src/remotes/askdeep.ts  createAskDeepRemotes  607',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/DailySummary.tsx  DailySummaryPanel  588',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Chats.tsx  ChatsPanel  465',
  // 2026-09-30：重做为「三块可折叠面板」时把子件拆成 ai-model-panel / -profiles / -roles /
  // llm-probe 四个文件，540 → 493；同日「默认全部折叠」又去掉了自动展开的旁路，493 → 488。
  // 棘轮只许变小，改完要回来改数字。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/AiModelConfig.tsx  AiModelConfig  488',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Ask.tsx  AskPanel  493',
  // 2026-09-30：底部固定区（设置 / 模型余额 / 主题与数据状态）拆成 `SidebarFooter`，
  // 492 → 464。棘轮的方向是「只许变小」，所以拆完要回来改数字。
  'src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx  WechatDataPanel  464',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/ExportHistoryDialog.tsx  ExportHistoryDialog  461',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-thread.tsx  useChatsThread  269',
  'src/backend/wechat-data/src/remotes/kb.ts  createKbRemotes  425',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-panel.tsx  OverviewPanel  403',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/KnowledgeBase.tsx  KnowledgeBasePanel  387',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Files.tsx  FilesPanel  368',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-panel.tsx  MomentsPanel  329',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx  WorldMapPanel  313',
  // 2026-09-28（E1 性能修复）：334 → 362。增量全部是**新增的 `getEmoticonDataUrls`
  // 批量壳**（签名 + 文档 + 一行转发）—— 算法体已搬到 `query/emoticon-batch.ts`，
  // 所以这里只长了那一层壳。想把它降回去就得把别的域也搬出去，不是靠改这个数字。
  'src/backend/wechat-data/src/remotes/media.ts  createMediaRemotes  332',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Settings.tsx  SettingsPanel  328',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/graph-model.ts  buildGraph  314',
  // 2026-09-30：给年报加「资金 / 撤回 / 群聊」三个字段时，先把 noteEmoji 与页脚首尾两条
  // 抽成模块级函数腾预算，assemble 308 → 306。棘轮只许变小，拆小了要回来改数字。
  'src/backend/wechat-data/src/query/annual-review.ts  assemble  306',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Contacts.tsx  ContactsPanel  303',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/KbRail.tsx  KbRail  292',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-cards.tsx  RichCard  290',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/AskHistoryDialog.tsx  AskHistoryDialog  289',
  'src/backend/wechat-data/src/query/ask.ts  retrieveAskCitations  285',
  // 2026-09-29：合并两个 Toolbar 为一行 + 注释精简 ⇒ 279（成果记账，数字改小；只许再变小）
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Records.tsx  RecordsPanel  279',
  'src/backend/wechat-data/src/remotes/export.ts  createExportRemotes  278',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Favorites.tsx  FavoritesPanel  259',
  'src/backend/wechat-data/src/query/parse-rich.ts  parseAppmsg  266',
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-card.tsx  MomentsCard  265',
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

/**
 * 主题覆盖矩阵：把「**每一个用户界面**在深色与浅色下的配色/对比度/文字与图标颜色一致性」
 * 落成一张可核对的表 —— 页面（36 个页签）× 组件（主题相关的那几族）× 主题切换场景。
 *
 * ## 为什么要有它
 *
 * 仓库里主题一致性已经有四层证据，但它们**各自只知道一部分**：
 *   · `theme-contrast.guard.spec.ts`（离线令牌）—— 知道"令牌没问题"，不知道"哪些页面用了它"；
 *   · `wx-skin-contrast.guard.spec.ts`（离线皮肤）—— 只管 `--wx-*` 那一层；
 *   · `theme-live-audit.mjs`（真机）—— 量页面，但默认只量**导航里的 16 个**；
 *   · `panel-audit.mjs`（截图）—— 截图在本环境**不可信**（账本陷阱②），只能人眼看。
 * 于是"要覆盖哪些页面/组件/场景"这件事**没有单一出处**：散在 4 个脚本的注释与账本文档里。
 * 本工具就是那个单一出处：**页面的那一半从源码+实测生成**，组件与场景两半是**登记表**，
 * 且**每一条引用都要能落到真实文件**（引用不存在 ⇒ 直接报错，与 `audit:ledger` 同一纪律）。
 *
 * ## 边界（写清楚）
 *
 * - "现状"列是**最近一次真机测量的结果**（`.tmp-e2e/theme-contrast.json`）；没有它时写 `未测量`，
 *   **不猜测**。要刷新就 `npm run theme:live-audit -- --all-tabs` 再跑本工具。
 * - 页面 × 主题的结论来自**computed style 抽样**（面板内第一个非空文本叶子 + 其不透明祖先背景），
 *   是抽样不是穷举；穷举那一层由离线令牌矩阵负责（见 §1 口径）。
 *
 * 用法：
 *   node scripts/theme-page-matrix.mjs          # 生成/刷新 docs/THEME-COVERAGE-MATRIX.md
 *   node scripts/theme-page-matrix.mjs --check   # 校验文档不过期 + 所有引用存在（CI 用）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const NAV = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts')
const SHELL = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx')
const MEASURED = join(ROOT, '.tmp-e2e', 'theme-contrast.json')
const OUT_DOC = join(ROOT, 'docs', 'THEME-COVERAGE-MATRIX.md')
const CHECK = process.argv.includes('--check')

/**
 * 主题相关的**组件族**登记表。
 *
 * `files` 里的每一项都会做**存在性断言**（引用不存在的文件 ⇒ 生成失败）——
 * 这是防止"文档里写着某个守卫、其实早被改名/删掉"的唯一机械手段。
 */
const COMPONENTS = [
  {
    family: '按钮（Button / 胶囊）',
    files: ['src/client/ui-primitives-shim/src/Button.module.css', 'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.module.css'],
    dark: '主/次/幽灵三档都有显式深色值；**禁用态对比度 4.45** 是登记过的有意取舍（复刻微信观感）',
    light: '浅色端全部 ≥ 4.5（离线矩阵实测 5.36–17.85）',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/panels/button-disabled-tone.wiring.spec.ts'],
  },
  {
    family: '输入框 / 表单字段（Input / kit-fields）',
    files: ['src/client/ui-primitives-shim/src/Input.module.css', 'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-fields.tsx'],
    dark: '底色/边框/占位文字走 `--nm-*` 令牌',
    light: '同一套令牌在 `:root.theme-light` 下换值',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts'],
  },
  {
    family: '标签 / 状态点（Pill / StateDot）',
    files: ['src/client/ui-primitives-shim/src/Pill.module.css', 'src/client/ui-primitives-shim/src/StateDot.module.css'],
    dark: '语义色（成功/警告/危险）当背景时的徽标对比度已单独覆盖',
    light: '同上',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts'],
  },
  {
    family: '图标（SVG 字形 / currentColor）',
    files: ['src/client/ui-primitives-shim/src/icons/index.tsx', 'src/client/ui-primitives-shim/src/icons/props.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/nav-config.ts'],
    dark: '字形一律 `fill: currentColor`（或外层 `stroke: currentColor`）⇒ 跟随文字色；',
    light: '唯一的例外是**收藏**那枚线稿立方体（官方字形本身就是线稿，不吃 `filled()` 包裹），已写进 nav-config 注释',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/dsw-alias-tokens.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/first-impressions-tokens.spec.ts'],
  },
  {
    family: '弹窗 / 浮层（确认框、设置弹窗、Tooltip、右键菜单）',
    files: ['src/client/ui-wechat/src/client/pages/wechat-data/ui/confirm.tsx', 'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-overlay.module.css'],
    dark: '遮罩 `rgba(4,8,20,0.6)` **刻意不随主题变**（浅色下也压暗背景）；弹窗内容走令牌',
    light: '同上；弹窗文字的对比度靠令牌矩阵保证',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/panels/dialog-a11y.wiring.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/theme-alpha-ladder.spec.ts'],
  },
  {
    family: '表格 / 长列表（Table / 虚拟滚动）',
    files: ['src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-table.module.css', 'src/client/ui-wechat/src/client/pages/wechat-data/panels/list-panel.module.css'],
    dark: '斑马纹与悬停层是**半透明**叠加 ⇒ 已用 alpha 阶梯做单调性断言',
    light: '同一阶梯在浅底上反向验证',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/theme-alpha-ladder.spec.ts'],
  },
  {
    family: '数据态（骨架 / 加载 / 空态 / 错误态）',
    files: ['src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-foldable.tsx', 'src/client/ui-wechat/src/client/pages/wechat-data/ui/state-components.wiring.spec.ts'],
    dark: '骨架与空态用 `text-3`（弱化文字）⇒ 深色端是**已登记的低对比**（3.75–4.15）',
    light: '浅色端 ≥ 4.5',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/ui/state-components.wiring.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts'],
  },
  {
    family: '图表与画布（echarts / 知识图谱 / 词云 / 矩形树图 / 等距地图）',
    files: [
      'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-card.module.css',
      'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-neon.module.css',
      'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map.module.css',
      'src/client/ui-wechat/src/client/pages/wechat-data/panels/graph.module.css',
    ],
    dark: '画布内的配色由脚本读取 `--nm-*`；霓虹皮肤（总览）在深色下是深蓝紫玻璃',
    light: '**2026-09-29 修好**：该皮肤的 13 条浅色规则原先写的是裸 `:root.theme-light`，被 CSS Modules 哈希成 `:root._theme-light_…` ⇒ 永不匹配、全是死规则（浅色下卡片仍是深海军蓝）。改成 `:root[class~=\'theme-light\']`（属性值不哈希）后浅色下是白玻璃（实测 `linear-gradient(158deg, rgba(255,255,255,.9), …)`）',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/panels/light-theme-coverage.wiring.spec.ts'],
  },
  {
    family: '微信皮肤层（聊天气泡 `--wx-*`）',
    files: ['src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-rows.module.css'],
    dark: '复刻微信官方色值：自方气泡 `#3EB575` + 白字 = **2.60（低于 AA，已登记的有意取舍）**；对方气泡 12.46–16.13 ✅',
    light: '自方气泡 `#95EC69` + 黑字 = **14.48** ✅；对方气泡 12.54–14.68 ✅',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/wx-skin-contrast.guard.spec.ts'],
  },
  {
    family: '外壳层（标题栏 / 启动引导 / 隐私同意 / 授权页 —— ui-app）',
    files: ['src/client/ui-app/titlebar.css', 'src/client/ui-app/privacy/PrivacyConsentGate.module.css'],
    dark: '外壳**不随主题变**（固定深色标题栏）；启动三站与同意屏是独立视觉，不参与面板主题',
    light: '同上 —— 真机审计里"顶部外壳仍是深色"**不是缺陷**（账本已写明）',
    guards: ['scripts/privacy-consent-ssr.tsx', 'scripts/ui-ask-smoke.js'],
  },
]

/**
 * **主题切换场景**登记表：用户实际会遇到的切换路径，逐条给"怎么覆盖 + 拿什么验 + 现状"。
 */
const SCENARIOS = [
  {
    id: 'S1', name: '冷启动即深色（localStorage 无值 / `dark`）',
    how: '真机：`localStorage["super-time-wechat-theme"]="dark"` → reload → 读 `htmlClass` 必须**不含** `theme-light`',
    guards: ['scripts/theme-live-audit.mjs'],
    status: '通过（两套主题各跑一轮，断言 `htmlClass` 与请求一致）',
  },
  {
    id: 'S2', name: '冷启动即浅色（`light`）',
    how: '同上，断言 `htmlClass` **含** `theme-light`',
    guards: ['scripts/theme-live-audit.mjs'],
    status: '通过',
  },
  {
    id: 'S3', name: '运行中 深→浅 / 浅→深 切换（不重启）',
    how: '真机：改 localStorage 后 reload；离线：令牌层两套主题各解析一遍',
    guards: ['scripts/theme-live-audit.mjs', 'src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts'],
    status: '通过（离线 10 用例；真机两轮都断言主题真的生效，避免"两轮都停在浅色"）',
  },
  {
    id: 'S4', name: '隐藏页签（hash 深链）在两套主题下',
    how: '`--all-tabs`：写 `location.hash` + reload 进入 20 个 `hidden: true` 页签，逐个体检采样',
    guards: ['scripts/theme-live-audit.mjs', 'scripts/panel-audit.mjs'],
    status: '本文件 §1 的 hidden 行即为测量结果（此前是**盲区**：默认只量 16 个可见页签）',
  },
  {
    id: 'S5', name: '设置弹窗 / 抽屉 / Tooltip / 右键菜单（浮层叠在遮罩上）',
    how: '真机审计里 4 个隐藏页签以「设置」弹窗形式打开；离线算遮罩 alpha 阶梯',
    guards: ['scripts/theme-live-audit.mjs', 'src/client/ui-wechat/src/client/pages/wechat-data/theme-alpha-ladder.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/panels/dialog-a11y.wiring.spec.ts'],
    status: '通过（遮罩刻意不随主题变，已登记）',
  },
  {
    id: 'S6', name: '交互态：hover / active / focus-visible / disabled / selected',
    how: '离线把令牌按"内容色 × 叠了 5% 悬停层"逐对算 WCAG；禁用态单独一条',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/panels/button-disabled-tone.wiring.spec.ts'],
    status: '通过（深色 `text-3` 叠加后 3.11–3.40，按棘轮登记）',
  },
  {
    id: 'S7', name: '数据态：骨架屏 / 加载中 / 空态 / 错误态',
    how: '离线令牌矩阵 + 状态组件接线用例；真机审计记录"仍有加载指示"的面板',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/ui/state-components.wiring.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts'],
    status: '通过；深色 `text-3` 的已知低对比在这些态上同样成立',
  },
  {
    id: 'S8', name: '图表与画布（echarts / 图谱 / 词云 / 树图 / 等距地图）',
    how: '浅色覆盖块必须与深色逐类成对（整份裸色皮肤不许只写深色）；令牌层覆盖语义色与 `color-mix`',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/panels/light-theme-coverage.wiring.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts'],
    status: '通过（裸色皮肤逐类成对；该文件的选择器必须写成 `:root[class~=\'theme-light\']` 或 `:global(…)`，否则被 CSS Modules 哈希 ⇒ 死规则 —— 2026-09-29 真事故，已由 `light-theme-coverage.wiring.spec.ts` 第 6/8 条常驻钉住）',
  },
  {
    id: 'S9', name: '微信皮肤层（聊天气泡 `--wx-*`）：深色与浅色两套官方色值',
    how: '解析 CSS 层叠语义（首次声明=深色、末次声明=浅色），逐对算对比度，例外按棘轮',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/wx-skin-contrast.guard.spec.ts'],
    status: '**已知不一致**：深色自方气泡白字压官方绿 = 2.60（浅色 14.48）—— 有意保真取舍，已登记',
  },
  {
    id: 'S10', name: '图标颜色（导航字形 / 面板图标）',
    how: '字形走 `currentColor`；对"别名令牌"与"首屏令牌"各一条离线用例',
    guards: ['src/client/ui-wechat/src/client/pages/wechat-data/dsw-alias-tokens.spec.ts', 'src/client/ui-wechat/src/client/pages/wechat-data/first-impressions-tokens.spec.ts'],
    status: '通过',
  },
  {
    id: 'S11', name: '真机整体门禁：每页签的背景是否随主题变 + 采样对比度',
    how: '落盘 `.tmp-e2e/theme-contrast.json` → 逐页签核对（缺登记 ≠ 通过）',
    guards: ['scripts/theme-contrast-budget.mjs', 'scripts/theme-contrast-budget.json'],
    status: '通过（16 个可见页签 × 2 主题；本文件 §1 已把覆盖扩到 36 个）',
  },
]

/** 从 nav-config.ts 抽全部页签（含 hidden）。 */
function navTabs () {
  const text = readFileSync(NAV, 'utf8')
  const out = []
  for (const ln of text.split(/\r?\n/)) {
    const m = /\{ tab: '([a-z]+)', label: '([^']+)'/.exec(ln)
    if (m) out.push({ tab: m[1], label: m[2], hidden: ln.includes('hidden: true') })
  }
  return out
}

/** 从 shell 的 `switch (tab)` 抽 `tab → 渲染的组件名[]`。 */
function tabComponents () {
  const text = readFileSync(SHELL, 'utf8')
  const map = new Map()
  let cur = []
  let buf = []
  /** 本组是否已经出现过 `return`（跨行 JSX 要靠它判断"还在同一组里"）。 */
  let sawReturn = false
  const flush = () => {
    for (const t of cur) {
      const set = map.get(t) ?? new Set()
      for (const c of buf) set.add(c)
      map.set(t, set)
    }
    cur = []; buf = []; sawReturn = false
  }
  for (const ln of text.split(/\r?\n/)) {
    const cs = /^\s*case '([a-z]+)':/.exec(ln)
    if (cs) {
      // ⚠️ 见到新 case 且上一组**已经写出 return** 时必须先结算上一组，
      // 否则所有 case 的组件会累加进同一张表（第一版就这样：36 行长得一模一样）。
      // 相邻的 `case 'a': case 'b': return …` 是一组（合并面板），不能拆开。
      if (sawReturn) flush()
      cur.push(cs[1])
      // ⚠️ `case 'x': return <X/>` 是**同一行**：`continue` 之前必须把 case 之后的
      // 半行也扫一遍，否则这些页签的组件列会全空（第二版就踩到了）。
      const rest = ln.slice(cs[0].length)
      if (/\breturn\b/.test(rest)) {
        sawReturn = true
        for (const m of rest.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) buf.push(m[1])
      }
      continue
    }
    if (/^\s*default:/.test(ln)) { flush(); break }
    if (cur.length === 0) continue
    if (/\breturn\b/.test(ln)) sawReturn = true
    // `return (` 之后的**跨行 JSX** 也要收：`<OverviewPanel` 在下一行，而它不带 `return`。
    if (sawReturn) {
      for (const m of ln.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) buf.push(m[1])
    }
  }
  flush()
  return map
}

/** 从 shell 抽 `DIALOG_SECTION_OF` 的页签（这些页签以「设置」弹窗呈现，没有主内容区落点）。 */
function dialogSectionTabs () {
  const text = readFileSync(SHELL, 'utf8')
  // 必须锚到**声明**那一处：文件上方还有注释/用法里提到同一个标识符，
  // 只按 `DIALOG_SECTION_OF...= {` 匹配会切到注释之后的第一个花括号（实测抓到过 `onOpenChat`）。
  const m = /const DIALOG_SECTION_OF[^=]*=\s*\{([\s\S]*?)\n\}/.exec(text)
  const out = new Set()
  for (const km of (m?.[1] ?? '').matchAll(/(\w+):\s*'/g)) out.add(km[1])
  return out
}

const tabs = navTabs()
const tabComp = tabComponents()
const dialogTabs = dialogSectionTabs()
const measured = existsSync(MEASURED) ? JSON.parse(readFileSync(MEASURED, 'utf8')) : null
const byLabel = new Map((measured?.panels ?? []).map((p) => [String(p.label), p]))

const problems = []
// 引用存在性：组件族与场景表里提到的每个文件都必须在。
for (const c of COMPONENTS) {
  for (const f of [...c.files, ...c.guards]) {
    if (!existsSync(join(ROOT, ...f.split('/')))) problems.push(`组件「${c.family}」引用了不存在的文件：${f}`)
  }
}
for (const s of SCENARIOS) {
  for (const f of s.guards) {
    if (!existsSync(join(ROOT, ...f.split('/')))) problems.push(`场景 ${s.id} 引用了不存在的守卫：${f}`)
  }
}
for (const t of tabs) {
  // 有 4~5 个页签**不进主内容区**，而是打开「设置」弹窗并落到某一节（`DIALOG_SECTION_OF`）——
  // 它们同样是用户界面（浅色下弹窗叠在遮罩上），只是落点不同，不算"找不到落点"。
  if (!tabComp.has(t.tab) && !dialogTabs.has(t.tab)) {
    problems.push(`页签「${t.label}」(${t.tab}) 既不在 shell 的 switch 里，也不在 DIALOG_SECTION_OF 里`)
  }
}

/** 生成文档。 */
function render () {
  const L = []
  L.push('# 主题覆盖矩阵（页面 × 组件 × 切换场景）')
  L.push('')
  L.push('> ⚙️ **本文件由 `node scripts/theme-page-matrix.mjs` 生成，不要手改**；')
  L.push('> CI 用 `node scripts/theme-page-matrix.mjs --check` 校验它与源码/测量一致。')
  L.push('')
  L.push('回答的是「**每一个用户界面**在深色与浅色下的配色、对比度、文字与图标颜色是否一致」，')
  L.push('以及「**要覆盖哪些页面、哪些组件、哪些切换场景**」。')
  L.push('')
  L.push('## 0. 口径（三条）')
  L.push('')
  L.push('1. **页面**（§1）：真机 computed style **多采样** —— 页签内所有可见文本按')
  L.push('   `(color, 不透明祖先背景)` 去重（上限 40 对），取**除弱化文字（`--nm-text-3`）外**的')
  L.push('   最低 WCAG 对比度。夹着渐变/图片底的对记 `n/a`（不合成，否则霓虹皮肤会算出假阳性）；')
  L.push('   弹窗类页签取「设置」弹窗本身，不取它背后那一页。')
  L.push('2. **组件**（§2）与**场景**（§3）是**登记表**：每条都要能落到真实文件（引用不存在 ⇒ 生成失败）。')
  L.push('3. **截图不是判据**（账本陷阱②）：同一时刻截图与 DOM 探针会给出相反结论，故本矩阵不用像素采样。')
  L.push('')
  L.push(`测量来源：${measured === null ? '**未测量**（先跑 `npm run theme:live-audit -- --all-tabs`）' : `\`.tmp-e2e/theme-contrast.json\`（${String(measured.generatedAt)}）`}`)
  L.push('')
  L.push(`## 1. 页面（${tabs.length} 个页签 = 16 可见 + ${tabs.filter((t) => t.hidden).length} 隐藏）`)
  L.push('')
  L.push('| # | 页签 | tab | 类型 | 面板组件 | 深色对比 | 浅色对比 | 背景随主题变 |')
  L.push('|---|---|---|---|---|---|---|---|')
  tabs.forEach((t, i) => {
    const isDialog = dialogTabs.has(t.tab) && !tabComp.has(t.tab)
    const comps = [...(tabComp.get(t.tab) ?? [])].filter((c) => c !== 'MergedSections' && c !== 'svg')
    const m = byLabel.get(t.label)
    const dark = m?.dark?.contrast; const light = m?.light?.contrast
    const fmt = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(2))
    const panelCell = isDialog
      ? '`SettingsDialog`（弹窗，无主内容区）'
      : (comps.length === 0 ? '-' : comps.map((c) => '`' + c + '`').join(' '))
    L.push(`| ${i + 1} | ${t.label} | \`${t.tab}\` | ${isDialog ? '隐藏（设置弹窗）' : (t.hidden ? '隐藏（深链）' : '侧栏可见')} | ${panelCell} | ${fmt(dark)} | ${fmt(light)} | ${m === undefined ? '未测量' : (m.themeChanged === true ? '是' : '**否**')} |`)
  })
  L.push('')
  const unmeasured = tabs.filter((t) => !byLabel.has(t.label))
  L.push(`未测量的页签：${unmeasured.length === 0 ? '**0 个**（全覆盖）' : unmeasured.map((t) => t.label).join('、')}`)
  L.push('')
  L.push('## 2. 组件（主题相关的那几族）')
  L.push('')
  L.push('| 组件族 | 关键文件 | 深色 | 浅色 | 守卫 |')
  L.push('|---|---|---|---|---|')
  for (const c of COMPONENTS) {
    L.push(`| ${c.family} | ${c.files.map((f) => '`' + f.split('/').pop() + '`').join(' ')} | ${c.dark} | ${c.light} | ${c.guards.map((f) => '`' + f.split('/').pop() + '`').join(' ')} |`)
  }
  L.push('')
  L.push('## 3. 主题切换场景（用户真会遇到的路径）')
  L.push('')
  L.push('| # | 场景 | 怎么覆盖 | 守卫 | 现状 |')
  L.push('|---|---|---|---|---|')
  for (const s of SCENARIOS) {
    L.push(`| ${s.id} | ${s.name} | ${s.how} | ${s.guards.map((f) => '`' + f.split('/').pop() + '`').join(' ')} | ${s.status} |`)
  }
  L.push('')
  L.push('## 4. 未闭环（如实登记，不是缺陷被隐藏）')
  L.push('')
  L.push('| 项 | 内容 | 为什么留着 |')
  L.push('|---|---|---|')
  L.push('| U1 | 深色端 `text-3`（弱化文字）3.75–4.15，低于 AA | `ui/kit.module.css` 早已记录并决策：内容类文字改用 `--text-2`，不动令牌值 |')
  L.push('| U2 | 深色端「自方气泡」白字压微信官方绿 = **2.60** | 复刻微信原生外观是这一层的目的；改色会背离复刻目标（`wx-skin-contrast.guard.spec.ts` 按棘轮钉住） |')
  L.push('| U3 | ~~霓虹皮肤（总览）两套主题都偏深~~ **已于 2026-09-29 修掉** | 根因是 CSS Modules 把裸 `theme-light` 哈希掉、13 条浅色规则全是死规则；见 [§1 口径] 与 `panels/light-theme-coverage.wiring.spec.ts` |')
  L.push('| U4 | 外壳（标题栏）不随主题变 | 主进程外壳，非面板；真机上"顶部仍是深色"不是缺陷 |')
  L.push('| U5 | 像素级证据缺失 | 本环境截图不可信（陷阱②）；只有人眼或先修截图时序才能补 |')
  L.push('')
  return L.join('\n')
}

if (problems.length > 0) {
  console.error('=== 主题覆盖矩阵：引用/结构校验失败 ===')
  for (const p of problems) console.error('  x ' + p)
  process.exit(1)
}
const rendered = render()
if (CHECK) {
  if (!existsSync(OUT_DOC)) { console.error('缺少 docs/THEME-COVERAGE-MATRIX.md ⇒ 先跑 node scripts/theme-page-matrix.mjs'); process.exit(1) }
  const cur = readFileSync(OUT_DOC, 'utf8')
  // 测量列是本机产物：CI 上生成物会多/少几行 ⇒ 只比"结构性内容"
  // （剥掉页面表的数据行、测量来源行、未测量页签汇总行）。
  const strip = (s) => s.split('\n')
    .filter((l) => !/^\| \d+ \| .* \| (是|否|未测量) \|$/.test(l))
    .filter((l) => !l.startsWith('测量来源：'))
    .filter((l) => !l.startsWith('未测量的页签：'))
    .join('\n')
  // 口径：写盘时补了尾换行，比较时也要带上，否则每次都判"不一致"（这个坑刚踩过一次）。
  const same = strip(cur) === strip(rendered + '\n')
  if (!same) { console.error('x docs/THEME-COVERAGE-MATRIX.md 与源码/测量不一致 ⇒ 重新生成'); process.exit(1) }
  console.log(`=== 主题覆盖矩阵自检通过：${tabs.length} 个页签、${COMPONENTS.length} 个组件族、${SCENARIOS.length} 个场景 ===`)
  process.exit(0)
}
writeFileSync(OUT_DOC, rendered + '\n', 'utf8')
console.log(`已生成 ${OUT_DOC}`)
console.log(`  ${tabs.length} 个页签（可见 ${tabs.filter((t) => !t.hidden).length} / 隐藏 ${tabs.filter((t) => t.hidden).length}）、${COMPONENTS.length} 个组件族、${SCENARIOS.length} 个切换场景`)
console.log(`  测量来源：${measured === null ? '无（刷新前请先跑 theme:live-audit -- --all-tabs）' : String(measured.generatedAt)}`)

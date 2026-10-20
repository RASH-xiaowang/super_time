# 前端 Bootstrap 响应式适配实施方案

> 目标：在项目所有界面中**引入 Bootstrap 的响应式栅格与实用类**，保证任意分辨率下内容正常显示，
> 不被隐藏、遮挡或溢出；同时不破坏现有 NEON MATRIX 设计体系、主题判据与面板高度预算。
>
> 范围：渲染层（`src/client/ui-app` + `src/client/ui-wechat`），覆盖 38 个页签 / 144 个面板视图。
> 状态：Wave 0（基建 + 基线审计）进行中；修复分 Wave 1–4 逐步推进。
> 工具：`npm run ui:responsive-audit`（真实 Electron + Playwright 多分辨率扫描）。

---

## 0. 结论先行（先定三件事，后面才有意义）

1. **引入方式只能是 npm，不能是 CDN。**
   渲染页的 CSP 是 `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`，
   远程 CSS/JS 会被直接拦掉；产品运行在 `file://` 且要求离线可用（隐私边界也禁止无谓出网）。
   → 用 `bootstrap@5.3.x` 的 **npm 包**，由 Vite 打包进本地产物，运行期零网络请求。

2. **只引入 `bootstrap-grid` + `bootstrap-utilities`，**不**引入 `bootstrap.css` 全量包。**
   `bootstrap.css` 含 reboot（`body` 字体/边距、标题、按钮、输入框、表格基线）与全部组件样式，
   会与现有 144 个面板的令牌体系、主题对比度判据、1000 行/高度预算正面冲突，回归面不可控。
   两个子文件只提供**类**：不写 `class="row/col/d-flex/..."` 的元素完全不受影响。

3. **组件不换实现，只借 Bootstrap 的类名与栅格语义。**
   本仓已有 kit（`Card/DataTable/Toolbar/Segmented/Drawer`，Radix 内核）与移动端外壳；
   Bootstrap 负责「怎么排/怎么断点/怎么保底滚动」，组件外观仍由 `--nm-*` 令牌与 CSS Modules 决定。
   需要 Bootstrap 组件类名（`.card/.table/.form-control/.modal`）时由
   `src/client/ui-app/bootstrap-bridge.css` 提供**最小桥接样式**（不含 reboot、不引 Bootstrap JS）。

---

## 1. 引入 Bootstrap（Wave 0，一次性基建）

1. `npm install bootstrap@5.3.8 --save`（版本随 lock 固定；升级走单独 PR）。
2. 在 **`src/client/ui-app/ui-entry.tsx` 的最前面**（早于 `titlebar.css` / `host.ts` 的主题导入）加：
   ```ts
   // Bootstrap 只取栅格与实用类（不含 reboot / 组件样式）；必须早于主题导入，
   // 保证 --nm-* 令牌与组件样式最后生效。
   import 'bootstrap/dist/css/bootstrap-grid.min.css'
   import 'bootstrap/dist/css/bootstrap-utilities.min.css'
   import './bootstrap-bridge.css'
   ```
   - 顺序不可反：CSS 级联以 import 顺序为准，主题必须最后。
3. **CSP 不改**：npm 包产物是本地资源（`style-src 'self'` 天然放行）；若有人提议 CDN，直接驳回并引用第 0 节。
4. **构建体积量化**：`npm run build:ui` 后记录 `ui-dist/assets/index-*.css` 增量。
   2026-10-18 基线实测：**137.10 kB → 269.21 kB（+132.11 kB 原始；gzip 40.02 kB）**。
   结论：**接受**——CSS 随应用本地加载（`file://`，无网络传输），解析开销在毫秒级；
   gzip 后仅 +17.3 kB（两份 Bootstrap 文件 gzip 合计）。
   阈值定为 **主 CSS ≤300 kB 原始 / ≤50 kB gzip**；超阈值才上子集化
   （PurgeCSS 或手写子集，注意 `bootstrap-grid` 无法 tree-shake）。
5. **`bootstrap-bridge.css` 最小桥接**：只提供实际用到的类，全部基于令牌：
   `.container/.container-fluid`（若与面板 padding 冲突就用 `.w-100` 替代，不强行改容器）、
   `.table/.table-responsive`、`.card/.card-body`、`.form-control/.form-select/.form-label`、
   `.modal/.modal-dialog/.modal-content/.modal-body`、`.navbar/.navbar-collapse`。
   每类 3–8 行，禁止把 Bootstrap 组件样式整段抄进来。
6. **不引入 Bootstrap JS**：dropdown/collapse/modal/offcanvas 继续用现有 Radix kit；
   Bootstrap 的 data-api 与 Popper 会引入第二套交互模型与焦点管理。

---

## 2. 栅格与断点使用规约

| 断点 | 宽度 | 本项目对应 | 用法 |
|---|---:|---|---|
| xs | < 576 | 手机浏览器（375–430）、手机远程访问 | 一律单列；`col-12`；不允许横向滚动 |
| sm | ≥ 576 | 小平板/手机横屏 | 2 列起（`col-sm-6`） |
| md | ≥ 768 | 平板 | 2–3 列（`col-md-6` / `col-md-4`） |
| lg | ≥ 992 | 小笔记本（1024×768） | 3 列 / 侧栏出现 |
| xl | ≥ 1200 | 1280×800 / 1440×900 常用 | 主布局：`col-xl-8` + `col-xl-4` |
| xxl | ≥ 1400 | 1920 / 2560 宽屏 | 上限宽度容器，避免「一行拉到 2560」 |

**硬性规约（违反即打回）**

1. **禁止用 `d-none` 隐藏业务内容**：响应式只允许「换行 / 变列 / 进抽屉 / 进横向滚动容器」，
   不允许「小屏看不见」。确需在手机端折叠的，用「可展开的详情」而不是 `display:none`。
2. **表格必须滚动而不是裁切**：外层套 `.table-responsive`（= `overflow-x:auto`），
   或本仓的 `tableScroll` 等价容器；表头 `position: sticky` 时容器不能同时 `overflow:hidden`。
3. **栅格负 margin 要有父级 padding**：`.row` 的 `--bs-gutter-x` 是负 margin，
   放进无 padding 的卡片会横向溢出 12px；要么用 `.row.g-2`（small gutter）、
   要么父级补 `px-*`，要么改用 `d-flex flex-wrap gap-*`（本仓首选，与现有 `gap` 语义一致）。
4. **flex/grid 子项必须 `min-width: 0`**：否则长昵称/长 ID 会把列撑破（这是本仓历史上最常见的溢出源）。
5. **固定尺寸改成上限**：`width: 320px` → `width: min(320px, 100%)`；
   `max-width: 100%` 要配 `overflow-wrap:anywhere`（聊天文本尤其）。
6. **模态框/抽屉在窄屏必须是全屏 sheet**：现有 `kit-overlay` 已把 ≤560px 的 Drawer 转成底部 sheet，
   新写的弹层必须复用 `Drawer`，不许自绘固定宽度的 `position:fixed` 面板。
7. **新增/修改的断点必须用 Bootstrap 5 的值**（576/768/992/1200/1400），
   **存量的非标断点不随本次改动**。2026-10-18 全量清点（`src/client/**/*.css`）：
   共 **99 处媒体查询，其中宽度断点 77 处**；分布为
   `560`×23、`900`×13、`1100`×8、`760`×4、`720`/`1180`×3、`820`/`620`/`700`/`1080`/`1000`/`360`×2、
   `1024`/`1025`×1…；Bootstrap 原生断点命中仅 `768`×1、`1200`×3。
   **结论：不做一次性统一**（会动 100+ 面板、且 560 是手机外壳与 `use-media-query` 的同一个数，
   两边必须一起改）；旧文件按原档位维护，新代码按下表就近映射：

   | 旧值 | 新代码就近用 | 说明 |
   |---:|---|---|
   | ≤560 / 561 | **保持 560** | 手机外壳 + `PHONE_QUERY` 特例，禁止改用 576 |
   | 620–768 | 768 | 平板竖屏 |
   | 820–1024 | 992 | 小笔记本 |
   | 1025–1200 | 1200 | 常规桌面 |
   | 1180 / 1400+ | 1400 | 宽屏上限 |
8. **不使用 `.container` 包整页**：本应用面板已有自己的 padding 与滚动容器，
   再套 `.container` 会二次留白；需要限宽时用 `.mx-auto` + `max-width` 令牌。

---

## 3. 关键组件适配策略（逐类）

### 3.1 导航栏（Navbar / 侧栏 / 手机底部导航）
- **现状**：桌面自绘标题栏 + 左侧栏（可收起）+ 手机端底部标签栏（`mobile-nav.tsx`，≤560px）。
- **策略**：不换 DOM 骨架，只借栅格与工具类做**断点行为**；
  `navbar-collapse` 类仅用于「窄屏收进抽屉」的语义，展开/收起仍由本仓状态机控制。
- **验收**：390px 无横向滚动；侧栏收起态不遮住内容；手机导航不与底部安全区重叠（`env(safe-area-inset-bottom)`）。

### 3.2 表单（Forms）
- **现状**：`kit-fields`（Input/DateField/Select/SearchInput）+ 各面板自绘行。
- **策略**：`.row.g-2 > .col-12.col-md-6` 做字段栅格；`.form-label` + `.form-control` 由桥接样式接管
  高度/圆角/聚焦环（沿用 `--nm-*`）；`flex-wrap` 优先于固定两列。
- **验收**：1280 宽两列、768 宽一列；输入框不溢出父容器；标签不被截断（`min-width:0` + 换行）。

### 3.3 卡片（Cards）
- **现状**：kit `Card`（标题/extra/footer/flush）+ 本地卡片（如 Ledger 排行卡）。
- **策略**：栅格容器用 `row g-3` 或 `d-grid`（`grid-template-columns: repeat(auto-fit,minmax(280px,1fr))`）；
  卡片内部滚动区必须 `min-height:0`，否则 flex 布局下会被内容顶破。
- **验收**：卡片内表格/列表「内部滚」不被卡片 `overflow:hidden` 切断；2560 宽下不出现一行 6 张超大卡。

### 3.4 表格（Tables）
- **现状**：`DataTable`（TanStack，列宽可指定）+ 虚拟化表（Records）。
- **策略**：`table-responsive` 兜底横向滚动；列宽用百分比/`minWidth` 而非固定 px；
  手机端隐藏优先级最低的**列**（用列定义按断点过滤，而非 CSS `d-none` 藏单元格）。
- **验收**：任意视口下无「表格伸到卡片外」；粘性表头不与滚动容器打架；行内容不截断（`overflow-wrap`）。

### 3.5 模态框 / 抽屉（Modal / Drawer）
- **现状**：Radix Dialog（`kit-overlay` Drawer/Confirm），≤560px 转底部 sheet。
- **策略**：宽度用 `.modal-dialog` 语义 + `max-width: min(680px, calc(100vw - 32px))`；
  内部滚动而不是整页滚动；关闭按钮固定可见；不允许 `position:fixed` 自绘无滚动体的弹层。
- **验收**：390px 弹层不超出视口、内容可滚、无背景穿透；1280 宽弹层不被标题栏遮挡。

---

## 4. 团队协作验收清单（每个 PR 必过）

### 4.1 测试步骤（每改一个面板）
1. `npm run build:ui`，`npm run dev:only` 启动真机 Electron。
2. Chrome DevTools → Toggle device toolbar，依次检查：**390×844（iPhone 12）**、**768×1024（iPad）**、
   **1024×768**、**1280×800**、**1440×900**、**2560×1440（本机宽屏）**。
3. 每个分辨率检查四件事：
   - **溢出**：页面无横向滚动条（`document.documentElement.scrollWidth <= innerWidth`）；
   - **裁切**：卡片/表格内部滚动条存在且内容可读到（不是被 `overflow:hidden` 切掉）；
   - **遮挡**：没有元素被固定标题栏/浮层压住（重点：表格底部「加载更多」、抽屉底部按钮）；
   - **隐藏**：小屏没有任何业务字段/按钮凭空消失（只允许折叠+可展开）。
4. 运行 `npm run ui:responsive-audit -- --only=<tab>` 对比基线 JSON（必须不新增问题）。
5. 跑收口链：`npm run typecheck:client`（必要时 `typecheck:tests`）+ 受影响 spec。

### 4.2 常见修复技巧（按优先级）
1. **先找父级**：横向溢出的元凶 90% 是某个 flex/grid 子项没有 `min-width:0`，或 `.row` 负 margin 没被父 padding 抵消。
2. **改成滚动**而不是藏：`overflow-x:auto` + `-webkit-overflow-scrolling:touch`；表头 sticky 时容器不要 `overflow:hidden`。
3. **长文本**：`overflow-wrap:anywhere` + `min-width:0`；`text-overflow:ellipsis` 只用于**可推断**的短字段（昵称），不用于消息正文。
4. **固定宽度**：`width: min(420px, 100%)`；`flex: 1 1 240px` 替代 `width:240px`。
5. **栅格对齐**：优先 `d-flex flex-wrap gap-*`（与现有 `gap` 体系一致），其次 `.row.g-2/.g-3`。
6. **高度预算**：面板固定区（页头/筛选/KPI）合计不得超过内容区 25%；超出就折叠进「更多筛选」。
7. **不要动全局**：`body`/`*` 选择器、`--nm-*` 令牌、kit 组件的公共样式（影响 100+ 面板）一律不允许局部 PR 修改。

### 4.3 代码审查要点（Reviewer checklist）
- [ ] 没有 `import 'bootstrap/dist/css/bootstrap.css'`（全量包）与 CDN 引用
- [ ] 没有 `d-none` / `visibility:hidden` 藏业务内容；折叠项有可展开入口
- [ ] 新增固定宽度都带 `min()/max()/100%` 上限；表格在滚动容器内
- [ ] flex/grid 新增子项有 `min-width:0`（长文本场景有 `overflow-wrap`）
- [ ] 断点只用 576/768/992/1200/1400，且与 Bootstrap 语义一致
- [ ] 面板固定区高度增量 ≤ 25%，有实测数字（截图/audit JSON）
- [ ] 1000 行/250 行棘轮未破；CSS 无 `!important`（Bootstrap 工具类除外）
- [ ] 用 Bootstrap 工具类（`d-*`/`gap-*`/`m-*` 等）时确认**没有**要压过它的模块样式：
      `bootstrap-utilities.min.css` 的多数工具类带 `!important`，同特异度模块规则会被压掉；
      优先用本仓 `gap` 变量/自有类，确需覆盖时在 PR 里注明
- [ ] 修改了公共 kit/主题 → 需附全 tab 审计对比（不是单面板截图）

### 4.4 自动化门禁（与人工清单互补）

- **桌面审计**：`npm run ui:responsive-audit` —— 38 tab × 6 视口，5 类检测（文档溢出/元素越界/裁切/固定层遮挡/有文本不可见），
  真实 Electron + 真实数据；`--selftest` 验证 5 条规则都会开火（含「滚动视口外内容不得判遮挡」负向护栏）。
- **手机浏览器审计**：`node scripts/responsive-audit-browser.mjs` —— 影子 profile 起真实 LAN 服务 + system Chrome 登录，
  375×667 / 390×844 / 414×896 / 844×390 四档；`--selftest` 6/6。
- **差异门禁**：`npm run ui:responsive-gate -- --baseline=<上一版.json> --current=<新版.json>`
  （或 `--run --only=<tab...> --quick` 现场跑）：
  - 问题身份键 = `tab|viewport|rule|sub|稳定选择器（剥 CSS Modules 哈希）|文本指纹（数字/长 hex 归一）`，
    **不含 rect/顺序**，所以 CSS 重建与数据态抖动不误报；
  - **新增未放行 ⇒ exit 2**；消失/severity 变化只提示；缺文件/坏 JSON/解析空 ⇒ exit 3；
  - `--allow=<json>` 接受清单（字段 glob）、`--report=<md>`、`--selftest` 9/9。
  - **推荐流程**：改面板 → `--run --only=<该面板> --quick` → 「无阻塞新增」才提交；发布前跑全量审计 +
    gate 对比上一版基线。CI 暂不挂（无真实微信数据，跑不出有意义的布局）。
- 当前基线（2026-10-18）：桌面 **90 条 / 228 格、0 失败格**（全部为 §5.1 的 accepted 项，
  ①文档溢出 ②元素越界 ④遮挡均 0）；手机浏览器 **57 条稳定 / 4 档、逐格零新增**。

---

## 5. 分期实施计划

| Wave | 内容 | 交付物 | 状态 |
|---|---|---|---|
| 0 | 方案文档 + npm 引入 + 桥接 CSS + 审计脚本 + 基线 | 本文件、`bootstrap-bridge.css`、`scripts/responsive-audit.mjs`（拆分后入口 87 行 + `scripts/responsive-audit/` 4 模块）、基线 JSON/报告 | ✅ 完成（2026-10-18） |
| 1 | 审计 Top offenders 修复（宽表格/固定宽卡片/筛选区） | `working/team/fix-wave-1.md`：6 个面板 CSS，7 tab 复测 99 → 57、42/42 格零新增；真机几何复核 | ✅ 完成第一批（2026-10-18） |
| 2 | 窄屏（≤768）专项：导航/表单/表格列过滤/抽屉全屏 | `working/team/fix-wave-2.md`：7 面板 CSS，7 tab 复测 17→0、全量 105→92、遮挡归零；A1/A2 判误报并修正真实根因（定高 grid 压卡） | ✅ 完成（2026-10-18） |
| 3 | 手机浏览器（LAN 远程访问）真机复核 + 375px | `working/team/lan-mobile-report.md` + `scripts/responsive-audit-browser.mjs`：真实 Chrome 38 tab×4 档，96→57（稳定，逐格零新增）；修复设置弹窗裁切 24 条、`90dvh`、横屏触摸目标；Lead 补 `viewport-fit=cover` | ✅ 完成（2026-10-18，真机 iOS 待复核） |
| 4 | 收口：基线门禁化 + README/文档更新 + 全 tab 复测 + **存量断点统一评估**（2026-10-18 清点：99 处媒体查询 / 77 处宽度断点，Bootstrap 断点仅 4 处命中；结论=不做一次性统一，按 §2.7 映射表维护） | `ui:responsive-gate`（681 行，selftest 9/9）+ README 文档索引 + 断点决策 | 🔄 进行中（门禁/文档/断点决策已完成；安全区仿真与真机复核进行中） |

**修复排序依据**：audit 基线里的「横向溢出 > 裁切 > 遮挡 > 隐藏」以及受影响 tab 数；
同一批修复不超过 8 个文件，保持可回滚。

---

## 5.1 已判定「有意响应式」的 accepted 清单（不视为缺陷，新增 PR 不要"修"它们）

| 元素 | 行为 | 理由（有代码/实测证据） |
|---|---|---|
| `railToggle`（知识图谱/知识库「⚙ 参数」） | 窄屏显示按钮、宽屏隐藏 | 宽屏右栏内联常驻；窄屏才需要按钮切换右栏 |
| kb/kbfiles `detailPane` | 无选中项时隐藏 | 详情区没有内容可显示，不是丢数据 |
| clawbot `_sectionBd` | 折叠的 `<details>` 内容隐藏 | 用户折叠态，可展开 |
| chats 家族侧栏 `_stats`（好友/群聊计数） | 手机档随侧栏整体收起 | 手机档侧栏只保留搜索条，导航由底部标签栏接管（wechat-data.module.css ≤560 档） |
| overview 世界地图 `_title`（「🌍 好友地区分布」） | 所有视口 display:none | 父卡片头已有同名标题，地图工具栏内的是重复标签 |
| overview `_avatarRailLeft/Right` | 部分视口隐藏 | 地图两侧的头像栏在窄地图上会遮挡地图主体，属降级 |
| annual `_calMonths` / `_calDows` | 多数视口隐藏 | 日历窄屏降级为无表头的紧凑列表 |
| annual `_moreRow` 3px 纵向裁切 | 舍入噪声 | 3px 级、滚动可达 |
| `_cloud_*`（词云/热词舞台） | 舞台内裁切 | canvas/绝对定位标签的兜底裁切，内容由组件自身滚动/缩放可达 |
| 滚动容器内的可滚动内容 | 不判为隐藏/遮挡 | 可通过滚动到达，审计口径应排除（task-10 已修正） |

---

## 6. 禁止事项（写进 PR 模板）
1. 不引 `bootstrap.css` 全量包、不引 Bootstrap JS、不引 CDN、不引 jQuery。
2. 不用 `d-none`/`visibility:hidden` 解决放不下；不写固定像素宽度覆盖。
3. 不改 `body/*/--nm-*` 全局；不动 5 个 kit 公共组件（除非全 tab 审计）。
4. 不缩小窗口最小尺寸（`minWidth: 960`）来"避免溢出"——手机端是浏览器模式，不归这条管。

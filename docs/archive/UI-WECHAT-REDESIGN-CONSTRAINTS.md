# 全站微信主题改版：测试与门禁约束审计

> **审计对象**：Super Time（Electron + React，仓库根 `D:\super-time-wechat`）。
> **审计方式**：只读源码/配置（逐文件读断言与脚本头注；未执行构建、未执行测试、未改任何源码）。
> **审计时间**：2026-10-19。
> **配套文档**：改版方案见 `docs/UI-WECHAT-REDESIGN-PLAN.md`；密度规范见 `docs/UI-DENSITY.md`（本次不推翻）。
> **数字时效**：文中提到的"实测/基线"数字来自仓库内脚本头注与 spec 内登记值；改版色板定稿后需按 §5 重跑一次。

---

## 1. 一句话结论

现有门禁由三层锁组成：**① 离线单测按 NEON 色值/几何快照逐字断言**（8 个主题 spec 共 81 个用例，另 31 个客户端 spec 涉及主题/几何令牌）；**② 构建产物里聊天微信皮肤的精确值断言**（`check:wx-tokens`，49 项 MUST_HAVE）；**③ 真机对比度/密度/响应式基线**（本机脚本，依赖被 gitignore 的 `working/` 基线）。改版若**保留 `--nm-*` 令牌名与既有主题机制、只改取值**，`theme-tokens.spec.ts`、`theme.spec.ts` 的注册/过渡/接线类断言、`theme-geometry.spec.ts`（只改令牌值）、`dsw-alias-tokens.spec.ts`（转发结构）大部分可继续工作；但 **28 条硬约束中约 10 条必须"改取值 + 同 PR 重新登记边界"**，否则会成片转红：`theme-alpha-ladder.spec.ts`（13 例）、`theme-contrast.guard.spec.ts`（FLOOR/语义/徽标 6–8 例）、`first-impressions-tokens.spec.ts`（6 例）、`wx-skin-contrast.guard.spec.ts`（4–5 例，且 `--wx-*` 改成 `var()` 会直接抛错）、以及焦点环/聊天几何/onboarding 的接线类断言。与主题外观直接相关的 CI 步骤只有"单元测试"与"主题令牌校验（先 build:ui）"（`ci.yml:83-104`、`ci.yml:203-204`）；真机门禁不在 CI 里，属于"本地/发布前"红线。

---

## 2. 硬约束表

判定说明：**❌ 会红**（该维度改动直接违反断言）；**⚠️ 条件性**（取决于改法/是否新增令牌）；**✅ 不受影响**（该维度改动不触发该断言）。"最小对策"默认遵守一条纪律：**不改令牌名、不改机制，只改取值；需要改 spec 时只改"登记数字/快照"，不删语义判据**。

### 2.1 离线单测断言（20 条）

| # | 断言文件:行 | 断言内容（证据） | 改色 | 改圆角 | 改阴影 | 改字体 | 最小对策 |
|---|---|---|---|---|---|---|---|
| 1 | `src/client/ui-wechat/src/client/pages/wechat-data/theme-tokens.spec.ts:40-60` | 全前端 `.css` 中不得出现"未定义且无兜底"的 `var(--nm-*)`；定义侧扫描 `.css/.ts/.tsx`，且定义数必须 >50（`:47`） | ⚠️ 只改值 ✅；改名/删令牌 ❌ | ✅ | ✅ | ✅ | 保留所有 `--nm-*` 名；新增令牌必须同时写定义（`scifi-theme.css` 或 TS `setProperty`） |
| 2 | `theme.spec.ts:306-328` | 主题文件里"解析到底是颜色"的每个令牌，必须与 `@property … syntax:'<color>'` 集合**双向相等**（漏登记/误登记都红）。当前 133 条注册 = 133 条 `transition-property` | ❌ 新增任何颜色令牌即红 | ✅ | ✅（阴影值不得注册） | ✅（字体令牌必须保持非颜色，`:316`） | 新增颜色令牌必须同步加 `@property` + 写进 `transition-property`；阴影/字体绝不注册 |
| 3 | `theme.spec.ts:330-353` | 每条 `@property` 必须 `inherits:true`、`initial-value` 为字面颜色且不含 `var()`；`transition-property` 列表与注册集合逐项相等、不重复 | ⚠️ 改值 ✅，新增颜色令牌 ❌ | ✅ | ✅ | ✅ | 同 #2；改色板时把对应 `initial-value` 一起改（否则规则虽绿但首帧回退值过时） |
| 4 | `theme.spec.ts:374-405` | `var()` 引用图不得成环（`--nm-*` 之间）、不得有 `var(--x, var(--x))` 自引用 fallback | ⚠️ 新增转发链时 ❌ | ✅ | ✅ | ✅ | 新令牌要么持字面量、要么单向转发；不要双向"优先取对面" |
| 5 | `theme.spec.ts:84-106,153-198` | 过渡观感契约：时长 250–700ms、减少动效时长 >0 且更短、`cubic-bezier` ease-out；**过渡对象必须是令牌名**，禁元素级选择器、禁 `background-color/color/...` 属性名、禁 `all`、禁 `transform/opacity/background-image` | ✅（改令牌值不触发） | ✅ | ⚠️ 把阴影令牌加进过渡 ❌ | ✅ | 保留 `theme.ts:77,84,90` 常量与 CSS `.theme-transition` 规则（`scifi-theme.css:766-834`）原样；阴影继续排除在过渡外 |
| 6 | `theme.spec.ts:408-438` | 禁 View Transitions；必须先 `classList.add(THEME_TRANSITION_CLASS)` 再 `apply(mode)`；摘类定时器 = `THEME_TRANSITION_DURATION + THEME_TRANSITION_LINGER`；类名 `theme-` 前缀 | ✅ | ✅ | ✅ | ✅ | 不改 `theme.ts` 机制；只换 CSS 取值 |
| 7 | `theme.spec.ts:440-471`；`nav-migration.spec.ts:106-138,188` | 主题按钮必须在标题栏（`ui-app/index.html:41` 的 `#tb-theme`，且在 `#tb-min` 之前、不在侧栏）；`ui-entry.tsx:139-152` 必须接线并订阅；onboarding 与图谱控制栏各有一枚 | ✅（与色板无关） | ✅ | ✅ | ✅ | 改标题栏外观可以，**不许删/挪 `#tb-theme` 与接线**；别把主题按钮做成"设置里的开关" |
| 8 | `theme-alpha-ladder.spec.ts:50-108` | `--nm-cyan` 深色必须逐字 `#00f0ff`（`:75`）；17 档 alpha 必须逐字 `rgba(0, 240, 255, α)`（`:83-89`）；浅色每档必须逐字 `rgba(8, 145, 178, α)`（`:101-107`） | ❌ 约 12/13 例会红（只改值也红） | ✅ | ✅ | ✅ | 若改用微信绿，必须同 PR 重写这 17 档期望（保留"档位名↔alpha 一一对应、单调递增、浅色有覆盖"三条语义） |
| 9 | `theme-alpha-ladder.spec.ts:110-149` | `--nm-text-4` 精确 `#4a5575`/`#94a3b8`（`:112-115`）；text-1..4 必须严格变暗（`:127-143`）；`--nm-brand` 精确 `#00f0ff`/`#0369a1`（`:146-149`） | ❌ | ✅ | ✅ | ⚠️ 仅当改 `--nm-text-*` 值 | 改中性色/品牌色时同步更新这两组快照；保留"四档严格递减"与"浅色压暗"语义 |
| 10 | `theme-alpha-ladder.spec.ts:152-222` | purple 阶梯精确 `rgba(168,85,247,α)`（`:163-169`）、浅色精确 `rgba(124,58,237,α)`（`:181-187`）；`--nm-panel-solid`/`--nm-veil-55`/`--nm-hover-neutral`（`:190-200`）、`--nm-scrim-50`/`--nm-sky`/`--nm-amber-45`（`:203-212`）精确深浅值；面/罩浅色必须"翻面"为白色系（`:214-222`） | ❌ | ✅ | ✅ | ✅ | 同上：改这 6 个面/罩/天空/琥珀令牌时必须同 PR 更新快照 |
| 11 | `theme-contrast.guard.spec.ts:56-65,300-321` | 深/浅 18 对 `text×bg` 对比度**棘轮**（不得低于登记 FLOOR）；浅色端每对必须 ≥4.5 AA | ❌（任何文字/底色改写基本都会破） | ✅ | ✅ | ✅ | 见 §3.1 预测；改色板后逐对重算：**只许降登记到实测值且只减不增**，浅色 AA 不建议放宽 |
| 12 | `theme-contrast.guard.spec.ts:342-404` | 语义色两套主题都过 AA：`--nm-danger-text`/`--nm-warning-text`（`color-mix` 70% + text-1，`:383-388`）、`--nm-on-accent` on `--nm-cyan`（`:347`）；反例自证必须仍咬住 | ❌（on-accent/cyan 尤其危险） | ✅ | ✅ | ✅ | 预测"微信绿 + 白字"= 2.38，见 §3.1；要么按钮文字改用满足 AA 的深绿，要么像 `--wx-*` 一样登记"保真例外"（需产品签字） |
| 13 | `theme-contrast.guard.spec.ts:418-459` | hover/选中状态：正文 text-1/2 仍 ≥4.5；text-3 按 HOVER_FLOOR 不劣化；状态层必须仍是半透明（`:364-367`） | ❌ | ✅ | ✅ | ✅ | 状态层 alpha 可保留；数值随新底色重算并重登记 |
| 14 | `theme-contrast.guard.spec.ts:478-541` | 5 组语义徽标（自色淡底+自色文字、实心底+白字）AA，含登记下限 `dark:danger on danger 15%`=4.45（`:506-508`） | ❌ | ✅ | ✅ | ✅ | 先按新 danger/warning 重算；不达标则改底色 alpha 或登记棘轮（同 #12 的取舍） |
| 15 | `wx-skin-contrast.guard.spec.ts:76-242` | `--wx-*` 必须是**十六进制字面量**（`:78` 正则只认 `#`）；6 个必需变量（`:107`）；深=首次声明、浅=最后声明；浅色除例外均 ≥4.5；FLOOR=自方气泡 2.6、未读徽标 3.3；**登记例外必须仍是例外**（≥4.5 反而要求删条目，`:232-242`） | ❌（改聊天皮肤必红） | ✅ | ✅ | ✅ | 第一步保留字面量；把 `--wx-chat-bg` 改成 `var(--nm-*)` 会让 `themesOf()` 抛错（`:141-146`）。若要统一，必须同 PR 扩展守卫支持 `var()` 并重登记 FLOOR |
| 16 | `theme-geometry.spec.ts:38-84,127-213` | 圆角字面量白名单（令牌/0/50%/999px/9 个复合角白名单），`--nm-r-*`/`--nm-dense-r`/`--wx-*` 单值合法；3 个文件 per-file per-value 基线（`:128-132`）只许减、清零必须删条目、基线文件必须存在；非法总数 ≤18、`999px` ≤3、`50%` ≤66；奇数间距（5/7/9/18px）基线 ≤5；哨兵：文件 ≥61、圆角声明 ≥500、间距声明 ≥1200（`:144-155`） | ✅ | ❌ 新增字面量/删基线文件 | ✅ | ✅ | 圆角全走令牌（含新微信令牌名，须以 `--wx-*`/`--nm-r-*`/`--nm-dense-r` 命名，否则被判非法）；确实要改字面量则同 PR 改基线数字 |
| 17 | `dsw-alias-tokens.spec.ts:90-209,227-254` | dsw 颜色必须转发 `--nm-*`（`BARE_ALLOW` 之外不能有字面量）；`EXPECTED_FORWARD` 逐条固定（测试标题写"25 个"，实际映射表为 33 条；`BARE_ALLOW` 16 条）；浅色不得重复定义 dsw；例外清单不许过期；桥接层不得反向依赖；哨兵 `--nm-cyan-8` 必须逐字 `rgba(0, 240, 255, 0.08)`（`:167`） | ❌（青改绿即哨兵红；新增字面量即红） | ✅ | ✅ | ✅ | 保留转发表；只改哨兵期望值与 `BARE_ALLOW` 中的字面色（若确需改）。新增 dsw 颜色令牌仍应转发，不要写死 |
| 18 | `first-impressions-tokens.spec.ts:49-66,108-166` | 6 个首见表面（titlebar/onboarding×3/privacy/license）真裸色总数必须**严格等于**基线 2/1/4/0/0/1（`:135-143`），非豁免裸色必须为 0；断点只许 1100/900/720（+卡片级 520/440/420/560，`:147-166`） | ❌（增删裸色都红） | ⚠️ 若用字面量圆角/色值 | ⚠️ 若新增裸阴影色 | ⚠️ 若新增裸色 | 新样式一律走令牌；确需增删裸色（如去掉 Windows 关闭键平台红）时必须同 PR 同步 `BARE_BASELINE`；新断点必须先登记 |
| 19 | `brand-consistency.spec.ts:32-38,61-97` | 全仓文本文件不得出现旧品牌名（`LEGACY` 常量，`:38`）；"微信"作为数据源必须保留（`wechat-paths.js`、`WechatDataPanel.tsx`）；窗口/页面标题、导航品牌位、后端错误文案固定为 `Super Time` | ✅（色板无关） | ✅ | ✅ | ✅（字体无关） | 改版不得改品牌名；**新写的文档/注释也不能含旧品牌名**（本文件即受此约束） |
| 20 | `ui/kit-css-split.wiring.spec.ts:75-86`；`panels/button-disabled-tone.wiring.spec.ts:174-175` | 焦点环声明块必须逐字相同：`outline: none; box-shadow: 0 0 0 2px var(--nm-bg-card), 0 0 0 4px var(--nm-border-active);`（两处文件）；全局 `button:focus-visible` 必须含 `outline: 2px solid var(--nm-cyan)` | ❌（换 semantic 色/阴影即红） | ✅ | ❌（焦点环就是 box-shadow） | ✅ | 若改版要"微信绿焦点环/去发光"，必须同 PR 同时改：kit 两处 CSS、`scifi-theme.css:234-243` 全局规则、两个 spec 的逐字声明 |

### 2.2 脚本门禁（8 条）

| # | 脚本:行 | 门禁口径/阈值 | 前置 | 改版触发面 | 最小对策 |
|---|---|---|---|---|---|
| 21 | `scripts/check-wx-tokens.js:34-141` | 扫 `src/client/ui-dist/assets/*.css` 全部产物：**49 项 `MUST_HAVE`**（`--wx-*` 精确值、圆角 4px、头像 40px、行距 16px、卡片定宽、`padding:6px 12px`、`line-height:1.6`、`rotate(45deg)` 等）+ **9 项 `MUST_NOT_HAVE`**（自造渐变、旧收角/描边/三角/最大宽）；`chats*.module.css` 不得回退到 `font-size: 14.5px`（`:160-181`） | `npm run build:ui` 先产出 `ui-dist`（`:35-46` 缺目录 exit 2） | ❌ 聊天微信皮肤改色/改几何即红 | 与聊天皮肤改动同 PR 更新 `MUST_HAVE` 常量；改色后必须重新 build 再校验 |
| 22 | `scripts/theme-live-audit.mjs:45-63,87,353-445,447-629` | 真实 Electron + 真实解密数据；默认 16 个显式页签，`--all-tabs` 覆盖 `nav-config` 全部隐藏页签；深/浅各 reload 一遍读 computed style；**背景未随主题变化 → exit 3**；`--stress` 门槛 3000ms、未登记慢面板 → exit 4；落盘 `.tmp-e2e/theme-contrast.json`、`interactive-timings.json` | `node_modules/electron/dist/electron.exe`（`:91`）、真实数据根（`:101`）、不能有其他 Electron 抢实例（`ui-verify.mjs:95-100`） | 改色后对比度/采样底变化；改布局后逐页取样变慢/取样点变化 | 改版必须至少跑一次 `theme:live-audit -- --all-tabs` 与 `ui:theme-budget`；慢面板名单只在真机数据下才有意义 |
| 23 | `scripts/theme-contrast-budget.mjs:39-104` + `scripts/theme-contrast-budget.json` | 读上一步 JSON：逐面板 × 深/浅，正文类最低对比度 ≥ AA 4.5；例外 `聊天会话|dark`/`聊天会话|light`=3.3（棘轮）；例外已达标或面板消失/改名也算失败（`:75-98`） | 先跑 #22 产出 JSON | ❌ 聊天皮肤/面板底色改动会改数值；改版删/改名面板会让例外过期 | 重跑测量 → 按实测更新 `exceptions`（只许收紧/删除，不许放宽）；保留 3.3 仅作"官方未读红保真"的既有取舍 |
| 24 | `scripts/interactive-budget.mjs:26-88` + `scripts/interactive-budget.json` | `defaultMs`=1200；`knownSlow` 2 个面板=61000；未登记面板、超时未出、超预算均失败；预算/测量里单边存在也失败（`:63-76`） | 先跑 `theme:live-audit -- --stress` | 改动若引入大面积阴影/模糊/动画/重排 → 真机点击→正文变慢 | 改版保留"去装饰"方向（与降低耗时同向）；发布前跑一轮，慢面板改名要同步 JSON |
| 25 | `scripts/ui-verify.mjs:65-92` | 串行五项：theme-live → theme-budget → stress → interactive-budget → panel-audit；退出码取第一个失败；运行前后统计 electron 进程防泄漏（`:94-150`）；不判像素级视觉 | 同 #22 + `panel-audit` 需要真实数据（`scripts/panel-audit.mjs:14` 写明无数据时跳过且退出 0） | 所有视觉改动的总闸 | 作为改版验收入口，放最后跑；不要把它当 CI 替代（CI 不跑它） |
| 26 | `scripts/ui-density-audit.mjs:67-93` + `scripts/ui-density-gate.mjs:24-61` | 真机量 `headerH`（1440 档 ≤44 / 1280 档 ≤48）、`toolbarH`、`statH`≤52、`cardHdH`≤36、`fixedRatio`≤20%/28%、`emptyRatio`≤35%/40%、`tableRowH` 28–34；gate 以基线 JSON 比较：新增超目标或恶化超阈值（固定区 +2pp、行高类 +4px、表格行 +2px、空白率 +5pp）→ exit 2 | 真实 Electron + 真实数据；基线 JSON（`working/team/density/*.json`，但 `working/` 被 `.gitignore:36` 忽略 ⇒ 新克隆需先产出基线） | 字体/间距/页头高度/卡片密度的变化 ❌；纯颜色/阴影（不影响测量高度）✅ | 改版原则上保持 `docs/UI-DENSITY.md` 目标；若确要加大圆角/页头，先跑 `density-audit --quick` 再逐个对比 gate |
| 27 | `scripts/responsive-audit.mjs:1-43` + `scripts/ui-responsive-gate.mjs:24-51` | 真机 38 页签 × 6 视口五类缺陷（文档横向溢出/元素越界/裁切/遮挡/有文本不可见）；gate 按稳定身份键比较：**新增问题未命中 allowlist → exit 2**；消失只提示；`scripts/responsive-accepted.json` 为已接受清单 | 真实 Electron + 真实数据；基线 JSON（`working/team/responsive/`，同样 gitignored）；`--quick` 只跑 390/1280/2560 三档 | 大圆角/新字体/新间距可能引入裁切/溢出/遮挡 ❌；纯颜色/阴影 ✅ | 改版涉及布局时跑 `--quick --no-shots` 对比基线；新增可接受项才登记 allowlist（不许整类豁免） |
| 28 | `scripts/mutation-check.mjs:39-125` + `scripts/mutations-*.mjs` | 277 条变异登记（`id: 'M…` 计数）：逐条注入 → 目标 spec 必须变红 → 逐字节还原；`--diff` 按"目标文件或它的判据 spec 改动"选取（`scripts/mutation-scope.mjs:13-30`）；**登记表被改 → 全量**（CI 单独 job，`ci.yml:281-315`） | 无 Electron；逐条起 vitest（约 4 秒/条，`ci.yml:283-284`）；全量 25–30 分钟（CI 口径） | 与主题/外观相关的登记：`M7`（`scifi-theme.css` 的 `.nm-skel` 加回 `display:block`，`scripts/mutations-registry.mjs:155-161`）、`M676`（骨架扫光回潮，`mutations-registry.batch3zd.mjs:451-458`）、`M622/M623`（标题栏主题按钮消失/顺序错，同文件 `:19-34`）、`M679–M685`（onboarding 铺满/盖标题栏/浮现/循环动画/同意屏字号/两栏，同文件 `:475-532`） | 改到这些 CSS 区域时先跑 `node scripts/mutation-check.mjs --only M7`（或对应 id）确认锚点仍唯一、注入仍咬得住；**不要轻易改 `scripts/mutations-registry*.mjs`**（一改触发全量 job） |

---

## 3. 会失败的测试与最小修复策略

### 3.1 先看预测：`docs/UI-WECHAT-REDESIGN-PLAN.md §1.1` 的色板会撞多少红灯

按下表计划值（浅色 `bg0 #EDEDED / bg1 #F7F7F7 / bg2 #FFFFFF`，文字 `#191919/#7F7F7F/#B2B2B2`；深色 `#111111/#191919/#2C2C2C`，文字 `#D8D8D8/#9F9F9F/#6B6B6B`）用 WCAG 2.x 公式**静态重算**现有 FLOOR（`theme-contrast.guard.spec.ts:56-65`）：

| 组合 | 计划值对比度 | 现登记下限 | 结果 |
|---|---|---|---|
| dark text-1 × bg-0 | 13.25 | 16.02 | ❌ |
| dark text-1 × bg-1 | 12.34 | 15.19 | ❌ |
| dark text-1 × bg-2 | 9.80 | 14.48 | ❌ |
| dark text-2 × bg-0/1/2 | 7.13 / 6.64 / 5.28 | 7.70 / 7.30 / 6.96 | ❌ |
| dark text-3 × bg-0/1/2 | 3.54 / 3.30 / 2.62 | 4.15 / 3.93 / 3.75 | ❌ |
| light text-1 × bg-0 | 15.02 | 16.78 | ❌ |
| light text-1 × bg-2 | 17.58 | 17.85 | ❌ |
| light text-2 × bg-0/1/2 | 3.42 / 3.74 / 4.00 | 7.12 / 6.69 / 7.58 | ❌（且破 AA 4.5） |
| light text-3 × bg-0/1/2 | 1.81 / 1.98 / 2.12 | 5.10 / 4.79 / 5.43 | ❌（且破 AA） |

另外两处关键语义色：**白字 on 微信绿 `#07C160` = 2.38**（现守卫要求 `on-accent/cyan` 两套主题都 ≥4.5，`theme-contrast.guard.spec.ts:342-404`）；**红/橙语义基色 on 白底**：`#FA5151`=3.30、`#FA9D3B`=2.11（徽标/文字会连带失败，见 `:478-541`）。

**结论**：方案里的"文字三级灰"和"主按钮白字压绿"是**按微信官方观感选的，不是按现有 WCAG 棘轮选的**。若不调整，`theme-contrast.guard.spec.ts` 约 6–8 个用例会红，且这是"守卫正确、色板越界"。最小修复只有三条路（需产品拍板）：
1. **保真例外**：把"白字压官方绿 2.38"像 `--wx-*` 的自方气泡 2.60 一样登记为保真例外（只许不变差）；浅色 `#7F7F7F`/`#B2B2B2` 不能走例外（它们是正文/辅助文字，会成为大面积低对比）。
2. **调色**：浅色辅助色压深到 ≥4.5（例如 `#7F7F7F` → 约 `#6B6B6B` 或更深），深色正文/辅助按 FLOOR 重新取更亮的灰。
3. **重登记 FLOOR**：仅当产品明确接受"正文对比度整体下调"时逐对改数字——**只许下降登记到实测值，不许把 4.5 的浅色 AA 整条删掉**。

### 3.2 改值即红（离线，优先处理）

- `theme-alpha-ladder.spec.ts`：13 例中约 12 例含精确值/解析式断言（`--nm-cyan`、17 档 cyan alpha、浅色 `rgba(8,145,178,·)`、`--nm-text-4`、`--nm-brand`、6 档 purple、6 个面/罩/天空/琥珀令牌）。**最小改法**：保留"档位名 ↔ alpha 一一对应、严格单调、浅色每档有覆盖且色相压暗、四档文字严格递减、面/罩浅色翻面"这些**语义**断言，把期望值从硬编码改为"从 `scifi-theme.css` 读取后验关系 + 单独登记一组新的基准值"。
- `theme-contrast.guard.spec.ts`：见 §3.1。改法顺序：先定色板 → 本地用同公式重算 → 改 `FLOOR`/`HOVER_FLOOR`/`BADGE_FLOOR` 数字 → 跑三条反例自证用例（`:388-404`、`:543-551`）确认判据没被架空。
- `dsw-alias-tokens.spec.ts`：若主色从青改绿，`:167` 哨兵与 `BARE_ALLOW`（`:90-113`）需要同步；`EXPECTED_FORWARD`（`:127-162`）**不要动**（它保的是语义对口，不是色值）。改 `--dsw-alias-button-primary-fill`（`#00c2d4`）时它已在例外清单里，值不校验。
- `first-impressions-tokens.spec.ts`：`:135-143` 是**严格相等**——去掉 Windows 关闭键平台红、去掉 onboarding 纯黑阴影都会红。最小改法：CSS 里先全部换令牌，再跑 `npx vitest run …first-impressions-tokens.spec.ts`，把实测裸色数写回 `BARE_BASELINE`（同 PR）；豁免 `EXEMPT`（`:62-65`）只放平台色/纯黑。
- `theme-geometry.spec.ts`：改版最容易踩的是"新增 8px/12px 字面量圆角"和"新增 CSS 文件里的新字面量"（新文件零容忍，`:174-186`）。最小改法：圆角一律 `var(--nm-r-*)` / `var(--wx-*)`；若微信令牌需要新名字，用 `--wx-*` 前缀（`:56` 的正则允许）或 `--nm-r-*`；确实收敛/新增了字面量，同 PR 改 `RADIUS_BASELINE` / `ODD_SPACING_BASELINE`，清零条目必须删。
- `wx-skin-contrast.guard.spec.ts`：聊天区改色必红。**第一阶段不要动 `chats-rows.module.css` 的 `--wx-*` 字面量**（`:76-88` 只认 `#`）；若必须改，同 PR 改 FLOOR 两条（2.6、3.3）；若某条达到 4.5，按 `:232-242` 必须删掉 FLOOR 条目。
- 其它面板级精确快照（都会被同一次改版波及）：`summary-density.wiring.spec.ts:35`（`--nm-dense-fs: 12px`、`--nm-dense-fs-sm: 11px` 逐字）、`button-family-a-chip-token.wiring.spec.ts:141-142`（同上两值）、`:104-115`（14 个 chip 的 `border-radius: var(--nm-r-pill)`）、`button-family-e-align.wiring.spec.ts:107`（`--nm-r-pill`）、`calls-layout.wiring.spec.ts:60-64`（`border-radius: var(--nm-r-xs)`）、`clawbot-layout.spec.ts:262-269`（轨必须 `--nm-r-lg` + `--nm-shadow-card`）。

### 3.3 机制/接线类（改结构才红，改值不红）

- `theme.spec.ts` 注册双向表（`:306-328`）：如果改版**新增**颜色令牌（例如 `--nm-brand-hover`、微信中性阶），必须同时加 `@property` 与 `transition-property`；否则红。阴影/字体令牌**绝不能**注册为 `<color>`（历史真事故：`--dsw-font-family` 曾被误判，见 `:22`、`:316-317`）。
- `light-theme.css` 与深色的覆盖关系：`theme.spec.ts:355-361` 只要求"浅色令牌 ⊆ 深色令牌"；新增深色专属颜色令牌不会被这条咬住，但它的 `initial-value` 会是深色值（`@property` 的 initial-value 取深色），浅色下若没有覆盖会退化成深色——建议成对新增。
- 焦点环：`kit-css-split.wiring.spec.ts:77` 的声明块、`button-disabled-tone.wiring.spec.ts:174-175` 的全局规则、`scifi-theme.css:234-243` 三处必须一起改；这是"去发光/换绿"最容易被忽略的一组。
- `light-theme-coverage.wiring.spec.ts`：**`overview-neon.module.css` 不能删**（`:33` 在模块加载时读文件，删了直接 ENOENT）；其浅色块必须保留 ≥8 条带 `:root[class~='theme-light']` 前缀的规则（`:278-299`）、10 个承载底/框的类必须有浅色覆盖（`:66-77`）、浅色块里不能出现亮度 <0.7 的实色（`:343-352`）、渐变文字必须重声明 `background-clip:text`（`:368-382`）、深色伪元素的浅色覆盖必须存在（`:384-397`）。
- `onboarding-css-split.wiring.spec.ts`：三份 CSS 的**文件名/分工固定**（`:31`）、每份 ≤1000 行（`:95-101`）、同名类不许跨份、消费者 ≥5、`theme-light` 规则 >10（`:118-121`）、舞台铺满 `#root` 且内容区固定 1180px 居中（`:124-147`）、`runtime.ts` 的 `STAGE_W=1180/STAGE_H=760` 与 CSS 一致（`:145-148`）、内容页不许有 `@media` 断点（`:169-172`）、Reveal 的 `--rise-i`/45ms 与 reduced-motion 契约（`:175-198`）。若微信改版要把启动页改成响应式/更简洁，这组断言必须**先设计好新形态再改**，不能只删断言。
- `overview-layout.spec.ts:42-151` + `layout-tokens.spec.ts:48-99`：Bootstrap 栅格类名/行数、`NeonHero` 不许回潮、JSX 里每个 `css.x` 必须在 overview CSS 里有定义、`layout-tokens` 派生字符串与"两档基准必须不同"都是逐字断言；纯换色/换圆角/换阴影不触发，**重排布局会红**。
- `chats-wx-geometry.wiring.spec.ts:46-124`：聊天消息区"扁平"形态（无四周边框/无 `--nm-r-lg` 圆角/无 `backdrop-filter: blur`、左边一条发丝线、`background: var(--wx-chat-bg)`）、气泡尖角必须 `clip-path` 三角形且该节不许 `rotate(45deg)`/`border-radius: 2px`、头像必须 40px 且 `chats-msg-row.tsx` 里 `size={40}`、`--wx-chat-bg` 深 `#191919`/浅 `#ededed` 各只出现一次。微信改版若要"更圆/更卡片化"，这组会红，且它和 `check-wx-tokens` 的 `rotate(45deg)` 期望互相牵制（尖角在别的卡片元素上仍用旋转方块）。
- `brand-consistency.spec.ts`：改版新写的所有 `.md/.ts/.tsx/.css` 都在扫描面内（`SKIP_FILES` 只排除 `docs/RELEASE-PLAN.md` 与 spec 自身，`:32-38`）。**新文档不能出现旧品牌名**；`微信` 单独出现是数据源，不受限；`WechatDataPanel.tsx` 的 `微信数据`、`navBrandName` 的 `Super Time` 不许动。

### 3.4 脚本/真机类

- `check:wx-tokens`：CI 在 `build:ui` 之后跑（`ci.yml:105-106,203-204`）。只改 `--nm-*` 不影响它；**改 `--wx-*`/聊天卡片几何就必须同 PR 改 49 项 `MUST_HAVE` + 9 项 `MUST_NOT_HAVE`**（`scripts/check-wx-tokens.js:58-141`），否则 CI 直接红。
- `theme:live-audit` + `ui:theme-budget`：真机测量，改色/改布局后必须重跑；`themeChanged` 为 false 或 `exceptions` 过期都会失败（`scripts/theme-contrast-budget.mjs:60-98`）。
- `ui:interactive-budget`：改版如果去掉大面积发光/模糊，耗时会下降（与门禁同向）；如果加入动画/阴影，可能触发 1200ms 预算（`scripts/interactive-budget.json`）。
- `ui:density-audit`/`ui:density-gate` 与 `ui:responsive-audit`/`ui:responsive-gate`：**不在 CI**（`.github/workflows/ci.yml` 无这四个 npm script），是本地/发布前门禁；基线在 `working/`（`.gitignore:36`），新克隆没有基线，需先产出再比。

### 3.5 变异自证锚点

`check:mutation:diff` 会按改动文件选变异（`scripts/mutation-check.mjs:54-125`）：改 `scifi-theme.css` 会命中 `M7`（`.nm-skel` 显示、`:155-161`）与 `M676`（骨架扫光，`batch3zd:451-458`）；改 onboarding CSS 会命中 `M679–M685`；改 `src/client/ui-app/index.html` 会命中 `M622/M623`（主题按钮）。**这些变异的 `from` 是逐字锚点，一旦改版把锚点文本改掉（哪怕只是相邻行），`mutation-check` 会报"锚点失效"而失败，不是"守卫没咬住"。** 处理纪律：改这些区域后先 `node scripts/mutation-check.mjs --only M7`（按命中 id 逐个）自证；确需改锚点才改登记表，并且知道一改登记表 CI 会起全量 job（`ci.yml:281-315`，70 分钟）。

### 3.6 建议的最小改动顺序（把红海拆成批）

1. **只改值、不改名**：先落 `--nm-*` 的新色板/新圆角/新阴影/新字体（`scifi-theme.css`、`light-theme.css` 值层面）。这一批会让 `theme-tokens`/`theme.spec` 注册类/`theme-geometry`（值层面）继续绿。
2. **同 PR 重登记快照**：`theme-alpha-ladder`（3 个 describe 的期望值）、`dsw` 哨兵、`summary-density`/`button-family-a` 的精确字号、`theme-contrast` 的 FLOOR（按 §3.1 结论走产品取舍）。把"语义判据"保留、只换数字。
3. **改机制/结构前先改守卫**：焦点环、`overview-neon`、onboarding、聊天扁平区、`--wx-*` 统一，这些要先在设计上定稿，再同 PR 改 spec 与 CSS；不要先删 spec。
4. **最后动聊天皮肤与脚本常量**：`--wx-*` + `check-wx-tokens` 的 49 项 + `wx-skin-contrast.guard` 一起改；这一步最容易漏一处（值在 CSS、期望在脚本、守卫在 spec，共三处）。
5. **真机复核**：§5 顺序执行。

---

## 4. 微信官方皮肤令牌（`--wx-*`）现状与可复用性

### 4.1 清单与位置（全仓 50 个不同名，来源：逐文件 grep `--wx-[a-z0-9-]+`）

| 位置 | 声明数 | 内容 |
|---|---|---|
| `panels/chats-rows.module.css` | 55 | 权威的聊天令牌：`.panel`（`:6`）挂几何（`--wx-avatar: 40px`/`--wx-avatar-radius: 6px`/`--wx-unread: #fa5151`，`:25-28`）；`.messages`（`:~70-162`）挂深色端聊天色板（`:122-161`）；`:global(.theme-light) .messages`（`:210-230`）挂浅色端覆盖 |
| `panels/chats-cards.module.css` | 18 | 卡片/群信息/搜索/右键菜单：`--wx-search-bg`/`--wx-search-ph`（`:177-178`、`:711-712`）、`--wx-info-title/text/meta/avatar`（`:703-707`）、`--wx-ctx-*` 深浅两份（`:874-885`） |
| `panels/chats-contact-info.module.css` | 1 | `--wx-info-avatar: 48px`（`:5`） |
| `panels/chats.module.css` | 11 | 各卡片规则里的 `--wx-card-pad: 12px`（如 `:333`，另 `:910` 为 10px） |
| 使用处但**无声明** | — | `chats-new-msg.module.css:29,32` 用 `var(--wx-border, …)`、`var(--wx-text, …)`（只有兜底，不是令牌） |

### 4.2 权威值（`chats-rows.module.css`，深/浅；`check-wx-tokens.js:58-122` 按这些值做产物校验）

| 令牌 | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `--wx-chat-bg` | `#191919`（:123） | `#ededed`（:211） | 会话底/消息区底 |
| `--wx-bubble-self` | `#3eb575`（:132） | `#95ec69`（:212） | 自方气泡 |
| `--wx-bubble-other` | `#2e2e2e`（:133） | `#ffffff`（:213） | 对方气泡 |
| `--wx-on-self` / `--wx-on-other` | `#ffffff` / `#f5f5f5`（:134-135） | `#000000` / `#1f2937`（:214-215） | 气泡文字 |
| `--wx-unread` | `#fa5151`（:28，两套同值） | 同左 | 未读徽标红 |
| `--wx-radius` / `--wx-avatar` / `--wx-avatar-radius` / `--wx-gap` / `--wx-row-gap` | `4px` / `40px` / `6px` / `10px` / `16px`（:124-126、:25-26） | 同左（几何不随主题变） | 气泡圆角/头像/间距 |
| `--wx-read-maxw` / `--wx-bubble-maxw` | `640px` / `min(640px, calc(100% - 40px - 10px))`（:122,127） | 同左 | 阅读宽度上界 |
| 链接/提及 | `--wx-link: #6f9bea`、`--wx-mention: #7d90b8`（:147-148） | `#245fbd` / `#576b95`（:227-228） | 聊天气泡内链接 |
| 卡片 | `--wx-card-bg: #2e2e2e` 等（:141-146） | `#ffffff` 等（:221-226） | 文件/链接/小程序卡 |
| 转账/红包/直播角标 | `#f79c46`/`#fa9d3b`/`rgba(250,81,81,.92)`（:154-161） | 同左 | 官方扁平色卡 |

### 4.3 能否复用到全局？

**结论：值可以借，令牌体系不建议一次性合并。**
- 这 50 个令牌的**作用域是组件类**（`.panel`/`.messages` 等），不是 `:root`；其他面板不在这些 DOM 子树里，直接用取不到值。
- `wx-skin-contrast.guard.spec.ts:76-88` 只从 `chats-rows.module.css` 抽**十六进制字面量**；把 `--wx-chat-bg` 改成 `var(--nm-bg-0)` 会让 `themesOf()` 抛错（`:141-146`），`check-wx-tokens` 的 49 项也会立刻缺项。⇒ 想"统一"必须同 PR 同时改：CSS 声明、`check-wx-tokens` 常量、`wx-skin-contrast.guard` 解析器。
- 可复用的**值是中性色板**：`#EDEDED/#FFFFFF`（底）、`#191919/#7F7F7F/#B2B2B2`（文字）、`#07C160`（微信主绿，注意并**不在**现有 `--wx-*` 里）、`#FA5151`（危险/未读）、`#576B95`（链接/次强调）。把它们写进 `--nm-bg-*`/`--nm-text-*`/`--nm-brand`/`--nm-danger`/`--nm-sky` 的**取值**即可获得全局观感，而无需新增令牌（新增颜色令牌会触发 §2.1 #2 的注册双向表）。
- 建议分三步：① 先换全局 `--nm-*` 取值（本文件主要风险面都在这一步暴露）；② 聊天区保留 `--wx-*` 字面量与既有守卫不动，最多按新全局色板微调 `--wx-bubble-*`（并重登记两条 FLOOR）；③ 若后续确实要"一套令牌"，再单独开任务改守卫+脚本，不塞进视觉改版首刀。

---

## 5. 验证命令清单与顺序（从快到慢、按风险排序）

> 通用前置：Windows x64；`node_modules` 已安装；真机脚本还需 `node_modules/electron/dist/electron.exe`（缺则 exit 2，`theme-live-audit.mjs:91`）与真实解密数据根（默认 `%APPDATA%/super-time-electron/wechat-data`，`theme-live-audit.mjs:101`）；同一时间只允许一个应用实例（`ui-verify.mjs:95-100` 会数 electron 进程）。带"*"的耗时是按脚本参数与注释的**估算**，首次跑请以实测为准。

| 步 | 命令 | 性质/前置 | 预计耗时 | 覆盖 |
|---|---|---|---|---|
| 0 | `npx vitest run src/client/ui-wechat/src/client/pages/wechat-data/theme.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/theme-tokens.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/theme-contrast.guard.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/wx-skin-contrast.guard.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/theme-alpha-ladder.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/theme-geometry.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/dsw-alias-tokens.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/first-impressions-tokens.spec.ts` | 离线，纯 node（81 用例） | 秒级–30 秒 | 令牌/对比度/几何/皮肤/首见表面 |
| 1 | `npx vitest run src/client/ui-app/brand-consistency.spec.ts src/client/ui-app/onboarding/onboarding-css-split.wiring.spec.ts src/client/ui-app/privacy/consent.spec.ts src/client/ui-app/license/license-layout.wiring.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-css-split.wiring.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/panels/light-theme-coverage.wiring.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-layout.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/panels/layout-tokens.spec.ts src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-wx-geometry.wiring.spec.ts` | 离线 | 秒级–1 分钟 | 品牌/引导/首见/kit/浅色覆盖/总览/聊天几何 |
| 2 | `npm test` | 离线；全量单测 | 本机约 2–5 分钟（CI 实测 26 分钟/共享 runner，`ci.yml:19-23`） | 全仓回归（CI 同款口径 `ci.yml:83-104`） |
| 3 | `npm run typecheck` | 离线；5 个 tsc 工程 | 约 1–3 分钟* | 新令牌/类型接线 |
| 4 | `npm run build:ui && npm run check:wx-tokens` | 离线；先构建 `ui-dist`（`check-wx-tokens.js:35-46`） | 构建约 20–60 秒* + 校验毫秒级 | 构建产物里 49 项微信皮肤值（CI 同款 `ci.yml:203-204`） |
| 5 | `npm run check:mutation:diff` | 离线；按改动文件增量选变异（`mutation-check.mjs:54-125`） | 命中 N 条约 4 秒/条（`ci.yml:283-284`），通常 1–15 分钟；若改了登记表 → 全量 25–30+ 分钟 | 守卫反证（主题相关：M7/M676/M622/M623/M679–M685） |
| 6 | `npm run theme:live-audit -- --all-tabs` → `npm run ui:theme-budget` | **真机**（Electron+真实数据）；默认 16 个 `WANT` 页签，`--all-tabs` 再加 `nav-config` 里 20 个隐藏页签；每条 × 深/浅 × 每页 ~10.5 秒（`theme-live-audit.mjs:447-474`：reload 1.5s + 4s + 5s） | 约 12–20 分钟* + 预算秒级 | 真机主题覆盖率与逐面板对比度（`theme-contrast-budget.mjs`） |
| 7 | `npm run theme:live-audit -- --stress` → `npm run ui:interactive-budget` | 真机；16 页签连点+回访 | 约 1–3 分钟* + 预算秒级 | 连点后点击→正文耗时（3000ms 门槛 + 1200ms 预算） |
| 8 | `npm run ui:density-audit -- --quick` → `npm run ui:density-gate -- --baseline=working/team/density/density-d2.json --current=working/team/density/<新文件>.json` | 真机；全量约 3 分钟（脚本头注 `ui-density-audit.mjs:8`），quick 2 视口同量级 | 约 2–3 分钟* + gate 秒级 | 页头/工具条/统计区/表格行高/空白率（§2.2 #26） |
| 9 | `npm run ui:responsive-audit -- --quick --no-shots` → `npm run ui:responsive-gate -- --baseline=working/team/responsive/density1-full.json --current=working/team/responsive/<新文件>.json --quick` | 真机；quick 3 视口 × 38 页签 | 约 4–8 分钟* + gate 秒级 | 溢出/越界/裁切/遮挡/隐藏（§2.2 #27） |
| 10 | `npm run ui:verify` | **真机串行五项**（theme-live → theme-budget → stress → interactive-budget → panel-audit，`ui-verify.mjs:65-92`） | 约 15–30 分钟* | 最终验收；退出码取第一个失败项，并检查 electron 泄漏 |

**执行纪律**
- 0–1 步是最便宜的"红海探测"：先跑它们，再决定是否进真机；不要一上来跑 `ui:verify`。
- 第 4 步是 CI 红线（`check:wx-tokens` 只在 build 之后才有意义），改聊天皮肤却不改脚本常量，CI 必红。
- 第 6–10 步依赖 `working/` 与 `.tmp-e2e/`（均被 `.gitignore` 的 `.tmp-*`/`working/` 覆盖，`.gitignore:36`）：新克隆上要么先产出基线，要么显式指定仓库内已存在的基线 JSON。当前仓库里可用的基线示例：`working/team/density/density-d2.json`、`working/team/density/density-final2.json`、`working/team/responsive/density1-full.json`。
- 改到变异锚点区域时，先 `node scripts/mutation-check.mjs --only M7` / `--only M676` / `--only M679` 等单条自证，再跑第 5 步。
- 不改像素判断：`ui:verify` 明确"不判像素级视觉"（`ui-verify.mjs:145`），颜色观感仍需人眼看一次浅色界面。

---

## 6. 风险与未知（读代码后仍不确定的）

1. **色板未定稿**：§3.1 的预测基于 `docs/UI-WECHAT-REDESIGN-PLAN.md §1.1` 的当前取值；一旦产品调整灰阶/绿色，预测数字与需重登记的 FLOOR 都要重算。最大未知是"白字压微信绿 2.38"是接受为保真例外，还是改按钮文字色/加深绿色。
2. **真机数据可用性未知**：本机是否已有真实解密数据根未验证；没有数据时 `theme-live-audit`/`panel-audit`/密度/响应式全部不可信（`panel-audit` 会"无数据跳过并退出 0"，`ui-verify` 仍可能因 theme 步骤 exit 2/3 而红）。
3. **真机基线不可复现**：`working/` 被 gitignore，density/responsive gate 的 baseline 只在本机存在；换机器/CI 无法直接复跑。建议改版前把"验收基线"另存进受版本管理的目录（例如 `docs/` 或脚本默认路径），否则"改版前后对比"只能手工指定两份 JSON。
4. **离线守卫与真机分叉**：`theme-contrast.guard` 只算令牌；真机 `theme-live-audit` 的采样受渐变/半透明底限制（`theme-live-audit.mjs:300-314` 跳过 gradient 对、半透明底记 null），可能"离线绿、真机红"或反之。改版后必须两层都跑。
5. **主题守卫没有变异自证**：我在全部 `scripts/mutations-*.mjs` 中未找到针对 `theme-alpha-ladder`/`theme-contrast.guard`/`dsw-alias-tokens`/`wx-skin-contrast` 的变异条目（现有主题外观相关只有 M7/M676/M622/M623/M679–M687）。⇒ 这些 spec 若被"放宽到绿"，`check:mutation` **抓不到**。改它们时必须人工 review 加普通单测反例（这些 spec 自带反例自证，别删）。
6. **`check-wx-tokens` 的错误分支有 bug**：`scripts/check-wx-tokens.js:193` 引用了从未定义的 `CHAT_CSS_PATH`；一旦旧字号回退命中，脚本会以 `ReferenceError` 崩溃而不是干净地报"旧字号回退"。仍是非 0 退出（门禁不会假绿），但报错信息会误导。建议另开小修（不在本任务写权限内）。
7. **`--wx-*` 三处口径同步风险**：CSS（`chats-rows.module.css` 等 4 份）、`check-wx-tokens` 常量（49+9 项）、`wx-skin-contrast.guard` 的 FLOOR/解析器，任一处漏改都红，且报错信息分散。建议改聊天皮肤时把三处列成 checklist。
8. **几何守卫的"文件数哨兵"**：`theme-geometry.spec.ts:144-155` 要求扫描到 ≥61 个 CSS 文件、≥500 条圆角、≥1200 条间距声明。如果改版大规模合并/删除 CSS 文件或把大量声明改为简写，可能触发"解析塌陷"哨兵红——需要连同扫描面一起评估，而不是只改数字。
9. **onboarding 的"固定 1180×760"是产品既有承诺**（`onboarding-css-split.wiring.spec.ts:124-148`），与"微信简洁风"未必冲突，但与"响应式重排"直接冲突；改版范围是否包括启动页/同意屏/授权屏需要产品明确，否则这组断言会挡路。
10. **`--nm-cyan` 语义已名不副实**：若按计划把它做成微信绿，`theme-alpha-ladder` 里的"cyan 阶梯/浅色色相"注释与名字都会误导后来人；两种选择（保留 cyan 名字当"主色别名"并重登记快照，或新增 `--nm-primary` 并同步注册双向表）都可行，但需要一次明确的命名决策——这是目前最容易"改到一半两边都不像"的点。

/**
 * 响应式审计：**真实 Electron + 真实数据 + 多分辨率 × 38 页签**，检测五类布局缺陷并产出可复跑基线。
 *
 * 目标（见 docs/BOOTSTRAP-RESPONSIVE.md 第 4 节）：回答「不同分辨率下有没有内容被隐藏、遮挡、
 * 溢出、裁切」。这类问题在源码里看不出来 —— 只有真实布局引擎能给出答案，所以必须起真机窗口。
 *
 * ## 检测规则（阈值都写在下面，报告里也复述一遍）
 *   ① doc-overflow   文档横向溢出：`documentElement.scrollWidth > innerWidth + 1`
 *   ② out-of-viewport 元素横向越界：`rect.right > innerWidth + 2` 或 `rect.left < -2`；
 *                      **排除**位于 `overflow-x:auto/scroll/overlay` 且确实可滚容器内的内容
 *                      （滚动可达），也排除被祖先 overflow hidden/clip 裁住的内容（那是规则③的
 *                      「裁切」，用户看到的是省略号而不是「露到视口外」）；只报最外层元凶。
 *   ③ clipped        被裁切：`scrollWidth/scrollHeight` 超过 `clientWidth/clientHeight`（>1px）且
 *                      x 轴 `overflow∈visible/hidden/clip`、y 轴仅 `hidden/clip`（可见的纵向溢出
 *                      属正常文档流）；x 轴 visible（spill）还要求溢出内容真的露出某个祖先盒子。
 *                      排除 `overflow:auto/scroll`（可滚）、表单控件（原生滚动）、`-webkit-line-clamp`
 *                      与 `text-overflow:ellipsis`（有意截断，计数进 stats.intentionalTruncation）、
 *                      `content-visibility:auto`（浏览器未渲染，误报源）、sr-only/clip 无障碍隐藏、
 *                      纯装饰层、只装图片/视频的缩略图容器（按设计裁切）。
 *   ④ occluded       被固定/粘性元素遮挡：取 `position:fixed|sticky` 且 `z-index > 0` 的可见元素，
 *                      与可交互元素/直接文本元素的 rect 相交 ≥ 目标面积 25%，且
 *                      `document.elementFromPoint(目标中心)` 命中的确实是该覆盖层（真实的命中测试，
 *                      不是仅几何相交）→ 判为遮挡。目标/覆盖层互为祖先时不报。
 *                      顶部标题栏/底部标签栏这类**边缘 chrome**：若滚动到极限后目标能完整移出
 *                      覆盖层（`canScrollClear`），视为移动端常态、不报；滚到底也露不出来的才报。
 *   ⑤ hidden         有文本但不可见：直接文本节点非空，但自身或祖先 `display:none` /
 *                      `visibility:hidden` / 零尺寸 / `opacity:0`；排除 `aria-hidden`、sr-only、
 *                      桌面自绘标题栏与侧栏/底部栏、`nav` 导航（窄屏收成图标属有意设计）、
 *                      以及 opacity:0 的 1-2 字符装饰（表头排序箭头）。同一棵隐藏子树只报最外层一次。
 *
 * ## 为什么用「影子 profile」而不是直接开真实 userData
 *   本机（以及 CI）同一时间只允许一个应用实例（main.js 的 requestSingleInstanceLock 以 userData
 *   为界）。若真实 userData 正被一个开发窗口占着，本脚本直接启动会静默退出（实测：
 *   「[single-instance] 已有实例在运行，本实例退出」+ Playwright `Process failed to launch!`）。
 *   因此脚本在 `.tmp-e2e/responsive-profile/` 播种一个**临时 profile**：
 *     · `wechat/config.json + llm.json + secrets.json + keys.json + all_keys.json` 从真实 profile
 *       只读复制，并把 resolved 指向应用**真正在用**的数据根（默认 `~/.dsh/wechat-data`）；
 *     · `Local Storage` 与 `license.json` 一并复制 —— 于是启动引导/隐私同意/授权三道闸门都按
 *       「已通过」进入主界面，**不需要** `SUPERTIME_SKIP_ONBOARDING=1`（它会往界面顶部插一条
 *       调试横幅，污染截图与布局测量）；复制失败时才回退到该环境变量，并在报告里标注。
 *   数据根是真实数据（只读打开），临时 profile 用完可删，不写源码树、不写真实 profile。
 *
 * ## 运行
 *   node scripts/responsive-audit.mjs                              # 全量：38 tab × 6 视口
 *   node scripts/responsive-audit.mjs --quick                      # 390 / 1280 / 2560 三档快跑
 *   node scripts/responsive-audit.mjs --only=ledger,chats,oplog
 *   node scripts/responsive-audit.mjs --viewports=390x844,1440x900
 *   node scripts/responsive-audit.mjs --label=before-fix --no-shots
 *   node scripts/responsive-audit.mjs --list                       # 只打印解析出的 38 个页签
 *
 * 常用参数：
 *   --only=a,b          只跑指定 tab（逗号分隔）
 *   --viewports=WxH,... 自定义视口矩阵（默认 390×844 / 768×1024 / 1024×768 / 1280×800 / 1440×900 / 2560×1440）
 *   --quick             只跑 390×844 / 1280×800 / 2560×1440
 *   --label=NAME        输出 JSON 文件名（默认按时间生成）
 *   --out=DIR           JSON/截图目录（默认 working/team/responsive）
 *   --report-dir=DIR    Markdown 基线目录（默认 working/team）
 *   --profile=DIR       临时 profile 目录（默认 .tmp-e2e/responsive-profile；并发跑时请分别指定）
 *   --user-data=DIR     覆盖「真实 profile」来源（默认自动探测 %APPDATA%/super-time-electron）
 *   --tab-wait=MS       每个页签最短等待（默认 1500ms；随后等文本稳定 2×250ms）
 *   --max-shots=N       截图上限（默认 40，只给「有 high 级问题 / 文档溢出」的格子拍，JPEG q70）
 *   --no-shots          不截图
 *   --keep-profile      保留临时 profile（默认保留，便于复查；它位于 .tmp-e2e/ 已被 gitignore）
 *   --list              列出页签后退出
 *
 * 退出码：0 = 跑完（即使有问题，这是基线工具）；2 = 前置缺失；3 = 闸门/窗口未能进入主界面；1 = 脚本异常。
 *
 * 产物：
 *   working/team/responsive/<label>.json         结构化基线（逐 tab × 视口的问题清单 + 统计 + Top offenders）
 *   working/team/responsive/shots/*.jpg          问题格子截图（≤40）
 *   working/team/responsive-baseline.md          人类可读基线（tab × 视口矩阵 / 分类统计 / Top 10 / 局限）
 *
 * ## 代码结构（M21 单文件 ≤1000 行棘轮，2026-10-18 拆分）
 *
 *   scripts/responsive-audit.mjs            入口：文件头说明 + 一行 `await run()`
 *   scripts/responsive-audit/setup.mjs      常量 / 视口矩阵 / 阈值 / CLI 参数 / 页签解析 / profile 播种
 *   scripts/responsive-audit/detector.mjs   页面内五类检测（AUDIT_PAGE，序列化进渲染进程执行）
 *   scripts/responsive-audit/report.mjs     汇总统计（buildSummary）+ Markdown 基线（buildBaselineMarkdown）
 *   scripts/responsive-audit/runner.mjs     主流程（启动 Electron / 自检 / 遍历 / 落盘）
 *
 * 拆分是**纯机械搬迁**：检测规则、阈值、CLI 参数、JSON/Markdown 输出格式与拆分前逐字一致，
 * `node scripts/responsive-audit.mjs --selftest`（5/5）与 --quick 冒烟均照旧通过。
 */
import { run } from './responsive-audit/runner.mjs'

// 顶层 await：入口只做「导入 + 执行」，与拆分前的脚本级执行模型一致。
await run()

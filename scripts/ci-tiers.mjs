/**
 * CI 分档表：哪些检查进哪一档，以及**为什么**是这一档。
 *
 * ## 为什么要有这张表
 *
 * 2026-10-09 审计发现：仓里 69 个 script，PR 门禁只调 24 个，而**缺的正好是最贵的那几件** ——
 * `check:mutation`（2026-10-09 时 412 条变异自证）、`lint:db`、`check:deps-provenance` 全都不在门禁里，
 * 9 个性能基准一个都没有对应的 script（所以它们一直被 `skipIf` 跳过、从未真正跑过）。
 * 「不在门禁里」这件事本身不可见，也就没有人去补 —— 缺口会一直安静地存在。
 *
 * 把分档写成**数据**（这个文件）而不是散在 workflow YAML 里的行，好处是：
 *   · 成本与前置条件集中在一处，新增检查时要在一个地方回答「放哪档」；
 *   · `src/backend/tests/ci-tiers.spec.ts` 能对着 workflow 逐条核对 ——
 *     改了 workflow 忘了改这张表（或反过来），那条 spec 会红。
 *
 * ## 分档的依据是**实测成本**，不是「哪个更重要」
 *
 * 2026-10-09 本机实测（Node 24.20.0，windows）：
 *
 *   · 9 个性能基准：`export-memory` **801.5 秒**（其中一个用例就 572.8 秒），
 *     **其余 8 个合计 11.3 秒**（串行跑 18.7 秒）。9 个里的 99.9% 是那一个。
 *   · 变异自证：增量（HEAD~1…HEAD 改 30 个文件）选出 53 条；全量按当前登记表条数（见 TIER2 的动态值）每条约 4 秒
 *     （vitest 冷启动主导）估 25~30 分钟 —— 塞不进 PR 门禁（单测已占 26 分钟 / 上限 45）。
 *
 * 所以：便宜基准进 PR 门禁（W2 之后从 8 个增至 **18 个**，2026-10-12 复测串行 **约 27 秒**），
 * 那一个 13 分钟的进夜间档；变异走「PR 跑增量、登记表被动时另起一个 job 跑全量」。
 *
 * ## KNOWN_ROT：明知道坏、故意不接进任何一档
 *
 * 这里的东西是**长期不跑**烂掉的，不是产品缺陷（根因逐条写在下表里）。放进任何一档都会让门禁
 * 变红，而「门禁红着」和「门禁没这条」一样糟 —— 通常是某个人把它 `continue-on-error` 打开，
 * 于是它变成一个看起来在跑、其实什么都不拦的检查。
 * `ci-tiers.spec.ts` 会断言它们**没有**出现在任何 workflow 里，防止有人顺手接上去。
 *
 * ⚠ 但「不接进门禁」只是**止血**：`ui:longlist-e2e`（2026-10-11 已修好，挪进 TIER1）的教训是
 * 「烂了没人知道」本身就是「没人跑」的直接后果 —— 它唯一那条红判据在这份清单里躺了至少一个
 * 多月，而真正的根因只是夹具每天 10 条，让那个场景永远不可能发生。看下面 KNOWN_ROT 末尾的墓碑。
 *
 * @module scripts/ci-tiers
 */
import { MUTATIONS } from './mutations-registry.mjs'

/** 第一档：每次 push/PR 都跑。选它的标准是「本机实测足够便宜且无外部前置」（上界是这一档里已有的 ~4 分钟增量变异）。 */
export const TIER1 = [
  { script: 'lint:db', cost: '1.7s', why: '后端源码的 eslint。2026-10-09 实测是绿的，但**新违规没人拦** —— 绿而不设门禁等于没检查。' },
  { script: 'check:deps-provenance', cost: '0.2s', why: '依赖来源核对。0.2 秒，不接进门禁等于白写。' },
  { script: 'measure:quick', cost: '约 27s', why: '18 个便宜的性能基准（W2 之后从 8 个增至 18 个；27 秒是 2026-10-12 本机复测的串行墙钟）。长期被 `skipIf` 跳过、从未真跑过；27 秒换「它们还活着」这个保证很划算。' },
  { script: 'check:mutation:diff', cost: '约 4 分钟', why: '变异自证的**增量**档：只跑这次改动波及的那些（目标文件改了、或它的判据 spec 改了）。' },
  { script: 'rag:smoke', cost: '0.4s', why: '纯 Node 检索冒烟。' },
  { script: 'epipe:smoke', cost: '18.4s', why: 'EPIPE 崩溃冒烟。' },
  { script: 'renderer-console:e2e', cost: '1s', why: '起真 Electron，验渲染层 console 进 app.log（2026-10-09 阶段 0 新加的，7 条断言）。' },
  { script: 'ui:e2e-smoke', cost: '4.4s', why: '起真 Electron 的 UI 冒烟。' },
  { script: 'ui:nav-e2e', cost: '5.8s', why: '起真 Electron 验导航壳。' },
  { script: 'ui:loading-e2e', cost: '6.1s', why: '起真 Electron 验加载态恢复。' },
  {
    script: 'ui:longlist-e2e',
    cost: '34.0s',
    why: '长列表虚拟化的**行为**验收（消息流 / 收藏 / 文件网格 / 朋友圈时间线四张）—— DOM 节点数硬上界、'
      + '首尾可达、加载更多不跳位、悬浮日期头。源码级接线守卫证明不了这些（只能证明「接上了」）。'
      + '此前**不在任何 workflow 里**，于是它自己那条「滚到底时悬浮日期头补上当前那一天」长期红着也没人知道；'
      + '2026-10-11 第一次跑起来才发现根因是夹具每天 10 条 ⇒ 每块 11 行 ≈ 一屏 11 行，'
      + '底部窗口起点必然落在日期标签行上，那条判据结构上不可能成立。'
      + '改成每天 40 条 + 补前提断言后 27 项全绿。34 秒远低于同档里那条 ~4 分钟的增量变异。',
  },
]

/** 第二档：夜间跑全量。选它的标准是「贵，但每天跑一次就够」。 */
export const TIER2 = [
  { script: 'check:mutation', cost: '约 25~30 分钟', why: `变异自证**全量** ${MUTATIONS.length} 条。增量档按构造跑不到「目标与 spec 都没动」的那些，登记表会慢慢腐烂；tag 发布时还要在 release.yml 里再跑一遍，因为 tag push 不触发 ci.yml，而夜间档可能排在发版之后。` },
  { script: 'measure:slow', cost: '13 分钟', why: '`export-memory` 一个文件就占 801.5 秒（九个里的 99.9%），只能单独一档。' },
  { script: 'e2e:ledger-reload', cost: '38.3s', why: '真 Electron + 真数据目录，验台账重载。' },
  { script: 'e2e:backup-progress', cost: '6.1s', why: '真 Electron + 真数据目录，验备份进度。' },
  {
    script: 'package:smoke',
    cost: '分钟级未知（打包成本本机未实测；pack 给 35 分钟、冒烟给 25 分钟）',
    why: '打包态冒烟（W2-13.3）：安装目录与 asar 里都不含 wechat/config.json / wechat/llm.json、'
      + '`src/**/*` 通配打包的兜底、生产依赖闭包、启动态断言。它要读打包产物且要启动应用，'
      + '所以必须在 nightly 的 `npm run pack` 之后。此前它「只能本机跑」的原因可以修：'
      + 'N23 禁的是完整路径字面量，而断言的**对象**正是那两个文件 —— 把尾段拆成常量就两全了。',
  },
]

/** 第三档：发版前跑，且必须先 `npm run pack`。 */
export const TIER3 = [
  { script: 'm1-secrets:smoke', cost: '需打包产物', why: '要读打包产物里的 resources；实测直接跑会报「找不到打包产物：请先运行 npm run pack」。' },
  {
    script: 'security-guard:smoke:packaged',
    cost: '秒级（要打包件）',
    why: '在真实 asar 环境里复验开窗/外部导航被拒：源码态守卫通过不等于安装包里还挂着同一个 webContents 钩子。',
  },
  {
    script: 'check:shim',
    cost: '秒级（不依赖 build:ui）',
    why: 'vite 构建已 alias 到源码，ui-dist 不读 node_modules 副本；此检查只守磁盘副本这一历史接口，防其它消费者静默漂移。',
  },
  {
    script: 'package:sns-video:smoke',
    cost: '0.3s（但要打包件才真验）',
    why:
      '⚠️ **它缺打包件时会 `exit 0`** —— 脚本自己打印「这一条不算通过 —— 只是本机暂时没有打包件可比」，'
      + '但退出码是 0。实测：在没有 dist/win-unpacked 的本机跑它，0.3 秒就绿。'
      + '放进任何一档门禁，只要那个 job 没先跑 `npm run pack`，它就是个**空跑的绿灯**。'
      + '所以它只在第三档（`npm run pack` 之后）才有意义。',
  },
]

/**
 * 只在本机跑、**故意不接进任何 workflow** 的（发版前的本地清单）。
 *
 * 判据是仓库里已有的 `ci-script-isolation.spec.ts`：CI 步骤调用的脚本不许引用
 * 只存在于本机的资源（签名私钥目录、`wechat/llm.json`、`wechat/config.json`）。
 * 2026-10-09 实测：`package:smoke` 正好踩中后两条 —— 它曾被接进 `release.yml`，
 * 那条守卫当场变红（`packaged-smoke.js` 引用了 `wechat/config.json, /wechat/llm.json`）。
 * 所以它留在本地清单里，而不是「接进去然后 `continue-on-error`」——
 * 那样会变成一个看起来在跑、其实什么都不拦的检查。
 *
 * W2-13.3：`package:smoke` 已从这里毕业进 TIER2 —— 它此前「只能本机跑」的原因是可以修的：
 * N23 那条 AST 判据禁的是「本机专有资产的完整路径字面量」，而它要断言的对象正是
 * `wechat/config.json` / `wechat/llm.json`。把尾段拆成常量后既过守卫、又保留完整路径比对。
 */
export const LOCAL_ONLY = []

/**
 * 明知道坏、故意**不**接进任何一档的。根因写清楚，免得下一个人重新查一遍。
 *
 * 剩下这一条**不是产品缺陷** —— 查过代码：脚本还在按「`更多` 菜单 → `导出消息`」的老流程点，
 * 而面板早已改成直接一个 `导出` 按钮开对话框（`moments-panel.tsx`）；而且对话框第一步要
 * **原生目录选择器**，headless e2e 里走不通 —— 要么给对话框加注入点，要么放弃这条。
 */
export const KNOWN_ROT = [
  {
    script: 'e2e:export-nonblocking',
    symptom: '基线探测通过，随后 `locator.click` 等 `button[name="更多"]` 超时 30s，1/2 成立',
    rootCause: '选择器腐烂 + 导出流程需要原生目录选择器，headless 走不通',
  },
]

/**
 * 已修好、从 KNOWN_ROT 毕业的东西。**墓碑**：不写的话，下一个人会照着老结论重新规划一次。
 *
 * · `ui:longlist-e2e` —— 原来的结论是「唯一不成立的那条断言与实现矛盾，断言过严」。
 *   2026-10-11 复查后**改了这个结论**：实现的规则（`showFloatingDay`）是对的，是**夹具**
 *   让那个场景永远不可能发生 —— `MOMENTS_PER_DAY = 10` ⇒ 每个日期块正好 11 行
 *   （1 标签 + 10 动态），而底部那一屏也正好挂 11 行 ⇒ 滚到底时窗口第一行必然是日期标签行。
 *   改成每天 40 条（41 行，远大于一屏）之后场景可达，实现当场把当天日期补出来了，27 项全绿。
 *   所以不是「断言过严」，是「判据在空转」—— 这类比断言过严更危险：它看起来是红的，
 *   谁都会以为那是个产品缺陷，然后照着错误的方向去改。现已接进 TIER1。
 */

/** 本机实测日期 —— 成本数字的来源，别让它悄悄过期。 */
export const MEASURED_ON = '2026-10-11'

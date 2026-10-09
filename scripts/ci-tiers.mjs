/**
 * CI 分档表：哪些检查进哪一档，以及**为什么**是这一档。
 *
 * ## 为什么要有这张表
 *
 * 2026-10-09 审计发现：仓里 69 个 script，PR 门禁只调 24 个，而**缺的正好是最贵的那几件** ——
 * `check:mutation`（408 条变异自证）、`lint:db`、`check:deps-provenance` 全都不在门禁里，
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
 *   · 变异自证：增量（HEAD~1…HEAD 改 30 个文件）选出 53 条；全量 408 条按每条约 4 秒
 *     （vitest 冷启动主导）估 25~30 分钟 —— 塞不进 PR 门禁（单测已占 26 分钟 / 上限 45）。
 *
 * 所以：8 个便宜基准进 PR 门禁，那一个 13 分钟的进夜间档；变异走「PR 跑增量、
 * 登记表被动时另起一个 job 跑全量」。
 *
 * ## KNOWN_ROT：明知道坏、故意不接进任何一档
 *
 * 这两条是**长期不跑**烂掉的，不是产品缺陷（根因逐条写在下表里）。放进任何一档都会让门禁变红，
 * 而「门禁红着」和「门禁没这条」一样糟 —— 所以先记在这里，等单独修。
 * `ci-tiers.spec.ts` 会断言它们**没有**出现在任何 workflow 里，防止有人顺手接上去。
 *
 * @module scripts/ci-tiers
 */

/** 第一档：每次 push/PR 都跑。选它的标准是「本机实测 < 30 秒且无外部前置」。 */
export const TIER1 = [
  { script: 'lint:db', cost: '1.7s', why: '后端源码的 eslint。2026-10-09 实测是绿的，但**新违规没人拦** —— 绿而不设门禁等于没检查。' },
  { script: 'check:deps-provenance', cost: '0.2s', why: '依赖来源核对。0.2 秒，不接进门禁等于白写。' },
  { script: 'measure:quick', cost: '19s', why: '8 个便宜的性能基准。长期被 `skipIf` 跳过、从未真跑过；19 秒换「它们还活着」这个保证很划算。' },
  { script: 'check:mutation:diff', cost: '约 4 分钟', why: '变异自证的**增量**档：只跑这次改动波及的那些（目标文件改了、或它的判据 spec 改了）。' },
  { script: 'rag:smoke', cost: '0.4s', why: '纯 Node 检索冒烟。' },
  { script: 'epipe:smoke', cost: '18.4s', why: 'EPIPE 崩溃冒烟。' },
  { script: 'renderer-console:e2e', cost: '1s', why: '起真 Electron，验渲染层 console 进 app.log（2026-10-09 阶段 0 新加的，7 条断言）。' },
  { script: 'ui:e2e-smoke', cost: '4.4s', why: '起真 Electron 的 UI 冒烟。' },
  { script: 'ui:nav-e2e', cost: '5.8s', why: '起真 Electron 验导航壳。' },
  { script: 'ui:loading-e2e', cost: '6.1s', why: '起真 Electron 验加载态恢复。' },
]

/** 第二档：夜间跑全量。选它的标准是「贵，但每天跑一次就够」。 */
export const TIER2 = [
  { script: 'check:mutation', cost: '约 25~30 分钟', why: '变异自证**全量** 408 条。增量档按构造跑不到「目标与 spec 都没动」的那些，登记表会慢慢腐烂。' },
  { script: 'measure:slow', cost: '13 分钟', why: '`export-memory` 一个文件就占 801.5 秒（九个里的 99.9%），只能单独一档。' },
  { script: 'e2e:ledger-reload', cost: '38.3s', why: '真 Electron + 真数据目录，验台账重载。' },
  { script: 'e2e:backup-progress', cost: '6.1s', why: '真 Electron + 真数据目录，验备份进度。' },
]

/** 第三档：发版前跑，且必须先 `npm run pack`。 */
export const TIER3 = [
  { script: 'm1-secrets:smoke', cost: '需打包产物', why: '要读打包产物里的 resources；实测直接跑会报「找不到打包产物：请先运行 npm run pack」。' },
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
 */
export const LOCAL_ONLY = [
  {
    script: 'package:smoke',
    why:
      '引用本机专属的 `wechat/config.json` / `wechat/llm.json`，`ci-script-isolation.spec.ts` '
      + '明确禁止 CI 步骤调它。接进 release.yml 会让那条守卫当场变红（实测过）。'
      + '它是打包态最有价值的冒烟，但只能在**有那几个文件的本机**上跑。',
  },
]

/**
 * 明知道坏、故意**不**接进任何一档的。根因写清楚，免得下一个人重新查一遍。
 *
 * 两条都**不是产品缺陷** —— 都查过代码：
 *   · `e2e:export-nonblocking`：脚本还在按「`更多` 菜单 → `导出消息`」的老流程点，而面板
 *     早已改成直接一个 `导出` 按钮开对话框（`moments-panel.tsx`）；而且对话框第一步要
 *     **原生目录选择器**，headless e2e 里走不通 —— 要么给对话框加注入点，要么放弃这条。
 *   · `ui:longlist-e2e`：26 条里 25 条成立，唯一不成立的是「滚到底时悬浮日期头补上当前那一天」，
 *     它要求该标签非空；而实现的明文规则是「当天日期头本身可见时**不重复显示**」
 *     （`moments-timeline.tsx` 的 `showFloatingDay = floatingDay !== '' && firstRow?.kind !== 'day'`）。
 *     滚到底时首行恰好就是日期头 ⇒ 不显示是**符合设计**的，是这条断言过严。
 */
export const KNOWN_ROT = [
  {
    script: 'e2e:export-nonblocking',
    symptom: '基线探测通过，随后 `locator.click` 等 `button[name="更多"]` 超时 30s，1/2 成立',
    rootCause: '选择器腐烂 + 导出流程需要原生目录选择器，headless 走不通',
  },
  {
    script: 'ui:longlist-e2e',
    symptom: '26 条里 25 条成立；唯一不成立的是「滚到底时悬浮日期头补上当前那一天」',
    rootCause: '断言与实现规则矛盾（实现是「日期头本身可见时不重复显示」），断言过严',
  },
]

/** 本机实测日期 —— 成本数字的来源，别让它悄悄过期。 */
export const MEASURED_ON = '2026-10-09'

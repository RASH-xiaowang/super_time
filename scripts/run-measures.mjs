#!/usr/bin/env node
/**
 * 性能基准 runner：按档位打开 `*.measure.spec.ts` 的门控变量并跑 vitest。
 *
 * ## 为什么要有它
 *
 * 仓里 9 个性能基准**一直被 `npm test` 收集，但一直是被跳过的** ——
 * 每个都用 `describe.skipIf(process.env.MEASURE_xxx !== '1')` 守着，平时只贡献一行 `skipped`。
 * 也就是说「有基准」这件事一直是假的：没人跑过，也就没人知道它们还能不能跑、
 * 更没人拿它们的数字做过任何判断。
 *
 * 而 `package.json` 里**一个 `MEASURE_*` script 都没有**，所以「跑一下 M10」这件事
 * 只能靠人记得去翻文件头的注释、把九份文档里的命令抄对 —— 这就是它们没被跑过的原因。
 *
 * ## 为什么自己 spawn 而不是 `MEASURE_M10=1 vitest …`
 *
 * `A=1 cmd` 这种前缀写法在 POSIX shell 里能用，在 Windows 的 cmd 里**不能**
 *（而 CI 与本机开发都是 Windows）。所以门控变量由本脚本设进 `process.env` 再 spawn。
 *
 * ## 档位是按**实测耗时**分的，不是按「哪个更重要」
 *
 * 2026-10-09 在本机实测（Node 24.20.0）：
 *
 *   · `export-memory`：**801.5 秒**（其中一个用例就 572.8 秒），9 个里的 99.9%；
 *   · 其余 8 个合计：**11.3 秒**。
 *
 * 于是分成两档：18 个便宜的进 PR 门禁（2026-10-12 复测串行约 27 秒，相对 26 分钟的单测可以忽略），
 * 那个 13 分钟的进夜间档。如果按「重要性」分档而不是按耗时，就会出现两种坏结果之一：
 * 贵的那个把 PR 门禁顶爆，或者把便宜的和它捆在一起导致便宜的也进不了门禁。
 *
 * @module scripts/run-measures
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

/**
 * 每个基准的门控变量 → spec 文件。
 *
 * 门控变量名取自各 spec 自己的文件头注释（那份注释就是它们唯一的「怎么跑」说明），
 * 这份对照表放在这里，是为了让「有哪些基准」有一个能 grep、能加断言的地方 ——
 * 否则新增一个基准的人不会想到要去改这里，基准就会悄悄退回到「没人跑」的状态。
 */
export const MEASURES = [
  { gate: 'MEASURE_M10', file: 'src/backend/wechat-data/tests/vector-build.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_N8', file: 'src/backend/wechat-data/tests/vector-build-read.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_M11', file: 'src/backend/wechat-data/tests/nplus1.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_M12', file: 'src/backend/wechat-data/tests/dedupe.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_HAMMING', file: 'src/backend/wechat-data/tests/hamming-select.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_N14', file: 'src/backend/wechat-data/tests/vector-status.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_N15', file: 'src/backend/wechat-data/tests/summary-run-due.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_XLSX_STREAM', file: 'src/backend/wechat-data/tests/xlsx-stream.measure.spec.ts', tier: 'quick' },
  // W1 观测基线（2026-10-09 新增，合成数据，各约 1.5–2s）
  { gate: 'MEASURE_SNS_MISS', file: 'src/backend/wechat-data/tests/sns-miss-cost.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_MEDIA_RESOLVE', file: 'src/backend/wechat-data/tests/media-resolve-batch.measure.spec.ts', tier: 'quick' },
  { gate: 'MEASURE_DECRYPT', file: 'src/backend/wechat-data/tests/decrypt-throughput.measure.spec.ts', tier: 'quick' },
  // 实测 801.5 秒（占九个里的 99.9%），单独一档
  { gate: 'MEASURE_EXPORT_MEMORY', file: 'src/backend/wechat-data/tests/export-memory.measure.spec.ts', tier: 'slow' },
  // W2-5.6：朋友圈视频封面逐条 vs 批量。回答的是「批量化省在哪一段」——
  // 月份少时 1.1×（瓶颈在整月扫 md5，已被按月索引摊掉），月份多时 25.7×（瓶颈在逐条重列月份根）。（实测 1.02s）
  { gate: 'MEASURE_SNS_COVER', file: 'src/backend/wechat-data/tests/sns-cover-batch.measure.spec.ts', tier: 'quick' },
  // W2-6.4：增量同步的代价随新增条数怎么长（决定「落后时要不要挪到后台」）。（实测 859ms）
  { gate: 'MEASURE_INDEX_FRESH', file: 'src/backend/wechat-data/tests/index-freshness.measure.spec.ts', tier: 'quick' },
  // W2-4.4：群洞察冷算 vs 签名命中（16 万条群消息：161.5ms → 0.003ms）。（实测 505ms）
  { gate: 'MEASURE_GROUP_INSIGHTS', file: 'src/backend/wechat-data/tests/group-insights-cost.measure.spec.ts', tier: 'quick' },
  // W2-3.5：消息分页的排序成本 —— (sort_seq, local_id) 覆盖索引 8~59×。（实测 448ms）
  { gate: 'MEASURE_MSG_PAGE', file: 'src/backend/wechat-data/tests/messages-page-cost.measure.spec.ts', tier: 'quick' },
  // W2-5.3：hardlink.db 开连接 / 重读 dir2id 只占端到端 0.26% ⇒ 长连接复用不成立。（实测 705ms）
  { gate: 'MEASURE_HARDLINK_OPEN', file: 'src/backend/wechat-data/tests/hardlink-open-cost.measure.spec.ts', tier: 'quick' },
  // W2-9.3：记录类长列表的 DOM 规模 ⇒ Ledger 半边前提不成立、Records 半边收益 30×。（实测 716ms）
  { gate: 'MEASURE_LONGLIST', file: 'src/backend/wechat-data/tests/longlist-dom-cost.measure.spec.ts', tier: 'quick' },
  // W2-10.2：头像逐张 vs 批量（200 个 = 34.18ms vs 6.15ms，5.6×）⇒ 组件侧攒批成立。（实测 261ms）
  { gate: 'MEASURE_AVATAR_BATCH', file: 'src/backend/wechat-data/tests/avatar-batch-cost.measure.spec.ts', tier: 'quick' },
]

const argv = process.argv.slice(2)
const tier = argv.find((a) => !a.startsWith('-')) ?? 'quick'
const picked = MEASURES.filter((m) => m.tier === tier || tier === 'all')

if (picked.length === 0) {
  process.stdout.write(`没有 tier=${tier} 的基准。可用：${[...new Set(MEASURES.map((m) => m.tier))].join(' / ')}\n`)
  process.exit(2)
}

const env = { ...process.env }
for (const m of picked) env[m.gate] = '1'

process.stdout.write(
  `跑 ${String(picked.length)} 个基准（tier=${tier}）：\n`
  + picked.map((m) => `  ${m.gate}=1  ${m.file}`).join('\n') + '\n\n',
)

const r = spawnSync(process.execPath, [VITEST, 'run', ...picked.map((m) => m.file), '--maxWorkers=1', '--no-file-parallelism'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
})
process.exit(r.status ?? 1)

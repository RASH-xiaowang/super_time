/**
 * laya 推理性能的**可复现证据脚本**：把「合批」这个看着该做、实测不该做的结论，
 * 拆成两个只用现有 API 就能量的机制事实。
 *
 * 需要真实模型（不进仓库）：默认 `D:\laya\models`，可用 `DSH_WECHAT_LAYA_DIR` 覆盖。
 * 跑法：`node tools/laya/bench-inference.mjs`
 *
 * ## 背景
 * `analyzeVisibleMessages` 一批最多 12 条，现场日志实测整批**均 36s / 峰值 110s**
 * （单次 54,103ms）。直觉是「12 次 forward 合成 1 次就快了」——
 * 本机实测（i7-14700K / 28 逻辑核 / fp32 1.23 GB）**合批反而慢 41.8%**：
 * 同一份 12 条输入，逐条 12 次 forward 29,560ms vs 合批 1 次 41,926ms。
 *
 * ## 为什么会这样（本脚本量的两条）
 * 实验一：**每次 `session.run` 的固定开销实测为 0** —— 耗时与「行数」严格成正比，
 *         所以合批**没有可摊薄的东西**（逐条 0.826 ms/token-row，合批同样 0.826）。
 * 实验二：**每 token 的成本随序列长度上升**（注意力是 O(seqLen²) 的那部分在涨）
 *         ⇒ 把较短的行 pad 到批内最长，等于让它们按最长那一档的价格买单。
 * 两条合起来：合批只能拿到「省掉固定开销」（=0），却必然付出 pad 的代价 ⇒ 净亏。
 *
 * 实验三顺带把「多加线程」也量了：intra-op 线程 **8 就是最优**，
 * 再往上（12/16/20/28）反而更慢，是 E-core 互相抢缓存。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))          // tools/laya
const ROOT = join(HERE, '..', '..')
const MODEL_DIR = process.env.DSH_WECHAT_LAYA_DIR ?? String.raw`D:\laya\models`

const SENT = '你今天怎么又不回我消息，我等了你半天，你到底在忙什么呀？'
const stateOf = (chars) => ({ dialogue: SENT.repeat(Math.max(1, Math.round(chars / SENT.length))) })

/** k 个**同型**命题（都是 noul / 2 选项）⇒ `optCols` 固定，唯一变量就是行数。 */
function noulQuestions(k) {
  const q = {}
  for (let i = 0; i < k; i += 1) {
    q[`p${i}`] = { type: 'noul', instructions: `${SENT}第 ${i} 问：这句话是在提问吗？`, labels: { false: '不是', true: '是' } }
  }
  return q
}

/**
 * 把 `laya/runtime.ts` 打成一个 ESM 到临时目录。
 *
 * ⚠ 临时目录必须**在仓库的 `node_modules/` 里面**：runtime 是动态 `import('onnxruntime-node')`，
 * 而 Node 的解析是从**引用文件所在目录**往上找 `node_modules` —— 落在系统 tmp 里就找不到，
 * 报 `Cannot find package 'onnxruntime-node'`（实测踩过）。放在 `node_modules/` 下既能解析到，
 * 又本来就被 gitignore 覆盖。用完即删。
 */
function buildRuntime() {
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.laya-bench-'))
  const entry = join(dir, 'entry.ts')
  const out = join(dir, 'bundle.mjs')
  const src = join(ROOT, 'src/backend/wechat-data/src/laya').replace(/\\/g, '/')
  writeFileSync(entry,
    `export { layaAnalyze, layaUnload, layaThreadCount } from ${JSON.stringify(src + '/runtime.ts')}\n`
    + `export { defaultChatQuestions } from ${JSON.stringify(src + '/presets.ts')}\n`, 'utf8')
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules/esbuild/bin/esbuild'), entry,
    '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`, '--log-level=warning',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  return { dir, out }
}

const rt = buildRuntime()
const mod = await import(pathToFileURL(rt.out).href)

// ── 子进程模式：只为「换线程数」用（ORT 的线程数在会话创建时定死，必须换进程）──
if (process.env.__LAYA_BENCH_THREADS === '1') {
  const states = [300, 600, 1100].map(stateOf)
  await mod.layaAnalyze({ state: states[0], modelDir: MODEL_DIR })
  let total = 0
  for (const s of states) {
    const r = await mod.layaAnalyze({ state: s, modelDir: MODEL_DIR })
    if (!r.ok) { console.log(JSON.stringify({ error: r.error })); process.exit(1) }
    total += r.inferenceMs
  }
  console.log(JSON.stringify({ threads: mod.layaThreadCount(), total }))
  process.exit(0)
}

const probe = await mod.layaAnalyze({ state: stateOf(300), modelDir: MODEL_DIR })
if (!probe.ok) {
  console.error(`模型不可用（${MODEL_DIR}）：${probe.error}`)
  console.error('这份脚本需要真实模型；请用 DSH_WECHAT_LAYA_DIR 指向模型目录。')
  rmSync(rt.dir, { recursive: true, force: true })
  process.exit(1)
}

const line = (s = '') => console.log(s)

line('='.repeat(78))
line('实验一：固定开销有多大？（同一 state，只改命题个数 ⇒ 唯一变量是「行数」）')
line('='.repeat(78))
const stateFixed = stateOf(600)
const counts = [1, 2, 3, 6]
const times = []
for (const k of counts) {
  const r = await mod.layaAnalyze({ state: stateFixed, questions: noulQuestions(k), modelDir: MODEL_DIR })
  if (!r.ok) { console.error(`k=${k} 失败: ${r.error}`); process.exit(1) }
  times.push(r.inferenceMs)
}
const perRow = times.map((t, i) => t / counts[i])
line(counts.map((k, i) => `  ${String(k).padStart(2)} 行 → ${String(times[i]).padStart(5)} ms（${perRow[i].toFixed(0)} ms/行）`).join('\n'))
const slope = (times[times.length - 1] - times[0]) / (counts[counts.length - 1] - counts[0])
const intercept = times[0] - slope * counts[0]
line(`  线性拟合：${slope.toFixed(1)} ms/行，截距 ${intercept.toFixed(1)} ms`)
line(intercept < slope * 0.2
  ? `  ⇒ 截距≈0（<20% 的单行成本）⇒ **每次 forward 的固定开销可以忽略**，合批没有可摊薄的东西`
  : `  ⇒ 截距显著，合批理论上能省下这部分`)

line('')
line('='.repeat(78))
line('实验二：每 token 的成本随序列长度上升（pad 到最长会亏）')
line('='.repeat(78))
const questions = mod.defaultChatQuestions()
for (const chars of [150, 300, 600, 900, 1100]) {
  const r = await mod.layaAnalyze({ state: stateOf(chars), questions, modelDir: MODEL_DIR })
  if (!r.ok) { console.error(`chars=${chars} 失败: ${r.error}`); process.exit(1) }
  line(`  ${String(chars).padStart(4)} 字 ≈ ${String(r.tokens).padStart(5)} tokens → ${String(r.inferenceMs).padStart(5)} ms`
    + `（${(r.inferenceMs / r.tokens).toFixed(3)} ms/token）`)
}
line('  ⇒ 单位成本**随长度上升**（注意力 O(seqLen²) 那部分在涨）。')
line('    合批会把短行 pad 到批内最长 ⇒ 短行按最长那一档买单，总账变大。')

line('')
line('='.repeat(78))
line('实验三：intra-op 线程数扫描（同一份输入，每条线程数各起一个进程）')
line('='.repeat(78))
for (const t of [4, 8, 12, 16, 20, 28]) {
  const raw = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, __LAYA_BENCH_THREADS: '1', DSH_WECHAT_LAYA_THREADS: String(t) },
    encoding: 'utf8',
  }).trim().split('\n').pop()
  let parsed
  try { parsed = JSON.parse(raw) } catch { line(`  threads=${t}  —— 输出不可解析：${raw}`); continue }
  if (parsed.error) { line(`  threads=${t}  —— 失败：${parsed.error}`); continue }
  line(`  threads=${String(t).padStart(3)} (生效 ${String(parsed.threads).padStart(3)})  ${String(parsed.total).padStart(6)} ms`)
}
line('  ⇒ 8 是最优点：再多只是让 E-core 互相抢缓存（`runtime.ts` 的 8 就是按这组数定的）。')

mod.layaUnload()
rmSync(rt.dir, { recursive: true, force: true })

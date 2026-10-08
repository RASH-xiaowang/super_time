/**
 * P3「真实打包产物里加载模型」的验证（2026-09-28）。
 *
 * ## 为什么不能只靠「文件在不在」
 * laya 的两个运行时依赖分居两处：`onnxruntime-node` 的原生库在 `app.asar.unpacked`，
 * 纯 JS 在 `app.asar` 里。**「文件存在」离「能跑」还隔着一整套模块解析 + 原生加载**。
 * 而本脚本要回答的正是那个从来没被回答过的问题：**把包解开、按打包版的布局摆好，
 * 这套东西到底能不能真的跑出一次推理。**
 *
 * ## 做法（尽量贴近真实布局）
 *   ① 读 asar 头部，确认原生文件被标成 `unpacked`（这是 Electron 把加载重定向到
 *      `app.asar.unpacked` 的前提）；
 *   ② `extractAll` 把 asar 解成真实文件 → 再把 `app.asar.unpacked` 覆盖上去
 *      —— 这就是打包版运行时看到的目录形态；
 *   ③ 在该目录里放一个入口，让 `import('onnxruntime-node')` / `import('@huggingface/tokenizers')`
 *      的解析**从模拟布局出发**（而不是从仓库的 node_modules），跑一次真实推理。
 *
 * ## 如实标注的边界
 * 本脚本**不覆盖**「Electron 在 asar 内的 fs 补丁」这一层 —— 那里由 ① 的头部标记 +
 * packaged-smoke 的存在性断言共同兜底。真实 GUI 启动被沙箱拦着（见 MEMORY），
 * 所以「Electron 里真跑一次」仍未验证。
 *
 * 跑法：`node tools/laya/verify-packaged-onnx.mjs`（需先 `electron-builder --dir` 出产物）
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const MODEL_DIR = process.env.DSH_WECHAT_LAYA_DIR ?? String.raw`D:\laya\models`
const RESOURCES = join(ROOT, 'dist', 'win-unpacked', 'resources')
const ASAR = join(RESOURCES, 'app.asar')
const UNPACKED = join(RESOURCES, 'app.asar.unpacked')
const SIM = join(ROOT, 'working', '_packaged-sim')

const line = (s = '') => console.log(s)
const ok = []
const bad = []

line('='.repeat(78))
line('P3 验证：模拟打包布局 → 真模型推理')
line('='.repeat(78))

if (!existsSync(ASAR)) {
  line(`❌ 没有打包产物：${ASAR}`)
  line('   先跑：node node_modules/electron-builder/out/cli/cli.js --dir')
  process.exit(1)
}

// ── ① asar 头部：原生文件必须被标成 unpacked（Electron 的重定向前提）──
const require = (await import('node:module')).createRequire(import.meta.url)
const { getRawHeader, listPackage, extractAll } = require('@electron/asar')
const header = getRawHeader(ASAR).header
const asarRoot = typeof header === 'string' ? JSON.parse(header) : header
const entryOf = (rel) => rel.split('/').reduce((n, seg) => n?.files?.[seg], asarRoot)
const check = (cond, label, extra = '') => {
  line(`  ${cond ? '✅' : '❌'} ${label}${extra ? `  [${extra}]` : ''}`)
  ;(cond ? ok : bad).push(label)
}
for (const rel of ['node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
                   'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node']) {
  const e = entryOf(rel)
  check(Boolean(e && e.unpacked === true), `asar 头部把 ${rel.split('/').pop()} 标为 unpacked`)
}
const entries = listPackage(ASAR).map((f) => f.replace(/\\/g, '/'))
check(entries.includes('/node_modules/@huggingface/tokenizers/dist/tokenizers.cjs'),
  'asar 内确实有分词器（纯 JS，不需要解包）')

// ── ② 解包 → 覆盖 unpacked → 得到「打包版看到的目录形态」──
line('')
line('  重建模拟布局…')
rmSync(SIM, { recursive: true, force: true })
mkdirSync(SIM, { recursive: true })
extractAll(ASAR, SIM)
cpSync(UNPACKED, SIM, { recursive: true, force: true })
check(existsSync(join(SIM, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime.dll')),
  '模拟布局里 onnxruntime.dll 是真实文件')
check(existsSync(join(SIM, 'node_modules', 'onnxruntime-common', 'package.json')),
  '模拟布局里 onnxruntime-common 在（少了它 import 就断）')

// ── ③ 从模拟布局跑一次真实推理 ──
const entry = join(SIM, '__verify.mjs')
const src = join(ROOT, 'src/backend/wechat-data/src/laya/runtime.ts').replace(/\\/g, '/')
const bundle = join(SIM, '__verify-bundle.mjs')
writeFileSync(entry, `export { layaAnalyze } from ${JSON.stringify(src)}\n`, 'utf8')
execFileSync(process.execPath, [join(ROOT, 'node_modules/esbuild/bin/esbuild'), entry,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--log-level=warning'],
  { stdio: ['ignore', 'ignore', 'inherit'] })

line('')
line(`  从模拟布局执行推理（模型 ${MODEL_DIR}）…`)
globalThis.__LAYA_VERIFY_MODULE = pathToFileURL(bundle).href
const mod = await import(pathToFileURL(bundle).href)
const r = await mod.layaAnalyze({
  state: { dialogue: '对方：你今天是不是又忘了我跟你说过什么？' },
  modelDir: MODEL_DIR,
})
if (!r.ok) {
  check(false, '模拟布局里能跑出一次真实推理', String(r.error).slice(0, 120))
} else {
  check(true, '模拟布局里能跑出一次真实推理',
    `${r.answers.length} 命题 / ${r.inferenceMs}ms / ${r.tokens} tokens`)
  const tension = r.answers.find((a) => a.kind === 'score')
  line(`     紧张度 ${tension?.score ?? '-'} / 10（与仓库内直跑同值即为通过）`)
}

// 收尾**尽力而为**：刚跑完推理，进程仍持有 onnxruntime.dll 的句柄 ⇒ Windows 上 unlink 会
// EPERM（本机 MEMORY 里记过一整类「残留进程锁住源文件」的坑）。目录在 `working/` 下（gitignore），
// 下次运行开头的 `rmSync` 会把它清掉 —— 所以这里**不能**因为删不掉就判失败。
try {
  rmSync(SIM, { recursive: true, force: true })
} catch (e) {
  line(`  ⚠️ 模拟布局未能即刻清理（${String(e.code ?? e.message)}）—— 不影响结论，下次运行开头会清`)
}
line('')
line('='.repeat(78))
line(bad.length === 0 ? `✅ P3 通过：${ok.length} 项` : `❌ ${bad.length} 项未通过：${bad.join('；')}`)
line('='.repeat(78))
process.exit(bad.length === 0 ? 0 : 1)

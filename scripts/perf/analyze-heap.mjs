/**
 * V8 heap snapshot 归因（2026-10-21 性能专项 · 内存）。
 *
 * 输入：`scripts/perf/worker-heap.mjs`（或任何 CDP `HeapProfiler.takeHeapSnapshot`）落盘的
 * `.json.gz` / `.json`。输出：按 **self_size** 聚合的类型/名字排行 + 大字符串盘点。
 *
 * 为什么要自己算：V8 快照不提供「retained size 现成表」（要给每个节点做支配树遍历，
 * 几百 MB 的图在脚本里不划算）。按 self_size 聚合已足够回答本轮问题：
 * 131MB heap 里是字符串、代码、还是大 buffer；再配合 `[mem]` 的 external/arrayBuffers
 * 判断 RSS 剩下的 300MB 在不在 V8 堆里。
 *
 * 用法：
 *   node scripts/perf/analyze-heap.mjs working/heap/worker-heap-idle.json.gz
 *   node scripts/perf/analyze-heap.mjs <file> --top=30
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/perf/analyze-heap.mjs <heap.json.gz|heap.json> [--top=20]')
  process.exit(2)
}
const topN = Number(String(process.argv.find((a) => a.startsWith('--top=')) ?? '--top=20').slice('--top='.length)) || 20

const raw = readFileSync(file)
const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')
const snap = JSON.parse(text)
const meta = snap.snapshot?.meta
if (!meta || !Array.isArray(snap.nodes)) throw new Error('不是 V8 heap snapshot 格式: ' + file)
const nf = meta.node_fields
const nt = meta.node_types[0]
const stride = nf.length
const ti = nf.indexOf('type')
const ni = nf.indexOf('name')
const si = nf.indexOf('self_size')
const nodes = snap.nodes
const strings = snap.strings ?? []
const count = nodes.length / stride

const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : (b / 1024).toFixed(1) + 'KB')
const fmtPct = (part, whole) => (whole === 0 ? '0%' : ((part / whole) * 100).toFixed(1) + '%')

let total = 0
const byType = new Map()
const byName = new Map()
for (let i = 0; i < count; i += 1) {
  const b = i * stride
  const type = nt[nodes[b + ti]] ?? '?'
  const size = nodes[b + si] ?? 0
  const name = strings[nodes[b + ni]] ?? ''
  total += size
  const t = byType.get(type) ?? { bytes: 0, n: 0 }
  t.bytes += size
  t.n += 1
  byType.set(type, t)
  const key = type + '\u0000' + name
  const e = byName.get(key) ?? { type, name, bytes: 0, n: 0 }
  e.bytes += size
  e.n += 1
  byName.set(key, e)
}

/** 字符串盘点：总字符、data: 大字符串、最长几条。 */
let strChars = 0
let dataChars = 0
let dataCount = 0
for (const s of strings) {
  strChars += s.length
  if (s.startsWith('data:')) { dataChars += s.length; dataCount += 1 }
}
const topStrings = [...strings].sort((a, b) => b.length - a.length).slice(0, Math.min(topN, 15))

const typeRows = [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, topN)
const nameRows = [...byName.values()].sort((a, b) => b.bytes - a.bytes).slice(0, topN)

console.log('\n══════ V8 heap snapshot 归因 ══════')
console.log(`文件：${file}`)
console.log(`节点 ${count} 个｜总 self_size ${fmt(total)}｜字符串表 ${strings.length} 条 / ${fmt(strChars * 2)}（UTF-16 估字节）`)
console.log(`其中 data: 大字符串 ${dataCount} 条 / ${fmt(dataChars * 2)}`)

console.log('\n── 按节点类型（self_size）──')
for (const [type, v] of typeRows) console.log(`  ${type.padEnd(22)} ${fmt(v.bytes).padStart(10)}  ${fmtPct(v.bytes, total).padStart(6)}  n=${v.n}`)

console.log('\n── 按 类型:名字 前 N（self_size）──')
for (const r of nameRows) {
  const label = (r.type + ':' + r.name).slice(0, 90)
  console.log(`  ${fmt(r.bytes).padStart(10)}  ${fmtPct(r.bytes, total).padStart(6)}  n=${String(r.n).padStart(6)}  ${label}`)
}

if (topStrings.length > 0) {
  console.log('\n── 最长字符串（前 15，截前 70 字符）──')
  for (const s of topStrings) {
    const one = s.replace(/\s+/g, ' ')
    console.log(`  ${fmt(s.length * 2).padStart(10)}  ${one.slice(0, 70)}`)
  }
}

const summary = {
  file,
  generatedAt: new Date().toISOString(),
  nodeCount: count,
  totalSelfSize: total,
  strings: { count: strings.length, chars: strChars, dataCount, dataChars },
  byType: typeRows.map(([type, v]) => ({ type, ...v })),
  byName: nameRows.map((r) => ({ ...r })),
  topStrings: topStrings.map((s) => ({ chars: s.length, prefix: s.replace(/\s+/g, ' ').slice(0, 120) })),
}
const out = file.replace(/\.json(\.gz)?$/, '') + '.summary.json'
writeFileSync(out, JSON.stringify(summary, null, 2))
console.log(`\n汇总 JSON：${out}`)

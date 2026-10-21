/**
 * worker heap snapshot 抓取（2026-10-21 性能专项 · 内存归因）。
 *
 * 为什么需要：第四轮量到 worker 空闲 60s 时 **RSS 449MB / V8 heapUsed 131MB**，
 * 但 `[mem]` 只能给出总量；要判断这 131MB 是「缓存/字符串/代码/大 buffer」哪一类，
 * 必须拿 V8 heap snapshot 按 self_size 归因。
 *
 * 用法（在仓库根跑）：
 *   node scripts/perf/worker-heap.mjs --out-dir=working/heap
 *
 * 原理：`SUPERTIME_BACKEND_INSPECT=1` 会让主进程在**未打包**时给 utilityProcess
 * 加 `--inspect=127.0.0.1:<port>`（见 backend-supervisor.js），本脚本连该端口，
 * 用 CDP `HeapProfiler.takeHeapSnapshot` 分块收快照并以 gzip 落盘。
 *
 * 会抓两张：启动后 15s（总览已加载）与再等 45s（空闲稳态），用于对比「什么东西在涨」。
 * 不修改产品行为：inspect 只在显式 env + 未打包时开启；脚本结束关应用、清临时 profile。
 */
import { _electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 解析 `--key=value` 形式的参数。 */
function parseArgs (argv) {
  const out = {}
  for (const raw of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 连上 Node inspector，抓一张完整 heap snapshot。
 * @param {number} port - worker 的 inspector 端口。
 * @param {string} label - 落盘文件名前缀。
 * @param {string} outDir - 输出目录。
 * @returns {Promise<{ file: string, bytes: number, chunks: number }>} 结果。
 */
async function takeSnapshot (port, label, outDir) {
  const listUrl = `http://127.0.0.1:${port}/json/list`
  let targets = null
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(listUrl)
      targets = await res.json()
      if (Array.isArray(targets) && targets.length > 0) break
    } catch { /* worker 还没起来 */ }
    await sleep(250)
  }
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('连不上 worker inspector: ' + listUrl)
  const target = targets[0]
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const chunks = []
  const pending = new Map()
  let nextId = 1
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = (e) => reject(new Error('inspector WS 连接失败: ' + String(e?.message ?? e)))
  })
  ws.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
    } catch { return }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p === undefined) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(String(msg.error.message ?? 'CDP error')))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(msg.params.chunk)
  }
  try {
    await send('HeapProfiler.enable')
    // reportProgress=false：不要进度通知，只要分块；命令 resolve 时快照已完整。
    await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  } finally {
    try { ws.close() } catch { /* 已关闭 */ }
  }
  const json = chunks.join('')
  const file = join(outDir, `${label}.json.gz`)
  writeFileSync(file, gzipSync(Buffer.from(json, 'utf8'), { level: 6 }))
  return { file, bytes: Buffer.byteLength(json, 'utf8'), chunks: chunks.length }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const outDir = join(ROOT, String(args['out-dir'] ?? join('working', 'heap')))
  const port = Number(args.port ?? 9229)
  const firstWaitMs = Number(args['first-wait-ms'] ?? 15_000)
  const secondWaitMs = Number(args['second-wait-ms'] ?? 45_000)
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(EXE)) throw new Error('找不到 Electron：' + EXE)

  const userData = mkdtempSync(join(tmpdir(), 'st-heap-'))
  let app = null
  try {
    const { seedRealProfile } = await import(pathToFileURL(join(ROOT, 'scripts', 'real-profile.mjs')).href)
    const seeded = seedRealProfile(userData)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SUPERTIME_TEST_MODE
    env.SUPERTIME_USER_DATA_DIR = userData
    env.SUPERTIME_SKIP_ONBOARDING = '1'
    env.SUPERTIME_BACKEND_INSPECT = '1'
    env.SUPERTIME_BACKEND_INSPECT_PORT = String(port)

    console.log(`[worker-heap] 启动：dataRoot=${seeded.dataRoot} inspect=127.0.0.1:${port}`)
    app = await _electron.launch({ executablePath: EXE, args: [ROOT], cwd: ROOT, env })

    await sleep(firstWaitMs)
    const first = await takeSnapshot(port, 'worker-heap-startup', outDir)
    console.log(`[worker-heap] 启动快照：${first.file} (${(first.bytes / 1048576).toFixed(1)}MB JSON, ${first.chunks} chunks)`)

    await sleep(secondWaitMs)
    const second = await takeSnapshot(port, 'worker-heap-idle', outDir)
    console.log(`[worker-heap] 空闲快照：${second.file} (${(second.bytes / 1048576).toFixed(1)}MB JSON, ${second.chunks} chunks)`)

    // 顺带把 app.log 里的 [mem] 行打出来（RSS/heap/external/arrayBuffers 的对照读数）。
    try {
      const log = readFileSync(join(userData, 'wechat', 'logs', 'app.log'), 'utf8')
      for (const line of log.split(/\r?\n/)) {
        if (line.includes('[mem] rss=')) console.log('[worker-heap] ' + line.replace(/^\[[^\]]+\]\s*\[backend\]\s*/, ''))
      }
    } catch { /* 日志读不到不影响快照结论 */ }
    writeFileSync(join(outDir, 'worker-heap-meta.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      profile: { dataRoot: seeded.dataRoot, copied: seeded.copied },
      snapshots: [first, second],
    }, null, 2))
  } finally {
    try { await app?.close() } catch { /* 尽力关闭 */ }
    if (!args['keep-profile']) { try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ } }
    else console.log(`[worker-heap] 保留临时 profile: ${userData}`)
  }
}

main().catch((e) => {
  console.error('[worker-heap] 失败：', e?.stack ?? e)
  process.exitCode = 1
})

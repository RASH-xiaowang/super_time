#!/usr/bin/env node
/**
 * Super Time 运行时性能基线探针（可重复、可对比）。
 *
 * ## 它解决什么
 *
 * 这个仓库已有的量具大多是"某一次专项"的一次性脚本；性能优化前后要对比时，
 * 没有一份"同机、同数据、同口径、可重复"的读数。本脚本把 5 类指标收进一次运行：
 *
 *   ① 内存：主进程 WorkingSet / PrivateBytes（PowerShell `Get-Process`，OS 口径）
 *          + Electron `app.getAppMetrics()` 的 per-process 明细（主/渲染/GPU/后端 worker）
 *          + 渲染层 CDP `Runtime.getHeapUsage` / `Performance.getMetrics` / `Memory.getDOMCounters`。
 *   ② 资源加载：CDP Network 的逐请求时延聚合（按协议/类型）—— 因为实测本仓库渲染层的
 *          `performance.getEntriesByType('resource')` **恒为 0 条**（sandbox:true + file://），
 *          Resource Timing 不能直接当量具；两者读数都会落进 JSON。
 *   ③ 呈现耗时：启动首屏（launch→导航可见 / 后端 ready / 总览落定）、面板切换 P50/P95
 *          （rAF 采样到"文字稳定 + 无加载措辞 + 无骨架"的落定帧）。
 *   ④ 请求数量：IPC（主进程运行时包装 `ipcMain` handler，按通道计数 + `wechat:call` 时延）
 *          + 渲染层 HTTP/自定义协议请求（CDP）+ 后端调用队列 completed/execution 增量。
 *   ⑤ 缓存：图片解码缓存目录（decoded_images 文件数/新增字节）+ `wechat-media://` 请求数
 *          + HTTP 缓存命中标记（CDP response.from*Cache）+ query 结果缓存的**代理指标**
 *          （`wechat:call` 快调用占比、后端 execution P50/P95、慢调用日志条数）。
 *
 * ## 四个采样点
 *
 *   `startup-stable`（启动稳定态）→ 重载基线（量渲染层资源加载）→ 各面板切换
 *   → `image-panel`（打开图片密集面板后）→ `after-scroll`（批量滚动后）
 *   → `after-idle`（空闲 60s 后，含空载 CPU）。
 *
 * ## 用法（一行）
 *
 *   node scripts/perf/perf-baseline.mjs --samples=3 --out=working/perf/baseline/runtime-baseline.json
 *
 * 常用参数：
 *   --panels=overview,chats,moments,favorites,contacts  面板 id 列表（或写中文标题、`all`）
 *   --image-panel=moments                               「图片密集面板」用哪个（默认 moments）
 *   --samples=3                                         整个采集重复几次（跨样本取中位）
 *   --idle-ms=60000                                     空闲采样点时长
 *   --scroll-rounds=6                                   批量滚动轮数
 *   --no-reload                                         跳过"页面重载"资源加载采样
 *   --repeat-visits=2                                   每个面板访问几次（2 = 额外量一遍热缓存切换）
 *   --keep-profile                                      保留临时 profile（排查用；默认删）
 *   --verbose=true                                      打印每个阶段的行进日志
 *
 * ## 纪律
 *
 * - 产品代码只读：本脚本只做运行时包装与只读采样，不改 `src/**`、`main.js`、`preload.js`。
 * - 不改 `wechat/config.json`：用 `scripts/real-profile.mjs` 把**配置复制到临时 profile**，
 *   数据根仍指向应用自己解析出的真实数据根（只读数据库；图片解码缓存会正常写 decoded_images，
 *   这是应用本来的行为）。
 * - 报告不落任何真实用户数据：只提取数字/计数；URL 只保留尾部 70 字符且仅供定位资源类型。
 * - 启动方式与 `scripts/launch-app.mjs` 等价（同一个 electron.exe、同一个仓库根、同样摘掉
 *   `ELECTRON_RUN_AS_NODE`）；改用 playwright `_electron.launch` 是因为需要主进程侧
 *   `app.evaluate` 通道（IPC 计数 / 进程指标 / 关闭窗口），这是 launch-app 的 detached
 *   子进程给不了的。差异已写进 docs/perf/02-BASELINE.md 的"环境与方法"。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, freemem, totalmem } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from 'playwright'

import { parseArgs, numArg, strArg, listArg, boolArg } from './lib/args.mjs'
import { aggregateSeries, quantile, round } from './lib/stats.mjs'
import {
  installMainIpcProbe, readMainIpcProbe, readMainProcessMetrics,
  installImageTrackerInit, collectPageSnapshot, collectImagePhase,
  switchPanelAndMeasure, scrollPanelRounds, waitPanelSettled,
} from './lib/instrument.mjs'
import { CdpNetwork } from './lib/cdp-net.mjs'
import {
  snapshotProcesses, summarizeProcesses, decodedCacheStats, countDecodedFiles, collectHostInfo,
} from './lib/proc.mjs'
import { LogTail } from './lib/logs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/** 可见导航 id → 中文标题（与 `nav-config.ts` 的可见项一致；运行时会以 DOM 为准再校验）。 */
const PANEL_ID_TO_LABEL = {
  overview: '数据总览',
  ask: '微信问答',
  dailysummary: '总结',
  kb: '知识库',
  chats: '聊天会话',
  groupinsights: '群聊分析',
  contacts: '通讯录',
  moments: '朋友圈',
  favorites: '收藏与表情',
  files: '文件与存储',
  ledger: '资金往来',
  clawbot: 'ClawBot集群',
  tasks: '待办日程',
  taskinfo: '任务信息',
  oplog: '操作日志',
}
const LABEL_TO_PANEL_ID = Object.fromEntries(Object.entries(PANEL_ID_TO_LABEL).map(([k, v]) => [v, k]))

const USAGE = `Super Time 运行时性能基线探针

用法:
  node scripts/perf/perf-baseline.mjs [options]

选项:
  --panels=LIST          逗号分隔：面板 id（overview,chats,moments,…）、中文标题、或 all（默认 overview,chats,moments,favorites,contacts）
  --image-panel=ID       「图片密集面板」采样点用哪个面板（默认 moments）
  --samples=N            整轮采集重复次数（默认 3；跨样本取中位）
  --out=PATH             输出 JSON（默认 working/perf/baseline/runtime-baseline.json）
  --idle-ms=MS           空闲采样点时长（默认 60000）
  --scroll-rounds=N      批量滚动轮数（默认 6）
  --repeat-visits=N      每个面板访问次数（默认 1；2=额外量热缓存切换）
  --no-reload            跳过"页面重载"资源加载采样
  --max-switch-ms=MS     单次面板切换等待上限（默认 30000）
  --max-settle-ms=MS     启动/重载后落定等待上限（默认 45000）
  --keep-profile         保留临时 profile（默认删除）
  --verbose=true         打印阶段日志
  --help                 显示本帮助
`

/**
 * 解析 CLI。
 * @returns {ReturnType<typeof buildConfig>}
 */
function buildConfig () {
  const { values } = parseArgs(process.argv.slice(2))
  if (values.help) { console.log(USAGE); process.exit(0) }
  const warn = (msg) => console.warn('[warn] ' + msg)
  const samples = Math.max(1, Math.round(numArg(values, 'samples', 3, warn)))
  const outRaw = strArg(values, 'out', join('working', 'perf', 'baseline', 'runtime-baseline.json'))
  return {
    panels: listArg(values, 'panels', ['overview', 'chats', 'moments', 'favorites', 'contacts']),
    imagePanel: strArg(values, 'image-panel', 'moments'),
    samples,
    out: isAbsolute(outRaw) ? outRaw : join(ROOT, outRaw),
    idleMs: Math.max(0, Math.round(numArg(values, 'idle-ms', 60000, warn))),
    scrollRounds: Math.max(0, Math.round(numArg(values, 'scroll-rounds', 6, warn))),
    repeatVisits: Math.max(1, Math.round(numArg(values, 'repeat-visits', 1, warn))),
    reload: boolArg(values, 'reload', true),
    maxSwitchMs: Math.max(1000, Math.round(numArg(values, 'max-switch-ms', 30000, warn))),
    maxSettleMs: Math.max(1000, Math.round(numArg(values, 'max-settle-ms', 45000, warn))),
    keepProfile: boolArg(values, 'keep-profile', false),
    verbose: boolArg(values, 'verbose', false),
    tag: strArg(values, 'tag', '') || null,
  }
}

const log = (verbose, ...args) => { if (verbose) console.log(...args) }

/**
 * IPC 累计快照做差（按通道）。
 * @returns {{ total: number, byChannel: Record<string, number>, wechatCallCount: number }}
 */
function diffIpc (before, after) {
  if (!before || !after || !before.installed || !after.installed) {
    return { total: 0, byChannel: {}, wechatCallCount: 0 }
  }
  const byChannel = {}
  for (const k of new Set([...Object.keys(before.byChannel), ...Object.keys(after.byChannel)])) {
    const d = (after.byChannel[k] || 0) - (before.byChannel[k] || 0)
    if (d !== 0) byChannel[k] = d
  }
  return { total: after.total - before.total, byChannel, wechatCallCount: after.wechatCall.count - before.wechatCall.count }
}

/** 后端状态两次快照做差（completed/failed 是累计计数）。 */
function diffBackend (before, after) {
  if (!before || !after) return null
  const qb = before.callQueue
  const qa = after.callQueue
  return {
    stateBefore: before.state,
    stateAfter: after.state,
    completedDelta: qa && qb ? qa.completed - qb.completed : null,
    failedDelta: qa && qb ? qa.failed - qb.failed : null,
    queuedAtEnd: qa?.queued ?? null,
    activeAtEnd: qa?.active ?? null,
    rejectedAtEnd: qa?.rejected ?? null,
    waitAtEnd: qa?.wait ?? null,
    executionAtEnd: qa?.execution ?? null,
    channelsAtEnd: qa?.channels ?? null,
    rpcAtEnd: after.rpc ?? null,
    mutationAtEnd: after.mutation ?? null,
  }
}

/** 渲染层 console error / pageerror：只留计数与脱敏后的短文本。 */
function redact (text) {
  return String(text)
    .replace(/https?:\/\/[^\s"']+/g, '<url>')
    .replace(/wechat-media:\/\/[^\s"']+/g, '<media>')
    .replace(/[A-Za-z]:\\[^\s"']{6,}/g, '<path>')
    .slice(0, 160)
}

/* ═══════════════════════════ 单个样本（一次启动） ═══════════════════════════ */

/**
 * 跑一个样本：启动应用 → 四个采样点 → 关闭。任何阶段失败都记进 sample.errors，不中断其它样本。
 * @param {{ index: number, cfg: ReturnType<typeof buildConfig>, hostInfo: object }} args
 */
async function runSample ({ index, cfg, hostInfo }) {
  const warn = (msg) => console.warn(`[sample ${index}] [warn] ${msg}`)
  const userData = mkdtempSync(join(tmpdir(), 'st-perf-'))
  const sample = {
    index,
    startedAt: new Date().toISOString(),
    // 同机同期可能有其它角色的探针/vitest 在跑（共享机器）；记下空载才有的可比性前提。
    hostLoadAtStart: { freeMemBytes: freemem(), totalMemBytes: totalmem() },
    userData: 'temporary seeded profile（真实配置复制，数据根指向应用解析出的真实目录）',
    errors: [],
    warnings: [],
    launch: {},
    reload: null,
    snapshots: {},
    phases: {},
    panelSwitches: [],
    peaks: { mainWorkingSetBytes: 0, rendererWorkingSetBytes: 0, backendWorkerWorkingSetBytes: 0, totalWorkingSetBytes: 0, mainNodeRssBytes: 0, rendererCdpHeapUsedBytes: 0, rendererJsHeapUsedSize: 0 },
    durationMs: 0,
  }
  const startedWall = Date.now()

  let app = null
  let win = null
  let cdp = null
  let net = null
  let logTail = null
  let decodedDir = null
  let mainPid = null
  const rendererConsoleErrors = []
  const pageErrors = []
  let ipcProbeInstalledMs = null
  const state = { prevNetMark: null, prevIpc: null, prevPerf: null, lastSnapshotAt: Date.now() }

  try {
    const seeded = (await import(pathToFileURL(join(ROOT, 'scripts', 'real-profile.mjs')).href)).seedRealProfile(userData)
    decodedDir = join(seeded.dataRoot, 'decoded_images')
    logTail = new LogTail(join(userData, 'wechat', 'logs', 'app.log'))
    sample.profile = { dataRootExists: existsSync(seeded.dataRoot), copied: seeded.copied, dataRootIsReal: true }

    const env = { ...process.env }
    const hadRunAsNode = env.ELECTRON_RUN_AS_NODE !== undefined
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SUPERTIME_TEST_MODE // 不让外部环境把 UI 切成"自动化窗口"横幅（影响 DOM/布局）
    env.SUPERTIME_USER_DATA_DIR = userData
    env.SUPERTIME_SKIP_ONBOARDING = '1'
    sample.launch.envStrippedRunAsNode = hadRunAsNode
    sample.launch.skipOnboarding = true

    if (!existsSync(EXE)) throw new Error('找不到 Electron：' + EXE)
    const tLaunch = Date.now()
    app = await _electron.launch({ executablePath: EXE, args: [ROOT], cwd: ROOT, env })
    sample.launch.firstWindowAtMs = Date.now() - tLaunch

    // ① 尽早在主进程装 IPC 探针（窗口创建前后都算启动期；包装前已发生的调用不在计数内）
    try {
      const meta = await app.evaluate(installMainIpcProbe)
      mainPid = await app.evaluate(() => process.pid)
      ipcProbeInstalledMs = Date.now() - tLaunch
      sample.launch.ipcProbe = { ...meta, installedAtMs: ipcProbeInstalledMs }
    } catch (e) {
      warn('主进程 IPC 探针安装失败（IPC 计数将降级为 0）：' + redact(e.message))
      sample.warnings.push('IPC 探针安装失败')
    }

    win = await app.firstWindow()
    win.setDefaultTimeout(60000)
    win.on('console', (m) => {
      if (m.type() === 'error') rendererConsoleErrors.push(redact(m.text()))
    })
    win.on('pageerror', (e) => pageErrors.push(redact('pageerror: ' + String(e.message))))

    // 图片生命周期追踪：当前文档 + 之后每次导航（reload）
    await win.addInitScript(installImageTrackerInit)
    await win.evaluate(installImageTrackerInit)

    // CDP：堆 / DOM 计数 / 渲染指标 / 逐请求时延
    cdp = await win.context().newCDPSession(win)
    net = new CdpNetwork(cdp)
    await cdp.send('Network.enable')
    await cdp.send('Performance.enable')

    await win.waitForLoadState('domcontentloaded')

    const waitNavVisible = async (timeoutMs) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        const ok = await win.evaluate(() => {
          const nav = document.querySelector('aside nav') || document.querySelector('nav')
          return Boolean(nav && nav.querySelectorAll('button').length >= 5)
        }).catch(() => false)
        if (ok) return Date.now() - t0
        await sleep(50)
      }
      throw new Error('导航栏在 ' + timeoutMs + 'ms 内未出现')
    }
    sample.launch.navVisibleAtMs = Date.now() - tLaunch
    const navWait = await waitNavVisible(cfg.maxSettleMs)
    sample.launch.navWaitMs = navWait
    sample.launch.navVisibleAtMs = Date.now() - tLaunch

    const navLabels = await win.evaluate(() => {
      const nav = document.querySelector('aside nav') || document.querySelector('nav')
      return [...nav.querySelectorAll('button')].map((b) => (b.getAttribute('title') || b.textContent || '').trim()).filter(Boolean)
    })
    sample.navLabels = navLabels

    // 解析面板参数（支持 id / 中文标题 / all）
    let resolvedPanels
    if (cfg.panels.includes('all') || cfg.panels.includes('*')) resolvedPanels = [...navLabels]
    else {
      resolvedPanels = []
      for (const token of cfg.panels) {
        if (navLabels.includes(token)) { resolvedPanels.push(token); continue }
        const mapped = PANEL_ID_TO_LABEL[token]
        if (mapped && navLabels.includes(mapped)) { resolvedPanels.push(mapped); continue }
        warn(`面板 "${token}" 不在当前可见导航里，已跳过`)
        sample.warnings.push('未找到面板: ' + token)
      }
    }
    if (resolvedPanels.length === 0) throw new Error('没有可用的面板（--panels 全部解析失败）')
    let imagePanelLabel = navLabels.includes(cfg.imagePanel)
      ? cfg.imagePanel
      : (PANEL_ID_TO_LABEL[cfg.imagePanel] && navLabels.includes(PANEL_ID_TO_LABEL[cfg.imagePanel]))
        ? PANEL_ID_TO_LABEL[cfg.imagePanel]
        : null
    if (imagePanelLabel === null) {
      imagePanelLabel = navLabels.includes('朋友圈') ? '朋友圈' : resolvedPanels[resolvedPanels.length - 1]
      warn(`--image-panel=${cfg.imagePanel} 解析失败，改用「${imagePanelLabel}」`)
    }
    sample.resolved = { panels: resolvedPanels, imagePanel: imagePanelLabel }

    /** 读后端状态（一次 IPC）。 */
    const readBackendState = () => win.evaluate(async () => {
      try {
        const r = await window.electronAPI.wechat.backendState()
        return r && r.value ? r.value : { error: 'no value' }
      } catch (e) { return { error: String(e).slice(0, 120) } }
    })
    /** 主进程 IPC 累计快照（不产生 IPC）。 */
    const readIpcCum = () => app.evaluate(readMainIpcProbe)
    const pagePerfNow = () => win.evaluate(() => performance.now())

    /**
     * 等渲染层网络静默（连续 `idleMs` 没有新的请求结束）。
     *
     * 为什么要它：面板"文字稳定"不等于"图/懒加载都到位"——实测朋友圈切过去文字 200ms 内就稳定，
     * 但图片 data URL 请求还会再持续 0.5~2s；不整流的话同一面板在两次运行里会落在不同加载阶段，
     * 请求数/内存/图片数全是噪声。等待上限故意较短（默认 6s），超时只记 `quiet:false`，不伪造静默。
     */
    const waitNetworkQuiet = async ({ idleMs = 400, timeoutMs = 6000, stepMs = 150 } = {}) => {
      const start = Date.now()
      let lastSeq = net.mark().seq
      let lastChange = Date.now()
      while (Date.now() - start < timeoutMs) {
        await sleep(stepMs)
        const seq = net.mark().seq
        if (seq !== lastSeq) { lastSeq = seq; lastChange = Date.now() } else if (Date.now() - lastChange >= idleMs) {
          return { quiet: true, waitedMs: Date.now() - start, requestsObserved: seq }
        }
      }
      return { quiet: false, waitedMs: Date.now() - start, requestsObserved: lastSeq }
    }

    /**
     * 等后端调用队列排空。
     *
     * 为什么测面板切换前要等：重载/上一个面板可能刚压了十几~几十个重查询，队列里还排着。
     * 不等的话"同一个面板"的切换耗时会在 150ms 与 1800ms 之间跳（实测），噪声比优化收益还大。
     * 超时只记录 `idle:false`，不把"没排空"伪装成"已排空"。
     */
    const waitBackendIdle = async ({ timeoutMs = 8000, pollMs = 150 } = {}) => {
      const start = Date.now()
      let last = null
      while (Date.now() - start < timeoutMs) {
        last = await readBackendState()
        const q = last?.callQueue
        if (q && (q.active ?? 0) === 0 && (q.queued ?? 0) === 0) {
          return { idle: true, waitedMs: Date.now() - start, queueCompletedAtEnd: q.completed ?? null }
        }
        await sleep(pollMs)
      }
      return { idle: false, waitedMs: Date.now() - start, lastQueue: last?.callQueue ? { active: last.callQueue.active, queued: last.callQueue.queued, completed: last.callQueue.completed } : null }
    }

    // 等后端 ready（后端没 ready 时所有面板都是骨架屏，量了没意义）
    {
      const t0 = Date.now()
      let last = null
      let readyMs = -1
      while (Date.now() - t0 < cfg.maxSettleMs) {
        last = await readBackendState()
        if (last?.state === 'ready') { readyMs = Date.now() - t0; break }
        await sleep(250)
      }
      sample.launch.backendReadyMs = readyMs
      sample.launch.backendStateAtReady = last ? { state: last.state, restarts: last.restarts, lastError: last.lastError ? redact(String(last.lastError)) : null } : null
      if (readyMs < 0) sample.warnings.push('后端未在期限内 ready（面板可能为空态）')
    }

    // 归位到「数据总览」并等落定
    const activeLabel = () => win.evaluate(() => {
      const b = document.querySelector('aside nav button[data-active], nav button[data-active]')
      return b ? (b.getAttribute('title') || b.textContent || '').trim() : null
    })
    if ((await activeLabel()) !== '数据总览') {
      await win.evaluate(switchPanelAndMeasure, { label: '数据总览', minMs: 200, maxMs: cfg.maxSwitchMs })
    }
    const overviewSettle = await win.evaluate(waitPanelSettled, { minMs: 600, maxMs: cfg.maxSettleMs })
    sample.launch.overviewSettledMs = Date.now() - tLaunch
    sample.launch.overviewSettle = overviewSettle

    // ── 核心：一次快照 ────────────────────────────────────────────────
    const updatePeaks = (psSum, mainMetrics, cdpHeap, perfMetrics) => {
      const bc = psSum.byClass
      sample.peaks.mainWorkingSetBytes = Math.max(sample.peaks.mainWorkingSetBytes, bc.main?.workingSetBytes ?? 0)
      sample.peaks.rendererWorkingSetBytes = Math.max(sample.peaks.rendererWorkingSetBytes, bc.renderer?.workingSetBytes ?? 0)
      sample.peaks.backendWorkerWorkingSetBytes = Math.max(sample.peaks.backendWorkerWorkingSetBytes, bc['backend-worker']?.workingSetBytes ?? 0)
      sample.peaks.totalWorkingSetBytes = Math.max(sample.peaks.totalWorkingSetBytes, psSum.totalWorkingSetBytes ?? 0)
      sample.peaks.mainNodeRssBytes = Math.max(sample.peaks.mainNodeRssBytes, mainMetrics.nodeMem?.rssBytes ?? 0)
      sample.peaks.rendererCdpHeapUsedBytes = Math.max(sample.peaks.rendererCdpHeapUsedBytes, cdpHeap?.usedSize ?? 0)
      sample.peaks.rendererJsHeapUsedSize = Math.max(sample.peaks.rendererJsHeapUsedSize, perfMetrics?.raw?.JSHeapUsedSize ?? 0)
    }

    /**
     * 采一次完整快照。
     * @param {string} label - 采样点名（startup-stable / image-panel / after-scroll / after-idle / reload）
     * @param {{ phaseStartWallMs?: number, phaseStartPerf?: number, fullImageScan?: boolean, decodedSinceMs?: number }} [opts]
     */
    const takeSnapshot = async (label, opts = {}) => {
      const wall = Date.now()
      const page = await win.evaluate(collectPageSnapshot, { fullImageScan: opts.fullImageScan !== false })
      const imagePhase = opts.phaseStartPerf != null ? await win.evaluate(collectImagePhase, { sincePerf: opts.phaseStartPerf }) : null
      let cdpHeap = null
      try { cdpHeap = await cdp.send('Runtime.getHeapUsage') } catch (e) { cdpHeap = { error: redact(e.message) } }
      let domCounters = null
      try { domCounters = await cdp.send('Memory.getDOMCounters') } catch (e) { domCounters = { error: redact(e.message) } }
      let perfMetrics = null
      try {
        const perf = await cdp.send('Performance.getMetrics')
        const obj = {}
        for (const m of perf.metrics ?? []) obj[m.name] = m.value
        const prev = state.prevPerf
        const delta = (k, unit = 1) => {
          if (!prev || !Number.isFinite(obj[k]) || !Number.isFinite(prev[k])) return null
          const d = (obj[k] - prev[k]) * unit
          return d < 0 ? null : Math.round(d * 100) / 100
        }
        perfMetrics = {
          raw: {
            JSHeapUsedSize: obj.JSHeapUsedSize ?? null,
            JSHeapTotalSize: obj.JSHeapTotalSize ?? null,
            Nodes: obj.Nodes ?? null,
            Documents: obj.Documents ?? null,
            LayoutObjects: obj.LayoutObjects ?? null,
            JSEventListeners: obj.JSEventListeners ?? null,
            LayoutCount: obj.LayoutCount ?? null,
            RecalcStyleCount: obj.RecalcStyleCount ?? null,
            LayoutDurationSec: obj.LayoutDuration ?? null,
            RecalcStyleDurationSec: obj.RecalcStyleDuration ?? null,
            ScriptDurationSec: obj.ScriptDuration ?? null,
            TaskDurationSec: obj.TaskDuration ?? null,
          },
          deltaSincePrevSnapshot: {
            LayoutCount: delta('LayoutCount'),
            RecalcStyleCount: delta('RecalcStyleCount'),
            LayoutDurationMs: delta('LayoutDuration', 1000),
            RecalcStyleDurationMs: delta('RecalcStyleDuration', 1000),
            ScriptDurationMs: delta('ScriptDuration', 1000),
            TaskDurationMs: delta('TaskDuration', 1000),
          },
        }
        state.prevPerf = obj
      } catch (e) { perfMetrics = { error: redact(e.message) } }

      const mainMetrics = await app.evaluate(readMainProcessMetrics)
      const ipc = await app.evaluate(readMainIpcProbe)
      const backend = await readBackendState() // 本快照之后才读 ipc 的下一次快照会含这 1 次
      const ps = await snapshotProcesses(mainMetrics.mainPid)
      const psSum = summarizeProcesses(ps.processes ?? [])
      // 把 Electron 的 per-process 指标按进程树分类 join 到 cls 上（否则只能看到 type=Utility，
      // 分不出哪个是后端 worker）。appMetrics 只含本实例进程，PID 与 PowerShell 的快照按 pid 对齐。
      const clsByPid = new Map()
      for (const [cls, v] of Object.entries(psSum.byClass ?? {})) for (const pid of v.pids ?? []) clsByPid.set(pid, cls)
      const appMetricsJoined = (mainMetrics.appMetrics ?? []).map((x) => ({ ...x, cls: clsByPid.get(x.pid) ?? 'unknown' }))
      const backendWorkerAppMetrics = appMetricsJoined.find((x) => x.cls === 'backend-worker') ?? null
      const rendererAppMetrics = appMetricsJoined.filter((x) => x.cls === 'renderer')
      const decoded = await decodedCacheStats(decodedDir, opts.decodedSinceMs ?? opts.phaseStartWallMs ?? 0)
      const logDelta = await logTail.readDelta()
      const netMark = net.mark()
      const netDelta = state.prevNetMark ? net.deltaSince(state.prevNetMark) : null
      state.prevNetMark = netMark
      const ipcDelta = state.prevIpc ? diffIpc(state.prevIpc, ipc) : null
      state.prevIpc = ipc
      updatePeaks(psSum, mainMetrics, cdpHeap, perfMetrics)
      state.lastSnapshotAt = Date.now()

      return {
        label,
        atWallMs: wall,
        afterLaunchMs: wall - tLaunch,
        phaseStartWallMs: opts.phaseStartWallMs ?? wall,
        mainProcess: {
          pid: mainMetrics.mainPid,
          uptimeSec: mainMetrics.uptimeSec,
          nodeMem: mainMetrics.nodeMem,
          osProcess: psSum.byClass.main ?? null,
        },
        electronVersions: mainMetrics.versions,
        electronAppMetrics: appMetricsJoined,
        osProcesses: psSum,
        osProcessSnapshotError: ps.error ?? null,
        renderer: {
          cdpHeap,
          perfMetrics,
          domCounters,
          performanceMemory: page.rendererMemory ?? null,
          osProcess: psSum.byClass.renderer ?? null,
          appMetrics: rendererAppMetrics,
        },
        backendWorker: psSum.byClass['backend-worker'] ?? null,
        backendWorkerAppMetrics,
        gpu: psSum.byClass.gpu ?? null,
        page,
        imagePhase,
        ipc: { ...ipc, deltaSincePrevSnapshot: ipcDelta },
        backend,
        decodedCache: decoded,
        logs: { delta: logDelta, totals: logTail.snapshot() },
        network: { sinceStart: netMark, deltaSincePrevSnapshot: netDelta },
        rendererConsoleErrorCount: rendererConsoleErrors.length,
        pageErrorCount: pageErrors.length,
      }
    }

    /** 阶段游标：开始一次「面板切换 / 滚动 / 空闲」的增量采集。 */
    const beginPhase = async (phaseLabel) => {
      const ipcBaselineBefore = await readIpcCum()
      const backendBefore = await readBackendState()
      const ipcBaseline = await readIpcCum() // 把上面这次探针 IPC 计入基线，保证增量里只有业务调用
      void ipcBaselineBefore
      return {
        phaseLabel,
        wall: Date.now(),
        ipcBaseline,
        backendBefore,
        netMark: net.mark(),
        logTotalsBefore: { ...logTail.totals },
        logSlowBefore: logTail.slowCalls.length,
        decodedFilesBefore: await countDecodedFiles(decodedDir),
        pagePerfStart: await pagePerfNow(),
      }
    }

    /** 结束阶段游标：返回纯业务增量。 */
    const finishPhase = async (cursor, extra = {}) => {
      const ipcAfter = await readIpcCum()
      const ipcDelta = diffIpc(cursor.ipcBaseline, ipcAfter)
      const backendAfter = await readBackendState()
      const netDelta = net.deltaSince(cursor.netMark)
      const decoded = await decodedCacheStats(decodedDir, cursor.wall)
      const logDelta = await logTail.readDelta()
      const imagePhase = await win.evaluate(collectImagePhase, { sincePerf: cursor.pagePerfStart })
      const elapsedMs = Date.now() - cursor.wall
      return {
        elapsedMs,
        ipc: { ...ipcDelta, byChannel: ipcDelta.byChannel },
        backend: diffBackend(cursor.backendBefore, backendAfter),
        network: netDelta,
        decoded: {
          filesBefore: cursor.decodedFilesBefore,
          filesAfter: decoded.files,
          deltaFiles: decoded.deltaFiles,
          deltaBytes: decoded.deltaBytes,
          changedDirs: decoded.changedDirs,
          error: decoded.error ?? null,
        },
        images: imagePhase,
        logs: {
          delta: logDelta,
          markersTotal: { ...logTail.totals },
          slowCallsTotal: logTail.slowCalls.length,
        },
        ...extra,
      }
    }

    // ── 采样点 A：启动稳定态 ─────────────────────────────────────────
    log(cfg.verbose, `[sample ${index}] 启动完成：nav=${sample.launch.navVisibleAtMs}ms backend=${sample.launch.backendReadyMs}ms overviewSettle=${sample.launch.overviewSettledMs}ms`)
    // 总览落定后仍可能有一两批图表/头像在画：等网络静默 + 1.5s，才是"用户停下来看到的稳定态"。
    // （少了这段，实测总览头像/图表还没挂上，会把启动态内存量低、图片数记成 0。）
    sample.launch.startupNetworkQuiet = await waitNetworkQuiet({ idleMs: 600, timeoutMs: 12000 })
    await sleep(1500)
    const startup = await takeSnapshot('startup-stable', { fullImageScan: true, phaseStartPerf: 0, phaseStartWallMs: tLaunch, decodedSinceMs: tLaunch })
    startup.startup = {
      navVisibleAtMs: sample.launch.navVisibleAtMs,
      backendReadyMs: sample.launch.backendReadyMs,
      overviewSettledMs: sample.launch.overviewSettledMs,
      firstWindowAtMs: sample.launch.firstWindowAtMs,
      ipcProbeInstalledAtMs: ipcProbeInstalledMs,
      rendererNavigation: startup.page.timing,
      ipcSinceProbeInstalled: { total: startup.ipc.total, byChannel: startup.ipc.byChannel, wechatCalls: startup.ipc.wechatCall?.count ?? 0 },
    }
    sample.snapshots.startupStable = startup

    // ── 重载基线：渲染层资源加载（Resource Timing 的替代量具）──────────
    if (cfg.reload) {
      log(cfg.verbose, `[sample ${index}] 页面重载，采渲染层资源加载…`)
      const cursor = await beginPhase('reload')
      const tReload = Date.now()
      await win.reload({ waitUntil: 'domcontentloaded' })
      const reloadNavWait = await waitNavVisible(cfg.maxSettleMs)
      // 后端早已 ready：等落定即可
      const reloadSettle = await win.evaluate(waitPanelSettled, { minMs: 800, maxMs: cfg.maxSettleMs })
      const reloadQuiet = await waitNetworkQuiet({ idleMs: 500, timeoutMs: 8000 })
      const reloadPhase = await finishPhase(cursor, { reloadNavWaitMs: reloadNavWait, reloadSettle, reloadQuiet })
      // 导航后 Performance 计数器会重置，别让 reload 快照的 delta 变成负数（置空后只留原始值）
      state.prevPerf = null
      const reloadPageSnap = await takeSnapshot('reload', { fullImageScan: false, phaseStartWallMs: cursor.wall, decodedSinceMs: cursor.wall })
      try { await cdp.send('Performance.enable') } catch { /* ignore */ }
      sample.reload = {
        reloadMs: Date.now() - tReload,
        navWaitMs: reloadNavWait,
        settle: reloadSettle,
        phase: reloadPhase,
        navigation: reloadPageSnap.page.timing,
        paints: reloadPageSnap.page.timing.paints,
        page: { viewport: reloadPageSnap.page.viewport, images: reloadPageSnap.page.images },
        ipc: reloadPhase.ipc,
        backend: reloadPhase.backend,
        network: reloadPhase.network,
        logs: reloadPhase.logs.delta,
      }
    }

    // ── 采样点：面板切换（含图片密集面板）─────────────────────────────
    const visited = new Set()
    const doSwitch = async (label, visit) => {
      // 先把后端队列放空再点，避免把"重载/上一次面板压在队里的重查询"算进切换耗时
      const backendIdle = await waitBackendIdle({ timeoutMs: 8000 })
      const cursor = await beginPhase('switch:' + label)
      const sw = await win.evaluate(switchPanelAndMeasure, { label, minMs: 150, maxMs: cfg.maxSwitchMs })
      // 让"文字落定"之后的图片/懒加载收尾（最多等 5s；超时只记录，不伪造）
      const quiet = await waitNetworkQuiet({ idleMs: 350, timeoutMs: 5000 })
      await sleep(80)
      const phase = await finishPhase(cursor)
      const panelId = LABEL_TO_PANEL_ID[label] ?? label
      const record = {
        panelId,
        label,
        visit,
        ok: sw.ok !== false,
        error: sw.error ?? null,
        backendIdleBefore: backendIdle,
        settleMs: sw.settleMs ?? null,
        networkQuiet: quiet,
        firstFrameMs: sw.firstFrameMs ?? null,
        stateChangedMs: sw.stateChangedMs ?? null,
        firstContentMs: sw.firstContentMs ?? null,
        preActiveLabel: sw.preActiveLabel ?? null,
        postTextLen: sw.postTextLen ?? null,
        scrollHeight: sw.scrollHeight ?? null,
        reason: sw.reason ?? null,
        ipc: phase.ipc,
        backend: phase.backend,
        network: phase.network,
        decoded: phase.decoded,
        images: phase.images,
        logs: { markers: phase.logs.delta.markers, slowCalls: phase.logs.delta.slowCalls },
        rendererConsoleErrorCount: rendererConsoleErrors.length,
        pageErrorCount: pageErrors.length,
      }
      sample.panelSwitches.push(record)
      return record
    }

    const panelsToVisit = resolvedPanels.filter((l) => l !== '数据总览')
    for (const label of panelsToVisit) {
      log(cfg.verbose, `[sample ${index}] 切换面板：${label}`)
      const rec = await doSwitch(label, 1)
      visited.add(label)
      log(cfg.verbose, `  → settle=${rec.settleMs}ms ipc=${rec.ipc.total} backendCompleted=${rec.backend?.completedDelta} req=${rec.network?.requests} imgs=${rec.images?.newImages}`)
      if (label === imagePanelLabel) {
        await sleep(1200)
        const phasePerf = await pagePerfNow()
        // decoded 增量窗口 = 从切换开始前 100ms 起（切换里产生的解码写盘都算"打开本面板后"）
        const sinceWall = Date.now() - ((rec?.settleMs ?? 0) + 100 + 1200)
        sample.snapshots.imagePanel = await takeSnapshot('image-panel', { fullImageScan: false, phaseStartWallMs: Date.now(), phaseStartPerf: phasePerf, decodedSinceMs: sinceWall })
      }
      // 热缓存切换（可选）：再点一次同面板，记录 visit=2
      for (let v = 2; v <= cfg.repeatVisits; v++) {
        // 先离开再回来，确保是真切换
        await win.evaluate(switchPanelAndMeasure, { label: '数据总览', minMs: 120, maxMs: cfg.maxSwitchMs })
        const rec2 = await doSwitch(label, v)
        log(cfg.verbose, `  → 热切换 v${v} settle=${rec2.settleMs}ms`)
      }
    }

    // 图片密集面板若不在 --panels 里，补一次切换 + 采样点 B
    if (!sample.snapshots.imagePanel) {
      log(cfg.verbose, `[sample ${index}] 补充切换图片密集面板：${imagePanelLabel}`)
      const rec = await doSwitch(imagePanelLabel, 1)
      await sleep(1200)
      const phasePerf = await pagePerfNow()
      const sinceWall = Date.now() - ((rec?.settleMs ?? 0) + 100 + 1200)
      sample.snapshots.imagePanel = await takeSnapshot('image-panel', { fullImageScan: false, phaseStartWallMs: Date.now(), phaseStartPerf: phasePerf, decodedSinceMs: sinceWall })
    }

    // ── 采样点 C：批量滚动 ────────────────────────────────────────────
    {
      // 滚动要在**图片密集面板**上做（长列表/懒加载都在它身上）；遍历完 --panels 后
      // 当前面板大概率是最后一个，先切回来。这次切换不算入面板切换统计（不调 doSwitch）。
      const activeNow = await activeLabel()
      if (activeNow !== imagePanelLabel) {
        log(cfg.verbose, `[sample ${index}] 回到图片密集面板再滚动：${imagePanelLabel}`)
        await win.evaluate(switchPanelAndMeasure, { label: imagePanelLabel, minMs: 150, maxMs: cfg.maxSwitchMs })
        await sleep(800)
      }
      log(cfg.verbose, `[sample ${index}] 批量滚动 ${cfg.scrollRounds} 轮…`)
      const scrollBackendIdle = await waitBackendIdle({ timeoutMs: 8000 })
      const cursor = await beginPhase('scroll')
      const scroll = await win.evaluate(scrollPanelRounds, { rounds: cfg.scrollRounds, stepRatio: 0.85, waitMs: 220 })
      await sleep(900)
      const scrollQuiet = await waitNetworkQuiet({ idleMs: 500, timeoutMs: 6000 })
      const phase = await finishPhase(cursor, { scroll, scrollQuiet, scrollBackendIdle })
      sample.phases.scroll = phase
      sample.snapshots.afterScroll = await takeSnapshot('after-scroll', {
        fullImageScan: false,
        phaseStartWallMs: cursor.wall,
        phaseStartPerf: cursor.pagePerfStart,
        decodedSinceMs: cursor.wall,
      })
      log(cfg.verbose, `  → scrollable=${scroll.scrollable} scrollTop=${scroll.scrollTopBefore}→${scroll.scrollTopAfter} newImgs=${phase.images.newImages}`)
    }

    // ── 采样点 D：空闲 60s（含空载 CPU / 内存是否回落）────────────────
    {
      log(cfg.verbose, `[sample ${index}] 空闲 ${cfg.idleMs}ms…`)
      const idleBefore = await app.evaluate(readMainProcessMetrics)
      const psBefore = await snapshotProcesses(idleBefore.mainPid)
      const psBeforeSum = summarizeProcesses(psBefore.processes ?? [])
      const t0 = Date.now()
      const idlePerf = await pagePerfNow()
      await sleep(cfg.idleMs)
      const elapsedMs = Date.now() - t0
      const idleSnapshot = await takeSnapshot('after-idle', {
        fullImageScan: false,
        phaseStartWallMs: t0,
        phaseStartPerf: idlePerf,
        decodedSinceMs: t0,
      })
      const psAfter = await snapshotProcesses(idleBefore.mainPid)
      const psAfterSum = summarizeProcesses(psAfter.processes ?? [])
      const cpuDelta = {}
      for (const cls of Object.keys(psAfterSum.byClass)) {
        const b = psBeforeSum.byClass[cls]?.cpuSeconds ?? 0
        const a = psAfterSum.byClass[cls]?.cpuSeconds ?? 0
        cpuDelta[cls] = {
          cpuSecondsDelta: round(a - b, 2),
          avgCorePercent: elapsedMs > 0 ? round(((a - b) / (elapsedMs / 1000)) * 100, 1) : null,
          workingSetDeltaBytes: (psAfterSum.byClass[cls]?.workingSetBytes ?? 0) - (psBeforeSum.byClass[cls]?.workingSetBytes ?? 0),
        }
      }
      sample.idle = {
        idleMs: elapsedMs,
        cpu: { durationMs: elapsedMs, byClass: cpuDelta, logicalProcessors: hostInfo.cpu?.logicalProcessors ?? null },
        memory: {
          totalWorkingSetDeltaBytes: psAfterSum.totalWorkingSetBytes - psBeforeSum.totalWorkingSetBytes,
          byClassWorkingSetDelta: Object.fromEntries(Object.keys(psAfterSum.byClass).map((c) => [c, (psAfterSum.byClass[c]?.workingSetBytes ?? 0) - (psBeforeSum.byClass[c]?.workingSetBytes ?? 0)])),
        },
      }
      sample.snapshots.afterIdle = idleSnapshot
    }

    sample.rendererConsoleErrors = { count: rendererConsoleErrors.length, samples: rendererConsoleErrors.slice(0, 5) }
    sample.pageErrors = { count: pageErrors.length, samples: pageErrors.slice(0, 5) }
  } catch (e) {
    sample.errors.push(redact((e && e.stack) || e))
    console.error(`[sample ${index}] 失败：` + redact(e && e.message ? e.message : e))
  } finally {
    if (app) { try { await app.close() } catch { /* ignore */ } }
    if (!cfg.keepProfile) { try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ } }
    else console.log(`[sample ${index}] 保留临时 profile: ${userData}`)
    sample.hostLoadAtEnd = { freeMemBytes: freemem(), totalMemBytes: totalmem() }
    sample.durationMs = Date.now() - startedWall
  }
  return sample
}

/* ═══════════════════════════ 汇总 ═══════════════════════════ */

/**
 * 从样本里抽取「报告要用的扁平淡数值表」，供跨样本取中位/噪声带。
 * @param {object} sample
 * @returns {Record<string, number>}
 */
function extractMetrics (sample) {
  const m = {}
  const put = (key, value) => { if (typeof value === 'number' && Number.isFinite(value)) m[key] = value }
  const s = sample.snapshots ?? {}
  const snap = (label) => s[label]

  // 启动
  put('startup.navVisibleMs', sample.launch?.navVisibleAtMs)
  put('startup.firstWindowMs', sample.launch?.firstWindowAtMs)
  put('startup.backendReadyMs', sample.launch?.backendReadyMs)
  put('startup.overviewSettledMs', sample.launch?.overviewSettledMs)
  put('startup.fcpMs', snap('startupStable')?.page?.timing?.paints?.find((p) => p.name === 'first-contentful-paint')?.startTimeMs)
  put('startup.domContentLoadedMs', snap('startupStable')?.page?.timing?.navigation?.domContentLoadedMs)
  put('startup.ipcCallsBeforeStable', snap('startupStable')?.ipc?.total)

  // 重载（渲染层资源加载）
  if (sample.reload) {
    put('reload.navWaitMs', sample.reload.navWaitMs)
    put('reload.requests', sample.reload.network?.requests)
    put('reload.finished', sample.reload.network?.finished)
    put('reload.bytes', sample.reload.network?.encodedBytes)
    put('reload.scriptRequests', sample.reload.network?.byType?.Script)
    put('reload.otherRequests', sample.reload.network?.byType?.Other)
    const fileDetail = sample.reload.network?.bySchemeDetail?.['file:']
    put('reload.fileRequests', fileDetail?.count)
    put('reload.fileBytes', fileDetail?.encodedBytes)
    put('reload.fileP50Ms', fileDetail?.p50Ms)
    put('reload.fileP95Ms', fileDetail?.p95Ms)
    const dataDetail = sample.reload.network?.bySchemeDetail?.['data:']
    put('reload.dataRequests', dataDetail?.count)
    put('reload.dataP95Ms', dataDetail?.p95Ms)
    put('reload.durationP50Ms', sample.reload.network?.duration?.p50Ms)
    put('reload.durationP95Ms', sample.reload.network?.duration?.p95Ms)
    put('reload.ipcCalls', sample.reload.ipc?.total)
    put('reload.backendCompleted', sample.reload.backend?.completedDelta)
    put('reload.fcpMs', sample.reload.paints?.find((p) => p.name === 'first-contentful-paint')?.startTimeMs)
  }

  // 每个采样点的内存（OS 口径 + 渲染层）
  for (const [label, key] of [['startupStable', 'startupStable'], ['imagePanel', 'imagePanel'], ['afterScroll', 'afterScroll'], ['afterIdle', 'afterIdle']]) {
    const x = snap(label)
    if (!x) continue
    const p = `memory.${key}.`
    put(p + 'mainWorkingSetBytes', x.mainProcess?.osProcess?.workingSetBytes)
    put(p + 'mainPrivateBytes', x.mainProcess?.osProcess?.privateBytes)
    put(p + 'mainNodeRssBytes', x.mainProcess?.nodeMem?.rssBytes)
    put(p + 'mainNodeHeapUsedBytes', x.mainProcess?.nodeMem?.heapUsedBytes)
    put(p + 'rendererWorkingSetBytes', x.renderer?.osProcess?.workingSetBytes)
    put(p + 'rendererJsHeapUsedBytes', x.renderer?.cdpHeap?.usedSize)
    put(p + 'rendererJsHeapTotalBytes', x.renderer?.cdpHeap?.totalSize)
    put(p + 'rendererBlinkHeapUsedBytes', x.renderer?.perfMetrics?.raw?.JSHeapUsedSize)
    put(p + 'rendererDomNodes', x.renderer?.perfMetrics?.raw?.Nodes)
    put(p + 'backendWorkerWorkingSetBytes', x.backendWorker?.workingSetBytes)
    put(p + 'gpuWorkingSetBytes', x.gpu?.workingSetBytes)
    put(p + 'totalWorkingSetBytes', x.osProcesses?.totalWorkingSetBytes)
    put(p + 'totalPrivateBytes', x.osProcesses?.totalPrivateBytes)
    put(p + 'processCount', x.osProcesses?.processCount)
    put(p + 'layoutCountDelta', x.renderer?.perfMetrics?.deltaSincePrevSnapshot?.LayoutCount)
    put(p + 'recalcStyleCountDelta', x.renderer?.perfMetrics?.deltaSincePrevSnapshot?.RecalcStyleCount)
    put(p + 'taskDurationMsDelta', x.renderer?.perfMetrics?.deltaSincePrevSnapshot?.TaskDurationMs)
    put(p + 'scriptDurationMsDelta', x.renderer?.perfMetrics?.deltaSincePrevSnapshot?.ScriptDurationMs)
    put(p + 'contentTextLen', x.page?.panel?.textLen)
    put(p + 'visibleImages', x.page?.images?.visibleNow)
    put(p + 'imageE2eP50Ms', x.imagePhase?.e2eP50Ms)
    put(p + 'imageE2eP95Ms', x.imagePhase?.e2eP95Ms)
    put(p + 'newImages', x.imagePhase?.newImages)
    put(p + 'mediaProtocolRequests', x.network?.deltaSincePrevSnapshot?.byScheme?.['wechat-media:'])
    put(p + 'httpRequests', x.network?.deltaSincePrevSnapshot?.byScheme?.['http:'])
    put(p + 'httpsRequests', x.network?.deltaSincePrevSnapshot?.byScheme?.['https:'])
    put(p + 'decodedNewFiles', x.decodedCache?.deltaFiles)
    put(p + 'decodedNewBytes', x.decodedCache?.deltaBytes)
    put(p + 'ipcCallsDelta', x.ipc?.deltaSincePrevSnapshot?.total)
    put(p + 'slowCallLogCount', x.logs?.totals?.slowCallCount)
    put(p + 'workerMemRssMb', x.logs?.totals?.lastMemSample?.rssMb)
    put(p + 'rendererConsoleErrors', x.rendererConsoleErrorCount)
  }

  // 面板切换逐面板（跨 3 个样本取中位的那个「同面板））
  const byPanel = {}
  for (const rec of sample.panelSwitches ?? []) {
    const key = rec.panelId ?? rec.label
    if (!byPanel[key]) byPanel[key] = []
    byPanel[key].push(rec)
  }
  for (const [panel, recs] of Object.entries(byPanel)) {
    // 每个样本内看「首次访问」；有 repeat 时另存热切换
    const first = recs.find((r) => r.visit === 1) ?? recs[0]
    const prefix = `panelSwitch.${panel}.`
    put(prefix + 'settleMs', first.settleMs)
    put(prefix + 'firstContentMs', first.firstContentMs)
    put(prefix + 'stateChangedMs', first.stateChangedMs)
    put(prefix + 'ipcCalls', first.ipc?.total)
    put(prefix + 'wechatCalls', first.ipc?.wechatCallCount)
    put(prefix + 'backendCompletedDelta', first.backend?.completedDelta)
    put(prefix + 'requests', first.network?.requests)
    put(prefix + 'fileRequests', first.network?.byScheme?.['file:'])
    put(prefix + 'dataRequests', first.network?.byScheme?.['data:'])
    put(prefix + 'requestsP95Ms', first.network?.duration?.p95Ms)
    put(prefix + 'networkQuietWaitedMs', first.networkQuiet?.waitedMs)
    put(prefix + 'backendIdleWaitedMs', first.backendIdleBefore?.waitedMs)
    put(prefix + 'newImages', first.images?.newImages)
    put(prefix + 'imageE2eP50Ms', first.images?.e2eP50Ms)
    put(prefix + 'decodedNewFiles', first.decoded?.deltaFiles)
    put(prefix + 'decodedNewBytes', first.decoded?.deltaBytes)
    put(prefix + 'textLen', first.postTextLen)
    const warm = recs.find((r) => r.visit === 2)
    if (warm) {
      put(`panelSwitchWarm.${panel}.settleMs`, warm.settleMs)
      put(`panelSwitchWarm.${panel}.firstContentMs`, warm.firstContentMs)
      put(`panelSwitchWarm.${panel}.ipcCalls`, warm.ipc?.total)
    }
  }
  // 单样本内的面板切换总览（跨面板 P50/P95）
  const settles = (sample.panelSwitches ?? []).filter((r) => r.visit === 1 && Number.isFinite(r.settleMs)).map((r) => r.settleMs)
  if (settles.length > 0) {
    put('panelSwitchAll.settleP50Ms', quantile(settles, 0.5))
    put('panelSwitchAll.settleP95Ms', quantile(settles, 0.95))
    put('panelSwitchAll.count', settles.length)
  }

  // 缓存指标（代理）
  const afterScroll = snap('afterScroll')
  if (afterScroll?.ipc?.wechatCall) {
    put('cache.queryProxy.fastCallRatio', afterScroll.ipc.wechatCall.fastRatio)
    put('cache.queryProxy.wechatCallP50Ms', afterScroll.ipc.wechatCall.p50Ms)
    put('cache.queryProxy.wechatCallP95Ms', afterScroll.ipc.wechatCall.p95Ms)
    put('cache.queryProxy.wechatCallCount', afterScroll.ipc.wechatCall.count)
  }
  const exec = afterScroll?.backend?.callQueue?.execution ?? afterScroll?.backend?.execution
  if (exec) {
    put('cache.backendExecutionP50Ms', exec.p50Ms)
    put('cache.backendExecutionP95Ms', exec.p95Ms)
    put('cache.backendExecutionCountRetained', exec.count)
  }
  put('cache.backendSlowCallLogCount', afterScroll?.logs?.totals?.slowCallCount)
  put('cache.httpCacheFromDisk', sample.reload?.network?.fromDiskCache)
  const mediaAll = (sample.panelSwitches ?? []).reduce((n, r) => n + (r.network?.byScheme?.['wechat-media:'] ?? 0), 0)
  put('cache.mediaProtocolRequestsTotal', mediaAll)
  const decodedNewAll = (sample.panelSwitches ?? []).reduce((n, r) => n + (r.decoded?.deltaFiles ?? 0), 0)
  put('cache.decodedNewFilesTotal', decodedNewAll)

  // 空闲
  if (sample.idle) {
    for (const [cls, v] of Object.entries(sample.idle.cpu?.byClass ?? {})) {
      put(`idle.cpu.${cls}.cpuSeconds`, v.cpuSecondsDelta)
      put(`idle.cpu.${cls}.avgCorePercent`, v.avgCorePercent)
      put(`idle.workingSet.${cls}.deltaBytes`, v.workingSetDeltaBytes)
    }
    put('idle.memory.totalWorkingSetDeltaBytes', sample.idle.memory?.totalWorkingSetDeltaBytes)
  }

  // 峰值
  for (const [k, v] of Object.entries(sample.peaks ?? {})) put(`peaks.${k}`, v)

  // 错误
  put('errors.sampleErrors', (sample.errors ?? []).length)
  put('errors.rendererConsole', sample.rendererConsoleErrors?.count)
  put('errors.pageErrors', sample.pageErrors?.count)
  return m
}

/**
 * 跨样本汇总：中位 + 噪声带（min~max + 相对展宽）。
 * @param {object[]} samples
 */
function aggregateSamples (samples) {
  const maps = samples.map(extractMetrics)
  const aggregate = aggregateSeries(maps)
  // 报告里要"每类指标的中位与噪声带"，按前缀分块打印/存盘
  return { perSample: maps, aggregate }
}

/** 控制台摘要（报告数字的人眼版）。 */
function printSummary ({ samples, medians, out, hostInfo }) {
  const fmt = (v) => (v === null || v === undefined ? '—' : Math.abs(v) >= 1024 * 1024 ? (v / 1024 / 1024).toFixed(1) + 'MB' : Math.abs(v) >= 1024 ? (v / 1024).toFixed(1) + 'KB' : String(v))
  const ser = (key) => medians[key] ? `${round(medians[key].median, 1)} [${round(medians[key].min, 1)}–${round(medians[key].max, 1)}]` : '—'
  console.log('\n══════════ 运行时性能基线摘要 ══════════')
  console.log(`样本数 ${samples.length}｜CPU ${hostInfo.cpu?.name ?? '?'}｜RAM ${(hostInfo.ramBytes / 1024 ** 3).toFixed(0)}GB｜Electron ${hostInfo.electronPackageVersion ?? '?'}｜Node ${process.versions.node}`)
  console.log(`启动：导航可见 ${ser('startup.navVisibleMs')}ms｜后端 ready ${ser('startup.backendReadyMs')}ms｜总览落定 ${ser('startup.overviewSettledMs')}ms｜FCP ${ser('startup.fcpMs')}ms`)
  if (medians['reload.fileRequests']) console.log(`重载资源：本地资源 ${ser('reload.fileRequests')} 个 / ${ser('reload.fileBytes')}B / p95 ${ser('reload.fileP95Ms')}ms｜data 图片请求 ${ser('reload.dataRequests')} 个（合计 ${ser('reload.requests')} 个请求）`)
  for (const [phase, zh] of [['startupStable', '启动稳定态'], ['imagePanel', '图片面板后'], ['afterScroll', '批量滚动后'], ['afterIdle', '空闲60s后']]) {
    const main = medians[`memory.${phase}.mainWorkingSetBytes`]
    if (!main) continue
    console.log(`${zh}：主进程 WS ${fmt(main.median)} [${fmt(main.min)}–${fmt(main.max)}]｜渲染 JS 堆 ${ser(`memory.${phase}.rendererJsHeapUsedBytes`)}B｜后端 worker ${ser(`memory.${phase}.backendWorkerWorkingSetBytes`)}B｜总 WS ${ser(`memory.${phase}.totalWorkingSetBytes`)}B`)
  }
  console.log(`面板切换：P50 ${ser('panelSwitchAll.settleP50Ms')}ms｜P95 ${ser('panelSwitchAll.settleP95Ms')}ms（跨面板，首次访问）`)
  console.log(`峰值：主进程 WS ${fmt(medians['peaks.mainWorkingSetBytes']?.median)}｜渲染 WS ${fmt(medians['peaks.rendererWorkingSetBytes']?.median)}｜后端 worker ${fmt(medians['peaks.backendWorkerWorkingSetBytes']?.median)}`)
  console.log(`缓存代理：wechat:call 快调用占比 ${ser('cache.queryProxy.fastCallRatio')}｜后端 execution P50 ${ser('cache.backendExecutionP50Ms')}ms｜P95 ${ser('cache.backendExecutionP95Ms')}ms｜慢调用日志 ${ser('cache.backendSlowCallLogCount')} 条`)
  console.log(`错误：样本失败 ${ser('errors.sampleErrors')}｜渲染 console error ${ser('errors.rendererConsole')}｜pageerror ${ser('errors.pageErrors')}`)
  console.log(`\n原始 JSON：${out}`)
  console.log('复跑（同一台机器）：node scripts/perf/perf-baseline.mjs --samples=3 --out=' + out.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
}

/**
 * 入口。
 */
async function main () {
  const cfg = buildConfig()
  if (!existsSync(EXE)) {
    console.error('[前置] 找不到 electron.exe：', EXE)
    process.exitCode = 2
    return
  }
  mkdirSync(dirname(cfg.out), { recursive: true })

  const hostInfo = await collectHostInfo(ROOT)
  const startedAt = new Date().toISOString()
  console.log(`[perf-baseline] 开始：samples=${cfg.samples} panels=${cfg.panels.join(',')} imagePanel=${cfg.imagePanel} idle=${cfg.idleMs}ms out=${cfg.out}`)
  console.log(`[perf-baseline] 环境：${hostInfo.cpu?.name}（${hostInfo.cpu?.logicalProcessors} 线程）/${(hostInfo.ramBytes / 1024 ** 3).toFixed(0)}GB / ${hostInfo.os?.caption} / Electron ${hostInfo.electronPackageVersion}`)

  const samples = []
  for (let i = 0; i < cfg.samples; i++) {
    console.log(`\n[perf-baseline] ── sample ${i + 1}/${cfg.samples} ──`)
    // 样本之间留 2s：给上一个进程完全退出、文件句柄释放
    if (i > 0) await sleep(2000)
    const sample = await runSample({ index: i + 1, cfg, hostInfo })
    samples.push(sample)
    const ok = (sample.errors ?? []).length === 0 && sample.snapshots?.startupStable
    console.log(`[perf-baseline] sample ${i + 1} ${ok ? '完成' : '失败'}，耗时 ${(sample.durationMs / 1000).toFixed(1)}s，错误 ${(sample.errors ?? []).length} 条`)
  }

  const { perSample, aggregate } = aggregateSamples(samples)
  const result = {
    schemaVersion: 1,
    tool: 'scripts/perf/perf-baseline.mjs',
    generatedAt: new Date().toISOString(),
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      samples: cfg.samples,
      panels: cfg.panels,
      imagePanel: cfg.imagePanel,
      idleMs: cfg.idleMs,
      scrollRounds: cfg.scrollRounds,
      repeatVisits: cfg.repeatVisits,
      reload: cfg.reload,
      tag: cfg.tag,
    },
    host: hostInfo,
    versions: {
      node: process.versions.node,
      electronPackage: hostInfo.electronPackageVersion,
      // 实际运行时版本在样本里（snapshot.electronVersions）
      runtimeElectron: samples.find((s) => s.snapshots?.startupStable?.electronVersions)?.snapshots?.startupStable?.electronVersions?.electron ?? null,
      runtimeNode: samples.find((s) => s.snapshots?.startupStable?.electronVersions)?.snapshots?.startupStable?.electronVersions?.node ?? null,
      chrome: samples.find((s) => s.snapshots?.startupStable?.electronVersions)?.snapshots?.startupStable?.electronVersions?.chrome ?? null,
    },
    methodology: {
      launch: 'playwright _electron.launch（electron.exe + 仓库根；等价 launch-app.mjs，额外摘除 ELECTRON_RUN_AS_NODE；env 见每样本 launch）',
      profile: '临时 userData（real-profile.mjs 复制真实 config/llm 配置；数据根指向应用解析出的真实 wechat-data）',
      skipOnboarding: 'SUPERTIME_SKIP_ONBOARDING=1（非打包态才生效，用于跳过首启三道闸门；不设 SUPERTIME_TEST_MODE）',
      resourceTimingCaveat: 'performance.getEntriesByType("resource") 在本仓库渲染层恒返回 0 条（sandbox:true + file:// 文档，实测）；资源加载时延改由 CDP Network 逐请求采集，两者读数都在 samples[].snapshots[].page.resourceTiming 里',
      memorySources: '主进程 WorkingSet/PrivateBytes 取 PowerShell Get-Process（OS 口径）；per-process 明细取 Electron app.getAppMetrics（Windows 下 KB 已换算字节）；渲染层堆取 CDP Runtime.getHeapUsage / Performance.getMetrics',
      median: '跨 samples 取中位（最近秩法），噪声带 = min~max 与 (max-min)/median',
      cacheProxy: 'query 签名缓存没有可读计数端点；用 wechat:call 快调用(<10ms)占比、后端 execution P50/P95、>1s 慢调用日志条数做代理。图片解码缓存用 decoded_images 目录增量 + wechat-media:// 请求数。HTTP 缓存用 CDP response.fromDiskCache/fromMemoryCache。',
      sessionTiming: '每个样本是独立的一次应用启动；样本间留 2s。样本 1 是"冷 OS 文件缓存"，2/3 是热缓存，逐一列出，取中位。',
      warnings: [
        '渲染层面板图片绝大多数是 data: URL（启动时实测 229/229），没有 HTTP/协议请求阶段；"请求发起→decode→可见"的请求段不可观测，只测"元素挂载→decode 完成→进入视口"。',
        '后端 worker 是独立 utilityProcess：其内部缓存命中计数无只读端点；出网请求（CDN 图片）发生在 worker 内，CDP 看不到。',
        'wechat-media:// 图片链路取决于具体面板/详情交互；本次 --panels 的可见面板集合未必触发。',
      ],
    },
    samples,
    metricsPerSample: perSample,
    medians: aggregate,
    summary: {
      // 报告直接引用的几个关键数（中位）
      startupNavVisibleMs: aggregate['startup.navVisibleMs']?.median ?? null,
      startupBackendReadyMs: aggregate['startup.backendReadyMs']?.median ?? null,
      startupOverviewSettledMs: aggregate['startup.overviewSettledMs']?.median ?? null,
      panelSwitchP50Ms: aggregate['panelSwitchAll.settleP50Ms']?.median ?? null,
      panelSwitchP95Ms: aggregate['panelSwitchAll.settleP95Ms']?.median ?? null,
      reloadRequests: aggregate['reload.requests']?.median ?? null,
      reloadP95Ms: aggregate['reload.durationP95Ms']?.median ?? null,
    },
  }
  writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
  printSummary({ samples, medians: aggregate, out: cfg.out, hostInfo })
  console.log(`\n[perf-baseline] 写入 ${cfg.out}（${(JSON.stringify(result).length / 1024).toFixed(0)}KB）`)
}

main().catch((e) => {
  console.error('[perf-baseline] 未捕获失败：', e)
  process.exitCode = 1
})

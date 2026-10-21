/**
 * 基线汇总（从 perf-baseline.mjs 拆出，满足「单文件 ≤1000 行」棘轮）。
 *
 * 只做纯数据变换与打印：从样本抽平坦指标（extractMetrics）→ 跨样本聚合（aggregateSamples）
 * → 人眼摘要（printSummary）。不碰应用、不读日志、不启动进程。
 */
import { aggregateSeries, round } from './stats.mjs'

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
  // 启动分段：只有开了 SUPERTIME_BOOT_TRACE=1 才有数据；按 label 取跨样本中位，便于改动前后对比。
  const bootByLabel = new Map()
  for (const s of samples) {
    const phases = s.snapshots?.startupStable?.logs?.totals?.bootPhases ?? []
    for (const p of phases) {
      if (!bootByLabel.has(p.label)) bootByLabel.set(p.label, [])
      bootByLabel.get(p.label).push(p.t)
    }
  }
  if (bootByLabel.size > 0) {
    const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor((a.length - 1) / 2)] }
    console.log('启动分段（[boot-phase] 跨样本中位，ms）：')
    for (const [label, arr] of bootByLabel) console.log(`  ${label.padEnd(26)} ${med(arr)}ms`)
  }
  console.log(`\n原始 JSON：${out}`)
  console.log('复跑（同一台机器）：node scripts/perf/perf-baseline.mjs --samples=3 --out=' + out.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
}

/**
 * 入口。
 */
export { aggregateSamples, extractMetrics, printSummary }

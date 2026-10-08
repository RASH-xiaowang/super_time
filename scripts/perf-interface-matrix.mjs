/**
 * 逐接口性能矩阵：把 **全部 172 个 `@Remote` 方法**逐个落到「优化范围 · 性能目标 · 验证方式」三列上，
 * 并附上最近一次真机探针的读数（有则填、无则 "-"）。
 *
 * ## 为什么要有这个工具（而不是再写一份手抄的表）
 *
 * 2026-09-28/29 那两轮优化（见 `docs/PERF-THEME-LEDGER-2026-09-29.md`）改的是 **23 处**，
 * 而接口面是 **172 个**。于是"剩下的 151 个是不是就不用管了"这个问题**没有机器判据**：
 * 靠人记、靠文档写，下一次加一个 `@Remote` 就没人知道它该归到哪一档、该拿什么去验。
 *
 * 本工具做三件事：
 *   ① **穷举**：从 `@Remote('name')` 装饰器里抽方法名，一个不多一个不少（对着 `docs/API.md` 数）；
 *   ② **归类**：每个方法必须落进**恰好一个**家族，每个家族自带"范围 / 目标 / 验证"三列；
 *      没归进去 ⇒ **报错**（新接口不会自动"免检"）；
 *   ③ **对账**：家族名单里写了一个不存在的方法 ⇒ **报错**（改名/删接口后名单会腐烂）；
 *      生成的文档与源码不一致（`--check`）⇒ **报错**（同 `docs:api:check` 的口径）。
 *
 * ## 口径与边界（写清楚，免得被当成万能的）
 *
 * - 家族是**按实现路径**分的（网络 / 模型 / 长任务 / 本地查询…），不是按"快不快"分的；
 *   一个方法属于哪个家族由 `FAMILIES` 的名单决定，**名单是人工维护的**，本工具只保证
 *   「不漏、不重复、不悬空」，不保证"这个归类一定对"。
 * - 探针读数**只作参考**：`docs/PERF-THEME-LEDGER` 第 73/74 轮已查明同一份代码同一台机器的
 *   耗时列会漂移（250×），而账本对"读数可信度"有分档。本工具因此**不拿读数当门槛**，
 *   只把它抄进表里，且对**物理上不可能**的值（>180s 墙钟）打上 `⚠坏读数`——那 4e9 那一行
 *   是 32 位溢出，不是真实耗时（账本第 73 轮）。
 * - 真正进退出码的是**结构与归类**（①②③），这也是它能进 CI 的原因：不依赖本机数据根。
 *
 * 用法：
 *   node scripts/perf-interface-matrix.mjs           # 生成/刷新 docs/PERF-INTERFACE-MATRIX.md
 *   node scripts/perf-interface-matrix.mjs --check    # 只校验（CI 用）：归类完整 + 文档不过期
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src', 'backend', 'wechat-data', 'src')
const API_DOC = join(ROOT, 'docs', 'API.md')
const OUT_DOC = join(ROOT, 'docs', 'PERF-INTERFACE-MATRIX.md')
const PROBE_DIR = join(ROOT, 'working')
const CHECK = process.argv.includes('--check')

/** 探针墙钟上限（`OVERALL_DEADLINE_MS` 默认 180s）⇒ 超过它的耗时列必是坏读数。 */
const IMPOSSIBLE_MS = 180_000

/**
 * 家族定义：`id` 只用于文档与统计；`members` 是该家族的方法名（**必须真实存在**）。
 *
 * ⚠️ 名单的纪律：**只收"这一档的判据/目标在它身上成立"的方法**。
 * 例如 `getArticleCover` 走网络，就不该因为它"也有 60s 负缓存"被塞进本地查询档。
 *
 * `scope` = 优化范围（数据库查询 / 缓存 / 算法复杂度 / 重复调用 / 网络往返 / 模型推理 / 调度）；
 * `target` = 性能目标；`verify` = 验证方式（脚本或 spec，指向仓库里真实存在的东西）。
 */
const FAMILIES = [
  {
    id: 'scan-yield',
    title: '本地整表扫（已优化：让出 + 结果缓存）',
    scope: '数据库查询：整表 `.all()` / 逐行 XML 解析 / 逐字符 bigram；算法复杂度：O(行数)；重复调用：同一会话内重复取数',
    target: '片段上界（单次不让出的最长时长）≤ 50ms（登记例外：`planOriginalFetch` ≤ 302ms，账本第 14 项）；让出次数 > 0；热点方法热跑 ≤ 5ms。⚠️ 年报首次冷跑仍有 ~2.5s（扫约 200 万行），已登记为未闭环项，缓存只解决"重复查看"。',
    verify: '`query-yield-discipline.spec.ts`（tick 下界）+ `guard-coverage-ledger.spec.ts`（每处修复都有守卫）+ `working/verify-acceptance.mjs`（账本 ↔ 守卫 ↔ 实测三方核对）',
    members: [
      'getWordCloud', 'getMomentsInsights', 'getMomentsMonthly', 'getAssetInsights',
      'getAnnualReport', 'getAnnualReview', 'exportAnnualReport', 'getCalls', 'getSessions',
      'getOverview', 'getOfficialAssets', 'planOriginalFetch', 'generatePeriodSummary',
      'generateDailySummary', 'extractTasks', 'exportMoments', 'createBackup',
      'resolveChatHistory', 'upgradeDecodedImages',
    ],
  },
  {
    id: 'scan-key',
    title: '密钥/解密类重任务（已加让出，不可中断）',
    scope: '数据库查询 + 文件遍历：微信进程内存扫描（读 `Weixin.exe`）、目录 BFS（最多 500 个）、全库重解密',
    target: '片段上界 ≤ 150ms（`verifyImageKey` ≤ 110ms）；让出次数 > 0；不阻塞轻调用',
    verify: '`guard-coverage-ledger.spec.ts` 的委派白名单（`image-key-resolver.ts` → `keysdec.ts`）+ 探针 `working/probe-remote.txt`',
    members: ['verifyImageKey', 'decryptAllDatabases', 'generateKeysFile', 'verifyDatabaseKey', 'autoGetDbKey', 'autoGetImageKey'],
  },
  {
    id: 'export-job',
    title: '导出/备份长任务（后台 job + 进度 + 可取消）',
    scope: '重复调用：分页收集时每页一次完整查询（已把页大小调到 1000 并在页内切 100 条上报）；总量大但已切片',
    target: '收集阶段 ≤ 1s/万条（实测 2449ms → 940ms/4.3 万条）；进度事件 ≥ 20 次；取消后无产出',
    verify: '`export-progress-job.spec.ts`、`export-stream.spec.ts`、`gateway-export-stream-progress.spec.ts`、`e2e:export-progress`、`e2e:export-nonblocking`',
    members: ['exportAllSessions', 'exportCsv', 'exportSessionMessages', 'createEncryptedBackup', 'restoreBackup', 'previewBackup', 'deleteBackup'],
  },
  {
    id: 'network',
    title: '网络取图/取文（出网闸门 + 两级缓存 + 批量 + 并发上限）',
    scope: '网络往返：逐条 RPC（已改批量）、单张 2 次往返（HTML + 图片）、超时叠加（40 张 ÷ 6 并发 × 12s ≈ 80s 已调到 20 ÷ 10 × 8s ≈ 16s）',
    target: 'RPC 次数 = ⌈N/批⌉；单批最坏 ≤ 16s；缓存命中 / 出网关闭 ≤ 5ms；永久 404 重抓间隔 ≥ 5min',
    verify: '`article-cover-cache.spec.ts`、`remote-image.spec.ts`、`emoticon-batch.spec.ts`、`article-cover-local-first.spec.ts`、`probe-perf5` 的 A/B 对照',
    members: [
      'getArticleCover', 'getArticleCovers', 'getRemoteImages', 'getEmoticonDataUrl',
      'getEmoticonDataUrls', 'getSnsImageDataUrl', 'getSnsVideoDataUrl', 'getSnsVideoCoverDataUrl',
      'exportSnsVideo', 'getAvatar', 'getAvatarsLocal', 'fetchOriginalImagesBatch',
      'getImageOriginal', 'getMessageFile', 'downloadWhisperModel', 'downloadLayaModel',
      'adoptLayaModel', 'installWhisperEngine',
    ],
  },
  {
    id: 'model',
    title: '本地模型 / 远端 LLM（推理不可中断，已实测否掉合批）',
    scope: '模型推理：ONNX 单次 forward 同步不可中断（`analyzeMessages` 1187ms 片段）；远端 LLM：provider 往返 + 生成 token 数（不在本仓控制内）',
    target: '首 token 看门狗 15s（D1）；`analyzeMessages` 片段 ≤ 1200ms；本地部分 ≤ 100ms',
    verify: '`laya/` 相关 spec + `llm-rerank.spec.ts` + `tools/laya/bench-inference.mjs`（合批慢 41.8% 的反证）+ `working/probe-remote.txt`',
    members: [
      'analyzeMessages', 'analyzeVisibleMessages', 'suggestReplies', 'askWechat',
      'optimizeAskQuestion', 'extractKbEntities', 'summarizeKbFile', 'suggestKbLinks',
      'buildKbVectorIndex', 'buildRagVectorIndex', 'evaluateRetrieval',
      'transcribeVoiceMessage', 'transcribeVoiceBatch', 'getVoiceTranscript',
      'resetRetrievalWeights', 'buildSearchIndex',
    ],
  },
  {
    id: 'image-local',
    title: '本地图片/语音取数（缓存索引化，不出网）',
    scope: '缓存：`4×N` 次 `existsSync` 试扩展名（已改成 1 次 `readdir` 建索引）；重复读盘 + base64（已加内存 LRU）；扫 `msg/attach` 全树（已加索引 + 负缓存）',
    target: '批量命中 ≤ 2ms/20 张；单张 ≤ 50ms；同一批 RPC 只发 1 次',
    verify: '`media-image-decode-shared.spec.ts`、`emoticon-batch.spec.ts`、`probe-perf5`（13.12ms → 1.95ms / 6.74×）',
    members: ['getImageDataUrl', 'getImageDataUrlsBatch', 'getFileImageDataUrl', 'getVideoInfo', 'getVoiceInfo', 'getVoiceDataUrl'],
  },
  {
    id: 'local-read',
    title: '本地只读查询（30s 结果缓存；冷跑 ≤ 210ms、热跑 0ms）',
    scope: '数据库查询：单库/单表带索引查询；缓存：`cachedBySigAsync`（30s，按库文件签名失效）',
    target: '冷跑 ≤ 210ms（本机基线；\`probe-remote.txt\` 的耗时列在受污染环境下不可比，见账本第 73/74/85 轮）、热跑 ≤ 5ms；无 ≥200ms 的整段独占',
    verify: '`cache-timing-coverage.spec.ts`、`cache-sig.spec.ts`、`probe-perf.ts`（29 接口冷/热对照）',
    members: [
      'getContacts', 'getOverviewInsights', 'getRegionMap', 'getRecords', 'searchMembers',
      'getRevoked', 'getStorageStats', 'getAnnual', 'getGraph', 'getMoments',
      'getSelfUsername', 'getMomentsAuthors', 'getFavorites', 'getMessages', 'getNewMessages',
      'getSearchIndexStatus', 'cancelSearch', 'getGroupInfo', 'getPaymentStatus', 'getDailyCounts',
      'listEditedMessages', 'listSummaryRecords', 'detectWechatAccounts', 'getKnowledgeGraph',
      'getKbs', 'getKbFiles', 'getKbFileChunks', 'getKbVectorIndex', 'getRetrievalStatus',
      'getEmoticons', 'getWechatConfig', 'getNotes', 'getFiles', 'listBackups', 'listLlmProviders',
      'listLlmModels', 'getExportProgress', 'getExportHistory', 'listRetrievalFeedback',
      'getWechatConfigFull', 'getWhisperStatus', 'getWechatKeysInfo', 'getDecryptStatus',
      'getDbStatus', 'getDbHealth', 'getHandoffReminds', 'getOperationLog', 'getPrivacyAuditRows',
      'getPrivacyState', 'listTasks', 'getLayaStatus', 'getKbModelConfig', 'getAskHistory',
      'listSummaryTasks', 'getPrivacyScan', 'getLedger', 'getMediaAssets', 'searchUnified',      'searchMessages', 'searchKb', 'getGroupInsights', 'getContact360',
    ],
  },
  {
    id: 'write',
    title: '写操作（本地落盘 / DB 写 / 配置写，原子写）',
    scope: '写放大：整文件重写、`cpSync`（已改异步原子写）；重复写：同一配置反复落盘',
    target: '单次 ≤ 200ms；写失败不产生半截文件（原子替换）',
    verify: '`backup-atomic.spec.ts`、`gateway-operation-log.spec.ts`、`m1-secrets-migration-smoke.js`、`read-failure-contract.spec.ts`',
    members: [
      'editChatMessage', 'resetEditedMessage', 'deleteNote', 'saveNote', 'deleteFavoriteItems',
      'saveWechatConfig', 'setKbModelConfig',
      'createKb', 'renameKb', 'deleteKb', 'addKbFiles', 'deleteKbFile', 'setKbFileRag',
      'saveSummaryTask', 'deleteSummaryTask', 'toggleSummaryTask', 'deleteSummaryRecord',
      'runSummaryTask', 'deleteAskHistory', 'clearAskHistory', 'deleteExportHistory',
      'pruneExportHistory', 'saveRetrievalConfig', 'submitAskFeedback', 'addTask', 'deleteTask',
      'setTaskStatus', 'syncHandoffTasks', 'clearOperationLog', 'clearPrivacyAudit',
      'setPrivacyState', 'decryptAllImages',
    ],
  },
  {
    id: 'system',
    title: '系统/壳层操作（打开路径、状态查询、模型装载）',
    scope: '进程与系统调用：shell open、onnxruntime session 装载/卸载（`unloadLaya` 释放内存）',
    target: '单次 ≤ 200ms；不阻塞 worker 队列',
    verify: '`security-guard:smoke`（开窗/外链被拒）+ `package:smoke`',
    members: [
      'openPath', 'openConfig', 'cancelExportJob', 'unloadLaya', 'clearSessionDraft',
      'clearAllSessionDrafts',
    ],
  },
]

/** 抽 `@Remote('name')`：三个 gateway 壳文件是唯一分发点（`docs/API.md` 由它们生成）。 */
function remoteMethods () {
  const out = []
  for (const f of readdirSync(SRC).filter((n) => /^gateway-.*\.ts$/.test(n))) {
    const text = readFileSync(join(SRC, f), 'utf8')
    for (const m of text.matchAll(/@Remote\('([^']+)'\)/g)) out.push({ name: m[1], file: f })
  }
  return out
}

/** 读最近一次探针产物（可选）：返回 `方法 → {total, ticks, snippet, note}`。 */
function probeReadings () {
  if (!existsSync(PROBE_DIR)) return { source: null, rows: new Map() }
  const cands = readdirSync(PROBE_DIR)
    .filter((n) => /^probe-remote.*\.txt$/.test(n))
    .map((n) => ({ n, t: readFileSync(join(PROBE_DIR, n), 'utf8') }))
  // 取"含方法表且方法行最多"的那一份（有的产物只有几行摘要）。
  let best = null
  for (const c of cands) {
    const n = (c.t.match(/^\w+\s+\d+\s+\d+\s+\d+\s*$/gm) ?? []).length
    if (n === 0) continue
    if (best === null || n > best.n) best = { ...c, n }
  }
  if (best === null) return { source: null, rows: new Map() }
  const rows = new Map()
  for (const line of best.t.split(/\r?\n/)) {
    // 坏读数那一行会**少一列**（`decryptAllDatabases 4157188997 0`，见账本第 73 轮），
    // 所以片段列是可选的；缺列时按"总耗时"判定坏读数。
    const m = /^(\w+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line)
    if (!m) continue
    const total = Number(m[2]); const ticks = Number(m[3])
    const snippet = m[4] === undefined ? total : Number(m[4])
    rows.set(m[1], {
      total, ticks, snippet,
      bad: snippet > IMPOSSIBLE_MS || total > IMPOSSIBLE_MS,
    })
  }
  return { source: best.n, rows }
}

const methods = remoteMethods()
const familyOf = new Map()
const problems = []
for (const fam of FAMILIES) {
  for (const name of fam.members) {
    if (familyOf.has(name)) problems.push(`方法 ${name} 同时出现在 ${familyOf.get(name)} 与 ${fam.id}`)
    familyOf.set(name, fam.id)
  }
}
const realNames = new Set(methods.map((m) => m.name))
for (const [name, fam] of familyOf) {
  if (!realNames.has(name)) problems.push(`家族 ${fam} 里的 ${name} 不是真实的 @Remote 方法（改名/删接口后名单要同步）`)
}
const unclassified = methods.filter((m) => !familyOf.has(m.name)).map((m) => m.name)
for (const name of unclassified) problems.push(`方法 ${name} 没有归入任何家族 ⇒ 它拿不到"范围/目标/验证"三列`)

const { rows: readings, source: probeSource } = probeReadings()
const apiCount = existsSync(API_DOC)
  ? Number(/当前共 \*\*(\d+)\*\* 个/.exec(readFileSync(API_DOC, 'utf8'))?.[1] ?? NaN)
  : NaN
if (Number.isFinite(apiCount) && apiCount !== methods.length) {
  problems.push(`docs/API.md 声明 ${apiCount} 个方法，但源码里抽到 ${methods.length} 个`)
}

/** 生成文档正文（确定性输出：家族顺序 = FAMILIES 顺序，家族内按方法名字典序）。 */
function render () {
  const lines = []
  lines.push('# 逐接口性能矩阵（172 个 Remote 方法 · 范围 / 目标 / 验证）')
  lines.push('')
  lines.push('> ⚙️ **本文件由 `node scripts/perf-interface-matrix.mjs` 生成，不要手改**；')
  lines.push('> CI 用 `node scripts/perf-interface-matrix.mjs --check` 校验它与源码一致。')
  lines.push('')
  lines.push('它回答的是「**每一个**接口的优化范围、性能目标、验证方式各是什么」——')
  lines.push('而不是只列被改过的那 23 处。归类由 `scripts/perf-interface-matrix.mjs` 的 `FAMILIES` 名单决定，')
  lines.push('工具只保证**不漏、不重复、不悬空**。')
  lines.push('')
  lines.push(`- 接口总数：**${methods.length}**（与 \`docs/API.md\` 一致${Number.isFinite(apiCount) ? `：${apiCount}` : ''}）`)
  lines.push(`- 家族数：**${FAMILIES.length}**；未归类：**${unclassified.length}**`)
  lines.push(`- 探针读数来源：${probeSource === null ? '**未找到** `working/probe-remote*.txt` ⇒ 实测列留空（CI 上正常）' : `\`working/probe-remote*.txt\`（方法表行数 ${probeSource}）`}`)
  lines.push('')
  lines.push('## 口径（三条，必须一起读）')
  lines.push('')
  lines.push('1. **片段上界** = `总耗时 / (让出次数 + 1)`。它是"串行 worker 上别的请求最多等多久"的上界，')
  lines.push('   **不是**"用户少等多久"；让出 0 时即"整段独占"。')
  lines.push('2. **探针耗时列不总是可信**：同一份代码同一台机器上曾漂移 250×；`> 180s` 的值一定是坏读数')
  lines.push('   （32 位溢出），表里标 `⚠坏读数`。要引用这些数请看 `docs/PERF-THEME-LEDGER-2026-09-29.md` 的分档说明。')
  lines.push('3. **进退出码的是结构与归类**（穷举 / 不悬空 / 文档不过期），**不是**上面那些毫秒值 ——')
  lines.push('   所以 `--check` 不依赖本机数据根，可以进 CI。')
  lines.push('')
  let idx = 0
  for (const fam of FAMILIES) {
    const members = [...fam.members].sort((a, b) => a.localeCompare(b))
    lines.push(`## ${fam.title}`)
    lines.push('')
    lines.push(`- **优化范围**：${fam.scope}`)
    lines.push(`- **性能目标**：${fam.target}`)
    lines.push(`- **验证方式**：${fam.verify}`)
    lines.push(`- **接口数**：${members.length}`)
    lines.push('')
    lines.push('| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const name of members) {
      idx += 1
      const r = readings.get(name)
      const mt = methods.find((m) => m.name === name)
      const note = r?.bad === true ? '⚠坏读数（>180s 墙钟）' : ''
      lines.push(`| ${idx} | \`${name}\` | ${mt?.file ?? '-'} | ${r ? r.total : '-'} | ${r ? r.ticks : '-'} | ${r ? r.snippet : '-'} | ${note} |`)
    }
    lines.push('')
  }
  const allSorted = [...methods.map((m) => m.name)].sort((a, b) => a.localeCompare(b))
  lines.push('## 附：全部方法名清单（字典序，便于核对穷举性）')
  lines.push('')
  lines.push(allSorted.map((n) => '`' + n + '`').join(' · '))
  lines.push('')
  return lines.join('\n')
}

const rendered = render()

if (problems.length > 0) {
  console.error('=== 逐接口矩阵：归集失败 ===')
  for (const p of problems) console.error('  x ' + p)
  process.exit(1)
}

if (CHECK) {
  if (!existsSync(OUT_DOC)) { console.error(`缺少 ${OUT_DOC} ⇒ 先跑 node scripts/perf-interface-matrix.mjs`); process.exit(1) }
  const cur = readFileSync(OUT_DOC, 'utf8')
  // 探针产物是**本机**才有的：CI 上生成物会少实测列 ⇒ 因此 --check 只在有产物时比全量，
  // 没有产物时只比"结构性内容"（家族标题、接口名清单）。
  // 口径：凡是随"本机有没有探针产物"而变的行都剥掉后再比 —— 否则换台机器就红。
  const strip = (s) => s.split('\n')
    .filter((l) => !/^\| \d+ \| /.test(l))
    .filter((l) => !l.includes('探针读数来源'))
    .join('\n')
  const same = probeSource === null ? strip(cur) === strip(rendered) : cur === rendered + '\n'
  if (!same) {
    console.error('x docs/PERF-INTERFACE-MATRIX.md 与源码/探针产物不一致 ⇒ 跑 node scripts/perf-interface-matrix.mjs 重新生成')
    process.exit(1)
  }
  console.log(`=== 逐接口矩阵自检通过：${methods.length} 个方法、${FAMILIES.length} 个家族、未归类 0 ===`)
  process.exit(0)
}

writeFileSync(OUT_DOC, rendered + '\n', 'utf8')
const perFam = FAMILIES.map((f) => `${f.id}=${f.members.length}`).join(', ')
console.log(`已生成 ${OUT_DOC}`)
console.log(`  ${methods.length} 个方法 → ${FAMILIES.length} 个家族（${perFam}）`)
console.log(`  探针读数来源：${probeSource === null ? '无（实测列留空）' : String(probeSource) + ' 行'}`)

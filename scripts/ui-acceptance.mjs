/**
 * 「深度优化 AI 问答 RAG 流水线」UI 自动化验收测试。
 *
 * 方案：
 *   · Playwright 的 Electron 驱动（_electron.launch）驱动**真实应用**：真实数据目录、
 *     真实 ui-dist 与后端 bundle —— 不是 mock 出来的渲染层。
 *     首启三道闸门（启动引导 / 授权 / 隐私同意）用 N2 的显式开关越过：
 *     `SUPERTIME_SKIP_ONBOARDING=1` 由**主进程**判定（仅非打包态生效）⇒ 本脚本既不需要
 *     厂商签发的真许可证，也不需要伪造「已同意隐私声明」的 localStorage 记录。
 *   · LLM 用**本地 mock**（127.0.0.1）替换：既让「问答 → 漏斗行 → 反馈」全链路可跑，
 *     又不把用户聊天数据发给任何外部厂商。mock 按 system prompt 区分规划器/综合回答，
 *     并提供 /embeddings（确定性向量）以真实跑通稠密通道。
 *   · 每步独立记 pass/fail，失败时截图 + dump DOM + 拉后端操作日志，最后输出报告。
 *
 * 本次重要变化（检索参数已固化）：
 *   · 「检索设置（RAG）」面板已**下线**：通道开关 / 相似度阈值 / RRF 常数 / 上下文预算 /
 *     学习率一律固化为产品默认值（后端 `query/retrieval/config.ts`），稠密索引在**首次提问时
 *     由网关自动增量构建** —— 界面上不再有任何「让用户自己调参」的地方。
 *   · 因此本脚本不再点面板，改为两头验证：① 断言界面上**不存在**任何调参入口（这是产品决策的
 *     验收点）；② 直连 IPC / 直接改 `rag-config.json` 来证明后端能力仍在、降级路径仍可走。
 *
 * 安全约束（重要）：
 *   · 会临时接管 `<userData>/wechat/llm.json` 指向本地 mock，并在结束时**逐字节还原**；
 *   · 会清空向量库/反馈库让建索引从 0 开始 —— 因为要写入 mock 哈希向量（语义无效），
 *     不还原会让后续真实提问拿垃圾向量做稠密检索。还原失败会显式告警。
 *   · 因此**运行前必须关闭正在运行的 Super Time 实例**（单实例锁会挡住测试实例）。
 *   · 截图默认落在系统临时目录（含真实联系人内容，不应进仓库）：可用 UI_ACCEPT_OUT 覆盖。
 *
 * 运行前置：需要 playwright（只驱动 Electron，用应用自带 Chromium，无需下载浏览器）
 *   npm i --no-save playwright          # PowerShell: $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
 *   npm run build:ui                    # 本脚本跑的是 src/client/ui-dist 里的产物：
 *                                       # 改了 src/client/ui-app/** 不重建，测的就是旧界面
 *   node scripts/ui-acceptance.mjs
 *
 * 明确不在范围内：生成答案的**语义质量**（依赖真实模型）；稠密检索的**语义精度**
 * （mock 向量是字符分桶哈希，只验证链路与 UI，不验证相关性）。
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 前置检查：playwright 缺失时给出可照做的安装命令，而不是抛一个模块解析错误。
let _electron
try {
  ;({ _electron } = await import('playwright'))
} catch {
  console.error([
    '缺少依赖：playwright',
    '本项目不把它作为常规依赖（体积大），验收时按需安装：',
    '',
    '  npm i --no-save playwright        # 或（PowerShell）',
    '  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm i --no-save playwright',
    '',
    '说明：驱动 Electron 用应用自带的 Chromium，无需下载浏览器二进制。',
  ].join('\n'))
  process.exit(2)
}
// llm.json 现在落在 userData 下（不再是项目 wechat/）：安装目录保持只读、
// 状态只随 userData 走。名称取自 package.json 的 name —— 即 Electron 开发态
// 的 app.getName()（打包态则被 main.js 隔离到 <APPDATA>/Super Time）。
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const USER_DATA = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), PKG.name)
const LLM_JSON = join(USER_DATA, 'wechat', 'llm.json')
const OUT = process.env.UI_ACCEPT_OUT || join(tmpdir(), 'super-time-ui-acceptance')
const PORT = 18787
/**
 * mock 回答：**故意编造**的固定文本，用来验证「引用编号解析 / 来源高亮 / 反馈标注」链路。
 *
 * 必须自带醒目标记：这条回答里的「王五 / 5000.00 元」在检索来源里根本不存在（来源是
 * 「收到转账 13.00 元」之类）。实际发生过——自动化跑到一半有人看窗口，把它当成了
 * 应用在编造答案，完全无法分辨。加前缀后，谁看窗口都知道这是测试替身。
 */
const MOCK_ANSWER = '【验收 mock·非真实回答】根据本机记录，最近一次转账来自王五，金额 5000.00 元 [1]。'
void createRequire

// ───────── 结果收集 ─────────
const results = []
/** 执行期异常：决定最终退出码（此前 catch 只打印，异常也会「通过」）。 */
let runError = null
let cur = null
function begin(name, goal) { cur = { name, goal, checks: [], ok: true }; results.push(cur) }
function ok(cond, label, detail) {
  cur.checks.push({ label, pass: !!cond, detail: detail === undefined ? '' : String(detail) })
  if (!cond) cur.ok = false
}
async function step(name, goal, fn) {
  begin(name, goal)
  try { await fn() } catch (e) {
    ok(false, '步骤异常', (e && e.message ? e.message : String(e)).split('\n')[0])
  }
  if (!cur.ok && win) {
    try {
      await shot(win, 'FAIL-' + name.split('.')[0])
      const dump = await win.locator('body').innerText()
      console.log(`\n[诊断] 「${name}」有断言失败，页面尾部：\n${dump.slice(-1000)}\n`)
      const ops = await win.evaluate(async () => {
        const r = await window.electronAPI.wechat.call('getOperationLog', [{ limit: 12 }])
        return r?.ok ? r.value?.items ?? [] : []
      })
      if (ops.length) {
        console.log('[诊断] 后端操作日志（最近 12 条）：')
        for (const o of ops) console.log(`   ${o.status} ${o.category}/${o.action} ${o.target} ${o.detail || ''}`.slice(0, 220))
      }
    } catch (e) { console.log('[诊断] 采集失败:', e.message) }
  }
}

// ───────── mock LLM ─────────
const DIM = 64
function vecOf(text) {
  const v = new Array(DIM).fill(0)
  const t = String(text || '')
  for (let i = 0; i < t.length; i += 1) {
    const c = t.charCodeAt(i)
    v[c % DIM] += 1
    v[(c * 7 + 3) % DIM] += 0.5
  }
  const n = Math.hypot(...v) || 1
  return v.map(x => x / n)
}
const mockCalls = { chat: 0, planner: 0, embed: 0, noCite: 0, lastSynth: '' }
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    if (req.url.includes('/embeddings')) {
      mockCalls.embed += 1
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { /* ignore */ }
      const input = Array.isArray(body.input) ? body.input : [body.input]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: vecOf(t) })) }))
      return
    }
    mockCalls.chat += 1
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* ignore */ }
    const msgs = Array.isArray(body.messages) ? body.messages : []
    const sys = msgs.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n')
    const all = msgs.map(m => String(m.content || '')).join('\n')
    const isPlanner = sys.includes('检索规划器')
    if (isPlanner) mockCalls.planner += 1
    // 「无引用测试」：故意返回**不带任何 [n] 引用**的编造文本，用来验证后端的硬约束
    //（第一次生成 + 更严格指令重试都拿不到引用时，应用应当不予采用并明说没有证据）。
    // 只看**最后一条 user 消息**（即本轮问题）—— 否则这一问会留在多轮历史里，
    // 让后续提问也被误判成「无引用」。
    const lastUser = [...msgs].reverse().find(m => m.role === 'user')
    const noCite = !isPlanner && String(lastUser?.content || '').includes('无引用测试')
    if (noCite) mockCalls.noCite += 1
    const content = isPlanner
      ? JSON.stringify({ intent: '聚合统计', subQueries: ['转账', '收到转账'], from: '', to: '', person: '' })
      : noCite
        ? '根据本机记录，上个月一共转了 7 笔账，合计 88888.88 元，收款人是某位叫「张三丰」的朋友。'
        : MOCK_ANSWER
    // 记住最后一次「综合回答」请求的全文提示词：用来断言提示词里的内容底线与语气要求没被改掉。
    if (!isPlanner) mockCalls.lastSynth = msgs.map(m => String(m.content || '')).join('\n')
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const half = Math.ceil(content.length / 2)
      for (const piece of [content.slice(0, half), content.slice(half)]) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n')
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
})

// ───────── 配置备份/恢复 ─────────
const backup = { llm: null, llmExisted: false, rag: null, ragExisted: false, ragPath: null, weightsPath: null, weights: null, weightsExisted: false }
/** 还原失败清单：任何一项非空都必须在报告里显式告警（可能残留 mock 向量）。 */
const restoreErrors = []
async function restoreConfigs() {
  try {
    if (backup.llmExisted && backup.llm) writeFileSync(LLM_JSON, backup.llm)
    else if (!backup.llmExisted && existsSync(LLM_JSON)) rmSync(LLM_JSON, { force: true })
  } catch (e) { console.error('恢复 llm.json 失败:', e.message) }
  try {
    if (backup.ragPath) {
      if (backup.ragExisted && backup.rag) writeFileSync(backup.ragPath, backup.rag)
      else if (!backup.ragExisted && existsSync(backup.ragPath)) rmSync(backup.ragPath, { force: true })
    }
    if (backup.weightsPath) {
      if (backup.weightsExisted && backup.weights) writeFileSync(backup.weightsPath, backup.weights)
      else if (!backup.weightsExisted && existsSync(backup.weightsPath)) rmSync(backup.weightsPath, { force: true })
    }
    // 向量库/反馈库：测试期间会写入 mock 哈希向量（语义无效）。
    // 不还原的话，之后真实提问会拿这些垃圾向量做稠密检索 —— 必须还原，且失败要**显式告警**。
    // （Windows 下若 utilityProcess 尚未完全退出，unlink 会失败；静默忽略会残留十几 MB 垃圾向量。）
    for (const d of backup.dbs || []) {
      for (const suffix of ['', '-wal', '-shm']) {
        const p = d.path + suffix
        // 重试要够久：Electron 的 utilityProcess 可能比主进程晚几百毫秒到几秒才释放句柄，
        // 4×300ms 实测不够（残留过一次 20KB、一次 15MB 的 mock 向量库）。
        for (let attempt = 0; attempt < 14 && existsSync(p); attempt += 1) {
          try { rmSync(p, { force: true }) } catch (e) {
            if (attempt === 13) { console.error(`⚠ 清理 ${p} 失败：${e.message}`); restoreErrors.push(p) }
            else await new Promise((r) => setTimeout(r, 500))
          }
        }
      }
      if (d.existed && d.data) writeFileSync(d.path, d.data)
      else if (!d.existed && existsSync(d.path)) {
        console.error(`⚠ 未清理干净：${d.path} —— 内含 mock 向量，请手动删除后再启用稠密检索`)
        restoreErrors.push(d.path)
      }
    }
  } catch (e) { console.error('恢复 rag 配置失败:', e.message); restoreErrors.push('rag-config: ' + e.message) }
}

// ───────── 小工具 ─────────
const shot = (win, name) => win.screenshot({ path: join(OUT, name + '.png') })
const countSrc = (win) => win.locator('text=/来源 ·/').count()

/**
 * 直连后端 Remote（不经界面）。
 *
 * 为什么需要它：检索参数与运维动作（建索引 / 离线评估 / 看反馈）**已不再暴露给用户**，
 * 界面上根本没有入口可点。但这些能力仍是后端契约的一部分，验收要能证明它们还在 ——
 * 于是从「点界面」改成「直连 IPC」，同时把「界面上确实没有入口」作为独立断言。
 */
const callBackend = (win, method, args = []) => win.evaluate(
  async ([m, a]) => {
    const t0 = Date.now()
    const to = new Promise((r) => setTimeout(() => r({ ok: false, error: { message: 'PROBE_TIMEOUT_120s' } }), 120000))
    const r = await Promise.race([window.electronAPI.wechat.call(m, a), to])
    return { ok: !!r?.ok, value: r?.value ?? null, error: r?.error?.message ?? '', ms: Date.now() - t0 }
  },
  [method, args],
)

/** 深合并（与后端 saveRetrievalConfig 的语义一致：只覆盖给到的叶子）。 */
function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const plain = v && typeof v === 'object' && !Array.isArray(v)
    out[k] = plain && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

/**
 * 直接改 rag-config.json 造场景（替代原来点面板上的开关）。
 *
 * 关键前提：网关在**每次提问**时都重新 `loadRetrievalConfig()`（无内存缓存，见 gateway.ts
 * askWechat 开头），所以文件写完立刻对下一次提问生效 —— 这正是本脚本不碰界面也能
 * 验证「关闭稠密通道」「总开关回退」两条降级路径的原因。
 */
function patchRagConfig(patch) {
  // 夹具没就位时给出可读的原因（否则 readFileSync(null) 抛的是 Node 内部措辞，
  // 看起来像「测试自己写错了」，而真正的问题是数据根没拿到）
  if (!backup.ragPath) throw new Error('rag-config.json 路径未就位：setup 阶段没有拿到数据根')
  const merged = deepMerge(JSON.parse(readFileSync(backup.ragPath, 'utf8')), patch)
  writeFileSync(backup.ragPath, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

/** 提问并等本轮结束：以「来源 ·」条数增加或错误 alert 出现为准。 */
async function askAndWait(win, question) {
  const before = await countSrc(win)
  await win.getByLabel('微信问答问题').fill(question)
  await win.keyboard.press('Enter')
  await win.waitForFunction((n) => {
    const src = (document.body.innerText.match(/来源 ·/g) || []).length
    return src > n || !!document.querySelector('[role="alert"]')
  }, before, { timeout: 180000 })
  return { before, after: await countSrc(win), alert: await win.locator('[role="alert"]').first().textContent().catch(() => null) }
}

// ───────── 主流程 ─────────
let app = null
let win = null
const consoleErrors = []

async function main() {
  mkdirSync(OUT, { recursive: true })
  backup.llmExisted = existsSync(LLM_JSON)
  if (backup.llmExisted) backup.llm = readFileSync(LLM_JSON)

  mkdirSync(dirname(LLM_JSON), { recursive: true })
  writeFileSync(LLM_JSON, JSON.stringify({
    provider: 'openai-compat', model: 'mock-chat', apiKey: 'mock-key',
    apiUrl: `http://127.0.0.1:${PORT}/v1`, apiPath: '/chat/completions',
    embedPath: '/embeddings', embeddingModel: 'mock-embed', timeoutMs: 30000,
  }, null, 2) + '\n', 'utf8')

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  app = await _electron.launch({
    executablePath: join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [ROOT], cwd: ROOT,
    // 面板截图导出会弹原生保存对话框（自动化里点不到）→ 指定路径直接落盘
    env: {
      ...process.env,
      SUPERTIME_CAPTURE_PATH: join(OUT, 'exported-report.png'),
      SUPERTIME_TEST_MODE: '1',
      // N2：越过首启三道闸门（引导 / 授权 / 隐私同意）。判定在主进程，且**仅非打包态**生效；
      // 进来后窗口顶部会出现 #debug-gates-banner（步骤 1 会断言它），一眼可辨这不是正常首启。
      SUPERTIME_SKIP_ONBOARDING: '1',
    },
  })
  win = await app.firstWindow()
  win.setDefaultTimeout(25000)
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
  win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 300)))

  // 首启闸门已由上面的 SUPERTIME_SKIP_ONBOARDING=1 越过（N2）—— 这里**不再**往
  // localStorage 里伪造「已同意隐私声明」的记录：那种做法等于绕过同意闸门本身，
  // 而本仓现在有显式的、仅非打包态生效的调试开关可用（见 RELEASE-PLAN N2）。

  // ⚠️ 后端是**异步启动**的：`firstWindow()` 一返回就调 info() 很可能拿到
  // `{ ok:false, error:{ message:'Super Time 后端未初始化' } }`（此时 wechatBoot 还是 null）。
  // 旧写法 `info?.value?.decrypted || ''` 会把「后端还没起来」静默降级成「数据根 = 空串」，
  // 于是下面整段测试夹具**被跳过**，脚本拿着**真实** rag-config.json 跑完全程，
  // 只在最后几条断言上莫名其妙地红一片 —— 2026-09-18 实测：步骤 2/3/7/8/9 共 5 条失败，
  // 根因只有这一个。所以这里①等到真的拿到 decrypted 为止，②拿不到就**当场抛错**。
  let info = null
  for (let i = 0; i < 60; i++) {
    info = await win.evaluate(() => window.electronAPI.wechat.info())
    if (info?.ok && info?.value?.decrypted) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const decrypted = info?.value?.decrypted || ''
  const root = decrypted ? join(decrypted, '..') : ''
  if (!root) {
    throw new Error(
      '拿不到数据根（wechat.info() 返回 ' + JSON.stringify(info) + '）—— '
      + '测试夹具无法就位；拒绝「静默地拿真实配置跑一遍」。'
    )
  }
  backup.ragPath = join(root, 'rag-config.json')
  backup.weightsPath = join(root, 'rag-weights.json')
  if (backup.ragPath) {
    backup.ragExisted = existsSync(backup.ragPath)
    if (backup.ragExisted) backup.rag = readFileSync(backup.ragPath)
    // 测试夹具：建索引单次上限压到 400（真实语料 20.7 万条，全量建索引不是本次验证目标）；
    // 相似度下限取 0，只为让稠密通道**必定**返回候选以验证链路（mock 向量不评估语义精度）。
    writeFileSync(backup.ragPath, JSON.stringify({
      enabled: true,
      embedding: { enabled: true, model: 'mock-embed', batchSize: 64, maxDocsPerBuild: 400, maxCharsPerDoc: 120 },
      channels: { dense: { enabled: true, topK: 100, minSimilarity: 0, candidatePool: 400 } },
      compress: { maxChars: 4000, maxChunks: 6, linesPerChunk: 4 },
    }, null, 2) + '\n', 'utf8')
  }
  if (backup.weightsPath) {
    backup.weightsExisted = existsSync(backup.weightsPath)
    if (backup.weightsExisted) backup.weights = readFileSync(backup.weightsPath)
  }
  // 向量库与反馈库：备份（含 WAL/SHM）后清空，让本次建索引从 0 开始。
  backup.dbs = ['wechat_rag_vectors.db', 'wechat_rag_feedback.db']
    .map(f => (root ? join(root, f) : ''))
    .filter(Boolean)
    .map(p => ({ path: p, existed: existsSync(p), data: existsSync(p) ? readFileSync(p) : null }))
  for (const d of backup.dbs) {
    if (d.existed) console.log(`[setup] 暂时移除 ${d.path}（结束后还原）`)
    for (const suffix of ['', '-wal', '-shm']) {
      try { if (existsSync(d.path + suffix)) rmSync(d.path + suffix, { force: true }) } catch { /* ignore */ }
    }
  }

  // ── 1 ──
  await step('1. 应用启动与问答面板可达', '目标①入口可用', async () => {
    ok(await win.locator('#test-mode-banner').count() > 0,
      '测试模式横幅可见（本窗口回答来自本地 mock，非真实数据）')
    // N2：这条同时是「豁免真的生效了」的证据 —— 没拿到豁免的话，页面会停在启动引导
    // 或隐私同意屏上，后面所有断言都会失败，而不只是这一条。
    ok(await win.locator('#debug-gates-banner').count() > 0,
      '闸门豁免横幅可见（已跳过启动引导 / 授权 / 隐私同意，且主进程判定为非打包态）')
    await win.getByRole('button', { name: '微信问答' }).first().click()
    await win.locator('text=本机检索 · AI 综合回答').first().waitFor({ timeout: 40000 })
    const body = await win.locator('body').innerText()
    ok(/\d+ 个会话可检索/.test(body), '会话数徽标渲染', (body.match(/\d+ 个会话可检索/) || [''])[0])
    // 检索参数已固化为产品默认值：界面上不该再有「检索设置」这类调参入口。
    ok((await win.getByRole('button', { name: '检索', exact: true }).count()) === 0,
      '问答面板不再有「检索」chip（面板已下线）')
    ok((await win.locator('section[aria-label="检索设置"]').count()) === 0,
      '界面上不存在「检索设置」面板')
    ok(await win.getByLabel('微信问答问题').count() > 0, '提问输入框存在')
    ok(await win.getByRole('button', { name: '优化提问' }).count() > 0, '「优化提问」按钮存在')
    // 模型配置已迁到「设置」：问答面板不该再出现模型入口
    ok(!body.includes('未配置模型') && (await win.locator('[title*="当前模型"]').count()) === 0,
      '问答面板不再有模型配置入口（已迁到设置）')
    await shot(win, '01-ask-panel')
  })

  // ── 2 ──
  await step('2. 检索参数不暴露：界面无入口，后端能力仍在', '目标⑥：开箱即用、零调参', async () => {
    // ① 界面侧：面板与入口都必须彻底消失（连文案都不该残留）
    ok((await win.locator('section[aria-label="检索设置"]').count()) === 0, '不存在「检索设置」面板')
    ok((await win.getByRole('button', { name: '检索', exact: true }).count()) === 0, '不存在「检索」入口按钮')
    const body = await win.locator('body').innerText()
    const exposed = ['检索设置（RAG）', '多阶段检索流水线', '稠密相似度下限', 'RRF 融合常数', '保存检索设置', '跑离线评估', '重置权重']
      .filter((s) => body.includes(s))
    ok(exposed.length === 0, '界面上不出现任何检索参数文案', exposed.join(' / '))

    // ② 后端侧：能力仍在，且默认值就是产品最优值（固化 ≠ 删除）
    const st = await callBackend(win, 'getRetrievalStatus')
    ok(st.ok, '后端 getRetrievalStatus 仍可用', st.error || `${st.ms}ms`)
    const cfg = st.value?.config || {}
    ok(cfg.enabled === true, '默认即启用多阶段检索流水线（开箱即用）', `enabled=${cfg.enabled}`)
    ok(cfg.channels?.sparse?.enabled === true, '默认即启用稀疏通道', `sparse.enabled=${cfg.channels?.sparse?.enabled}`)
    ok(cfg.channels?.dense?.enabled === true, '默认即启用稠密向量通道', `dense.enabled=${cfg.channels?.dense?.enabled}`)
    ok(cfg.fusion?.k === 60, 'RRF 融合常数为文档默认值 60', `fusion.k=${cfg.fusion?.k}`)
    ok(cfg.fusion?.keep === 120, '融合保留条数为默认值 120', `fusion.keep=${cfg.fusion?.keep}`)
    ok(cfg.intent?.llmAssist === false, 'LLM 辅助意图分类保持默认关闭（少一跳模型调用）', `llmAssist=${cfg.intent?.llmAssist}`)
    ok(cfg.compress?.maxChars === 4000, '夹具参数未被界面改写（maxChars=4000）', `maxChars=${cfg.compress?.maxChars}`)
    await shot(win, '02-no-retrieval-panel')
  })
  // ── 3 ──
  await step('3. 改一处不重置其它参数（后端契约，无需界面）', '目标⑥：参数合并安全', async () => {
    const before = JSON.parse(readFileSync(backup.ragPath, 'utf8'))
    ok(before?.embedding?.maxDocsPerBuild === 400 && before?.channels?.dense?.minSimilarity === 0,
      '起始态：夹具参数就位（未暴露参数 = 400 / 0）',
      `maxDocsPerBuild=${before?.embedding?.maxDocsPerBuild} minSimilarity=${before?.channels?.dense?.minSimilarity}`)
    // 写入的是**文档默认值 60**（而不是某个临时数字）：万一脚本被中断、还原没跑到，
    // 真实配置里也不会残留一个只有测试才知道来历的怪值。
    const save = await callBackend(win, 'saveRetrievalConfig', [{ patch: { fusion: { k: 60 } } }])
    ok(save.ok, '后端 saveRetrievalConfig 仍可用（诊断/测试用，界面不接线）', save.error || '')
    const after = JSON.parse(readFileSync(backup.ragPath, 'utf8'))
    ok(after?.fusion?.k === 60, '落盘 fusion.k=60（= 文档默认值）', JSON.stringify(after?.fusion))
    ok(after?.embedding?.maxDocsPerBuild === 400, '未暴露参数未被重置（maxDocsPerBuild 仍为 400）',
      `maxDocsPerBuild=${after?.embedding?.maxDocsPerBuild}`)
    ok(after?.channels?.dense?.minSimilarity === 0, '已改参数保留（minSimilarity=0）')
  })
  // ── 4 ──
  await step('4. 稠密索引开箱即用：首次提问自动构建（界面无手动入口）', '目标①混合检索的稠密底座默认即生效', async () => {
    // 向量库已在本脚本 setUp 时清空 → 现在就是**真正的开箱初始态**，不预先手动建索引。
    ok(!existsSync(join(root, 'wechat_rag_vectors.db')), '起始态：向量库尚不存在（开箱初始态）')
    ok((await win.locator('text=/构建向量索引|全量重建/').count()) === 0,
      '界面上没有「构建向量索引」入口（用户不需要知道有这回事）')
    const embedBefore = mockCalls.embed
    // 用户侧只做一件事：提问。
    const r = await askAndWait(win, '最近一次转账给我的是谁')
    if (r.alert) ok(false, '问答返回错误', r.alert)
    const embedDelta = mockCalls.embed - embedBefore
    ok(embedDelta > 0, '仅靠一次普通提问就真实调用了 embedding 接口（自动建索引）',
      `本次 embed ${embedDelta} 次（合计 ${mockCalls.embed}）`)
    ok(embedDelta <= 40, '自动建索引请求量有界（未失控）', `embed ${embedDelta} 次`)
    const st = await callBackend(win, 'getRetrievalStatus')
    const rows = Number(st.value?.vector?.rows || 0)
    ok(rows > 0, '向量库已自动入库（>0 条）', `rows=${rows}`)
    ok(Boolean(st.value?.vector?.model), '向量库记录了所用模型', String(st.value?.vector?.model || ''))
    await shot(win, '03-auto-vector-built')
  })
  // ── 5 ──
  await step('5. 召回评估机制（指标与消融）仍在，界面无入口', '目标②可量化评估', async () => {
    ok((await win.locator('text=/跑离线评估/').count()) === 0, '界面无「跑离线评估」入口')
    const ev = await callBackend(win, 'evaluateRetrieval', [{ k: 10 }])
    ok(ev.ok, '后端 evaluateRetrieval 返回 ok', ev.error || `${ev.ms}ms`)
    const report = String(ev.value?.report || '')
    ok(report.length > 0, '返回评估报告文本', `${report.length} 字符`)
    for (const k of ['P@10', 'R@10', 'MRR', 'NDCG@10', 'MAP']) ok(report.includes(k), `报告含 ${k}`)
    ok(report.includes('消融对照（仅稀疏）'), '报告含消融对照')
    ok(report.includes('意图分类准确率'), '报告含意图分类准确率')
    const hy = Number(ev.value?.hybrid?.mrr ?? NaN)
    const sp = Number(ev.value?.sparseOnly?.mrr ?? NaN)
    ok(Number.isFinite(hy) && Number.isFinite(sp), '解析出两组 MRR', `hybrid=${hy} sparse=${sp}`)
    ok(hy >= sp, '混合检索 MRR ≥ 纯稀疏（消融成立）', `hybrid=${hy} sparse=${sp}`)
  })
  // ── 6 ──
  await step('6. 问答全链路与检索漏斗可视化', '目标①③④：召回→融合→重排→压缩可见', async () => {
    const r = await askAndWait(win, '我一共转了多少笔账')
    if (r.alert) ok(false, '问答返回错误', r.alert)
    const body = await win.locator('body').innerText()
    ok(body.includes('最近一次转账来自王五'), '回答已渲染（mock 回答落地）')
    ok(r.after > r.before, '引用来源列表已渲染', `来源 ${r.before} → ${r.after}`)
    ok(/召回 \d+ → 融合 \d+ → 重排 \d+ → 窗口 \d+/.test(body), '漏斗行：召回→融合→重排→窗口')
    ok(/路由 .+/.test(body), '漏斗行：意图路由标签')
    ok(/稀疏 \d+/.test(body), '漏斗行：稀疏通道命中数')
    ok(/稠密 \d+/.test(body), '漏斗行：稠密通道命中数（链路验证）')
    ok(/\d+ms/.test(body), '漏斗行：检索耗时')
    ok(!body.includes('稠密通道未生效'), '稠密通道生效（未降级）')
    ok(mockCalls.planner > 0 && mockCalls.chat > mockCalls.planner, '规划器与综合回答均被调用（查询改写 + 生成）', `chat=${mockCalls.chat} planner=${mockCalls.planner}`)
    // mock 回答里的「5000.00 元」在来源里根本不存在（来源是「收到转账 13.00 元」），
    // 接地审计必须把它标出来 —— 这条同时是「编造金额会被提示」的端到端证明。
    ok(body.includes('在它引用的原文里没有出现'), '接地上报：回答里编造的金额被标出')
    ok(body.includes('5000.00元'), '接地提示里点名了那个金额', (body.match(/回答里的[^\n]{0,40}/) || [''])[0])
    // 数据来源说明：由后端按检索结果算出，条数必须与实际来源列表一致（可逐条核对）
    const srcCount = Number((body.match(/来源 · (\d+) 条/) || [])[1] || 0)
    const basisMatch = body.match(/依据本机记录：(\d+) 条原文 · (\d+) 个会话/)
    ok(!!basisMatch, '回答下方给出数据来源说明', basisMatch ? basisMatch[0] : '未找到')
    ok(!!basisMatch && Number(basisMatch[1]) === srcCount,
      '来源条数与实际来源列表一致', basisMatch ? `说明 ${basisMatch[1]} vs 列表 ${srcCount}` : '')
    ok(body.includes('回答引用了其中'), '说明里写清了引用了哪几条 [n]')
    // 提示词回归：内容底线 + 语气要求必须真的发给了模型（不是只写在注释里）
    const promptReqs = ['只用材料里的事实', '不要凭常识推测', '像微信里跟人说话那样自然', '找不到就直说', '每条事实后面标 [n]']
    const missingReq = promptReqs.filter(p => !mockCalls.lastSynth.includes(p))
    ok(missingReq.length === 0, '发给模型的提示词含内容底线与自然语气要求',
      missingReq.length ? `缺少：${missingReq.join(' / ')}` : promptReqs.length + ' 项齐备')
    await shot(win, '05-answer-funnel')

    // 硬约束：模型给的内容一条原文都对应不上 → 用更严格指令重试一次；仍无引用则不予采用
    await askAndWait(win, '无引用测试')
    const body2 = await win.locator('body').innerText()
    ok(body2.includes('没有找到可据以回答的证据'), '无引用的回答被弃用（不把无法核实的内容给用户）')
    ok(!body2.includes('88888.88'), '编造的数字没有出现在界面上')
    ok(mockCalls.noCite >= 2, '确实重试过一次（两次都拿不到引用才弃用）', `noCite=${mockCalls.noCite}`)
  })

  // ── 7 ──
  await step('7. 反馈闭环（标注 → 提交 → 归因 → 调参落盘）', '目标⑤用户反馈写回', async () => {
    await win.getByRole('button', { name: /待改进/ }).last().click()
    await win.getByRole('button', { name: '提交反馈' }).waitFor({ timeout: 10000 })
    ok(true, '👎 展开逐条标注面板')
    ok(await win.getByRole('button', { name: '有用' }).count() > 0, '含「有用」标注')
    ok(await win.getByRole('button', { name: '没用' }).count() > 0, '含「没用」标注')
    await win.getByRole('button', { name: '没用' }).first().click()
    await win.getByRole('button', { name: '提交反馈' }).click()
    await win.locator('text=已反馈：待改进').first().waitFor({ timeout: 30000 })
    ok(true, '提交后进入「已反馈」态')
    await shot(win, '06-feedback-submitted')
    // 「查看最近反馈」原本挂在检索设置面板里 —— 面板已下线，改从后端读回同一份事实。
    ok((await win.getByRole('button', { name: '查看最近反馈' }).count()) === 0, '界面无「查看最近反馈」入口')
    const fb = await callBackend(win, 'listRetrievalFeedback', [{ limit: 50 }])
    ok(fb.ok, '后端 listRetrievalFeedback 仍可用', fb.error || '')
    const items = fb.value?.items || []
    ok(items.length > 0, '反馈已写入后端', `total=${fb.value?.stats?.total} items=${items.length}`)
    ok(items.some((it) => it.rating === 'down'), '👎 已落库（存在 rating=down 的记录）',
      items[0] ? `${items[0].rating} · ${String(items[0].question || '').slice(0, 40)}` : '')
    ok(existsSync(backup.weightsPath), '权重调参结果已落盘 rag-weights.json')
  })
  // ── 8 ──
  await step('8. 降级验证：关闭稠密通道（改配置，界面不暴露该开关）', '目标①通道可独立降级且显式告知', async () => {
    ok((await win.locator('text=/稠密向量通道/').count()) === 0, '界面上没有稠密通道开关')
    patchRagConfig({ channels: { dense: { enabled: false } } })
    const r = await askAndWait(win, '最近一次转账给我的是谁')
    if (r.alert) ok(false, '问答返回错误', r.alert)
    await win.locator('text=稠密通道未生效').first().waitFor({ timeout: 30000 })
    ok(true, '关闭稠密后漏斗行显示「稠密通道未生效（纯稀疏）」')
    await shot(win, '07-degraded-dense-off')
    patchRagConfig({ channels: { dense: { enabled: true } } })
    ok(true, '已恢复稠密通道')
  })
  // ── 9 ──
  await step('9. 灰度回退：总开关关闭即走旧检索（改配置，界面不暴露该开关）', '目标⑥可一键回退', async () => {
    ok((await win.locator('text=/多阶段检索流水线/').count()) === 0, '界面上没有流水线总开关')
    const before = await win.locator('text=/召回 \d+ → 融合 \d+/').count()
    patchRagConfig({ enabled: false })
    const r = await askAndWait(win, '上个月工资发了多少')
    if (r.alert) ok(false, '问答返回错误', r.alert)
    const after = await win.locator('text=/召回 \d+ → 融合 \d+/').count()
    ok(after === before, '总开关关闭后不再产生漏斗行（回退旧单通道检索）', `before=${before} after=${after}`)
    ok(r.after > r.before, '旧路径仍能返回引用（功能未失效）', `来源 ${r.before} → ${r.after}`)
    await shot(win, '08-legacy-fallback')
    patchRagConfig({ enabled: true })
    ok(true, '已恢复流水线总开关')
  })
  // ── 10 ──
  await step('10. 会话级 AI 对话（聊天头部入口 + 「新对话」面板）', '会话级 AI 问答可用且不遮挡消息流', async () => {
    const wait = (ms) => win.waitForTimeout(ms)
    // 进入「聊天消息」并打开一个会话
    await win.getByRole('button', { name: '聊天会话' }).first().click()
    await win.locator('text=聊天消息').first().waitFor({ timeout: 40000 })
    await wait(2500)
    const rowCls = await win.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find(d => /_list_/.test(d.className || '') && d.childElementCount > 20)
      const kids = el ? [...el.children] : []
      const row = kids.find(c => c.tagName === 'BUTTON' && /_sessionItem/.test(String(c.className)))
      return row ? String(row.className).split(' ')[0] : ''
    })
    ok(Boolean(rowCls), '找到会话行', rowCls)
    await win.locator('[class*="' + rowCls + '"]').first().click()
    await wait(3000)

    const aiBtn = win.getByRole('button', { name: 'AI 问答' })
    ok((await aiBtn.count()) > 0, '聊天头部出现「AI 问答」入口')
    await aiBtn.first().click()
    const aiPanel = win.locator('section[aria-label="会话 AI 对话"]')
    await aiPanel.waitFor({ timeout: 15000 })
    const t = await aiPanel.innerText()
    ok(t.includes('新对话'), '面板标题「新对话」')
    ok(t.includes('读取范围'), '含「读取范围」')
    // 范围恒为当前会话 ⇒ 必须是只读展示；面板内只应剩「默认模型」一个下拉
    const combos = await aiPanel.getByRole('combobox').count()
    ok(combos === 0, '会话 AI 面板无任何下拉（范围只读、模型已迁出）', `combobox 数=${combos}`)
    ok(!t.includes('跟随聊天'), '不再有只能取单值的「跟随聊天」控件')
    const sessName = (await win.locator('[class*="_msgHeaderName_"]').first().textContent().catch(() => '')) || ''
    ok(sessName.trim() !== '' && t.includes(sessName.trim()), '范围显示的就是当前会话名', `会话头=${sessName.trim()}`)
    for (const s of ['最近讨论了哪些重要的事？', '帮我找一下之前提过的报价', '有哪些事情还没确认？']) {
      ok(t.includes(s), `引导问题：${s}`)
    }
    ok(t.includes('回答附原文出处'), '含出处说明')
    // 输入区观感：空输入时发送键必须是**中性描边**，不能是一个亮着的实心圆
    //（早先无论能否发送都是亮青色实心，只有 disabled 时降透明度，看着像一盏常亮的按钮）。
    const sendBtn = aiPanel.getByRole('button', { name: '发送' })
    const idleBg = await sendBtn.evaluate((el) => getComputedStyle(el).backgroundImage)
    const idleBorder = await sendBtn.evaluate((el) => getComputedStyle(el).borderTopWidth)
    ok(idleBg === 'none' && parseFloat(idleBorder) > 0, '空输入时发送键为中性描边（不是亮色实心圆）',
      `bg=${idleBg} border=${idleBorder}`)
    await win.getByLabel('继续追问这段聊天').fill('随便写点什么')
    const activeBg = await sendBtn.evaluate((el) => getComputedStyle(el).backgroundImage)
    ok(activeBg.includes('gradient'), '有输入时发送键才变为渐变高亮', activeBg.slice(0, 44))
    // 与消息流并排、不遮挡
    const mb = await win.locator('[class*="_msgBody_"]').first().boundingBox().catch(() => null)
    const ab = await aiPanel.boundingBox()
    ok(Boolean(ab) && (!mb || ab.x >= mb.x + mb.width - 2), '面板在消息流右侧（不遮挡）',
      `ai.x=${ab ? Math.round(ab.x) : '?'} msg.right=${mb ? Math.round(mb.x + mb.width) : '?'}`)
    await shot(win, '09-session-ai-empty')

    // 提问 → 走 mock LLM 的完整链路
    await win.getByLabel('继续追问这段聊天').fill('最近讨论了哪些重要的事？')
    await win.keyboard.press('Enter')
    // 两种都算通过：有原文时走模型（mock 固定回复），**检索不到原文时**后端会短路成
    // 「没有检索到相关原文」的明确说明而不是编答案 —— 后者恰恰是我们要的严格行为。
    await win.waitForFunction(() => {
      const sec = document.querySelector('section[aria-label="会话 AI 对话"]')
      if (!sec) return false
      const text = sec.innerText
      return /最近一次转账来自王五/.test(text)
        || /没有检索到与这个问题相关的原文/.test(text)
        || /没有找到可据以回答的证据/.test(text)
        || !!sec.querySelector('[role="alert"]')
    }, undefined, { timeout: 180000 })
    const after = await aiPanel.innerText()
    const answered = after.includes('最近一次转账来自王五')
    const noEvidence = /没有检索到与这个问题相关的原文/.test(after)
    ok(answered || noEvidence, '会话内问答要么给出带引用的回答、要么明确说明无证据',
      answered ? '（走模型）' : '（本会话该问题检索不到原文，按严格模式不予回答）')
    ok(after.includes('依据本机记录：') || noEvidence, '回答下方给出数据来源说明（或说明无证据）',
      (after.match(/依据本机记录：[^\n]{0,60}/) || [''])[0])
    ok((await aiPanel.locator('[role="alert"]').count()) === 0, '无错误提示',
      await aiPanel.locator('[role="alert"]').first().textContent().catch(() => ''))
    await shot(win, '10-session-ai-answer')

    // 新对话（清空线程）后应回到空态
    await aiPanel.getByRole('button', { name: '开始新对话' }).click()
    await wait(600)
    ok((await aiPanel.innerText()).includes('想从聊天里了解什么？'), '「开始新对话」清空后回到空态')

    // 关闭面板
    await aiPanel.getByRole('button', { name: '关闭 AI 对话' }).click()
    await wait(600)
    ok((await win.locator('section[aria-label="会话 AI 对话"]').count()) === 0, '关闭后面板消失')
  })

  // ── 11 ──
  await step('11. 「设置」弹窗（左导航 + 右内容）与全应用唯一的 AI 模型入口', '配置/授权/维护动作收进弹窗：右区 13 节连续滚动、左导航充当目录；只读数据视图（隐私体检 / 操作日志）留在主界面；模型配置不再散落在问答面板', async () => {
    const wait = (ms) => win.waitForTimeout(ms)
    // 侧栏底部固定的那个按钮现在叫「设置」（原来叫「数据配置」）。名字短了必须精确匹配，
    // 否则「高级设置」「前往系统设置」这类含同名字串的按钮会先被选中。
    await win.getByRole('button', { name: '设置', exact: true }).first().click()
    // Radix 1.1.23 只给 Content 加 role="dialog"，不写 aria-modal，所以判据落在
    // 「role=dialog + 遮罩层 + 主内容区未被替换」三条上，而不是查属性值。
    const dlg = win.locator('[role="dialog"]').filter({ has: win.locator('nav[aria-label="设置导航"]') })
    await dlg.first().waitFor({ timeout: 30000 })
    ok(await dlg.first().isVisible(), '「设置」以弹窗打开（role=dialog 且可见）')
    ok((await win.locator('[class*="dialogOverlay"]').count()) === 1, '弹窗带遮罩层（是模态弹窗）')
    // 关键判据：它是弹窗，不是把主内容区切成设置页 —— 导航长在弹窗里，主内容区里查不到它
    ok((await win.locator('main nav[aria-label="设置导航"]').count()) === 0,
      '左导航属于弹窗而不是主内容区（主内容区留在原来那一页）')

    // —— 左右结构：左导航（固定宽，充当目录）+ 右内容（13 节堆叠，连续滚动）——
    // 这一页共 13 节（配置向导 5 步 + 智能与隐私 2 + 授权与更新 2 + 维护与自检 3 + 高级 1）。
    // 早期是「右侧一次只显示一节」：滚到该节底部就停住，想继续看下一节得回左栏再点一次。
    // 现在 13 节全部堆在同一个滚动区里，滚到一节末尾自然接下一节；左导航变成目录 ——
    // 点击滚到该节，高亮按滚动位置反推（见 Settings.tsx 的 onPaneScroll）。
    const rail = dlg.locator('nav[aria-label="设置导航"]')
    await rail.waitFor({ timeout: 20000 })
    const layout = await win.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      const nav = d.querySelector('nav[aria-label="设置导航"]')
      const pane = nav.nextElementSibling
      const nr = nav.getBoundingClientRect()
      const pr = pane.getBoundingClientRect()
      // 各节带 data-settings-section 锚点（滚动侦测与断言都靠它定位）。这里数「真的显示出来」
      // 的节，判定按算出来的 display：只写 hidden 属性会被 .card 的 display 压过。
      const secs = Array.from(pane.querySelectorAll('[data-settings-section]'))
      const shown = secs
        .filter(c => getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'absolute')
        .map(c => c.dataset.settingsSection)
      return {
        items: Array.from(nav.querySelectorAll('button')).map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()),
        groups: Array.from(nav.querySelectorAll('[class*="navGroupLabel"]')).map(e => (e.textContent || '').trim()),
        dir: getComputedStyle(nav).flexDirection,
        navW: Math.round(nr.width), navRight: Math.round(nr.right), navTop: Math.round(nr.top),
        paneW: Math.round(pr.width), paneLeft: Math.round(pr.left), paneTop: Math.round(pr.top),
        shown,
        // 节被 flex 压扁的迹象：自身 clientHeight 小于 scrollHeight（内容被静默截掉）
        squashed: secs.filter(c => c.scrollHeight > c.clientHeight + 2).map(c => c.dataset.settingsSection),
        scrollH: pane.scrollHeight, clientH: pane.clientHeight,
        disclosures: d.querySelectorAll('details, summary').length,
      }
    })
    ok(layout.items.length === 13, '左导航 13 项',
      layout.items.join(' / '))
    ok(layout.groups.join('|') === '配置向导|智能与隐私|授权与更新|维护与自检|高级',
      '13 项分五组显示（配置向导 / 智能与隐私 / 授权与更新 / 维护与自检 / 高级）', layout.groups.join('|'))
    ok(layout.dir === 'column', '导航项竖向排列', layout.dir)
    ok(layout.paneLeft >= layout.navRight, '右内容区在左导航右侧（并排、不重叠）',
      `导航右缘 ${layout.navRight} ≤ 内容左缘 ${layout.paneLeft}`)
    ok(Math.abs(layout.paneTop - layout.navTop) <= 2, '左右两栏顶部对齐',
      `导航 ${layout.navTop} / 内容 ${layout.paneTop}`)
    ok(layout.paneW > layout.navW * 3, '右内容区宽度远大于导航（右区才是主区）',
      `导航 ${layout.navW}px / 内容 ${layout.paneW}px`)
    ok(layout.shown.length === 13 && layout.shown[0] === 'detect',
      '13 节全部堆在右区（不再是只显示一节、其余 display:none）', layout.shown.join(' | '))
    ok(layout.scrollH > layout.clientH, '整份内容高于右区 → 右区可连续滚动',
      `${layout.scrollH} > ${layout.clientH}`)
    ok(layout.squashed.length === 0, '没有节被压扁（节自身高度小于内容高度）', layout.squashed.join(' | '))
    ok(layout.disclosures === 0, '节内不再有可折叠的 details/summary（高级设置已是普通卡片）',
      String(layout.disclosures))

    // 导航点击 = 滚到该节（节顶对齐右区上沿，左导航高亮跟着切）；滚到底高亮落到最后一节。
    // 早先这里必须先压矮窗口才能验滚动（单节装得下就没有滚动条），现在 13 节堆在一起、
    // 八千多像素的内容远高于 665px 的右区，窗口尺寸不再需要干预。
    const sectionState = (key) => win.evaluate((k) => {
      const d = document.querySelector('[role="dialog"]')
      const nav = d.querySelector('nav[aria-label="设置导航"]')
      const box = nav.nextElementSibling
      const el = box.querySelector(`[data-settings-section="${k}"]`)
      const cur = nav.querySelector('button[aria-current="true"]')
      const br = box.getBoundingClientRect()
      const rr = el.getBoundingClientRect()
      return {
        rel: Math.round(rr.top - br.top),
        // 末尾几节顶不到右区上沿（下方内容不够高，滚动被夹住），所以另看是否落在可视区
        inView: rr.bottom > br.top + 4 && rr.top < br.bottom - 4,
        current: (cur?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12),
        scrollTop: Math.round(box.scrollTop), scrollH: box.scrollHeight, clientH: box.clientHeight,
        maxScroll: box.scrollHeight - box.clientHeight,
      }
    }, key)

    await rail.getByRole('button', { name: '语音转文字' }).first().click()
    await win.waitForTimeout(900)
    const jumped = await sectionState('voice')
    ok(Math.abs(jumped.rel) <= 20, '点导航把该节滚到右区上沿', `rel ${jumped.rel}`)
    ok(jumped.current.includes('语音'), '左导航高亮跟着切到被点的那节', jumped.current)
    ok(jumped.scrollH > jumped.clientH, '整份内容高于右区，确实需要滚动', `${jumped.scrollH} > ${jumped.clientH}`)
    ok(jumped.scrollTop > 0, '右内容区可滚动', String(jumped.scrollTop))

    // 手动滚到底。显式写 instant：CSS 的 scroll-behavior:smooth 会把程序化赋值也变成动画，
    // 八千多像素等它走完要好几秒（真实滚轮不受影响，这是模拟方式的坑）。
    //
    // ⚠️ 还要**等高度稳定、再滚一次**（2026-09-18 实测）：右区里有几节是异步自检（原图链路自检 /
    // 数据库健康），它们会在滚到底之后才把结果渲染进来。内容一长高，刚才的「底」就不再是底
    // —— 实测 scrollHeight 7033 → 7088（+55），scrollTop 停在旧的最大值 6368、新的是 6423，
    // 于是「确实滚到了底部」差 55 而红，高亮也停在「原图链路自检」上。再滚一次即到底
    // （高亮正确落到「高级设置」）。这是**量法没跟上异步渲染**，不是产品缺陷。
    const scrollToBottom = () => win.evaluate(() => {
      const box = document.querySelector('[role="dialog"] nav[aria-label="设置导航"]').nextElementSibling
      box.scrollTo({ top: box.scrollHeight, behavior: 'instant' })
      return box.scrollHeight
    })
    let lastH = -1
    for (let i = 0; i < 15; i++) {
      const h = await scrollToBottom()
      await win.waitForTimeout(400)
      if (h === lastH) break
      lastH = h
    }
    const bottom = await sectionState('advanced')
    ok(bottom.scrollTop >= bottom.maxScroll - 2, '确实滚到了底部', `${bottom.scrollTop}/${bottom.maxScroll}`)
    ok(bottom.current.includes('高级'), '滚到底高亮落到最后一节', bottom.current)

    await rail.getByRole('button', { name: '检测账号' }).first().click()
    await win.waitForTimeout(900)
    const backTop = await sectionState('detect')
    ok(backTop.scrollTop <= 2, '点第一节回到顶部', String(backTop.scrollTop))
    ok(backTop.current.includes('检测账号'), '高亮回到第一节', backTop.current)

    // AI 大模型是左导航的一项：点它滚过去（13 节都在 DOM 里，不再是「切过去才可见」）
    await rail.getByRole('button', { name: 'AI 大模型' }).first().click()
    await win.waitForTimeout(500)

    const card = win.locator('section[aria-label="AI 大模型"]')
    await card.waitFor({ timeout: 30000 })
    // 等 apiGetLlmConfig 回来（SSR 之外的 effect）
    await card.locator('text=模型供应商').waitFor({ timeout: 20000 }).catch(() => {})
    const t = await card.innerText()
    ok(t.includes('AI 大模型'), '卡片标题')
    ok(t.includes('全应用共用一份配置'), '说明文案')
    ok(t.includes('模型供应商'), '含「模型供应商」')
    ok(t.includes('API Key'), '含 API Key')
    ok(t.includes('向量模型'), '含「向量模型」（原检索设置里的那项）')
    ok(t.includes('配置模板'), '含厂商模板下拉')
    ok(t.includes('获取官方模型') && t.includes('保存模型配置'), '含获取/保存动作')
    ok(t.includes('mock-chat'), '显示当前已配置模型', t.slice(0, 160).replace(/\n/g, ' '))
    await shot(win, '11-ai-model-card')

    // —— 从外层侧栏迁进来、且留在弹窗里的那一节：数据边界与出网 ——
    // 外面那个「隐私与信任」页签已下线，这里是它们唯一的入口。
    // 溢出检查要**限定到某一节**：13 节现在同处一个滚动容器，扫整棵子树会把别的节里
    // 本来就该内部滚动的区域也算成「被裁掉」，报出与本节无关的失败。
    const clipIn = (key) => win.evaluate((k) => {
      const pane = document.querySelector('[role="dialog"] nav').nextElementSibling
      const scope = pane.querySelector(`[data-settings-section="${k}"]`)
      const clipped = []
      for (const el of scope.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.overflowY !== 'hidden' && cs.overflow !== 'hidden') continue
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2) {
          clipped.push(`${String(el.className).split(' ')[0]}:${el.clientHeight}/${el.scrollHeight}`)
        }
      }
      return { clipped, scrollH: pane.scrollHeight, clientH: pane.clientHeight }
    }, key)

    await rail.getByRole('button', { name: '数据边界与出网' }).first().click()
    await win.waitForTimeout(1200)
    const boundary = await win.evaluate(() => {
      const nav = document.querySelector('[role="dialog"] nav[aria-label="设置导航"]')
      const pane = nav.nextElementSibling
      const scope = pane.querySelector('[data-settings-section="boundary"]')
      const cur = nav.querySelector('button[aria-current="true"]')
      const br = pane.getBoundingClientRect()
      const rr = scope.getBoundingClientRect()
      const text = (scope.textContent || '').replace(/\s+/g, ' ')
      const toggle = Array.from(scope.querySelectorAll('button'))
        .find(b => (b.textContent || '').includes('一律不调用模型'))
      return {
        inView: rr.bottom > br.top + 4 && rr.top < br.bottom - 4,
        current: (cur?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12),
        hasLead: text.includes('检索统计、导出、图谱、备份等均为纯本地操作'),
        hasAvatarNote: text.includes('头像图片是唯一例外'),
        hasAudit: text.includes('AI 出站审计'),
        toggleH: toggle ? toggle.clientHeight : 0,
      }
    })
    ok(boundary.inView && boundary.current.includes('数据边界'), '点导航把「数据边界与出网」滚进可视区',
      boundary.current)
    ok(boundary.hasLead && boundary.hasAvatarNote, '两段边界说明都在（第二段原来被裁掉）')
    ok(boundary.toggleH > 0, '「禁止 AI 出网」开关在（原来被裁掉）', String(boundary.toggleH))
    ok(boundary.hasAudit, '含「AI 出站审计」')
    const bClip = await clipIn('boundary')
    ok(bClip.clipped.length === 0, '该节内没有「内容溢出但 overflow:hidden」的元素', bClip.clipped.slice(0, 4).join(' '))
    await shot(win, '11-boundary')

    // 隐私体检与操作日志 2026-09 从弹窗迁回主界面（只读数据视图）。这里先确认它们**不在**弹窗里，
    // 迁回主界面的行为在本步末尾单独验（要等弹窗关掉之后）。
    const railLabels = await win.evaluate(() => Array.from(
      document.querySelectorAll('[role="dialog"] nav[aria-label="设置导航"] button'),
    ).map(b => (b.textContent || '').replace(/\s+/g, ' ')))
    ok(!railLabels.some(t => t.includes('隐私体检')), '弹窗左导航不再有「隐私体检」（已迁回主界面）', railLabels.join(' | ').slice(0, 90))
    ok(!railLabels.some(t => t.includes('操作日志')), '弹窗左导航不再有「操作日志」（已迁回主界面）')

    // —— 第二批留在弹窗：备份恢复 / 数据库健康 / 原图链路自检（配置与维护动作） ——
    const KEY_OF = { 备份恢复: 'backup', 数据库健康: 'health', 原图链路自检: 'hook' }
    for (const label of ['备份恢复', '数据库健康', '原图链路自检']) {
      await rail.getByRole('button', { name: label }).first().click()
      await win.waitForTimeout(1800)
      const st = await sectionState(KEY_OF[label])
      ok(st.inView && st.current.includes(label),
        `点导航把「${label}」滚进可视区且高亮同步`, `${st.current} rel=${st.rel}`)
      const clip = await clipIn(KEY_OF[label])
      ok(clip.clipped.length === 0, `「${label}」节内没有溢出被裁的元素`, clip.clipped.slice(0, 3).join(' '))
    }
    await shot(win, '11-maintenance')

    // Esc 关闭（Radix 卸载内容），并确认回到原页
    await win.keyboard.press('Escape')
    await dlg.first().waitFor({ state: 'detached', timeout: 15000 })
    ok((await win.locator('[role="dialog"]').count()) === 0, 'Esc 关闭弹窗')
    const back = await win.locator('main').innerText()
    ok(back.length > 0 && !back.includes('检测账号'), '关闭后主内容区回到原来那一页')

    // —— 迁回主界面的两节：从侧栏进，且**不再**弹弹窗（判据：只读数据视图不该待在设置里） ——
    await win.getByRole('button', { name: '隐私体检' }).first().click()
    await win.waitForTimeout(2200)
    const privMain = await win.evaluate(() => {
      const main = document.querySelector('main')
      const text = (main?.textContent || '').replace(/\s+/g, ' ')
      const cats = ['手机号', '身份证号', '银行卡号', '邮箱', '密码口令', '地址信息']
      return {
        dialogOpen: !!document.querySelector('[role="dialog"]'),
        missing: cats.filter(c => !text.includes(c)),
        scan: Array.from(main?.querySelectorAll('button') ?? []).some(b => /重新扫描|开始扫描/.test(b.textContent || '')),
        hasTop: text.includes('风险联系人') && text.includes('风险群聊'),
      }
    })
    ok(!privMain.dialogOpen, '「隐私体检」在主内容区打开（不再弹设置弹窗）')
    ok(privMain.scan, '扫描入口还在（PanelHeader 的动作没丢）')
    ok(privMain.missing.length === 0, '六个敏感信息类别都在', privMain.missing.join(','))
    ok(privMain.hasTop, '风险联系人 / 风险群聊两栏还在')
    const privClip = await win.evaluate(() => {
      const main = document.querySelector('main')
      const clipped = []
      for (const el of main.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.overflowY !== 'hidden' && cs.overflow !== 'hidden') continue
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2) clipped.push(String(el.className).split(' ')[0])
      }
      return clipped
    })
    ok(privClip.length === 0, '主内容区里也没有被裁的元素', privClip.slice(0, 4).join(' '))
    await shot(win, '11-privacy-main')

    await win.getByRole('button', { name: '操作日志' }).first().click()
    await win.waitForTimeout(2200)
    const oplogMain = await win.evaluate(() => ({
      dialogOpen: !!document.querySelector('[role="dialog"]'),
      hasTable: (document.querySelector('main')?.textContent || '').includes('操作日志'),
      mainW: Math.round((document.querySelector('main')?.getBoundingClientRect().width ?? 0)),
    }))
    ok(!oplogMain.dialogOpen, '「操作日志」在主内容区打开（不再弹设置弹窗）')
    ok(oplogMain.hasTable, '主内容区是操作日志面板', String(oplogMain.hasTable))
    ok(oplogMain.mainW > 700, '审计表拿到了主内容区的整宽（弹窗右区只有 ~660px）', `${oplogMain.mainW}px`)
    await shot(win, '11-oplog-main')

    // 其他界面不再有模型入口
    await win.getByRole('button', { name: '微信问答' }).first().click()
    await win.locator('text=本机检索 · AI 综合回答').first().waitFor({ timeout: 30000 })
    await wait(800)
    ok((await win.locator('[title*="当前模型"]').count()) === 0, '问答面板无模型 chip')
    const body = await win.locator('body').innerText()
    ok(!body.includes('未配置模型'), '问答面板无「未配置模型」提示')

    // —— 弹窗内的跳转：能落在本弹窗某节的就地切节；装不下的才关窗走主内容区 ——
    await win.getByRole('button', { name: '设置', exact: true }).first().click()
    const dlg2 = win.locator('[role="dialog"]').filter({ has: win.locator('nav[aria-label="设置导航"]') })
    await dlg2.first().waitFor({ timeout: 30000 })
    const rail2 = dlg2.locator('nav[aria-label="设置导航"]')
    const paneOf = (label) => dlg2.locator('[class*="embedPane"]').filter({ hasText: label })
    // 「数据库健康 → 快捷入口 → 数据边界与出网」：应该是弹窗内换节，弹窗不关
    await rail2.getByRole('button', { name: '数据库健康' }).first().click()
    await win.waitForTimeout(1800)
    await paneOf('数据健康中心').getByRole('button', { name: '数据边界与出网' }).first().click()
    await win.waitForTimeout(1200)
    const inside = await win.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      if (!d) return { open: false }
      const nav = d.querySelector('nav[aria-label="设置导航"]')
      const pane = nav.nextElementSibling
      const scope = pane.querySelector('[data-settings-section="boundary"]')
      const active = nav.querySelector('button[aria-current="true"]')
      const br = pane.getBoundingClientRect()
      const rr = scope.getBoundingClientRect()
      return {
        open: true,
        inView: rr.bottom > br.top + 4 && rr.top < br.bottom - 4,
        active: (active?.textContent || '').replace(/\s+/g, ' ').slice(0, 10),
      }
    })
    ok(inside.open, '弹窗仍在（弹窗内的跳转没有把弹窗关掉）')
    ok(inside.inView && inside.active.includes('数据边界'),
      '「数据边界与出网」就地滚到本弹窗的对应节并同步高亮', inside.active)
    // 「数据库健康 → 快捷入口 → 文件资产」：弹窗装不下 → 关窗并切主内容区
    await rail2.getByRole('button', { name: '数据库健康' }).first().click()
    await win.waitForTimeout(1600)
    await paneOf('数据健康中心').getByRole('button', { name: '文件资产' }).first().click()
    await win.waitForTimeout(1500)
    ok((await win.locator('[role="dialog"]').count()) === 0, '「文件资产」是弹窗外页面 → 关掉弹窗')
    ok((await win.locator('main').innerText()).includes('文件资产'),
      '主内容区已切到「文件与存储」', (await win.locator('main').innerText()).slice(0, 30).replace(/\n/g, ' '))
  })

  // ── 12 ──
  await step('12. 年度报告看板（15 张卡片 · 一屏无滚动）', '年度回顾内容完整、一屏装下且不留大块空白', async () => {
    const wait = (ms) => win.waitForTimeout(ms)
    await win.getByRole('button', { name: '总结' }).first().click()
    await win.locator('text=年度报告').first().waitFor({ timeout: 40000 })
    // 分段选择器是 Radix ToggleGroup（role=radio），不是 button
    await win.getByText('年度报告', { exact: true }).first().click()
    await win.locator('section', { hasText: '全年发出' }).first().waitFor({ timeout: 180000 })
    await wait(2000)
    const body = await win.locator('body').innerText()
    const titles = ['全年发出', '最疯的一天', '年度搭子', '十二个月的主演', '深夜', '作息切片',
      '你说的话', '年度口头禅', '回复速度', '谁先开口', '年度聊天排行', '表情宇宙', '还有这些人']
    for (const t of titles) ok(body.includes(t), `卡片存在：${t}`)
    ok(body.includes('好好再说'), '页脚口号')
    ok(/第一条 ·/.test(body) && /最后一条 ·/.test(body), '页脚首尾')
    ok((await win.locator('[class*="_calCell_"]').count()) > 300, '日历格子 >300',
      String(await win.locator('[class*="_calCell_"]').count()))
    ok((await win.locator('[class*="_rhythmCell_"]').count()) === 168, '作息 168 格',
      String(await win.locator('[class*="_rhythmCell_"]').count()))
    // 布局：目标是「一屏装下、不出滚动条」——固定 12 列网格，行高按内容需求分配。
    // 三条判据缺一不可：容器不溢出、卡片不越界、卡片内容不被裁掉。
    //
    // ⚠️ 尺寸前提（2026-09-18 实测补上）：这套判据来自**设计基准尺寸** —— annual.module.css
    // 开头写明「实测可用区 1572×787（窗口 1664×1066）」。应用默认窗口是 1440×900，面板只有
    // ~684px，此时组件**按设计主动退化**成 `data-compact`（瀑布流 + 滚动，卡片一张不裁，
    // 实测 14 张卡 clip 全为 0）。那是预期降级、不是缺陷，但会让「一屏」这条判据量出
    // 714 vs 684 的假失败。所以先在基准尺寸上验「一屏」，再切回默认窗口验「退化也不许藏内容」。
    const measureBoard = () => win.evaluate(() => {
      const body = document.querySelector('[class*="_panelBody_"]')
      const wrap = document.querySelector('[class*="_wrap_"]')
      if (!body || !wrap) return { error: 'missing' }
      const br = body.getBoundingClientRect()
      const cards = [...wrap.querySelectorAll('[class*="_card_"]')]
      const clipped = cards.filter(c => c.scrollHeight > c.clientHeight + 2)
        .map(c => c.querySelector('[class*="_cardTitle_"]')?.textContent || '?')
      const overflow = cards.filter(c => c.getBoundingClientRect().bottom > br.bottom + 1)
        .map(c => c.querySelector('[class*="_cardTitle_"]')?.textContent || '?')
      return { scroll: body.scrollHeight, client: body.clientHeight, cards: cards.length, clipped, overflow,
        compact: wrap.hasAttribute('data-compact') }
    })
    // 换尺寸要**确认换成了**：静默失败会让判据在错误尺寸下跑（本脚本上一轮就栽在这类静默降级上）。
    const resizeWin = async (w, h) => {
      await win.evaluate(([tw, th]) => window.resizeTo(tw, th), [w, h])
      await win.waitForTimeout(1300)
      const got = await win.evaluate(() => [window.innerWidth, window.innerHeight])
      if (got[0] !== w || got[1] !== h) throw new Error(`窗口没能切到 ${w}×${h}（实测 ${got.join('×')}）`)
      return got
    }

    await resizeWin(1664, 1066)
    await wait(900)
    const layout = await measureBoard()
    ok(layout.scroll <= layout.client + 1, '一屏无滚动条（设计基准尺寸 1664×1066）',
      `${layout.scroll} vs ${layout.client}`)
    ok(layout.overflow.length === 0, '没有卡片越出可视区', layout.overflow.join(','))
    ok(layout.clipped.length === 0, '没有卡片内容被裁切', layout.clipped.join(','))
    ok(layout.cards === 14, '14 张卡片全部渲染', String(layout.cards))

    // 对照：回到应用默认窗口 1440×900 ——「一屏」不再成立（组件按设计退化），但**内容不许被藏**。
    await resizeWin(1440, 900)
    await wait(900)
    const small = await measureBoard()
    ok(small.cards === 14, '1440×900 下 14 张卡片仍在', String(small.cards))
    ok(small.clipped.length === 0, '1440×900 下退化（compact）也不裁切卡片内容', small.clipped.join(','))

    // 导出报告 = 界面截图（PNG）。SUPERTIME_CAPTURE_PATH 让它跳过原生保存对话框。
    const png = join(OUT, 'exported-report.png')
    try { rmSync(png, { force: true }) } catch { /* ignore */ }
    await win.getByRole('button', { name: '导出报告' }).first().click()
    await win.locator('text=已导出 PNG').first().waitFor({ timeout: 40000 })
    ok(existsSync(png), '导出报告产出 PNG 文件', png)
    const pngSize = existsSync(png) ? statSync(png).size : 0
    ok(pngSize > 20000, 'PNG 体积合理（>20KB）', `${pngSize} bytes`)
    const pngBuf = existsSync(png) ? readFileSync(png) : Buffer.alloc(0)
    ok(pngBuf.length > 24 && pngBuf[0] === 0x89 && pngBuf[1] === 0x50 && pngBuf[2] === 0x4E && pngBuf[3] === 0x47,
      'PNG 魔数正确')
    const pngW = pngBuf.length > 24 ? pngBuf.readUInt32BE(16) : 0
    // 期望宽度取**运行时实测**的面板宽度：窗口现在按屏幕工作区自适应、也允许自由缩放，
    // 写死像素（原来是 1664 宽窗口下的 1572）一换窗口尺寸就会误报。
    const shellW = await win.evaluate(() => {
      const el = document.querySelector('[class*="_panelShell_"]')
      return el ? Math.round(el.getBoundingClientRect().width) : 0
    })
    ok(shellW > 400 && Math.abs(pngW - shellW) <= 6, 'PNG 宽度 ≈ 面板宽度（所见即所存）', `${pngW} vs ${shellW}px`)
    await shot(win, '12-annual-dashboard')
  })

  // ── 13 ──
  await step('13. 面板内容不被静默裁切（flex 压缩回归）', '内容超高的面板要出现滚动条，而不是把卡片压扁后裁掉内容', async () => {
    const wait = (ms) => win.waitForTimeout(ms)
    // 资金往来是实测最严重的一例：定高 flex 列把「异常提醒」卡从 860px 压到 464px，
    // 卡片自带 overflow:hidden，于是半张卡的内容直接消失且没有任何可见提示。
    await win.getByRole('button', { name: '资金往来' }).first().click()
    await wait(3000)
    const r = await win.evaluate(() => {
      const shell = document.querySelector('[class*="_panelShell_"]')
      const clipped = []
      for (const el of shell.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.overflowY !== 'hidden' && cs.overflow !== 'hidden') continue
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2) {
          clipped.push(`${String(el.className).split(' ')[0]}:${el.clientHeight}/${el.scrollHeight}`)
        }
      }
      const cards = Array.from(shell.querySelectorAll('section')).map(s => ({
        h: s.clientHeight, sh: s.scrollHeight, t: (s.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14),
      }))
      return { clipped, cards, shell: `${shell.scrollHeight}/${shell.clientHeight}` }
    })
    const warn = r.cards.find(c => c.t.includes('异常提醒'))
    ok(!!warn, '找到「异常提醒」卡', warn ? warn.t : '未找到')
    ok(warn && warn.sh === warn.h, '异常提醒卡高度=内容高度（没有被压扁）',
      warn ? `${warn.h}/${warn.sh}` : '-')
    ok(r.clipped.length === 0, '面板内没有「内容溢出但 overflow:hidden」的元素', r.clipped.slice(0, 4).join(' '))
    ok(Number(r.shell.split('/')[0]) > Number(r.shell.split('/')[1]), '内容超高时面板改出现滚动（而不是压扁）', r.shell)
  })

  // ── 14 ──
  await step('14. 运行期无渲染错误', '整体稳定性', async () => {
    const real = consoleErrors.filter(e => !/use client|Module level directives|Download the React DevTools/i.test(e))
    ok(real.length === 0, '无 React/渲染错误', real.slice(0, 3).join(' | '))
  })
}

// ───────── 报告 ─────────
function report() {
  console.log('\n' + '='.repeat(74))
  console.log('「深度优化 AI 问答 RAG 流水线」UI 自动化验收报告')
  console.log('='.repeat(74))
  let pass = 0; let fail = 0
  for (const s of results) {
    console.log(`\n${s.ok ? '✅ 通过' : '❌ 不通过'}  ${s.name}    [${s.goal}]`)
    for (const c of s.checks) {
      if (c.pass) pass += 1
      else fail += 1
      if (!c.pass) console.log(`     ✗ ${c.label}${c.detail ? '  [' + c.detail + ']' : ''}`)
    }
    if (s.ok) console.log(`     ✓ ${s.checks.filter(c => c.pass).length}/${s.checks.length} 项断言通过`)
  }
  const stepsOk = results.filter(s => s.ok).length
  console.log('\n' + '-'.repeat(74))
  console.log(`步骤：${stepsOk}/${results.length} 通过 · 断言：${pass}/${pass + fail} 通过`)
  console.log(`mock 调用：chat=${mockCalls.chat}（规划器 ${mockCalls.planner}）· embed=${mockCalls.embed}`)
  console.log(`截图：${OUT}`)
  console.log('='.repeat(74))
  const ok = stepsOk === results.length && fail === 0
  console.log(ok ? '\n总判定：✅ 通过' : '\n总判定：❌ 不通过')
  // 返回判定结果，交给 main() 的 finally 决定退出码。
  // 原实现只把结论打在屏幕上：断言全挂时退出码仍是 0，CI 会看到「通过」。
  return { ok, stepsOk, total: results.length, pass, fail }
}

/**
 * 收尾：关应用 → 等进程真正退出 → 关 mock 服务 → 还原被接管的配置。
 *
 * 幂等：正常结束（finally）与信号中断（Ctrl+C）都可能调用，只跑第一次。
 */
let shutdownDone = false
async function shutdown(reason) {
  if (shutdownDone) return
  shutdownDone = true
  if (reason) console.error(`\n[${reason}] 正在收尾并还原配置…`)
  // 先关应用并**等进程真正退出**，再还原文件 —— 否则 Windows 会因文件被占用而删不掉
  // 向量库（实测残留过 15MB mock 向量）。
  const child = (() => { try { return app?.process() ?? null } catch { return null } })()
  try { await app?.close() } catch { /* ignore */ }
  for (let i = 0; i < 40 && child && child.exitCode === null; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
  }
  try { await new Promise((r) => server.close(() => r())) } catch { /* ignore */ }
  await restoreConfigs()
}

// 中断兜底：Ctrl+C / 被 kill 时上面的 finally 不会执行，llm.json 会一直指向本地 mock，
// 之后真人提问就会拿到 mock 的固定回答（看起来像应用在编造）。这里补一次还原。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    void shutdown(sig).then(() => process.exit(130))
  })
}

main()
  .catch((e) => { console.error('测试执行异常:', e); runError = e })
  .finally(async () => {
    await shutdown()
    let verdict = null
    try { verdict = report() } catch (e) { console.error('报告输出失败:', e) }
    let code = 0
    if (runError) code = 1
    if (verdict && !verdict.ok) code = 1
    if (restoreErrors.length > 0) {
      console.error('\n⚠ 环境还原不完整，请手动处理以下路径（否则会影响真实检索）：')
      for (const p of restoreErrors) console.error('   - ' + p)
      code = 1
    }
    if (code !== 0) {
      console.error(`\n退出码 ${code}：${[
        runError ? '执行期异常' : null,
        verdict && !verdict.ok ? `断言未全通过（${verdict.fail} 条失败 / ${verdict.pass} 条通过，步骤 ${verdict.stepsOk}/${verdict.total}）` : null,
        restoreErrors.length > 0 ? '环境还原不完整' : null,
      ].filter(Boolean).join('；')}`)
    }
    process.exitCode = code
  })

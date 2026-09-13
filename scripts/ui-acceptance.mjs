/**
 * 「深度优化 AI 问答 RAG 流水线」UI 自动化验收测试。
 *
 * 方案：
 *   · Playwright 的 Electron 驱动（_electron.launch）驱动**真实应用**：真实数据目录、
 *     真实许可、真实 ui-dist 与后端 bundle —— 不是 mock 出来的渲染层。
 *   · LLM 用**本地 mock**（127.0.0.1）替换：既让「问答 → 漏斗行 → 反馈」全链路可跑，
 *     又不把用户聊天数据发给任何外部厂商。mock 按 system prompt 区分规划器/综合回答，
 *     并提供 /embeddings（确定性向量）以真实跑通稠密通道。
 *   · 每步独立记 pass/fail，失败时截图 + dump DOM + 拉后端操作日志，最后输出报告。
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
const panel = (win) => win.locator('section[aria-label="检索设置"]')
const numInput = (win, i) => panel(win).getByRole('spinbutton').nth(i)
const checkbox = (win, i) => panel(win).getByRole('checkbox').nth(i)
const saveBtn = (win) => win.getByRole('button', { name: '保存检索设置' })
const waitEnabled = (win, label) => win.waitForFunction(
  (l) => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === l); return !!b && !b.disabled },
  label, { timeout: 60000 },
)
const countSrc = (win) => win.locator('text=/来源 ·/').count()

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
    env: { ...process.env, SUPERTIME_CAPTURE_PATH: join(OUT, 'exported-report.png'), SUPERTIME_TEST_MODE: '1' },
  })
  win = await app.firstWindow()
  win.setDefaultTimeout(25000)
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
  win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 300)))

  const info = await win.evaluate(() => window.electronAPI.wechat.info())
  const decrypted = info?.value?.decrypted || ''
  const root = decrypted ? join(decrypted, '..') : ''
  backup.ragPath = root ? join(root, 'rag-config.json') : null
  backup.weightsPath = root ? join(root, 'rag-weights.json') : null
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
    await win.getByRole('button', { name: '微信问答' }).first().click()
    await win.locator('text=本机检索 · AI 综合回答').first().waitFor({ timeout: 40000 })
    const body = await win.locator('body').innerText()
    ok(/\d+ 个会话可检索/.test(body), '会话数徽标渲染', (body.match(/\d+ 个会话可检索/) || [''])[0])
    ok(await win.getByRole('button', { name: '检索' }).count() > 0, '「检索」chip 存在（新增入口）')
    ok(await win.getByLabel('微信问答问题').count() > 0, '提问输入框存在')
    ok(await win.getByRole('button', { name: '优化提问' }).count() > 0, '「优化提问」按钮存在')
    // 模型配置已迁到「设置」：问答面板不该再出现模型入口
    ok(!body.includes('未配置模型') && (await win.locator('[title*="当前模型"]').count()) === 0,
      '问答面板不再有模型配置入口（已迁到设置）')
    await shot(win, '01-ask-panel')
  })

  // ── 2 ──
  await step('2. 检索设置面板与实时状态', '目标⑥参数面板 + 状态真实', async () => {
    await win.getByRole('button', { name: '检索' }).first().click()
    await panel(win).waitFor({ timeout: 15000 })
    // 面板先渲染骨架、状态是异步拉取的 —— 必须等状态到达再断言
    await panel(win).locator('text=意图分类自评').waitFor({ timeout: 20000 })
    const t = await panel(win).innerText()
    ok(t.includes('检索设置（RAG）'), '面板标题')
    ok(/100\.0%/.test(t) && /7\/7/.test(t), '概览：意图分类自评 100%（7/7）', (t.match(/100\.0%7\/7/) || [''])[0])
    ok(t.includes('向量库'), '概览：向量库')
    ok(t.includes('反馈'), '概览：反馈')
    ok(t.includes('多阶段检索流水线'), '开关：流水线总开关')
    ok(t.includes('稠密向量通道'), '开关：稠密通道')
    ok(t.includes('LLM 辅助意图分类'), '开关：意图分类 LLM 辅助')
    // 提示文案里会出现「向量模型」四个字，所以判据必须落在**输入控件**上，不能查文本
    ok((await panel(win).getByRole('textbox').count()) === 0, '检索设置里不再有「向量模型」输入框（已迁到设置）')
    ok(t.includes('向量模型在「设置'), '检索设置指明向量模型去哪配')
    ok(t.includes('稠密相似度下限') && t.includes('RRF 融合常数') && t.includes('上下文预算') && t.includes('权重微调步长'), '阈值：四项可调参数')
    ok(t.includes('保存检索设置') && t.includes('跑离线评估') && t.includes('增量构建向量索引') && t.includes('全量重建') && t.includes('重置权重'), '动作按钮齐全')
    const ta = await win.getByLabel('微信问答问题').boundingBox()
    const pb = await panel(win).boundingBox()
    ok(Boolean(ta && pb) && (ta.x + ta.width) <= pb.x + 1, '面板与对话栏并排（不遮挡输入框）', `ta.right=${ta && Math.round(ta.x + ta.width)} panel.left=${pb && Math.round(pb.x)}`)
    await shot(win, '02-retrieval-panel')
  })

  // ── 3 ──
  await step('3. 阈值保存落盘且不丢未暴露参数', '目标⑥：改参数→落盘→可读回，且不重置其它参数', async () => {
    await numInput(win, 2).fill('37')
    await saveBtn(win).click()
    await win.locator('text=已保存检索设置').first().waitFor({ timeout: 15000 })
    ok(true, '保存成功提示出现')
    const cfg = JSON.parse(readFileSync(backup.ragPath, 'utf8'))
    ok(cfg?.fusion?.k === 37, '落盘 fusion.k=37', JSON.stringify(cfg?.fusion))
    ok(cfg?.embedding?.maxDocsPerBuild === 400, '未暴露参数未被重置（maxDocsPerBuild 仍为 400）', `maxDocsPerBuild=${cfg?.embedding?.maxDocsPerBuild}`)
    ok(cfg?.channels?.dense?.minSimilarity === 0, '未暴露/已改参数保留（minSimilarity=0）')
  })

  // ── 4 ──
  await step('4. 稠密通道：向量索引构建', '目标①混合检索的稠密底座', async () => {
    const embedBefore = mockCalls.embed
    const msg = panel(win).locator('[role="status"]')
    // 先直连 IPC 探一次（带超时），拿到后端**真实返回**，避免只看到「UI 没更新」而不知后端状态
    const probe = await win.evaluate(async () => {
      const t0 = Date.now()
      const to = new Promise((r) => setTimeout(() => r({ ok: false, error: { message: 'PROBE_TIMEOUT_90s' } }), 90000))
      const r = await Promise.race([window.electronAPI.wechat.call('buildRagVectorIndex', [{ force: false }]), to])
      return { r, ms: Date.now() - t0 }
    })
    console.log('[探针] buildRagVectorIndex 直连结果:', JSON.stringify(probe).slice(0, 300))
    ok(probe.r?.ok === true, '直连调用 buildRagVectorIndex 返回 ok', JSON.stringify(probe.r?.error ?? probe.r?.value ?? {}).slice(0, 200))
    await win.getByRole('button', { name: /增量构建向量索引/ }).click()
    // 先确认请求真的发出去了（按钮进入 busy 态），否则「等结果」只是在等一个没发生的事
    const busySeen = await win.getByRole('button', { name: '构建中…' }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
    ok(busySeen, '点击后进入构建中状态（请求已发出）')
    await win.waitForFunction(() => {
      const el = document.querySelector('section[aria-label="检索设置"] [role="status"]')
      // 必须排除「正在增量构建…」这句进行中文案 —— 它同样含「向量索引」，
      // 只匹配「向量索引」会在点击瞬间就返回，等于没等（实测踩过）。
      return !!el && /向量索引\s*(构建完成|已是最新)/.test(el.textContent || '')
    }, undefined, { timeout: 120000 }).catch(() => {})
    const msgText = await msg.first().innerText().catch(() => '')
    ok(/向量索引\s*(构建完成|已是最新)/.test(msgText), '出现构建结果提示', msgText.trim().slice(0, 160))
    await waitEnabled(win, '刷新状态')
    await win.getByRole('button', { name: '刷新状态' }).click()
    await win.waitForTimeout(1500)
    const rows = Number(((await panel(win).innerText()).match(/向量库\s*\n?\s*(\d+)/) || [])[1] || 0)
    ok(rows > 0, '向量库已入库（>0 条）', `rows=${rows}`)
    const embedDelta = mockCalls.embed - embedBefore
    ok(embedDelta > 0, '真实调用了 embedding 接口', `本次 embed 请求 ${embedDelta} 次（合计 ${mockCalls.embed}）`)
    ok(embedDelta <= 40, '建索引请求量有界（未失控）', `embed ${embedDelta} 次`)
    await shot(win, '03-vector-built')
  })

  // ── 5 ──
  await step('5. 召回评估机制（指标与消融）', '目标②可量化评估', async () => {
    await win.getByRole('button', { name: '跑离线评估' }).click()
    await panel(win).locator('pre').waitFor({ timeout: 60000 })
    const report = await panel(win).locator('pre').innerText()
    for (const k of ['P@10', 'R@10', 'MRR', 'NDCG@10', 'MAP']) ok(report.includes(k), `报告含 ${k}`)
    ok(report.includes('消融对照（仅稀疏）'), '报告含消融对照')
    ok(report.includes('意图分类准确率'), '报告含意图分类准确率')
    // 报告是多行文本，按标题行定位再读下一行的 MRR
    const lines = report.split('\n')
    const numAfter = (title) => {
      const i = lines.findIndex(l => l.includes(title))
      if (i < 0) return NaN
      const m = (lines[i + 1] || '').match(/MRR=([\d.]+)/) || (lines[i] || '').match(/MRR=([\d.]+)/)
      return m ? Number(m[1]) : NaN
    }
    const hy = numAfter('混合：稀疏+稠密+结构化')
    const sp = numAfter('消融对照（仅稀疏）')
    ok(Number.isFinite(hy) && Number.isFinite(sp), '解析出两组 MRR', `hybrid=${hy} sparse=${sp}`)
    ok(hy >= sp, '混合检索 MRR ≥ 纯稀疏（消融成立）', `hybrid=${hy} sparse=${sp}`)
    await shot(win, '04-eval-report')
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
    await win.getByRole('button', { name: '查看最近反馈' }).click()
    await win.waitForTimeout(1500)
    const t = await panel(win).innerText()
    ok(t.includes('👎'), '检索设置内可见该条反馈')
    ok(existsSync(backup.weightsPath), '权重调参结果已落盘 rag-weights.json')
  })

  // ── 8 ──
  await step('8. 降级验证：关闭稠密通道', '目标①通道可独立关闭且显式告知', async () => {
    await checkbox(win, 1).uncheck()
    await saveBtn(win).click()
    await win.waitForTimeout(1500)
    const r = await askAndWait(win, '最近一次转账给我的是谁')
    if (r.alert) ok(false, '问答返回错误', r.alert)
    await win.locator('text=稠密通道未生效').first().waitFor({ timeout: 30000 })
    ok(true, '关闭稠密后漏斗行显示「稠密通道未生效（纯稀疏）」')
    await shot(win, '07-degraded-dense-off')
    await checkbox(win, 1).check()
    await saveBtn(win).click()
    await win.waitForTimeout(1200)
    ok(true, '已恢复稠密通道')
  })

  // ── 9 ──
  await step('9. 灰度回退：总开关关闭即走旧检索', '目标⑥可一键回退', async () => {
    const before = await win.locator('text=/召回 \d+ → 融合 \d+/').count()
    await checkbox(win, 0).uncheck()
    await saveBtn(win).click()
    await win.waitForTimeout(1500)
    const r = await askAndWait(win, '上个月工资发了多少')
    if (r.alert) ok(false, '问答返回错误', r.alert)
    const after = await win.locator('text=/召回 \d+ → 融合 \d+/').count()
    ok(after === before, '总开关关闭后不再产生漏斗行（回退旧单通道检索）', `before=${before} after=${after}`)
    ok(r.after > r.before, '旧路径仍能返回引用（功能未失效）', `来源 ${r.before} → ${r.after}`)
    await shot(win, '08-legacy-fallback')
    await checkbox(win, 0).check()
    await saveBtn(win).click()
    await win.waitForTimeout(1200)
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
  await step('11. 「设置」弹窗（左导航 + 右内容）与全应用唯一的 AI 模型入口', '配置/隐私/维护都收进弹窗：左导航分节、右侧一次只显示一节；模型配置不再散落在问答面板', async () => {
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

    // —— 左右结构：左导航（固定宽）+ 右内容（一次只显示一节）——
    // 这一页共 14 节（配置向导 5 步 + 智能与隐私 3 + 授权与维护 5 + 高级 1）。
    // 早期只有 5 张速览卡横排在顶部、5 节一路堆叠：一屏装不下，想改「图片密钥」
    // 得先滚下去找，还容易忘了下面还有几节。
    const rail = dlg.locator('nav[aria-label="设置导航"]')
    await rail.waitFor({ timeout: 20000 })
    const layout = await win.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      const nav = d.querySelector('nav[aria-label="设置导航"]')
      const pane = nav.nextElementSibling
      const nr = nav.getBoundingClientRect()
      const pr = pane.getBoundingClientRect()
      // 右侧「真正显示」的节要按算出来的 display 判定：早期只写 hidden 属性，
      // 被 .card 自己的 display 压过，等于所有节堆在一起显示。
      const shown = Array.from(pane.children)
        .filter(c => getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'absolute')
        .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20))
      return {
        items: Array.from(nav.querySelectorAll('button')).map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()),
        groups: Array.from(nav.querySelectorAll('[class*="navGroupLabel"]')).map(e => (e.textContent || '').trim()),
        dir: getComputedStyle(nav).flexDirection,
        navW: Math.round(nr.width), navRight: Math.round(nr.right), navTop: Math.round(nr.top),
        paneW: Math.round(pr.width), paneLeft: Math.round(pr.left), paneTop: Math.round(pr.top),
        shown,
        disclosures: d.querySelectorAll('details, summary').length,
      }
    })
    ok(layout.items.length === 14, '左导航 14 项',
      layout.items.join(' / '))
    ok(layout.groups.join('|') === '配置向导|智能与隐私|授权与维护|高级',
      '14 项分四组显示（配置向导 / 智能与隐私 / 授权与维护 / 高级）', layout.groups.join('|'))
    ok(layout.dir === 'column', '导航项竖向排列', layout.dir)
    ok(layout.paneLeft >= layout.navRight, '右内容区在左导航右侧（并排、不重叠）',
      `导航右缘 ${layout.navRight} ≤ 内容左缘 ${layout.paneLeft}`)
    ok(Math.abs(layout.paneTop - layout.navTop) <= 2, '左右两栏顶部对齐',
      `导航 ${layout.navTop} / 内容 ${layout.paneTop}`)
    ok(layout.paneW > layout.navW * 3, '右内容区宽度远大于导航（右区才是主区）',
      `导航 ${layout.navW}px / 内容 ${layout.paneW}px`)
    ok(layout.shown.length === 1 && layout.shown[0].includes('检测账号'),
      '默认只有「检测账号」一节可见（其余节真的 display:none，不是堆在一起）', layout.shown.join(' | '))
    ok(layout.disclosures === 0, '节内不再有可折叠的 details/summary（高级设置已是普通卡片）',
      String(layout.disclosures))

    // 切节：右区只显示选中的那一节，且回到顶部（否则接着上一节的滚动位置看会莫名其妙）。
    // 默认窗口下右区高 795px，连语音转写这种长节也装得下 —— 先把窗口压矮，长节才会真的溢出。
    const paneScroll = () => win.evaluate(() => {
      const pane = document.querySelector('[role="dialog"] nav[aria-label="设置导航"]').nextElementSibling
      const shown = Array.from(pane.children)
        .filter(c => getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'absolute')
        .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20))
      return { scrollTop: pane.scrollTop, scrollH: pane.scrollHeight, clientH: pane.clientHeight, shown }
    })
    const origBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    let scrolled = { scrollTop: 0, scrollH: 0, clientH: 0, shown: [] }
    let afterSwitch = scrolled
    try {
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 700) })
      await win.waitForTimeout(600)
      await rail.getByRole('button', { name: '语音转文字' }).first().click()
      await win.waitForTimeout(500)
      await win.evaluate(() => {
        const pane = document.querySelector('[role="dialog"] nav[aria-label="设置导航"]').nextElementSibling
        pane.scrollTop = pane.scrollHeight
      })
      await win.waitForTimeout(700) // scroll-behavior:smooth 是动画，等它走完再取值
      scrolled = await paneScroll()
      await rail.getByRole('button', { name: '检测账号' }).first().click()
      await win.waitForTimeout(700)
      afterSwitch = await paneScroll()
    } finally {
      // 恢复原窗口尺寸：后续步骤（年度看板）对窗口宽高敏感
      await app.evaluate(({ BrowserWindow }, b) => { BrowserWindow.getAllWindows()[0].setBounds(b) }, origBounds)
      await win.waitForTimeout(600)
    }
    ok(scrolled.scrollH > scrolled.clientH, '矮窗下长节（语音转文字）内容高于右区，确实需要滚动',
      `${scrolled.scrollH} > ${scrolled.clientH}`)
    ok(scrolled.scrollTop > 0, '右内容区可滚动', String(scrolled.scrollTop))
    ok(afterSwitch.scrollTop <= 2, '切节后右内容回到顶部', String(afterSwitch.scrollTop))
    ok(afterSwitch.shown.length === 1 && afterSwitch.shown[0].includes('检测账号'),
      '切节后只有新选中那一节可见', afterSwitch.shown.join(' | '))

    // AI 大模型现在是左导航的一项：先切过去，卡片才可见
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

    // —— 从外层侧栏迁进来的两节：数据边界与出网 / 隐私体检 ——
    // 外面那个「隐私与信任」页签已下线，这里是它们唯一的入口。
    const clipInPane = () => win.evaluate(() => {
      const pane = document.querySelector('[role="dialog"] nav').nextElementSibling
      const clipped = []
      for (const el of pane.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.overflowY !== 'hidden' && cs.overflow !== 'hidden') continue
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2) {
          clipped.push(`${String(el.className).split(' ')[0]}:${el.clientHeight}/${el.scrollHeight}`)
        }
      }
      return { clipped, scrollH: pane.scrollHeight, clientH: pane.clientHeight }
    })

    await rail.getByRole('button', { name: '数据边界与出网' }).first().click()
    await win.waitForTimeout(1200)
    const boundary = await win.evaluate(() => {
      const pane = document.querySelector('[role="dialog"] nav').nextElementSibling
      const shown = Array.from(pane.children)
        .filter(c => getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'absolute')
      const text = (pane.textContent || '').replace(/\s+/g, ' ')
      const toggle = Array.from(pane.querySelectorAll('button'))
        .find(b => (b.textContent || '').includes('一律不调用模型'))
      return {
        shown: shown.length,
        hasLead: text.includes('检索统计、导出、图谱、备份等均为纯本地操作'),
        hasAvatarNote: text.includes('头像图片是唯一例外'),
        hasAudit: text.includes('AI 出站审计'),
        toggleH: toggle ? toggle.clientHeight : 0,
      }
    })
    ok(boundary.shown === 1, '右区只显示「数据边界与出网」一节', String(boundary.shown))
    ok(boundary.hasLead && boundary.hasAvatarNote, '两段边界说明都在（第二段原来被裁掉）')
    ok(boundary.toggleH > 0, '「禁止 AI 出网」开关在（原来被裁掉）', String(boundary.toggleH))
    ok(boundary.hasAudit, '含「AI 出站审计」')
    const bClip = await clipInPane()
    ok(bClip.clipped.length === 0, '该节内没有「内容溢出但 overflow:hidden」的元素', bClip.clipped.slice(0, 4).join(' '))
    ok(bClip.scrollH > bClip.clientH, '该节比右区高 → 右区滚动，而不是把卡片压扁', `${bClip.scrollH}/${bClip.clientH}`)
    await shot(win, '11-boundary')

    await rail.getByRole('button', { name: '隐私体检' }).first().click()
    await win.waitForTimeout(1800)
    const priv = await win.evaluate(() => {
      const pane = document.querySelector('[role="dialog"] nav').nextElementSibling
      const shown = Array.from(pane.children)
        .filter(c => getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'absolute')
      const text = (pane.textContent || '').replace(/\s+/g, ' ')
      const cats = ['手机号', '身份证号', '银行卡号', '邮箱', '密码口令', '地址信息']
      return {
        shown: shown.length,
        missing: cats.filter(c => !text.includes(c)),
        scan: Array.from(pane.querySelectorAll('button')).some(b => /重新扫描|开始扫描/.test(b.textContent || '')),
      }
    })
    ok(priv.shown === 1, '右区只显示「隐私体检」一节', String(priv.shown))
    ok(priv.scan, '扫描入口还在（PanelHeader 的动作没丢）')
    ok(priv.missing.length === 0, '六个敏感信息类别都在（原来最后一类被裁）', priv.missing.join(','))
    const pClip = await clipInPane()
    ok(pClip.clipped.length === 0, '该节内没有「内容溢出但 overflow:hidden」的元素', pClip.clipped.slice(0, 4).join(' '))
    await shot(win, '11-privacy-health')

    // —— 第二批迁入：备份恢复 / 数据库健康 / 原图链路自检 / 操作日志 ——
    for (const label of ['备份恢复', '数据库健康', '原图链路自检', '操作日志']) {
      await rail.getByRole('button', { name: label }).first().click()
      await win.waitForTimeout(1800)
      const r = await win.evaluate(() => {
        const pane = document.querySelector('[role="dialog"] nav[aria-label="设置导航"]').nextElementSibling
        const shown = Array.from(pane.children)
          .filter(c => getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'absolute')
          .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18))
        return { n: shown.length, first: shown[0] || '' }
      })
      ok(r.n === 1, `「${label}」是右区唯一显示的一节`, r.first)
      const clip = await clipInPane()
      ok(clip.clipped.length === 0, `「${label}」节内没有溢出被裁的元素`, clip.clipped.slice(0, 3).join(' '))
    }
    await shot(win, '11-maintenance')

    // Esc 关闭（Radix 卸载内容），并确认回到原页
    await win.keyboard.press('Escape')
    await dlg.first().waitFor({ state: 'detached', timeout: 15000 })
    ok((await win.locator('[role="dialog"]').count()) === 0, 'Esc 关闭弹窗')
    const back = await win.locator('main').innerText()
    ok(back.length > 0 && !back.includes('检测账号'), '关闭后主内容区回到原来那一页')
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
      const shown = Array.from(pane.children)
        .filter(c => getComputedStyle(c).display !== 'none' && getComputedStyle(c).position !== 'absolute')
      const active = nav.querySelector('button[aria-current="true"]')
      return {
        open: true,
        n: shown.length,
        shownText: (shown[0]?.textContent || '').replace(/\s+/g, ' ').slice(0, 14),
        active: (active?.textContent || '').replace(/\s+/g, ' ').slice(0, 10),
      }
    })
    ok(inside.open, '弹窗仍在（弹窗内的跳转没有把弹窗关掉）')
    ok(inside.n === 1 && inside.shownText.includes('数据边界与出网'),
      '「数据边界与出网」就地切到本弹窗的对应节', `${inside.active} → ${inside.shownText}`)
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
    const layout = await win.evaluate(() => {
      const body = document.querySelector('[class*="_panelBody_"]')
      const wrap = document.querySelector('[class*="_wrap_"]')
      if (!body || !wrap) return { error: 'missing' }
      const br = body.getBoundingClientRect()
      const cards = [...wrap.querySelectorAll('[class*="_card_"]')]
      const clipped = cards.filter(c => c.scrollHeight > c.clientHeight + 2)
        .map(c => c.querySelector('[class*="_cardTitle_"]')?.textContent || '?')
      const overflow = cards.filter(c => c.getBoundingClientRect().bottom > br.bottom + 1)
        .map(c => c.querySelector('[class*="_cardTitle_"]')?.textContent || '?')
      return { scroll: body.scrollHeight, client: body.clientHeight, cards: cards.length, clipped, overflow }
    })
    ok(layout.scroll <= layout.client + 1, '一屏无滚动条（scrollHeight ≤ clientHeight）',
      `${layout.scroll} vs ${layout.client}`)
    ok(layout.overflow.length === 0, '没有卡片越出可视区', layout.overflow.join(','))
    ok(layout.clipped.length === 0, '没有卡片内容被裁切', layout.clipped.join(','))
    ok(layout.cards === 14, '14 张卡片全部渲染', String(layout.cards))

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

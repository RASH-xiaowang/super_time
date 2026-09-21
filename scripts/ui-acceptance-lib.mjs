/**
 * `ui-acceptance.mjs` 的**夹具与助手**（M21 第十四刀拆出）。
 *
 * 搬出来的是与「验收场景」无关的那一层：本地 mock LLM 服务、llm/rag 配置的备份与逐字节还原、
 * 路径与端口、以及驱动真实窗口的几个助手（截图 / 数来源 / 调后端 / 提问等）。
 * 场景本身（main 里那串 step）留在 `ui-acceptance.mjs`。
 *
 * 行为逐字节不变：这些函数与常量原样搬移，只有顶层声明加了 `export`。
 * 安全约束（原样保留）：mock 只监听 127.0.0.1；结束时会逐字节还原 llm/rag 配置，
 * 还原失败会记进 `restoreErrors` 由报告显式告警。
 * @module ui-acceptance-lib
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 前置检查：playwright 缺失时给出可照做的安装命令，而不是抛一个模块解析错误。
export let _electron
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
export const LLM_JSON = join(USER_DATA, 'wechat', 'llm.json')
export const OUT = process.env.UI_ACCEPT_OUT || join(tmpdir(), 'super-time-ui-acceptance')
export const PORT = 18787
/**
 * mock 回答：**故意编造**的固定文本，用来验证「引用编号解析 / 来源高亮 / 反馈标注」链路。
 *
 * 必须自带醒目标记：这条回答里的「王五 / 5000.00 元」在检索来源里根本不存在（来源是
 * 「收到转账 13.00 元」之类）。实际发生过——自动化跑到一半有人看窗口，把它当成了
 * 应用在编造答案，完全无法分辨。加前缀后，谁看窗口都知道这是测试替身。
 */
const MOCK_ANSWER = '【验收 mock·非真实回答】根据本机记录，最近一次转账来自王五，金额 5000.00 元 [1]。'
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
export const mockCalls = { chat: 0, planner: 0, embed: 0, noCite: 0, lastSynth: '' }
export const server = createServer((req, res) => {
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
export const backup = { llm: null, llmExisted: false, rag: null, ragExisted: false, ragPath: null, weightsPath: null, weights: null, weightsExisted: false }
/** 还原失败清单：任何一项非空都必须在报告里显式告警（可能残留 mock 向量）。 */
export const restoreErrors = []
export async function restoreConfigs() {
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
export const shot = (win, name) => win.screenshot({ path: join(OUT, name + '.png') })
const countSrc = (win) => win.locator('text=/来源 ·/').count()

/**
 * 直连后端 Remote（不经界面）。
 *
 * 为什么需要它：检索参数与运维动作（建索引 / 离线评估 / 看反馈）**已不再暴露给用户**，
 * 界面上根本没有入口可点。但这些能力仍是后端契约的一部分，验收要能证明它们还在 ——
 * 于是从「点界面」改成「直连 IPC」，同时把「界面上确实没有入口」作为独立断言。
 */
export const callBackend = (win, method, args = []) => win.evaluate(
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
export function patchRagConfig(patch) {
  // 夹具没就位时给出可读的原因（否则 readFileSync(null) 抛的是 Node 内部措辞，
  // 看起来像「测试自己写错了」，而真正的问题是数据根没拿到）
  if (!backup.ragPath) throw new Error('rag-config.json 路径未就位：setup 阶段没有拿到数据根')
  const merged = deepMerge(JSON.parse(readFileSync(backup.ragPath, 'utf8')), patch)
  writeFileSync(backup.ragPath, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

/** 提问并等本轮结束：以「来源 ·」条数增加或错误 alert 出现为准。 */
export async function askAndWait(win, question) {
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

/**
 * 响应式审计 · 运行前准备（常量 / CLI 参数 / 页签与视口解析 / 影子 profile 播种）。
 *
 * 从 `scripts/responsive-audit.mjs`（M21 单文件 ≤1000 行棘轮）**机械拆出**：
 * 只搬代码、不改行为 —— 阈值、默认视口、参数名、profile 播种顺序与原文件逐字一致。
 *
 * @module scripts/responsive-audit/setup
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync, writeFileSync,
} from 'node:fs'

// ── 路径与常量 ────────────────────────────────────────────────────────────
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
export const NAV_CONFIG = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts')

export const ARGV = process.argv.slice(2)
export const hasFlag = (name) => ARGV.includes(`--${name}`)
export const opt = (name, fallback = '') => {
  const prefix = `--${name}=`
  const hit = ARGV.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
export const optInt = (name, fallback) => {
  const v = Number.parseInt(opt(name, ''), 10)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

/** 默认视口矩阵：任务书给定的 6 档（手机竖屏 → 本机 2560 宽屏）。 */
export const DEFAULT_VIEWPORTS = [
  { label: '390x844', w: 390, h: 844 },
  { label: '768x1024', w: 768, h: 1024 },
  { label: '1024x768', w: 1024, h: 768 },
  { label: '1280x800', w: 1280, h: 800 },
  { label: '1440x900', w: 1440, h: 900 },
  { label: '2560x1440', w: 2560, h: 1440 },
]
/** `--quick`：本地迭代只跑三档（最窄 / 常用 / 最宽）。 */
export const QUICK_VIEWPORTS = ['390x844', '1280x800', '2560x1440']

/** 阈值（报告里会复述，改这里就等于改审计口径，需要同步 docs）。 */
export const THRESHOLDS = {
  viewportOverflowPx: 2, // rect 越界容差
  docOverflowPx: 1, // 文档横向溢出容差
  clipPx: 1, // scrollWidth/Height 超出容差
  occlusionOverlapPct: 0.25, // 判为遮挡的最小相交面积占比
  occlusionVisualPct: 0.5, // pointer-events:none 覆盖层的「视觉遮挡」更严阈值
  perRuleCap: 60, // 每个 tab×视口 每类规则最多保留条数（JSON 体积安全阀；超出记 truncated）
  tabWaitMinMs: optInt('tab-wait', 1500), // 每页签最短等待
  tabWaitMaxMs: 6000, // 落定最长等待
  resizeSettleMs: 320, // 改窗口尺寸后的沉降
}
export const MAX_SHOTS = optInt('max-shots', 40)
export const NO_SHOTS = hasFlag('no-shots')

/** 严重度排序权重（Top offenders 打分用）。 */
export const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 }
export const RULE_WEIGHT = { 'doc-overflow': 100, 'out-of-viewport': 60, clipped: 40, occluded: 30, hidden: 20 }
export const RULE_ORDER = ['doc-overflow', 'out-of-viewport', 'clipped', 'occluded', 'hidden']
/** 规则的中文名（控制台与 Markdown 共用一份）。 */
export const RULE_CN = {
  'doc-overflow': '① 文档横向溢出',
  'out-of-viewport': '② 元素越界',
  clipped: '③ 裁切',
  occluded: '④ 固定/粘性遮挡',
  hidden: '⑤ 有文本不可见',
}

// ── 参数解析：页签 ────────────────────────────────────────────────────────
/**
 * 从 `nav-config.ts` 用正则提取页签（Node 侧不能 import TS；这是仓库既有脚本的同一做法）。
 * 提取 `{ tab: 'x', label: 'y' ... }` 条目与同行的 `hidden: true` 标记。
 * @returns {Array<{tab:string,label:string,hidden:boolean}>} 按源码顺序的 38 个页签。
 */
export function parseTabs () {
  const src = readFileSync(NAV_CONFIG, 'utf8')
  const tabs = []
  const seen = new Set()
  for (const line of src.split(/\r?\n/)) {
    // 注意 `settings` 条目的 `tab`/`label` 缩进在 `{` 的下一行，所以不能要求同行有 `{`；
    // 而只出现 `tab: 'x'` 的地方（种子查询/路由判断）都没有 `label:`，不会误命中。
    const m = line.match(/tab:\s*'([a-z]+)',\s*label:\s*'([^']+)'/)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    tabs.push({ tab: m[1], label: m[2], hidden: /\bhidden:\s*true/.test(line) })
  }
  return tabs
}

/**
 * 解析视口参数。
 * @returns {Array<{label:string,w:number,h:number}>} 视口列表。
 */
export function parseViewports () {
  const raw = opt('viewports', '')
  if (raw) {
    const out = []
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^(\d+)x(\d+)$/i)
      if (!m) {
        console.error(`[参数] 无法解析视口 "${part}"（期望 宽x高，例如 390x844）`)
        process.exit(2)
      }
      out.push({ label: `${m[1]}x${m[2]}`, w: Number(m[1]), h: Number(m[2]) })
    }
    return out
  }
  if (hasFlag('quick')) return DEFAULT_VIEWPORTS.filter((v) => QUICK_VIEWPORTS.includes(v.label))
  return DEFAULT_VIEWPORTS
}

/** 给文件/目录名做 slug（tab 键本身就是安全字符，这里只兜底）。 */
export const slug = (s) => String(s).replace(/[^\w.-]+/g, '_')

/** 生成默认 label（本地时间，文件名安全）。 */
export function defaultLabel () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/** 读取 git 短提交（拿不到就写 unknown，不让审计因为 git 失败而中断）。 */
export function gitHead () {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

// ── 影子 profile 播种 ─────────────────────────────────────────────────────
/** 候选 userData 目录名（开发态用包名，装好后用 productName），与 scripts/real-profile.mjs 同一口径。 */
const USERDATA_CANDIDATES = ['super-time-electron', 'Super Time']

/**
 * 自动探测应用真实 userData（优先含 `wechat/config.json` 的那个）。
 * @returns {string} userData 绝对路径（都不存在时返回第一候选）。
 */
export function detectUserDataDir () {
  const appData = process.env.APPDATA ?? ''
  let first = ''
  for (const name of USERDATA_CANDIDATES) {
    const dir = join(appData, name)
    if (first === '') first = dir
    if (existsSync(join(dir, 'wechat', 'config.json'))) return dir
  }
  return first
}

/** 需要从真实 profile 复制过去的**配置**文件（不含任何数据）。 */
const COPY_INTO_PROFILE = ['config.json', 'llm.json', 'secrets.json', 'keys.json', 'all_keys.json']

/**
 * 播种临时 profile：真实配置 + （尽量）真实闸门状态，数据根指向真实数据。
 *
 * 与 `scripts/real-profile.mjs` 的关系：同一套「真实 profile 播种」思路，区别是
 * ① 支持 `--user-data` 自定义来源；② 额外复制 `Local Storage` / `license.json` 以跳过首启
 * 闸门（避免调试横幅污染布局测量）。复制失败不是致命错误：回退 `SUPERTIME_SKIP_ONBOARDING=1`。
 *
 * @param {string} profileDir 临时 profile 目录（会被清空重建）。
 * @param {string} srcUserData 真实 userData 目录。
 * @returns {{source:string,dataRoot:string,copied:string[],gates:'seeded'|'skip-onboarding',reasons:string[]}}
 */
export function seedProfile (profileDir, srcUserData) {
  const reasons = []
  if (!existsSync(srcUserData)) {
    console.error(`[前置] 真实 userData 不存在：${srcUserData}`)
    process.exit(2)
  }
  mkdirSync(profileDir, { recursive: true })
  rmSync(join(profileDir, 'wechat'), { recursive: true, force: true })
  rmSync(join(profileDir, 'Local Storage'), { recursive: true, force: true })
  rmSync(join(profileDir, 'license.json'), { force: true })

  const srcState = join(srcUserData, 'wechat')
  const dstState = join(profileDir, 'wechat')
  mkdirSync(dstState, { recursive: true })
  const copied = []
  for (const name of COPY_INTO_PROFILE) {
    const from = join(srcState, name)
    if (!existsSync(from)) continue
    try {
      copyFileSync(from, join(dstState, name))
      copied.push(name)
    } catch (e) {
      reasons.push(`复制 ${name} 失败：${e.code ?? e.message}`)
    }
  }

  // 数据根：以真实 profile 的 `resolved.dataRoot` 为准（应用真正在用的那一份）。
  let dataRoot = ''
  try {
    const cfg = JSON.parse(readFileSync(join(dstState, 'config.json'), 'utf8'))
    dataRoot = typeof cfg?.resolved?.dataRoot === 'string' ? cfg.resolved.dataRoot : ''
  } catch { /* 下面兜底 */ }
  if (!dataRoot) {
    const fallback = join(srcUserData, 'wechat-data')
    dataRoot = existsSync(join(fallback, 'config.json')) ? fallback : ''
    if (dataRoot) reasons.push(`config.json 缺 resolved.dataRoot，退回 ${dataRoot}`)
  }
  if (!dataRoot) reasons.push('未能确定真实数据根（面板可能显示空态）')
  // 把路径写进临时 profile 的 config.json：应用启动时按这份配置解析数据根。
  try {
    const cfgPath = join(dstState, 'config.json')
    let cfg = {}
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch { /* 不存在则新建 */ }
    cfg['resolved'] = {
      ...(cfg['resolved'] ?? {}),
      dataRoot,
      decrypted: join(dataRoot, 'decrypted'),
      decoded: join(dataRoot, 'decoded_images'),
      configFile: join(dataRoot, 'config.json'),
    }
    cfg['dataRoot'] = dataRoot
    cfg['decryptedDir'] = join(dataRoot, 'decrypted')
    cfg['decodedImagesDir'] = join(dataRoot, 'decoded_images')
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch (e) {
    reasons.push(`写临时 config.json 失败：${e.code ?? e.message}`)
  }

  // 闸门状态：Local Storage（启动引导 / 隐私同意 / 主题）+ license.json（授权）。
  let gates = 'skip-onboarding'
  try {
    const srcLs = join(srcUserData, 'Local Storage')
    if (!existsSync(srcLs)) throw new Error('无 Local Storage 目录')
    cpSync(srcLs, join(profileDir, 'Local Storage'), { recursive: true })
    let licenseOk = false
    for (const name of ['license.json', 'license.json.bak']) {
      const from = join(srcUserData, name)
      if (!existsSync(from)) continue
      copyFileSync(from, join(profileDir, name))
      if (name === 'license.json') licenseOk = true
    }
    if (!licenseOk) throw new Error('无 license.json')
    gates = 'seeded'
  } catch (e) {
    reasons.push(`闸门状态复制失败（回退 SUPERTIME_SKIP_ONBOARDING=1，界面会有调试横幅）：${e.message}`)
  }
  return { source: srcUserData, dataRoot, copied, gates, reasons }
}

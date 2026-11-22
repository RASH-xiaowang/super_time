#!/usr/bin/env node
/**
 * 字体合规门禁。
 *
 * 目标：闭源商业发布时，不把专有字体文件或来源不明的字形资产打进安装包；
 * UI 只引用系统字体，导出 HTML/SVG 只写字体族名，不绑定任何字体文件。
 *
 * 规则：
 *   ① 运行时代码里不得点名常见专有字体（微软雅黑、苹方、Segoe UI、Consolas…）；
 *   ② 不得引用远程字体 URL，也不得新增未登记许可证的 @font-face；
 *   ③ 仓库业务资产里出现字体文件时，必须在 scripts/font-assets.json 登记来源、
 *      许可证、许可证文件、版本和 sha256；
 *   ④ --packaged 时检查 app.asar / app.asar.unpacked 里没有任何字体文件，
 *      并单独确认 pdfjs-dist/standard_fonts 不在包内。
 *
 * 用法：
 *   node scripts/font-compliance-check.mjs --source-only
 *   node scripts/font-compliance-check.mjs --packaged
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RESOURCES = join(ROOT, 'dist', 'win-unpacked', 'resources')
const FONT_MANIFEST = join(ROOT, 'scripts', 'font-assets.json')
const SOURCE_ONLY = process.argv.includes('--source-only')
const PACKAGED_ONLY = process.argv.includes('--packaged')

const SOURCE_ROOTS = ['src', 'apps/website', 'tools', 'apps/license-studio', 'wechat', 'assets', 'docs/architecture']
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.svg', '.py', '.json'])
const FONT_EXT = new Set(['.ttf', '.ttc', '.otf', '.otc', '.woff', '.woff2', '.eot', '.fon', '.pfb', '.pfa'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.tmp-e2e', 'working', 'ui-dist.bak'])
const SKIP_PREFIXES = ['src/backend/deps/', 'src/backend/tests/', 'src/backend/wechat-data/tests/']
const SPEC_RE = /\.(?:spec|test)\.[cm]?[jt]sx?$/i

const BANNED_FAMILIES = [
  ['Segoe UI', /\bSegoe\s+UI\b/i],
  ['Microsoft YaHei', /\bMicrosoft\s+YaHei(?:\s+UI)?\b/i],
  ['PingFang', /\bPingFang(?:\s+SC)?\b/i],
  ['HarmonyOS Sans', /\bHarmonyOS\s+Sans(?:\s+SC)?\b/i],
  ['Cascadia Code', /\bCascadia\s+(?:Code|Mono)\b/i],
  ['Consolas', /\bConsolas\b/i],
  ['Helvetica Neue', /\bHelvetica(?:\s+Neue)?\b/i],
  ['Arial', /\bArial\b/i],
  ['SF Mono', /\bSF(?:Mono|Mono-Regular|\s+Mono)\b/i],
  ['Menlo', /\bMenlo\b/i],
  ['Monaco', /\bMonaco\b/i],
  ['SimSun', /\bSimSun\b/i],
  ['Microsoft JhengHei', /\bMicrosoft\s+JhengHei\b/i],
  ['Calibri', /\bCalibri\b/i],
  ['Cambria', /\bCambria\b/i],
  ['Times New Roman', /\bTimes\s+New\s+Roman\b/i],
]

const REMOTE_FONT_HOSTS = /\b(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fast\.fonts\.net)\b/i
const REMOTE_FONT_URL = /\burl\(\s*['"]?https?:\/\/[^)'"\s]+\.(?:woff2?|ttf|otf|eot)(?:[?#][^)'"\s]*)?['"]?\s*\)/i

/**
 * 递归列文件。用 POSIX 相对路径，和 manifest 的写法保持一致。
 * @param {string} abs 绝对路径。
 * @param {(rel: string) => boolean} [skip] 返回 true 的路径不再深入。
 * @param {string[]} [acc] 累积结果。
 * @returns {string[]} 相对 ROOT 的文件路径。
 */
function walk(abs, skip = () => false, acc = []) {
  if (!existsSync(abs)) return acc
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const full = join(abs, entry.name)
    const rel = relative(ROOT, full).replace(/\\/g, '/')
    if (skip(rel)) continue
    if (entry.isDirectory()) walk(full, skip, acc)
    else if (entry.isFile()) acc.push(rel)
  }
  return acc
}

function sourceFiles() {
  const out = []
  for (const top of SOURCE_ROOTS) {
    if (!existsSync(join(ROOT, top))) continue
    out.push(...walk(join(ROOT, top), (rel) => {
      const base = rel.split('/').pop() ?? ''
      if (SKIP_DIRS.has(base)) return true
      if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) return true
      if (SPEC_RE.test(base)) return true
      return false
    }))
  }
  return out
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readManifest() {
  if (!existsSync(FONT_MANIFEST)) {
    return { fonts: [], error: '缺少 scripts/font-assets.json；字体资产必须登记后才能进仓库/发布包' }
  }
  try {
    const parsed = JSON.parse(readFileSync(FONT_MANIFEST, 'utf8'))
    return { fonts: Array.isArray(parsed.fonts) ? parsed.fonts : [], error: '' }
  } catch (error) {
    return { fonts: [], error: `scripts/font-assets.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}

function validateManifest(manifest) {
  const violations = []
  if (manifest.error) violations.push({ rule: 'manifest', file: 'scripts/font-assets.json', detail: manifest.error })
  const seen = new Set()
  for (const font of manifest.fonts) {
    if (!font || typeof font !== 'object') {
      violations.push({ rule: 'manifest-entry', file: 'scripts/font-assets.json', detail: '字体条目必须是对象' })
      continue
    }
    const rel = typeof font.path === 'string' ? font.path.replace(/\\/g, '/') : ''
    const file = rel || 'scripts/font-assets.json'
    if (!rel || rel.startsWith('/') || rel.startsWith('../') || rel.includes('/../')) {
      violations.push({ rule: 'manifest-path', file, detail: 'path 必须是仓库内相对路径' })
      continue
    }
    if (seen.has(rel)) violations.push({ rule: 'manifest-duplicate', file, detail: '同一字体路径重复登记' })
    seen.add(rel)
    const abs = join(ROOT, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      violations.push({ rule: 'manifest-missing', file, detail: '登记的字体文件不存在' })
      continue
    }
    if (font.commercialUse !== true) {
      violations.push({ rule: 'manifest-commercial-use', file, detail: '必须明确记录 commercialUse: true' })
    }
    if (typeof font.license !== 'string' || font.license.trim() === '') {
      violations.push({ rule: 'manifest-license', file, detail: '缺少 license（如 OFL-1.1 / Apache-2.0）' })
    }
    const licenseFile = typeof font.licenseFile === 'string' ? font.licenseFile.replace(/\\/g, '/') : ''
    if (!licenseFile || !existsSync(join(ROOT, licenseFile))) {
      violations.push({ rule: 'manifest-license-file', file, detail: 'licenseFile 不存在或未填写' })
    }
    if (typeof font.sourceUrl !== 'string' || !/^https?:\/\//.test(font.sourceUrl)) {
      violations.push({ rule: 'manifest-source', file, detail: '缺少可追溯的 sourceUrl' })
    }
    if (typeof font.version !== 'string' || font.version.trim() === '') {
      violations.push({ rule: 'manifest-version', file, detail: '缺少字体版本' })
    }
    if (typeof font.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(font.sha256)) {
      violations.push({ rule: 'manifest-sha256', file, detail: '缺少 64 位 sha256' })
    } else if (sha256(abs) !== font.sha256.toLowerCase()) {
      violations.push({ rule: 'manifest-sha256', file, detail: 'sha256 与文件内容不一致' })
    }
  }
  return violations
}

function scanSources() {
  const violations = []
  const manifest = readManifest()
  violations.push(...validateManifest(manifest))
  const registered = new Set(manifest.fonts
    .filter((font) => font && typeof font.path === 'string')
    .map((font) => font.path.replace(/\\/g, '/')))

  for (const rel of sourceFiles()) {
    const ext = extname(rel).toLowerCase()
    if (FONT_EXT.has(ext) && !registered.has(rel)) {
      violations.push({
        rule: 'unregistered-font-file',
        file: rel,
        detail: '字体文件未在 scripts/font-assets.json 登记来源、许可证和 sha256',
      })
      continue
    }
    if (!TEXT_EXT.has(ext)) continue
    let text
    try {
      const size = statSync(join(ROOT, rel)).size
      if (size > 6 * 1024 * 1024) continue
      text = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      continue
    }
    // 生成目录里的第三方库可能保留自己的默认字体名（例如 ECharts 的 Windows 回退名）。
    // 这不是字体文件再分发；自有源码的字体名由上面的 src 扫描逐文件负责。
    if (!rel.startsWith('src/client/ui-dist/')) {
      for (const [name, pattern] of BANNED_FAMILIES) {
        const match = pattern.exec(text)
        if (match) {
          const around = text.slice(Math.max(0, match.index - 120), Math.min(text.length, match.index + 120))
          const fontContext = ext === '.css' || ext === '.html' || ext === '.htm' || ext === '.svg'
            || /font/i.test(around) || /\bFONT\b/.test(around)
          // “Monaco” 等地名与普通英文词不能误报；只有字体声明附近才判红。
          if (!fontContext) continue
          const line = text.slice(0, match.index).split('\n').length
          violations.push({
            rule: 'proprietary-font-name',
            file: rel,
            line,
            detail: `运行时代码点名了专有字体“${name}”；请改用 system-ui / ui-monospace / sans-serif / monospace`,
          })
        }
      }
    }
    if (REMOTE_FONT_HOSTS.test(text) || REMOTE_FONT_URL.test(text)) {
      violations.push({
        rule: 'remote-font',
        file: rel,
        detail: '发现远程字体引用；桌面端必须离线可用，且远程字体许可与隐私都不可控',
      })
    }
    if (/@font-face\b/i.test(text) && manifest.fonts.length === 0) {
      violations.push({
        rule: 'unregistered-font-face',
        file: rel,
        detail: '出现 @font-face 但 manifest 为空；随包字体必须先登记许可证与来源',
      })
    }
  }
  return violations
}

/**
 * 校验已打包资源的字体边界。
 *
 * 同时供 CLI 和 electron-builder 的 afterPack 钩子调用；后者传入实际的
 * resources 目录，避免只检查 dist/win-unpacked 而漏掉其他输出目录。
 * @param {string} [resourcesDir] 打包后的 resources 目录。
 * @returns {{ violations: Array<{rule: string, file: string, detail: string}>, checked: boolean, entries: string[] }}
 */
export function verifyPackagedFonts(resourcesDir = DEFAULT_RESOURCES) {
  const asar = join(resourcesDir, 'app.asar')
  const unpacked = join(resourcesDir, 'app.asar.unpacked')
  if (!existsSync(asar)) {
    return {
      violations: [{
        rule: 'package-missing',
        file: asar,
        detail: '找不到 app.asar；请先完成打包',
      }],
      checked: false,
      entries: [],
    }
  }
  const require = createRequire(import.meta.url)
  let listPackage
  try {
    ({ listPackage } = require('@electron/asar'))
  } catch {
    return {
      violations: [{ rule: 'asar-reader', file: asar, detail: '无法加载 @electron/asar，不能验证发布包' }],
      checked: false,
      entries: [],
    }
  }
  const entries = listPackage(asar).map((entry) => String(entry).replace(/\\/g, '/'))
  const violations = []
  for (const entry of entries) {
    if (FONT_EXT.has(extname(entry).toLowerCase())) {
      violations.push({
        rule: 'packaged-font-file',
        file: `app.asar${entry.startsWith('/') ? '' : '/'}${entry}`,
        detail: '发布包出现字体文件；除非已完成许可证登记并更新本门禁，否则必须排除',
      })
    }
  }
  if (entries.some((entry) => entry.includes('/node_modules/pdfjs-dist/standard_fonts/'))) {
    violations.push({
      rule: 'pdfjs-standard-fonts',
      file: 'app.asar',
      detail: 'pdfjs-dist/standard_fonts 必须排除：LiberationSans 是 GPLv2 + 字体例外',
    })
  }
  if (existsSync(unpacked)) {
    for (const rel of walk(unpacked)) {
      if (FONT_EXT.has(extname(rel).toLowerCase())) {
        violations.push({
          rule: 'packaged-font-file',
          file: rel,
          detail: 'app.asar.unpacked 出现字体文件；发布前必须完成许可证登记或移除',
        })
      }
    }
  }
  return { violations, checked: true, entries }
}

function main() {
  const violations = []
  if (!PACKAGED_ONLY) violations.push(...scanSources())
  let packaged = { checked: false, entries: [] }
  if (!SOURCE_ONLY) {
    packaged = verifyPackagedFonts()
    violations.push(...packaged.violations)
  }

  if (violations.length > 0) {
    console.error(`❌ 字体合规检查失败（${violations.length} 项）：`)
    for (const item of violations.slice(0, 60)) {
      const where = item.line ? `${item.file}:${item.line}` : item.file
      console.error(`  - [${item.rule}] ${where} — ${item.detail}`)
    }
    if (violations.length > 60) console.error(`  … 还有 ${violations.length - 60} 项`)
    process.exitCode = 1
    return
  }

  const packageNote = SOURCE_ONLY
    ? '仅检查业务源码（产物层由 font:check:packaged 负责）'
    : PACKAGED_ONLY || packaged.checked
      ? `发布包 ${packaged.entries.length} 个条目`
      : '未发现 dist/win-unpacked（跳过产物层）'
  console.log(`✅ 字体合规检查通过：业务源码无专有字体名/远程字体/未登记字体文件；${packageNote}`)
}

main()

#!/usr/bin/env node
/**
 * sync-ui-shim.js — 把 `src/client/ui-primitives-shim` 同步到它在 node_modules 里的安装副本。
 *
 * 为什么需要这个脚本
 * ------------------
 * `package.json` 用 `"@deepseek-ai/dsh-client-ui-primitives": "file:src/client/ui-primitives-shim"`
 * 声明这个 shim，但 npm 把它装成了**真实目录拷贝**（不是符号链接）。Vite 解析的是
 * `node_modules/@deepseek-ai/dsh-client-ui-primitives/src/*`，所以**直接改源码目录不会生效**。
 *
 * 这个坑是静默的：tsc 不报错、vite 不报错、页面不报错，只是改动完全没进包。
 * 实测（第 34 轮）曾经如此丢掉：`Button` 的 `:focus-visible` 焦点环、`.iconOnly`、
 * `.danger`、统一后的 `:disabled opacity .5`、以及本轮新增的 `.pill` 变体 ——
 * 产物 CSS 里 `_danger_` / `_iconOnly_` 命中数都是 0，而源码里全都在。
 * 因此 `build:ui` 会在 vite 之前调用本脚本，让「改源码」重新成为唯一正确做法。
 *
 * 安全守卫（`--check` 与写入模式都执行）
 * -------------------------------------
 * 写入前先做超集校验，避免把别人对 node_modules 副本做的修复**反向覆盖**掉：
 *   · CSS：副本里出现的每一条选择器，源码里必须也有；
 *   · TS/TSX：副本里导出的每个标识符，源码里必须也导出。
 * 任一不满足就**中止且不写任何文件**，并列出缺失项。
 *
 * 用法
 * ----
 *   node scripts/sync-ui-shim.js           # 同步（写入）
 *   node scripts/sync-ui-shim.js --check   # 只校验是否一致，不一致则退出码 1
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'client', 'ui-primitives-shim')
const DST = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives')

const CHECK_ONLY = process.argv.includes('--check')

/** 递归列出目录下所有文件，返回相对路径（POSIX 分隔符）。 */
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out.sort()
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 去掉 CSS 注释，避免注释内容干扰选择器解析。 */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 抽取 CSS 选择器集合。只取规则头，跳过 @ 开头的 at-rule 关键字，
 * 以便比较「副本有的规则源码是否也有」。
 */
function cssSelectors(text) {
  const out = new Set()
  for (const m of stripCssComments(text).matchAll(/([^{}]+)\{/g)) {
    for (const part of m[1].split(',')) {
      const sel = part.replace(/\s+/g, ' ').trim()
      if (!sel || sel.startsWith('@') || sel.includes(';')) continue
      if (sel.startsWith('from') || sel.startsWith('to') || /^\d+%$/.test(sel)) continue
      out.add(sel)
    }
  }
  return out
}

/** 抽取 TS/TSX 的导出标识符集合。 */
function tsExports(text) {
  const out = new Set()
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    out.add(m[1])
  }
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) out.add(name)
    }
  }
  return out
}

function diffSets(needed, have) {
  return [...needed].filter((x) => !have.has(x))
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[shim-sync] 源码目录不存在: ${SRC}`)
    process.exit(1)
  }

  const srcFiles = walk(SRC)
  const dstFiles = walk(DST)

  // ── 守卫：副本里独有的修复不能丢 ──────────────────────────────
  const violations = []
  for (const rel of dstFiles) {
    const dstPath = path.join(DST, rel)
    const srcPath = path.join(SRC, rel)
    if (!fs.existsSync(srcPath)) continue // 副本独有文件：下面按「多余文件」处理
    const ext = path.extname(rel).toLowerCase()
    if (ext === '.css') {
      const missing = diffSets(cssSelectors(fs.readFileSync(dstPath, 'utf8')), cssSelectors(fs.readFileSync(srcPath, 'utf8')))
      if (missing.length) violations.push(`${rel}: 副本有而源码缺失的选择器 -> ${missing.join(' | ')}`)
    } else if (ext === '.ts' || ext === '.tsx') {
      const missing = diffSets(tsExports(fs.readFileSync(dstPath, 'utf8')), tsExports(fs.readFileSync(srcPath, 'utf8')))
      if (missing.length) violations.push(`${rel}: 副本有而源码缺失的导出 -> ${missing.join(', ')}`)
    }
  }
  if (violations.length) {
    console.error('[shim-sync] 中止：node_modules 副本里有源码不具备的内容，同步会丢失它们：')
    for (const v of violations) console.error('  · ' + v)
    console.error('  请先把上述内容补回 src/client/ui-primitives-shim 再运行。')
    process.exit(2)
  }

  // ── 计算差异 ──────────────────────────────────────────────
  const changed = []
  const added = []
  for (const rel of srcFiles) {
    const srcPath = path.join(SRC, rel)
    const dstPath = path.join(DST, rel)
    if (!fs.existsSync(dstPath)) added.push(rel)
    else if (sha256(srcPath) !== sha256(dstPath)) changed.push(rel)
  }
  const extra = dstFiles.filter((rel) => !srcFiles.includes(rel))

  const inSync = changed.length === 0 && added.length === 0 && extra.length === 0

  if (CHECK_ONLY) {
    if (inSync) {
      console.log(`[shim-sync] 已同步（${srcFiles.length} 个文件，源码与 node_modules 逐字节一致）`)
      process.exit(0)
    }
    console.error('[shim-sync] 未同步：源码改动没有进入 Vite 实际解析的 node_modules 副本。')
    for (const r of changed) console.error('  · 内容不同: ' + r)
    for (const r of added) console.error('  · 副本缺失: ' + r)
    for (const r of extra) console.error('  · 副本多余: ' + r)
    console.error('  运行 `node scripts/sync-ui-shim.js` 或 `npm run build:ui` 修复。')
    process.exit(1)
  }

  if (inSync) {
    console.log(`[shim-sync] 无需同步（${srcFiles.length} 个文件已一致）`)
    return
  }

  // ── 写入 ──────────────────────────────────────────────────
  fs.mkdirSync(DST, { recursive: true })
  for (const rel of [...changed, ...added]) {
    const dstPath = path.join(DST, rel)
    fs.mkdirSync(path.dirname(dstPath), { recursive: true })
    fs.copyFileSync(path.join(SRC, rel), dstPath)
  }
  for (const rel of extra) {
    fs.rmSync(path.join(DST, rel), { force: true })
  }

  console.log(`[shim-sync] 已同步 ${srcFiles.length} 个文件 -> node_modules/@deepseek-ai/dsh-client-ui-primitives`)
  for (const r of changed) console.log('  · 更新: ' + r)
  for (const r of added) console.log('  · 新增: ' + r)
  for (const r of extra) console.log('  · 删除: ' + r)
}

main()

#!/usr/bin/env node
'use strict'

/**
 * 微信 4.x 原生 OCR 冒烟脚本（Windows x64）。
 *
 * 该脚本只调用微信安装目录里的 WeChatOcr 插件，不调用 Windows OCR。
 * 输出刻意不包含 OCR 正文，避免把聊天图片里的隐私写进终端或 CI 日志。
 *
 * 用法：
 *   node scripts/wechat-ocr-native-smoke.js --image <图片路径>
 *   node scripts/wechat-ocr-native-smoke.js --image <图片路径> --wrapper <wcocr.dll>
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_WRAPPER = path.join(
  REPO_ROOT,
  'src',
  'backend',
  'wechat-data',
  'native',
  'wcocr',
  'win32-x64',
  'wcocr.dll',
)
const REGISTRY_KEY = 'HKCU\\Software\\Tencent\\Weixin'

function usage() {
  return [
    '用法: node scripts/wechat-ocr-native-smoke.js --image <图片路径> [选项]',
    '',
    '选项:',
    '  --image <path>       必需。待识别的图片。',
    `  --wrapper <path>     可选。兼容包装 DLL，默认 ${DEFAULT_WRAPPER}`,
    '  --wxocr <path>       可选。覆盖自动发现的 wxocr.dll。',
    '  --wechat-dir <path>  可选。覆盖自动发现的微信版本目录。',
    '  --help               显示帮助。',
  ].join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    if (!token.startsWith('--')) {
      throw new Error(`未知参数: ${token}`)
    }
    const eq = token.indexOf('=')
    const name = token.slice(2, eq === -1 ? undefined : eq)
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1)
    if (!value || value.startsWith('--')) {
      throw new Error(`参数 --${name} 缺少值`)
    }
    if (!['image', 'wrapper', 'wxocr', 'wechat-dir'].includes(name)) {
      throw new Error(`未知参数: --${name}`)
    }
    args[name] = value
  }
  return args
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function directChild(dir, wantedName) {
  if (!exists(dir)) return ''
  const wanted = wantedName.toLowerCase()
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === wanted) {
        return path.join(dir, entry.name)
      }
    }
  } catch {
    // Discovery is best-effort; the caller reports a targeted "not found" error.
  }
  return ''
}

function directFile(dir, wantedName) {
  if (!exists(dir)) return ''
  const wanted = wantedName.toLowerCase()
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        return path.join(dir, entry.name)
      }
    }
  } catch {
    // Same as directChild.
  }
  return ''
}

function listDirectories(dir) {
  if (!exists(dir)) return []
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

function findDirectoriesNamed(root, wantedName, maxDepth) {
  const found = []
  const wanted = wantedName.toLowerCase()
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = path.join(dir, entry.name)
      if (entry.name.toLowerCase() === wanted) {
        found.push(child)
      }
      if (depth < maxDepth) {
        queue.push({ dir: child, depth: depth + 1 })
      }
    }
  }
  return found
}

function versionParts(value) {
  return String(value)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
}

function compareVersionLike(a, b) {
  const av = versionParts(a)
  const bv = versionParts(b)
  const count = Math.max(av.length, bv.length)
  for (let i = 0; i < count; i += 1) {
    const delta = (av[i] || 0) - (bv[i] || 0)
    if (delta !== 0) return delta
  }
  return a.localeCompare(b, 'en')
}

function discoverWxocr() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const tencentDir = directChild(appData, 'Tencent')
  const xwechatDir = directChild(tencentDir, 'xwechat')
  if (!xwechatDir) {
    throw new Error(`找不到微信配置目录: ${path.join(tencentDir || appData, 'xwechat')}`)
  }

  const pluginDirs = findDirectoriesNamed(xwechatDir, 'WeChatOcr', 5)
  const candidates = []
  for (const pluginDir of pluginDirs) {
    const directExtracted = directChild(pluginDir, 'extracted')
    const directWxocr = directFile(directExtracted, 'wxocr.dll')
    if (directWxocr) {
      candidates.push({
        wxocrDll: directWxocr,
        version: path.basename(pluginDir),
        pluginDir,
      })
    }
    for (const versionDir of listDirectories(pluginDir)) {
      const extracted = directChild(versionDir, 'extracted')
      const wxocrDll = directFile(extracted, 'wxocr.dll')
      if (wxocrDll) {
        candidates.push({
          wxocrDll,
          version: path.basename(versionDir),
          pluginDir,
        })
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `找不到微信 OCR 插件 wxocr.dll（已检查 ${xwechatDir} 下的 WeChatOcr/*/extracted）`,
    )
  }
  candidates.sort((a, b) => compareVersionLike(b.version, a.version))
  return candidates[0]
}

function readInstallPathFromRegistry() {
  const command = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    `$item = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Tencent\\Weixin'`,
    'if (-not $item.InstallPath) { throw "InstallPath is empty" }',
    '[Console]::Out.Write($item.InstallPath)',
  ].join('; ')

  let installPath
  try {
    installPath = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
  } catch (error) {
    throw new Error(
      `读取注册表 ${REGISTRY_KEY}\\InstallPath 失败: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!installPath || !exists(installPath)) {
    throw new Error(`注册表 InstallPath 不存在或目录不可用: ${installPath || '(空)'}`)
  }
  return installPath
}

function discoverWechatDir() {
  const installPath = readInstallPathFromRegistry()
  const candidates = []
  const rootMmmojo = directFile(installPath, 'mmmojo_64.dll')
  if (rootMmmojo) {
    candidates.push({ dir: installPath, mmmojo: rootMmmojo })
  }

  const queue = [{ dir: installPath, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    if (depth >= 4) continue
    for (const child of listDirectories(dir)) {
      const mmmojo = directFile(child, 'mmmojo_64.dll')
      if (mmmojo) {
        candidates.push({ dir: child, mmmojo })
      }
      queue.push({ dir: child, depth: depth + 1 })
    }
  }
  if (candidates.length === 0) {
    throw new Error(`${installPath} 下找不到含 mmmojo_64.dll 的微信版本目录`)
  }
  candidates.sort((a, b) =>
    compareVersionLike(path.basename(b.dir), path.basename(a.dir)),
  )
  return candidates[0]
}

function absoluteFromCwd(value) {
  return path.resolve(process.cwd(), value)
}

function summarize(payload) {
  const blocks = Array.isArray(payload.ocr_response) ? payload.ocr_response : []
  return {
    errcode: payload.errcode,
    lines: blocks.length,
    textChars: blocks.reduce((total, block) => total + String(block && block.text ? block.text : '').length, 0),
    width: payload.width,
    height: payload.height,
  }
}

function run() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`仅支持 Windows x64，当前为 ${process.platform}/${process.arch}`)
  }

  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.image) {
    throw new Error(`缺少 --image\n\n${usage()}`)
  }

  const imagePath = absoluteFromCwd(args.image)
  if (!exists(imagePath)) {
    throw new Error(`图片不存在: ${imagePath}`)
  }
  const wrapperPath = absoluteFromCwd(args.wrapper || DEFAULT_WRAPPER)
  if (!exists(wrapperPath)) {
    throw new Error(`包装 DLL 不存在: ${wrapperPath}（可用 --wrapper 指定）`)
  }

  const ocr = args.wxocr
    ? { wxocrDll: absoluteFromCwd(args.wxocr), version: 'manual', pluginDir: '' }
    : discoverWxocr()
  if (!exists(ocr.wxocrDll)) {
    throw new Error(`wxocr.dll 不存在: ${ocr.wxocrDll}`)
  }
  const wechat = args['wechat-dir']
    ? { dir: absoluteFromCwd(args['wechat-dir']), mmmojo: '' }
    : discoverWechatDir()
  if (!exists(wechat.dir)) {
    throw new Error(`微信版本目录不存在: ${wechat.dir}`)
  }

  const koffi = require('koffi')
  const lib = koffi.load(wrapperPath)
  const callbackProto = koffi.proto('void', ['str'])
  const callbackPointer = koffi.pointer(callbackProto)
  const wechatOcr = lib.func('wechat_ocr', 'bool', [
    'str16',
    'str16',
    'str',
    callbackPointer,
  ])
  const stopOcr = lib.func('stop_ocr', 'void', [])

  let callbackCount = 0
  let raw = ''
  const callback = koffi.register((value) => {
    callbackCount += 1
    raw = value
  }, callbackPointer)

  const startedAt = process.hrtime.bigint()
  try {
    const ok = wechatOcr(ocr.wxocrDll, wechat.dir, imagePath, callback)
    if (!ok) {
      throw new Error('wechat_ocr 返回 false（微信 OCR 插件未连接或识别失败）')
    }
    if (callbackCount !== 1) {
      throw new Error(`微信 OCR 回调次数异常: ${callbackCount}`)
    }

    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error(`微信 OCR 返回了无法解析的 JSON（${raw.length} 字节）`)
    }
    const summary = summarize(payload)
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    console.log(
      JSON.stringify({
        ok: summary.errcode === 0,
        ...summary,
        elapsedMs: Math.round(elapsedMs),
        pluginVersion: ocr.version,
        wechatVersion: path.basename(wechat.dir),
      }),
    )
    if (summary.errcode !== 0) {
      process.exitCode = 1
    }
  } finally {
    try {
      stopOcr()
    } finally {
      koffi.unregister(callback)
    }
  }
}

try {
  run()
} catch (error) {
  console.error(`[wechat-ocr] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

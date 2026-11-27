#!/usr/bin/env node
/**
 * 打包前的 SuperLanguage 暂存（`beforePack`）。
 *
 * electron-builder 的 `extraResources` 会把这个目录整体复制到
 * `resources/apps/`，于是运行时路径就是 `resources/apps/superlanguage/SuperLanguage.exe`
 * —— 与 `src/backend/app-host.js` 的 `sourceExe()` 完全一致。
 *
 * 为什么要暂存而不是直接指向 `apps/superlanguage/build`：
 *   · 那个目录里有 queue.db、api-token.txt、日志等运行残留（可能就是打包机自己的账号数据）；
 *   · 没有构建过 exe 时目录可能不存在，会让 electron-builder 直接失败。
 * 这里只复制 exe 与局域网启动器，并写一份 manifest，目录总是存在；没构建时打出来的包
 * 仍然能启动，只是应用托管面板会提示「未找到 SuperLanguage.exe」。
 *
 * 启动器（`scripts/superlanguage-launch-watch.cmd`）也要一起暂存：部署到局域网实例时
 * `app-host.js` 会把它和 exe 一并复制到目标机的共享目录，装完就不用再回仓库找文件。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(ROOT, 'apps', 'superlanguage', 'build', 'SuperLanguage.exe')
const launcherSource = path.join(ROOT, 'scripts', 'superlanguage-launch-watch.cmd')
const staging = path.join(ROOT, 'build', 'staged-apps', 'superlanguage')
const target = path.join(staging, 'SuperLanguage.exe')
const launcherTarget = path.join(staging, 'superlanguage-launch-watch.cmd')
const manifestPath = path.join(staging, 'manifest.json')

fs.mkdirSync(staging, { recursive: true })

/**
 * 启动器与 exe 解耦：即使没构建 exe，也要把启动器放进包，
 * 这样「部署一份到目标机」的能力不会因为构建状态而缺一块。
 */
const launcherStaged = fs.existsSync(launcherSource)
if (launcherStaged) {
  fs.copyFileSync(launcherSource, launcherTarget)
} else {
  fs.rmSync(launcherTarget, { force: true })
}

if (!fs.existsSync(source)) {
  fs.rmSync(target, { force: true })
  fs.writeFileSync(manifestPath, JSON.stringify({
    app: 'superlanguage',
    staged: false,
    launcher: launcherStaged,
    note: '未找到 apps/superlanguage/build/SuperLanguage.exe；本次安装包不含被托管应用。',
  }, null, 2), 'utf8')
  console.log('[stage-superlanguage] 未找到构建产物，跳过 exe（安装包将不含 SuperLanguage.exe）')
  console.log('[stage-superlanguage] 启动器：' + (launcherStaged ? '已暂存' : '缺失（scripts 里没有）'))
  process.exit(0)
}

fs.copyFileSync(source, target)
const bytes = fs.readFileSync(target)
const manifest = {
  app: 'superlanguage',
  staged: true,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  launcher: launcherStaged,
  stagedAt: new Date().toISOString(),
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
console.log('[stage-superlanguage] 已暂存 SuperLanguage.exe（' + String(bytes.length) + ' 字节）')
console.log('[stage-superlanguage] 启动器：' + (launcherStaged ? '已暂存' : '缺失（scripts 里没有）'))

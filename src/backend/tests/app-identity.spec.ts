/**
 * N20：主进程必须显式声明 AppUserModelID，且与快捷方式里的 appId 同源。
 *
 * 背景：NSIS 安装器给快捷方式写的 AppUserModelID 来自 `package.json` 的 `build.appId`，
 * 而 `main.js` 此前**从未调用** `app.setAppUserModelId()` —— Electron 用默认身份
 * （exe 路径派生），两边不一致时任务栏固定/分组会认成两个应用（可能出现双图标）。
 *
 * ## 为什么用 AST 而不是源码字符串
 *
 * 第一版守卫写的是 `/app\.setAppUserModelId\(\s*appId\s*\)/.test(mainSrc)`。
 * 可逆 A/B 实测：把调用点**注释掉**（`// app.setAppUserModelId(appId);`）后 4 项断言
 * 依然全绿 —— 它断言的是「这行字出现过」，不是「真的调用了」。这正是本仓库反复栽的
 * 同一个坑（M12 的 `toContain('f(')`、N19 的 `toContain('onDiskPath(candidate)')`）。
 * 这里改成解析 `main.js` 的语法树、只认**真实的 CallExpression 节点**，
 * 注释与字符串里的同名文本一概不算。
 *
 * 这条用例能守什么、守不住什么（如实标注）：
 *   · **守得住**：取值函数的行为、「主进程确实调用了它、实参就是本模块的 appId」、
 *     以及「调用发生在 app ready 之前」；
 *   · **守不住**：Windows 任务栏的真实分组行为。条目 N20 的验收（安装 → 固定到任务栏 →
 *     再启动不出第二个图标）需要真机装包操作，仓库的自动化里没有这一环。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { APP_ID, FALLBACK_APP_ID, appIdFromManifest } from '../app-id.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8')

/**
 * 在源码里定位 `app.setAppUserModelId(...)` 的**真实调用点**。
 * @returns 实参源码文本与节点起始偏移；没有真实调用时返回 null。
 */
function findAppUserModelIdCall(src: string): { args: string[]; pos: number } | null {
  const sf = ts.createSourceFile('main.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let hit: { args: string[]; pos: number } | null = null
  const visit = (node: ts.Node): void => {
    if (hit) return
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'app.setAppUserModelId') {
      hit = { args: node.arguments.map((a) => a.getText(sf)), pos: node.getStart(sf) }
      return
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return hit
}

/** 同上，用于定位 `app.whenReady()` 的调用点（判「建窗前设置身份」）。 */
function findWhenReadyPos(src: string): number {
  const sf = ts.createSourceFile('main.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let pos = -1
  const visit = (node: ts.Node): void => {
    if (pos >= 0) return
    if (ts.isCallExpression(node) && /^app\.whenReady$/.test(node.expression.getText(sf))) {
      pos = node.getStart(sf)
      return
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return pos
}

describe('N20：应用身份（AppUserModelID）', () => {
  it('manifest 的 appId 存在且是反向域名形态', () => {
    // 防空转：appId 若被删除，下面的「同源」断言会退化成两个 undefined 相等
    expect(typeof pkg.build?.appId).toBe('string')
    expect(pkg.build.appId).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/)
  })

  it('appIdFromManifest 取 build.appId，异常输入退回兜底值', () => {
    expect(appIdFromManifest({ build: { appId: 'com.example.app' } })).toBe('com.example.app')
    expect(appIdFromManifest({ build: { appId: '  com.example.app  ' } })).toBe('com.example.app')
    // 这些输入都不能返回 undefined —— setAppUserModelId(undefined) 会直接抛错
    expect(appIdFromManifest({})).toBe(FALLBACK_APP_ID)
    expect(appIdFromManifest({ build: { appId: '' } })).toBe(FALLBACK_APP_ID)
    expect(appIdFromManifest({ build: { appId: '   ' } })).toBe(FALLBACK_APP_ID)
    expect(appIdFromManifest({ build: { appId: 42 } })).toBe(FALLBACK_APP_ID)
    expect(appIdFromManifest(null)).toBe(FALLBACK_APP_ID)
    expect(appIdFromManifest(undefined)).toBe(FALLBACK_APP_ID)
  })

  it('模块导出的 APP_ID 就等于 manifest 里的 appId（require 路径没走兜底）', () => {
    // 若 `require('../../package.json')` 的路径写错，APP_ID 会静默变成兜底值 ——
    // 而兜底值恰好可能与 appId 相同，所以这里断言的是「与 manifest 相等」这件事本身
    expect(APP_ID).toBe(pkg.build.appId)
  })

  it('main.js 真的调用了 app.setAppUserModelId，且实参是本模块的 appId', () => {
    const call = findAppUserModelIdCall(mainSrc)
    expect(call, 'main.js 里没有 app.setAppUserModelId(...) 的真实调用点').toBeTruthy()
    expect(call!.args).toEqual(['appId'])
    // 取值必须来自模块，做法是在 main.js 里解构 `require('./src/backend/app-id.js')`
    expect(mainSrc).toContain("require('./src/backend/app-id.js')")
  })

  it('调用发生在 app ready 之前（建窗之前就要定好身份）', () => {
    const call = findAppUserModelIdCall(mainSrc)
    const readyPos = findWhenReadyPos(mainSrc)
    expect(readyPos, 'main.js 里找不到 app.whenReady() —— 用例前提不成立').toBeGreaterThan(0)
    expect(call!.pos).toBeLessThan(readyPos)
  })
})

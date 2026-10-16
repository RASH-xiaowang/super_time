/**
 * 把 `electron-api.ts` 与 `preload.js` 钉成同一份桥面。
 *
 * 类型面是手写的，因此字段一旦在 preload 里改名、裁剪或新增，这里应当直接红；
 * 否则窗口代码会退回「编译全绿、运行时报 undefined」的旧问题。
 * @vitest-environment node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const TYPE = readFileSync(join(HERE, 'electron-api.ts'), 'utf8')
const ROOT = join(HERE, '..', '..', '..', '..', '..')
const CLIENT_ROOT = join(HERE, '..', '..', '..')
const PRELOAD = readFileSync(join(ROOT, 'preload.js'), 'utf8')

const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  ElectronApi: [
    'getVersions', 'isTestMode', 'runMode', 'debugGates', 'ping',
    'openFile', 'pickDirectory', 'saveFileDialog', 'showInFolder', 'capturePanel',
  ],
  WindowControlsBridge: ['minimize', 'toggleFullscreen', 'close', 'isFullscreen', 'onFullscreenChange'],
  WechatBridge: [
    'listMethods', 'info', 'call', 'getLlmConfig', 'saveLlmConfig', 'listLlmModels',
    'testLlmConnection', 'getLlmBalance', 'getLlmProfiles', 'activateLlmProfile',
    'saveLlmProfile', 'deleteLlmProfile', 'backendState', 'onEvent',
  ],
  RemoteAccessBridge: ['state', 'apply', 'rotate', 'toggle'],
  LicenseBridge: ['status', 'exportRequest', 'importFile', 'importText', 'remove'],
  DiagBridge: ['logInfo', 'exportLog', 'previewLog', 'copyLogPath', 'revealLog'],
  UpdateBridge: ['state', 'check', 'install', 'skip', 'retry', 'onEvent'],
}

/** 从一份源码里切出一个 `export interface X { … }` 块。 */
function interfaceBlock(source: string, name: string): string {
  const at = source.indexOf(`export interface ${name}`)
  expect(at, `electron-api.ts 里找不到 ${name}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`${name} 的接口块没有闭合`)
}

describe('Electron bridge 类型面与 preload 对齐', () => {
  it('preload 仍暴露在 electronAPI 这个全局名上', () => {
    expect(PRELOAD).toContain("exposeInMainWorld('electronAPI'")
  })

  it('每个 namespace 的方法都同时存在于类型面与 preload', () => {
    for (const [typeName, methods] of Object.entries(EXPECTED)) {
      const block = interfaceBlock(TYPE, typeName)
      const declared = new Set([...block.matchAll(/^\s{2}([A-Za-z]\w*)\s*[(<]/gm)].map((m) => m[1] ?? ''))
      const missingInType = methods.filter((name) => !declared.has(name))
      expect(missingInType, `${typeName} 少声明了方法`).toEqual([])

      const missingInPreload = methods.filter((name) => !PRELOAD.includes(`${name}:`))
      expect(missingInPreload, `${typeName} 的方法没有暴露到 preload`).toEqual([])
    }
  })

  it('没有生产代码再用 window as any/unknown 拼 electronAPI（类型面是唯一桥口）', () => {
    const productionHits: string[] = []
    for (const path of ['ui-wechat/src', 'ui-app'].map((p) => join(CLIENT_ROOT, p))) {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name)
          if (entry.isDirectory()) walk(p)
          else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.spec.') && statSync(p).isFile()) {
            if (p.endsWith('electron-api.ts')) continue
            const code = readFileSync(p, 'utf8')
            if (/\(window as (any|unknown)[^)]*\)[^;]*electronAPI|window as any\)[^;]*electronAPI/.test(code)) {
              productionHits.push(p)
            }
          }
        }
      }
      walk(path)
    }
    expect(productionHits.map((p) => p.replace(CLIENT_ROOT, '').replace(/\\/g, '/'))).toEqual([])
  })
})

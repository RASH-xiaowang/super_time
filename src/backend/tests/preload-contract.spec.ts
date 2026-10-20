/**
 * preload ↔ main 的通道镜像判据（Alpha 265 channel 镜像的缩小版）。
 *
 * 为什么值得一条 spec：
 * - 我们的 `window.electronAPI` 是手写桥，channel 字面量只应出现在 preload；
 * - 主进程各 `ipc-*.js` 用手写 `handleIpc/onIpc` 注册；
 * - 新增通道时最容易漏的是「两边只改了一边」：preload 暴露了但 main 没注册
 *   （运行期 invoke 直接 reject），或 main 注册了却没人能调（死通道）。
 *
 * 当前 46 个 invoke/send ↔ 46 个 handler 完全一致。这里用静态扫描把
 * 「今天一致」变成「漂移会红」；不引入共享常量表，避免为了校验再改一遍 46 个调用点。
 *
 * 限制：正则只认本仓当前的三种注册形状（`handleIpc` / `reg.onIpc` / `ipcMain.handle|on`）；
 * 动态拼接的 channel 不在覆盖内（本仓没有）。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** preload 里真正会触发 IPC 的 invoke/send；事件订阅（`.on`）不要求 main 有 handler。 */
function preloadChannels(): Set<string> {
  const source = readFileSync(join(ROOT, 'preload.js'), 'utf8')
  const channels = [...source.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)]
    .map((m) => m[1])
    .filter((channel): channel is string => typeof channel === 'string' && channel !== '')
  return new Set(channels)
}

/** main.js + src/backend/*.js 里注册的 handle/on。 */
function registeredChannels(): { channels: Set<string>, files: string[] } {
  const files = [
    join(ROOT, 'main.js'),
    ...readdirSync(join(ROOT, 'src', 'backend'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => join(ROOT, 'src', 'backend', name)),
  ]
  const channels: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:handleIpc|reg\.onIpc|ipcMain\.(?:handle|on))\('([^']+)'/g)) {
      const channel = match[1]
      if (typeof channel === 'string' && channel !== '') channels.push(channel)
    }
  }
  return { channels: new Set(channels), files }
}

describe('preload ↔ main 通道镜像', () => {
  const exposed = preloadChannels()
  const registered = registeredChannels()

  it('扫描器确实扫到了通道（防止正则失效后变成恒真）', () => {
    expect(exposed.size, 'preload 一个通道都没扫到，正则已失效').toBeGreaterThanOrEqual(40)
    expect(registered.channels.size, 'main 一个 handler 都没扫到，正则已失效').toBeGreaterThanOrEqual(40)
  })

  it('preload 暴露的每个 invoke/send 都有 main handler', () => {
    const missing = [...exposed].filter((channel) => !registered.channels.has(channel))
    expect(missing, `这些通道 preload 暴露了但 main 没注册（运行期会直接 reject）：${missing.join(', ')}`).toEqual([])
  })

  it('main 注册的每个 handler 都能从 preload 调到（没有死通道）', () => {
    const orphan = [...registered.channels].filter((channel) => !exposed.has(channel))
    expect(orphan, `这些 handler 注册了但 preload 没暴露（没人能调）：${orphan.join(', ')}`).toEqual([])
  })

  it('preload 不直接把 ipcRenderer 暴露给渲染层（只暴露白名单方法）', () => {
    const source = readFileSync(join(ROOT, 'preload.js'), 'utf8')
    expect(source).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/)
  })
})

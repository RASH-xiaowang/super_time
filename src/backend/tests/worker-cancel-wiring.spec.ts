/**
 * worker 端取消消息的接线守卫。
 *
 * worker 进程入口不像 backend-rpc.js 那样方便在单测里注入假子进程，因此这里用
 * 源码级判据钉住四个必须同时出现的特征：
 *   ① 主进程发来的 `cancel` 会被处理；
 *   ② 只取消仍然 active 的那一次调用，已完成的调用不能让它打到之后复用的 jobId；
 *   ③ 回执形状与主进程期待的一致；
 *   ④ call 无论成败都清理 active 槽。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const worker = readFileSync(join(ROOT, 'backend', 'wechat-worker.js'), 'utf8')

describe('wechat-worker：RPC 超时取消接线', () => {
  it('处理 type=cancel，并只按当前 active id 查找调用', () => {
    expect(worker).toContain("case 'cancel'")
    expect(worker).toContain('activeCalls.get(id)')
    expect(worker).toContain('activeCalls.set(id, entry)')
    expect(worker).toContain('activeCalls.delete(id)')
  })

  it('认领到 active 调用后调用后端 cancelCall，并回 canceled 回执', () => {
    expect(worker).toContain('backend.cancelCall(entry.method, entry.args, String(id))')
    expect(worker).toContain("type: 'canceled'")
    expect(worker).toContain("value: { ok: false, reason: 'call-completed' }")
  })

  it('call 分支用 try/finally 清理 active 槽，异常与取消都不会留旧 id', () => {
    const at = worker.indexOf("case 'call'")
    const body = worker.slice(at, at + 1200)
    expect(body).toContain('try {')
    expect(body).toContain('} finally {')
    expect(body).toContain('activeCalls.delete(id)')
  })
})

describe('wechat-worker：退出兜底（还原原图自动下载的注入）', () => {
  it('进程 exit 时兜底 dispose，避免注入留在微信进程里', () => {
    // 正常路径是主进程 dispose 握手；兜底是进程自己被杀时（SIGTERM/握手超时）。
    // 少了这一条，worker 被信号打掉后注入无人还原，用户界面只能提示「重启微信」。
    expect(worker).toContain("process.once('exit'")
    const at = worker.indexOf("process.once('exit'")
    const body = worker.slice(at, at + 700)
    expect(body).toContain('backend === null')
    expect(body).toContain('backend.dispose()')
  })

  it('兜底只在还没 dispose 过时动手（不重复还原）', () => {
    const at = worker.indexOf("process.once('exit'")
    const body = worker.slice(at, at + 400)
    expect(body).toContain('if (backend === null) return')
  })

  it('dispose 分支把 backend 置 null —— 这样兜底才知道「已经还原过」', () => {
    const at = worker.indexOf("case 'dispose'")
    const body = worker.slice(at, at + 400)
    expect(body).toContain('backend?.dispose()')
    expect(body).toContain('backend = null')
  })
})

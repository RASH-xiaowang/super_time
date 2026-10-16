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

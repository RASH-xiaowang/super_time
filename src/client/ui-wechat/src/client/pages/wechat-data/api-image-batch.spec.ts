// @vitest-environment node
/**
 * N16（前端半边）/ N1（前端半边）的接线验收。
 *
 * ① 批量取图的合并窗口：列表型取图的面板（聊天的 `MessageThumb`、图片组网格）是「一屏挂 N 个
 *    组件、每个组件各自 `apiGetImageUrl`」，改前就是一屏 N 次 RPC、每次各扫一次路径表。
 *    合并发生在 `apiGetImageDataUrl` 内部（同一次渲染提交里的请求攒到一个微任务里整批发），
 *    所以那些面板**一行都不用改**就能吃到批量入口 —— 这里用「远程面被调了几次、传了几个
 *    item」把这条钉住（数调用次数是确定性判据，不依赖计时）。
 * ② `readError` 透传：后端读不到库时返回空列表 + `readError`，`api.ts` 必须把它带出去，
 *    否则面板只能看到「空」，「库读不到」与「确无数据」又混成一样（N1）。
 *
 * 能证明什么、不能证明什么：这里证明「api 层真的合并成一次批量调用」；**面板里的实际渲染
 * 行为（图片是否显示、读取失败提示是否出现）没有浏览器验证**（仓库没有组件测试环境）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  apiCancelExportJob,
  apiCreateEncryptedBackup,
  apiExportAllSessions,
  apiExportSessionMessages,
  apiGetExportProgress,
  apiGetImageDataUrl,
  apiGetImageDataUrlsBatch,
  apiListTasks,
  setWechatRemote,
  type WechatRemote,
} from './api.ts'

/** 一次批量调用的记录（items 原样留一份，便于断言「合并了几个」）。 */
interface BatchCall {
  items: Array<{ username: string; localId: number }>
}

/** 造一个只实现被测方法的假远程面，并记录它被怎么调用。 */
function stubRemote(overrides: Partial<Record<string, unknown>> = {}): {
  batches: BatchCall[]
  singles: Array<{ username: string; localId: number }>
  calls: string[]
} {
  const batches: BatchCall[] = []
  const singles: Array<{ username: string; localId: number }> = []
  const calls: string[] = []
  const base = {
    getImageDataUrlsBatch: async ({ items }: { items: Array<{ username: string; localId: number }> }) => {
      calls.push('batch')
      batches.push({ items })
      return { ok: true as const, value: { items: items.map(it => ({ ...it, url: 'data:image/png;base64,' + String(it.localId) })) } }
    },
    getImageDataUrl: async (options: { username: string; localId: number }) => {
      calls.push('single')
      singles.push(options)
      return { ok: true as const, value: { url: 'data:image/png;base64,single' } }
    },
    ...overrides,
  }
  setWechatRemote(base as unknown as WechatRemote)
  return { batches, singles, calls }
}

afterEach(() => {
  // 远程面是模块级状态：用例之间必须复位，否则会有隐式顺序依赖。
  setWechatRemote({} as unknown as WechatRemote)
})

describe('N16：列表型取图走批量入口（合并窗口在 api 层）', () => {
  it('同一 tick 的 3 次取图 → 1 次批量 RPC、0 次单张 RPC，结果按位置回填', async () => {
    const stub = stubRemote()
    const [a, b, c] = await Promise.all([
      apiGetImageDataUrl({ username: 'wxid_a', localId: 11 }),
      apiGetImageDataUrl({ username: 'wxid_b', localId: 22 }),
      apiGetImageDataUrl({ username: 'wxid_c', localId: 33 }),
    ])
    expect(stub.calls).toEqual(['batch'])
    expect(stub.singles.length).toBe(0)
    expect(stub.batches.length).toBe(1)
    expect(stub.batches[0]!.items).toEqual([
      { username: 'wxid_a', localId: 11 },
      { username: 'wxid_b', localId: 22 },
      { username: 'wxid_c', localId: 33 },
    ])
    // 顺序必须一一对应（错位会让用户看到别人的图）
    expect(a.url).toContain('11')
    expect(b.url).toContain('22')
    expect(c.url).toContain('33')
  })

  it('单张取图也走批量入口（行为等价：一个 item 的一次批量调用）', async () => {
    const stub = stubRemote()
    const r = await apiGetImageDataUrl({ username: 'wxid_solo', localId: 7 })
    expect(r.url).toContain('7')
    expect(stub.calls).toEqual(['batch'])
    expect(stub.batches[0]!.items).toEqual([{ username: 'wxid_solo', localId: 7 }])
  })

  it('超过分块上限时按 200 一批分多次发（不是悄悄截断）', async () => {
    const stub = stubRemote()
    const n = 201
    const all = await Promise.all(Array.from({ length: n }, (_, i) => apiGetImageDataUrl({ username: 'wxid_x', localId: i + 1 })))
    expect(stub.batches.map(b => b.items.length).sort((x, y) => y - x)).toEqual([200, 1])
    expect(all.length).toBe(n)
    expect(all.every(r => Boolean(r.url))).toBe(true)
  })

  it('批量 RPC 整块失败 → 每一个待回填的调用各自 reject（不静默变成空图）', async () => {
    stubRemote({
      getImageDataUrlsBatch: async () => { throw new Error('后端批量取图失败') },
    })
    const results = await Promise.allSettled([
      apiGetImageDataUrl({ username: 'wxid_a', localId: 1 }),
      apiGetImageDataUrl({ username: 'wxid_b', localId: 2 }),
    ])
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected'])
    expect(String((results[0] as PromiseRejectedResult).reason)).toContain('后端批量取图失败')
  })

  it('显式批量入口原样转发 items 并返回条目', async () => {
    const stub = stubRemote()
    const items = await apiGetImageDataUrlsBatch([{ username: 'wxid_a', localId: 1 }, { username: 'wxid_a', localId: 2 }])
    expect(items.map(i => i.localId)).toEqual([1, 2])
    expect(stub.batches.length).toBe(1)
    expect(stub.singles.length).toBe(0)
  })
})

describe('M3：jobId / 取消 / 进度三条 RPC 的前端镜像', () => {
  it('导出与加密备份把 jobId 原样传下去', async () => {
    const seen: Array<Record<string, unknown>> = []
    stubRemote({
      exportAllSessions: async (options: Record<string, unknown>) => { seen.push(options); return { ok: true as const, value: { path: 'p', filename: 'f', count: 0 } } },
      exportSessionMessages: async (options: Record<string, unknown>) => { seen.push(options); return { ok: true as const, value: { path: 'p', filename: 'f', count: 0 } } },
      createEncryptedBackup: async (options: Record<string, unknown>) => { seen.push(options); return { ok: true as const, value: { ok: true } } },
    })
    await apiExportAllSessions({ jobId: 'job-a' })
    await apiExportSessionMessages({ username: 'u', format: 'txt', jobId: 'job-b' })
    await apiCreateEncryptedBackup({ password: 'pw', jobId: 'job-c' })
    expect(seen.map(o => o['jobId'])).toEqual(['job-a', 'job-b', 'job-c'])
  })

  it('取消与进度查询的返回值/错误原样透出（未找到任务不是静默成功）', async () => {
    stubRemote({
      cancelExportJob: async ({ jobId }: { jobId: string }) => (jobId === 'running'
        ? { ok: true as const, value: { ok: true } }
        : { ok: true as const, value: { ok: false, error: '没有该导出任务' } }),
      getExportProgress: async () => ({ ok: true as const, value: { found: true, phase: 'sessions', done: 3, total: 20, finished: false } }),
    })
    expect(await apiCancelExportJob('running')).toEqual({ ok: true })
    expect((await apiCancelExportJob('gone')).error).toContain('没有该导出任务')
    const st = await apiGetExportProgress('running')
    expect(st).toEqual({ found: true, phase: 'sessions', done: 3, total: 20, finished: false })
  })
})

describe('N1：readError 透传到前端', () => {
  it('待办快照把「库读不到」的原因原样带出来（不是空列表）', async () => {
    stubRemote({
      listTasks: async () => ({ ok: true as const, value: { items: [], total: 0, readError: 'database is locked' } }),
    })
    const r = await apiListTasks()
    expect(r.items).toEqual([])
    expect(r.readError).toBe('database is locked')
  })

  it('确无数据时不带 readError（两条路径必须可区分）', async () => {
    stubRemote({ listTasks: async () => ({ ok: true as const, value: { items: [], total: 0 } }) })
    const r = await apiListTasks()
    expect(r.readError).toBeUndefined()
  })
})

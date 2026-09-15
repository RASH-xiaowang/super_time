// @vitest-environment node
/**
 * M3 接线验收（gateway 侧）：导出/备份的**进度事件 + 取消**必须真的从 RPC 入口接上。
 *
 * 为什么这层必须单独测：`export-stream.spec.ts` 覆盖的是 query 层的 `onProgress`/`signal`
 * 语义，而「渲染层能不能拿到进度、能不能取消」取决于 gateway —— 两者之间的接线（jobId →
 * 本地 onProgress + AbortController）断了的话，query 层用例全绿而功能为零。
 *
 * 顺带钉住两件 M3 的收口：`createBackup` 的「部分失败」被 gateway 转成可读的 `{ok:false}`，
 * 以及**不带 jobId 的老调用方行为完全不变**（没有事件、不可取消、照常成功）。
 *
 * 为什么 mock `node:fs` 的 cpSync：要让「只某一个子目录复制失败」可复现，真实磁盘上没有
 * 跨平台、与权限无关的办法（同 `backup-atomic.spec.ts`），mock 只替换 cpSync，其余透传。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    cpSync: (src: Parameters<typeof actual.cpSync>[0], dest: Parameters<typeof actual.cpSync>[1], opts?: Parameters<typeof actual.cpSync>[2]) => {
      if (String(src).includes('boom')) throw new Error('EIO 模拟复制失败')
      return actual.cpSync(src, dest, opts)
    },
  }
})

const { WechatDataGateway } = await import('../src/gateway.ts')

/** 进度事件的最小形状（后端 `wechat-export/progress` 的 payload）。 */
interface ProgressEvent {
  jobId: string
  phase: string
  done: number
  total: number
}

let root = ''
let decrypted = ''
let decoded = ''
let outDir = ''
let disposers: Array<() => void> = []

/** 造一个有小规模会话数据的解密根（session.db + message 分片），并可选一个注定复制失败的目录。 */
function makeRoot(withBoom: boolean): void {
  root = mkdtempSync(join(tmpdir(), 'dsh-wechat-m3-'))
  decrypted = join(root, 'decrypted')
  decoded = join(root, 'decoded_images')
  outDir = join(root, 'exports-out')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(decoded, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  try {
    sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
    const insS = sdb.prepare("INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?,?,?,?,0,1,'')")
    for (let s = 0; s < 20; s += 1) {
      const u = 'wxid_m3_' + String(s)
      insS.run(u, '会话 ' + String(s), 1700000000 + s, 1700000000 + s)
      const t = 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex')
      mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER)`)
      const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?)`)
      for (let i = 1; i <= 3; i += 1) ins.run(i, i, 1, i % 2, 1700000000 + i, 1, '第 ' + String(i) + ' 条', 'srv' + String(i))
    }
  } finally {
    sdb.close()
    mdb.close()
  }
  if (withBoom) {
    mkdirSync(join(decrypted, 'boom'), { recursive: true })
    writeFileSync(join(decrypted, 'boom', 'broken.db'), 'boom')
  }
}

/**
 * 带事件收集的 Context（gateway 的进度事件走 `ctx.emit`）。
 * @param onEvent - 每次 emit 的回调（用于在进度中途触发取消）。
 */
function fakeCtx(onEvent?: (event: string, payload: ProgressEvent) => void): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: (event: string, payload: ProgressEvent) => { onEvent?.(event, payload) },
  } as unknown as Context
}

/** 建一个指向当前夹具的网关。 */
function gateway(onEvent?: (event: string, payload: ProgressEvent) => void): InstanceType<typeof WechatDataGateway> {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  return new WechatDataGateway(fakeCtx(onEvent))
}

beforeEach(() => { disposers = [] })

afterEach(() => {
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('M3：导出/备份的进度与取消（gateway 接线）', () => {
  it('jobId 让进度推得出去；取消后不留半成品，终态能从轮询读到', async () => {
    makeRoot(false)
    const events: ProgressEvent[] = []
    let gw: InstanceType<typeof WechatDataGateway>
    let cancelled = false
    gw = gateway((event, payload) => {
      if (event !== 'wechat-export/progress') return
      events.push(payload)
      // 第 2 个会话的进度到达时取消：取消必须从 RPC 入口真的贯通到 query 层的检查点。
      if (!cancelled && payload.phase === 'sessions' && payload.done >= 2) {
        cancelled = true
        expect(gw.cancelExportJob({ jobId: payload.jobId }).ok).toBe(true)
      }
    })

    const err = await gw.exportAllSessions({ dir: outDir, filename: 'job.zip', jobId: 'job-1' }).catch((e: unknown) => e)
    expect((err as Error).name).toBe('AbortError')
    expect(cancelled, '进度事件没有把 done 推出来，取消用例失去意义').toBe(true)
    // 事件必须带 jobId（同一进程可能同时跑多个导出，渲染层靠它分流）
    expect(events.length).toBeGreaterThan(0)
    expect(events.every(e => e.jobId === 'job-1')).toBe(true)
    expect(events.some(e => e.phase === 'sessions' && e.total === 20)).toBe(true)
    // 半成品文件一个都不许留（temp+rename 的承诺）
    expect(existsSync(join(outDir, 'job.zip'))).toBe(false)
    expect(readdirSync(outDir)).toEqual([])

    // 轮询兜底：终态 + 可读的取消原因
    const st = gw.getExportProgress({ jobId: 'job-1' })
    expect(st.found).toBe(true)
    expect(st.finished).toBe(true)
    expect(st.error).toBeTruthy()
    // 已结束的任务再取消 → 可读失败（不是静默 ok）
    const again = gw.cancelExportJob({ jobId: 'job-1' })
    expect(again.ok).toBe(false)
    expect(again.error).toBeTruthy()
  })

  it('不带 jobId 的老调用方行为不变：没有事件、照常产出文件', async () => {
    makeRoot(false)
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })
    const r = await gw.exportAllSessions({ dir: outDir, filename: 'plain.zip' })
    expect(r.filename).toBe('plain.zip')
    expect(existsSync(join(outDir, 'plain.zip'))).toBe(true)
    expect(events).toEqual([])
    // 未知 jobId 的轮询是 found:false（渲染层据此显示「任务已不在」而不是 0%）
    expect(gw.getExportProgress({ jobId: 'never-existed' }).found).toBe(false)
    expect(gw.cancelExportJob({ jobId: 'never-existed' }).ok).toBe(false)
  })

  it('朋友圈导出与加密备份同样接上了 jobId 进度', async () => {
    makeRoot(false)
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })

    const m = await gw.exportMoments({ dir: outDir, filename: 'moments.json', format: 'json', jobId: 'moments-1' })
    expect(m.filename).toContain('moments')
    expect(events.filter(e => e.jobId === 'moments-1').length).toBeGreaterThan(0)
    expect(gw.getExportProgress({ jobId: 'moments-1' }).finished).toBe(true)

    events.length = 0
    const b = await gw.createEncryptedBackup({ password: 'pw-m3', jobId: 'backup-1' })
    expect(b.ok).toBe(true)
    expect(b.name).toBeTruthy()
    expect(events.filter(e => e.jobId === 'backup-1').length).toBeGreaterThan(0)
    expect(events.every(e => e.jobId === 'backup-1')).toBe(true)
  })

  it('createBackup 的「部分失败」被 gateway 转成 {ok:false,error}（不再报假成功）', () => {
    makeRoot(true)
    const gw = gateway()
    const r = gw.createBackup()
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('备份不完整')
    expect(r.error ?? '').toContain('boom')
    // 半成品备份目录也不能留下
    const backups = join(root, 'backups')
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([])
  })
})

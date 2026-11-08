// @vitest-environment node
/**
 * 单文件媒体导出的任务终态。
 *
 * 这些入口也会复制几百 MB 的视频/附件，但此前只拿宽 RPC 窗口，没有 jobId：用户既看不到
 * 字节进度，超时/取消也只能等复制结束。这里走真实网关 + 临时 `msg/file`，钉住三件事：
 * 成功终态必须是 done 且可轮询；失败终态必须留下 error；取消必须停止复制且不留半成品。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'

interface ProgressEvent {
  jobId: string
  phase: string
  done: number
  total: number
  finished?: boolean
  status?: 'ok' | 'error' | 'canceled'
  error?: string
}

let root = ''
let decrypted = ''
let raw = ''
let outDir = ''
let events: ProgressEvent[] = []
let onEvent: ((event: ProgressEvent) => void) | null = null

function fakeCtx(): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => fn(),
    emit: (event: string, payload: unknown) => {
      if (event !== 'wechat-export/progress') return
      const progress = payload as ProgressEvent
      events.push(progress)
      onEvent?.(progress)
    },
  } as unknown as Context
}

function gateway(): WechatDataGateway {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  vi.stubEnv('DSH_WECHAT_BASE_DIR', raw)
  return new WechatDataGateway(fakeCtx())
}

function putAttachment(name: string, bytes: Buffer): { path: string; md5: string } {
  const dir = join(raw, 'msg', 'file', '2024-01')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return { path, md5: createHash('md5').update(bytes).digest('hex') }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-media-export-job-'))
  decrypted = join(root, 'decrypted')
  raw = join(root, 'raw')
  outDir = join(root, 'out')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  events = []
  onEvent = null
})

afterEach(() => {
  onEvent = null
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

describe('媒体单文件导出的 jobId 终态', () => {
  it('成功复制后推送 finished/ok 终态，轮询的 done 与 total 收口', async () => {
    const bytes = Buffer.alloc(256 * 1024, 7)
    const source = putAttachment('成功附件.bin', bytes)
    const dest = join(outDir, '成功附件.bin')
    const gw = gateway()

    const result = await gw.exportFileAttachment({
      fileName: '成功附件.bin',
      size: bytes.length,
      md5: source.md5,
      dest,
      jobId: 'media-ok',
    })

    expect(result).toMatchObject({ ok: true, path: dest, bytes: bytes.length })
    expect(existsSync(dest)).toBe(true)
    const mine = events.filter((e) => e.jobId === 'media-ok')
    expect(mine.some((e) => e.phase === 'copy' && e.done > 0 && e.total === bytes.length)).toBe(true)
    expect(mine.at(-1)).toMatchObject({ phase: 'done', finished: true, status: 'ok' })
    const progress = gw.getExportProgress({ jobId: 'media-ok' })
    expect(progress).toMatchObject({ found: true, finished: true, status: 'ok', cancelRequested: false })
    expect(progress.done).toBe(progress.total)
    expect(progress.done).toBeGreaterThan(0)
  })

  it('来源不存在也通过轮询留下 error 终态，而不是只有一次 RPC 错误', async () => {
    const gw = gateway()
    const result = await gw.exportFileAttachment({
      fileName: '不存在.bin',
      dest: join(outDir, '不存在.bin'),
      jobId: 'media-error',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(gw.getExportProgress({ jobId: 'media-error' })).toMatchObject({
      found: true,
      finished: true,
      status: 'error',
      error: result.error,
    })
    expect(events.at(-1)).toMatchObject({ finished: true, status: 'error' })
  })

  it('复制中途取消会停止后续字节、清理临时文件，并留下 canceled 终态', async () => {
    const bytes = Buffer.alloc(12 * 1024 * 1024, 11)
    const source = putAttachment('大附件.bin', bytes)
    const dest = join(outDir, '大附件.bin')
    const gw = gateway()
    let cancelled = false
    onEvent = (progress) => {
      if (cancelled || progress.jobId !== 'media-cancel' || progress.phase !== 'copy' || progress.done <= 0) return
      cancelled = true
      expect(gw.cancelExportJob({ jobId: 'media-cancel' })).toEqual({ ok: true })
      expect(gw.getExportProgress({ jobId: 'media-cancel' })).toMatchObject({
        found: true,
        finished: false,
        status: 'running',
        cancelRequested: true,
      })
    }

    const result = await gw.exportFileAttachment({
      fileName: '大附件.bin',
      size: bytes.length,
      md5: source.md5,
      dest,
      jobId: 'media-cancel',
    })

    expect(cancelled, '复制阶段没有字节进度，取消用例失去意义').toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/取消|cancel|abort/i)
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(outDir).filter((name) => name.includes('.partial-'))).toEqual([])
    expect(gw.getExportProgress({ jobId: 'media-cancel' })).toMatchObject({
      found: true,
      finished: true,
      status: 'canceled',
      cancelRequested: false,
    })
    expect(events.at(-1)).toMatchObject({ finished: true, status: 'canceled' })
  })
})

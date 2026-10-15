// @vitest-environment node
/**
 * W2-8.3：`exportMoments` 的**正常路径**进度。
 *
 * ## 这条要守的事
 *
 * `exportMoments` 早就装了取消三件套（jobId → `onProgress` + `AbortController`），
 * 但进度只报了 `collect` 与 `media` 两段 —— **写盘那一段一个事件都不发**。
 * 后果很具体：进度条停在 `media` 最后一个百分比就再也不动，用户分不清
 * 「正在写盘」与「卡住了」。而写盘对大朋友圈来说不是一瞬间（几 MB 的 txt/html）。
 *
 * ## 判据钉的三条
 *
 * ① 写盘前 `write 0/1`、写盘后 `write 1/1`（定量，界面能收尾）。
 * ② 写盘前查一次取消（拼内容那几秒是纯 CPU，此时点「停止」应当一个文件都不留）。
 * ③ `collect` 段仍然是 `total: 0`（不定量进度）—— 不能为了让进度条好看就编一个总数。
 * @module export-moments-progress
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'

let root = ''
let decrypted = ''
let outDir = ''

/** 造一个有朋友圈的解密根。 */
function makeRoot(): void {
  root = mkdtempSync(join(tmpdir(), 'wx-83-'))
  decrypted = join(root, 'decrypted')
  outDir = join(root, 'out')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  const snsDir = join(decrypted, 'sns', 'db_sns')
  mkdirSync(snsDir, { recursive: true })
  const db = new DatabaseSync(join(snsDir, 'sns.db'))
  // ⚠ 列名必须用真机那套：`queryMoments` 按 `PRAGMA table_info` 在
  //   `tid|Id` / `user_name|userName` / `content|Content` 之间挑，
  //   两边都没有就会走到 `Id` 而报「no such column」（第一版就是这么写的）。
  db.exec('CREATE TABLE SnsTimeLine (tid INTEGER PRIMARY KEY, user_name TEXT, content TEXT, createTime INTEGER, Type INTEGER)')
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO SnsTimeLine (tid, user_name, content, createTime, Type) VALUES (?, ?, ?, ?, ?)')
  for (let i = 0; i < 800; i += 1) {
    ins.run(i, 'wxid_m' + (i % 3), '<msgsome><![CDATA[今天天气不错]]></msgsome>', 1704067200 + i, 1)
  }
  db.exec('COMMIT')
  db.close()
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  const s = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  s.exec('CREATE TABLE SessionTable (username TEXT, type INTEGER, content TEXT)')
  s.prepare('INSERT INTO SessionTable (username, type, content) VALUES (?, ?, ?)').run('wxid_m0', 1, '')
  s.close()
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const ALPHA = 'wxid_m0'
  const table = 'Msg_' + createHash('md5').update(ALPHA, 'utf8').digest('hex')
  const m = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  m.exec('CREATE TABLE "' + table + '" (local_id INTEGER, local_type INTEGER, create_time INTEGER, message_content BLOB)')
  m.close()
}

interface ProgressEvent { jobId: string; phase: string; done: number; total: number }

function fakeCtx(onEvent?: (event: string, payload: ProgressEvent) => void): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => fn(),
    emit: (event: string, payload: ProgressEvent) => { onEvent?.(event, payload) },
    llm: { stream: async function* () { /* 不测生成 */ }, embed: async (t: string[]) => t.map(() => new Array(8).fill(0.1)) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
  } as unknown as Context
}

function gateway(onEvent?: (event: string, payload: ProgressEvent) => void): WechatDataGateway {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  return new WechatDataGateway(fakeCtx(onEvent))
}

beforeEach(() => { makeRoot() })
afterEach(() => { vi.unstubAllEnvs(); try { rmSync(root, { recursive: true, force: true }) } catch { /* 下一条用例自己会报 */ } })

describe('W2-8.3 朋友圈导出的写盘进度', () => {
  it('write 段是定量的 0/1 → 1/1，界面能把进度条收尾', async () => {
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })
    const r = await gw.exportMoments({ format: 'txt', dir: outDir, filename: 'm.txt', jobId: 'j-m1' })
    expect(r.count).toBeGreaterThan(0)
    const w = events.filter(e => e.phase === 'write')
    expect(w.length, '写盘段一个进度事件都没发 ⇒ 进度条停在 media 就不动了').toBeGreaterThanOrEqual(2)
    expect(w[0]).toMatchObject({ phase: 'write', done: 0, total: 1 })
    expect(w[w.length - 1], '最后一条必须是 write 1/1，否则界面收不了尾').toMatchObject({ phase: 'write', done: 1, total: 1 })
  })

  it('collect 段仍是「不定量」（total: 0）—— 不能为了好看编一个总数', async () => {
    const events: ProgressEvent[] = []
    const gw = gateway((event, payload) => { if (event === 'wechat-export/progress') events.push(payload) })
    await gw.exportMoments({ format: 'txt', dir: outDir, filename: 'm2.txt', jobId: 'j-m2' })
    const c = events.filter(e => e.phase === 'collect')
    expect(c.length).toBeGreaterThan(0)
    expect(c.every(e => e.total === 0), 'collect 阶段总量算不出来（还要往下翻页），编一个就是骗界面').toBe(true)
  })

  it('写盘阶段被取消 ⇒ 一个文件都不留', async () => {
    const events: ProgressEvent[] = []
    let gw: WechatDataGateway
    let cancelled = false
    gw = gateway((event, payload) => {
      if (event !== 'wechat-export/progress') return
      events.push(payload)
      // 在 write 0/1 到达的那一刻取消 —— 拼内容那几秒是纯 CPU，此时停手应当零落盘。
      if (!cancelled && payload.phase === 'write' && payload.done === 0) {
        cancelled = true
        expect(gw.cancelExportJob({ jobId: payload.jobId }).ok).toBe(true)
      }
    })
    const err = await gw.exportMoments({ format: 'txt', dir: outDir, filename: 'm3.txt', jobId: 'j-m3' }).catch((e: unknown) => e)
    expect(cancelled, 'write 0/1 没有推到 ⇒ 取消用例失去意义').toBe(true)
    expect((err as Error).name).toBe('AbortError')
    expect(rmSync.length > 0).toBe(true)
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync(join(outDir, 'm3.txt')), '取消后留下了半成品').toBe(false)
  })
})
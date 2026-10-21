/**
 * 接收通道与真实 clawbot.db 的受控集成守卫。
 *
 * 覆盖两个只在「在飞 long-poll + 本地生命周期变化」同时发生时出现的窗口：
 * clear 后旧消息跨重启复活，以及同 wxid 被另一实例接管后旧批次污染新会话。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { completeBinding, readBindingInternal, saveSyncBuf } from '../src/query/clawbot/clawbot-binding.ts'
import { clawbotDbPath } from '../src/query/clawbot/clawbot-db.ts'
import {
  clearClawbotMessages,
  insertClawbotMessage,
  listClawbotMessages,
  suppressClawbotMessageIds,
} from '../src/query/clawbot/clawbot-message.ts'
import { clearClawbotReplyState, listRecoverableReplyRuns } from '../src/query/clawbot/clawbot-reply-store.ts'
import { createClawbotChannel, type ClawbotBatchLease, type ClawbotChannelDeps } from '../src/query/clawbot/clawbot-channel.ts'
import type { IlinkUpdates, WeixinMessage } from '../src/query/clawbot/clawbot-ilink.ts'
import { withDb } from '../src/query/db-open.ts'
import { insertClawbotMessages } from '../src/remotes/clawbot.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-channel-durable-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

function resp(patch: Partial<IlinkUpdates> = {}): IlinkUpdates {
  return { ret: 0, errCode: 0, errMsg: '', messages: [], buf: '', longPollingTimeoutMs: 0, ...patch }
}

function msg(id: number, text: string): WeixinMessage {
  return { message_id: id, message_type: 1, item_list: [{ type: 1, text_item: { text } }] }
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => { setImmediate(resolve) })
  }
  throw new Error(`等待超时：${label}`)
}

function tombstoneCount(dir: string): number {
  return withDb(clawbotDbPath(dir), (db) => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM clawbot_message_tombstone').get() as { n?: number } | undefined
    return Number(row?.n ?? 0)
  })
}

function channelDeps(input: {
  dir: string
  lifecycle: { intake: number, cursor: number }
  responses: Array<IlinkUpdates | Promise<IlinkUpdates>>
  onSuppress?: () => void
}): ClawbotChannelDeps {
  let calls = 0
  return {
    beginBatch: (): ClawbotBatchLease => {
      const intake = input.lifecycle.intake
      const cursor = input.lifecycle.cursor
      const sessionEpoch = readBindingInternal(input.dir, 1).sessionEpoch
      return {
        isCurrent: () => input.lifecycle.intake === intake,
        canAdvanceStaleBuf: () => input.lifecycle.cursor === cursor,
        sessionEpoch,
        clearWatermark: readBindingInternal(input.dir, 1).clearWatermark,
      }
    },
    getUpdates: () => {
      const next = input.responses[calls]
      calls += 1
      return next === undefined ? new Promise<IlinkUpdates>(() => {}) : Promise.resolve(next)
    },
    readBuf: () => readBindingInternal(input.dir, 1).syncBuf,
    saveBuf: (buf, expectedSessionEpoch) => { saveSyncBuf(input.dir, buf, 1, expectedSessionEpoch) },
    suppressMessages: (ids, expectedSessionEpoch) => {
      suppressClawbotMessageIds(
        input.dir,
        1,
        ids,
        expectedSessionEpoch === undefined ? undefined : { expectedSessionEpoch },
      )
      input.onSuppress?.()
    },
    insertMessages: (messages, expectedSessionEpoch) => insertClawbotMessages(
      input.dir,
      1,
      messages,
      { replyIntake: true, ...(expectedSessionEpoch === undefined ? {} : { expectedSessionEpoch }) },
    ),
    onMessages: () => {},
    onError: () => {},
    sleep: () => Promise.resolve(),
    log: () => {},
  }
}

describe('clawbot channel + durable state', () => {
  it('clear 后旧 intake 的同一响应 [旧,新]：只落新消息，跨重启重放仍只保留新消息', async () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wx-clear' }, null, 1)
    insertClawbotMessage(dir, { slot: 1, ts: 1, direction: 'in', content: 'clear 前', msgId: 41 })
    clearClawbotMessages(dir, 1)
    clearClawbotReplyState(dir, 1)

    const lifecycle = { intake: 0, cursor: 0 }
    const stale = deferred<IlinkUpdates>()
    const first = createClawbotChannel(channelDeps({
      dir,
      lifecycle,
      responses: [stale.promise],
    }))
    first.start()
    await waitFor(() => true, '首个通道启动')

    lifecycle.intake += 1
    stale.resolve(resp({
      buf: 'cursor-after-clear',
      messages: [msg(41, 'clear 前'), msg(42, 'clear 后新消息')],
    }))
    await waitFor(() => listClawbotMessages(dir, { slot: 1 }).total === 1, '同一响应只落新消息')
    expect(listClawbotMessages(dir, { slot: 1 }).items.map(item => item.content)).toEqual(['clear 后新消息'])
    expect(readBindingInternal(dir, 1).syncBuf).toBe('cursor-after-clear')
    first.stop()

    const replay = deferred<IlinkUpdates>()
    const second = createClawbotChannel(channelDeps({
      dir,
      lifecycle,
      responses: [resp({
        buf: 'cursor-after-replay',
        messages: [msg(41, '重放旧消息'), msg(42, '新消息')],
      }), replay.promise],
    }))
    second.start()
    await waitFor(
      () => readBindingInternal(dir, 1).syncBuf === 'cursor-after-replay',
      '重启后重放批次推进游标',
    )

    expect(listClawbotMessages(dir, { slot: 1 }).items.map(item => item.content)).toEqual(['clear 后新消息'])
    expect(listRecoverableReplyRuns(dir, Date.now() + 2_000, 20)).toHaveLength(1)
    second.stop()
  })

  it('clear 后在途响应尚未返回就重启：持久墓碑仍拦住旧消息', async () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wx-clear-before-restart' }, null, 1)
    insertClawbotMessage(dir, { slot: 1, ts: 1, direction: 'in', content: 'clear 前', msgId: 81 })
    clearClawbotMessages(dir, 1)

    const lifecycle = { intake: 0, cursor: 0 }
    const replay = deferred<IlinkUpdates>()
    const channel = createClawbotChannel(channelDeps({
      dir,
      lifecycle,
      responses: [resp({
        buf: 'cursor-after-clear-restart',
        messages: [msg(81, '重启后重放旧消息'), msg(82, '重启后的新消息')],
      }), replay.promise],
    }))
    channel.start()
    await waitFor(() => listClawbotMessages(dir, { slot: 1 }).total === 1, '只落重启后的新消息')

    expect(listClawbotMessages(dir, { slot: 1 }).items.map(item => item.content)).toEqual(['重启后的新消息'])
    expect(readBindingInternal(dir, 1).syncBuf).toBe('cursor-after-clear-restart')
    channel.stop()
  })

  it('同 wxid 被另一 slot 接管：旧批次不落库、不写槽位游标、不产生墓碑', async () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wx-shared' }, null, 1)
    const lifecycle = { intake: 0, cursor: 0 }
    const inflight = deferred<IlinkUpdates>()
    const channel = createClawbotChannel(channelDeps({
      dir,
      lifecycle,
      responses: [inflight.promise],
    }))
    channel.start()
    await waitFor(() => true, '通道启动')

    lifecycle.intake += 1
    lifecycle.cursor += 1
    completeBinding(dir, { wxid: 'wx-shared' }, null, 2)
    inflight.resolve(resp({ buf: 'old-session-cursor', messages: [msg(51, '旧会话消息')] }))
    await waitFor(() => !channel.state().running, '旧通道退出')

    expect(listClawbotMessages(dir, { slot: 1 }).total).toBe(0)
    expect(listRecoverableReplyRuns(dir, Date.now() + 2_000, 20)).toHaveLength(0)
    expect(readBindingInternal(dir, 1).syncBuf).toBe('')
    expect(tombstoneCount(dir)).toBe(0)
  })

  it('另一个进程已重新绑定：进程内代次未变也必须拒绝旧批次写库', async () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wx-before-restart' }, null, 1)
    const lifecycle = { intake: 0, cursor: 0 }
    const inflight = deferred<IlinkUpdates>()
    const channel = createClawbotChannel(channelDeps({
      dir,
      lifecycle,
      responses: [inflight.promise],
    }))
    channel.start()
    await waitFor(() => true, '通道启动')

    // 不推进本进程的 intake/cursor，模拟另一个进程完成了重绑。
    completeBinding(dir, { wxid: 'wx-after-restart' }, null, 1)
    inflight.resolve(resp({ buf: 'old-process-cursor', messages: [msg(61, '旧进程晚到消息')] }))
    await waitFor(() => !channel.state().running, '旧通道按持久代次退出')

    expect(listClawbotMessages(dir, { slot: 1 }).total).toBe(0)
    expect(readBindingInternal(dir, 1).syncBuf).toBe('')
    expect(tombstoneCount(dir)).toBe(0)
  })
})

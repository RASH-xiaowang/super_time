/**
 * 定时总结的 Webhook 推送（2026-11-18）。
 *
 * 要守住的不变量有四个，每个都对应一种「表面能用、实际会坑人」的写法：
 *
 *   ① **地址只收 Feather 发送端点 `/webhook/<token>`**。收 `/resources` 的话保存时会成功、
 *      到点推送才失败 —— 那时用户已经等了 24 小时。
 *   ② **脱敏地址回写不算修改**。界面只回显 `/webhook/***`，如果把它当新 token 存进去，
 *      真实地址就被 `***` 覆盖了，之后每次推送都静默失败（而且看起来「配置还在」）。
 *   ③ **老库要能直接升级**。`CREATE TABLE IF NOT EXISTS` 对已存在的表不动，不补列时
 *      升级后第一次写入会报 `no column named webhook_url`。
 *   ④ **推送失败不能污染总结本身**。总结已生成并落库，推送只是投递那一步。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from '../src/query/db-open.ts'
import { listSummaryTasks, saveSummaryTask } from '../src/query/summary-tasks.ts'
import {
  normalizeSummaryWebhookUrl,
  pushSummaryToWebhook,
} from '../src/query/summary-webhook.ts'
import { redactWebhookEndpoint } from '../src/net/webhook-endpoint.ts'
import { createSummaryRemotes } from '../src/remotes/summary.ts'
import type { SummaryTaskInput } from '../src/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * 造一个**独立**的解密数据根。
 *
 * 注意库的位置是 `dirname(decryptedDir)/daily_summary.db`（与待办库同族），
 * 所以不能把 mkdtemp 的目录本身当 decryptedDir —— 那样所有用例会共用
 * `tmpdir/daily_summary.db`，前一个用例建的任务会漏到下一个里（本文件就踩过）。
 */
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'summary-webhook-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return decrypted
}

const OK_URL = 'http://192.168.1.2:55725/webhook/fb90139b3e708090469256fd2f8d9c4f'

function task(overrides: Partial<SummaryTaskInput> = {}): SummaryTaskInput {
  return {
    groupUsername: 'g@chatroom',
    groupName: '某个群',
    targetUsers: [],
    format: 'brief',
    customPrompt: '',
    scheduleTime: '08:00',
    enabled: true,
    ...overrides,
  }
}

/** 一个只回一次固定响应的 fetch 替身（记录请求体便于断言协议）。 */
function fakeFetch(response: () => Promise<Response>): {
  impl: (input: string, init?: RequestInit) => Promise<Response>
  calls: Array<{ url: string; body: string; method: string }>
} {
  const calls: Array<{ url: string; body: string; method: string }> = []
  return {
    calls,
    impl: (input, init) => {
      calls.push({
        url: input,
        body: typeof init?.body === 'string' ? init.body : '',
        method: String(init?.method ?? ''),
      })
      return response()
    },
  }
}

describe('推送地址规范化', () => {
  it('空串 = 显式关掉推送（clear），不是错误', () => {
    expect(normalizeSummaryWebhookUrl('')).toEqual({ ok: true, url: '', kind: 'clear' })
    expect(normalizeSummaryWebhookUrl('   ')).toMatchObject({ ok: true, kind: 'clear' })
    expect(normalizeSummaryWebhookUrl(undefined)).toMatchObject({ ok: true, kind: 'clear' })
  })

  it('合法的 Feather 发送端点被接受并规范化', () => {
    const r = normalizeSummaryWebhookUrl(OK_URL)
    expect(r).toMatchObject({ ok: true, kind: 'set', url: OK_URL })
  })

  it('脱敏占位 /webhook/*** 表示「不修改」，不能被当成真 token', () => {
    const r = normalizeSummaryWebhookUrl('http://192.168.1.2:55725/webhook/***')
    expect(r).toMatchObject({ ok: true, kind: 'keep', url: '' })
  })

  it('拒绝 /resources 附件端点（保存时就失败，而不是到点推送才失败）', () => {
    const r = normalizeSummaryWebhookUrl('http://192.168.1.2:55725/webhook/abc/resources')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('/webhook/<token>')
  })

  it('拒绝非 http(s)、内嵌凭据、查询串与不是 /webhook/ 的路径', () => {
    for (const bad of [
      'ftp://192.168.1.2:55725/webhook/abc',
      'http://user:pass@192.168.1.2:55725/webhook/abc',
      'http://192.168.1.2:55725/webhook/abc?x=1',
      'http://192.168.1.2:55725/api/message-webhook/abc',
      'not-a-url',
    ]) {
      expect(normalizeSummaryWebhookUrl(bad).ok, bad).toBe(false)
    }
  })
})

describe('推送请求', () => {
  it('没配地址时跳过，不产生任何请求', async () => {
    const fetch = fakeFetch(() => Promise.resolve(new Response('{}', { status: 200 })))
    const r = await pushSummaryToWebhook({ webhookUrl: '', target: '文件传输助手', message: '总结' }, { fetchImpl: fetch.impl })
    expect(r).toMatchObject({ ok: true, skipped: true })
    expect(fetch.calls).toHaveLength(0)
  })

  it('按下游协议只发 {target, message} 两个字段', async () => {
    const fetch = fakeFetch(() => Promise.resolve(
      new Response(JSON.stringify({ ok: true, id: 'abc', state: 'queued' }), { status: 202 }),
    ))
    const r = await pushSummaryToWebhook(
      { webhookUrl: OK_URL, target: '文件传输助手', message: '这是今天的总结' },
      { fetchImpl: fetch.impl },
    )
    expect(r.ok).toBe(true)
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]?.method).toBe('POST')
    expect(fetch.calls[0]?.url).toBe(OK_URL)
    expect(JSON.parse(fetch.calls[0]?.body ?? '{}')).toEqual({
      target: '文件传输助手',
      message: '这是今天的总结',
    })
  })

  it('2xx 但正文 ok=false 仍判失败（下游拒收时就是这么回的）', async () => {
    const fetch = fakeFetch(() => Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: 'target not found' }), { status: 200 }),
    ))
    const r = await pushSummaryToWebhook(
      { webhookUrl: OK_URL, target: '不存在的人', message: '总结' },
      { fetchImpl: fetch.impl },
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('target not found')
  })

  it('非 2xx 带上状态码与响应片段', async () => {
    const fetch = fakeFetch(() => Promise.resolve(new Response('token expired', { status: 401 })))
    const r = await pushSummaryToWebhook(
      { webhookUrl: OK_URL, target: '文件传输助手', message: '总结' },
      { fetchImpl: fetch.impl },
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.error).toContain('401')
  })

  it('网络异常折进返回值而不是抛错，且错误文本里的 token 被抹掉', async () => {
    const fetch = fakeFetch(() => Promise.reject(new Error('connect ECONNREFUSED ' + OK_URL)))
    const r = await pushSummaryToWebhook(
      { webhookUrl: OK_URL, target: '文件传输助手', message: '总结' },
      { fetchImpl: fetch.impl },
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ECONNREFUSED')
    expect(r.error).not.toContain('fb90139b3e708090469256fd2f8d9c4f')
  })

  it('缺推送对象直接失败，不发请求', async () => {
    const fetch = fakeFetch(() => Promise.resolve(new Response('{}', { status: 200 })))
    const r = await pushSummaryToWebhook({ webhookUrl: OK_URL, target: '  ', message: '总结' }, { fetchImpl: fetch.impl })
    expect(r.ok).toBe(false)
    expect(fetch.calls).toHaveLength(0)
  })

  it('超长正文完整发出（不截断）：限制字数会正好砍在结论上', async () => {
    const fetch = fakeFetch(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
    // 4 万字：远超过去那 2 万的上限，验证现在整段照发。
    const long = '总结'.repeat(20_000)
    const r = await pushSummaryToWebhook({ webhookUrl: OK_URL, target: '文件传输助手', message: long }, { fetchImpl: fetch.impl })
    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('truncated')
    const body = JSON.parse(fetch.calls[0]?.body ?? '{}') as { message: string }
    expect(body.message.length).toBe(long.length)
    expect(body.message).toBe(long)
  })

  it('返回的端点始终是脱敏形式', async () => {
    const fetch = fakeFetch(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
    const r = await pushSummaryToWebhook({ webhookUrl: OK_URL, target: '文件传输助手', message: '总结' }, { fetchImpl: fetch.impl })
    expect(r.endpoint).toBe(redactWebhookEndpoint(OK_URL))
    expect(r.endpoint).not.toContain('fb90139b3e708090469256fd2f8d9c4f')
  })
})

describe('Remote 边界', () => {
  it('listSummaryTasks 只返回脱敏地址，完整 token 不出本机库', () => {
    const dir = tempDir()
    const root = join(dir, '..')
    expect(saveSummaryTask(dir, task({ webhookUrl: OK_URL, webhookTarget: '文件传输助手' })).ok).toBe(true)

    // 只造 list 需要的依赖：其余（op / ctx / privacyGate）在 list 路径上根本不会被调用。
    const remotes = createSummaryRemotes({
      dirs: () => ({ decrypted: dir, decoded: join(root, 'decoded') }),
      op: () => { /* list 不写操作流水 */ },
      ctx: () => ({} as never),
      privacyGate: ((texts: readonly string[]) => ['', texts]) as never,
    })
    const snapshot = remotes.listSummaryTasks()
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.webhookUrl).toBe(redactWebhookEndpoint(OK_URL))
    expect(snapshot.items[0]?.webhookUrl).not.toContain('fb90139b3e708090469256fd2f8d9c4f')
    // 推送对象不是凭据，照常回显。
    expect(snapshot.items[0]?.webhookTarget).toBe('文件传输助手')
    // 而本机库里仍是完整地址（推送要用它）。
    expect(listSummaryTasks(dir).items[0]?.webhookUrl).toBe(OK_URL)
  })
})

describe('任务存储的新增两列', () => {
  it('保存后能读回完整地址与推送对象', () => {
    const dir = tempDir()
    const saved = saveSummaryTask(dir, task({ webhookUrl: OK_URL, webhookTarget: '文件传输助手' }))
    expect(saved.ok).toBe(true)
    const read = listSummaryTasks(dir).items[0]
    expect(read?.webhookUrl).toBe(OK_URL)
    expect(read?.webhookTarget).toBe('文件传输助手')
  })

  it('非法地址在保存时就被拒绝，且任务没被建出来', () => {
    const dir = tempDir()
    const r = saveSummaryTask(dir, task({ webhookUrl: 'https://example.com/hook' }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('/webhook/<token>')
    expect(listSummaryTasks(dir).items).toHaveLength(0)
  })

  it('回写脱敏地址不会覆盖真实 token（keep）', () => {
    const dir = tempDir()
    const id = saveSummaryTask(dir, task({ webhookUrl: OK_URL, webhookTarget: '文件传输助手' })).id ?? 0
    const again = saveSummaryTask(dir, task({
      id,
      webhookUrl: redactWebhookEndpoint(OK_URL),
      webhookTarget: '文件传输助手',
    }))
    expect(again.ok).toBe(true)
    expect(listSummaryTasks(dir).items[0]?.webhookUrl).toBe(OK_URL)
  })

  it('不传 webhookUrl（旧表单）时保留原值，不会被清空', () => {
    const dir = tempDir()
    const id = saveSummaryTask(dir, task({ webhookUrl: OK_URL, webhookTarget: '文件传输助手' })).id ?? 0
    const legacy = task({ id, scheduleTime: '09:30' })
    expect(saveSummaryTask(dir, legacy).ok).toBe(true)
    const read = listSummaryTasks(dir).items[0]
    expect(read?.scheduleTime).toBe('09:30')
    expect(read?.webhookUrl).toBe(OK_URL)
  })

  it('显式传空串 = 关掉推送', () => {
    const dir = tempDir()
    const id = saveSummaryTask(dir, task({ webhookUrl: OK_URL, webhookTarget: '文件传输助手' })).id ?? 0
    expect(saveSummaryTask(dir, task({ id, webhookUrl: '' })).ok).toBe(true)
    expect(listSummaryTasks(dir).items[0]?.webhookUrl).toBe('')
  })

  it('老库（没有这两列）升级后自动补列，老任务读成空串', () => {
    const dir = tempDir()
    // 造一个「升级前」的库：建表语句刻意不含 webhook_*，并塞一条老任务。
    const legacy = new DatabaseSync(join(dir, '..', 'daily_summary.db'))
    legacy.exec("CREATE TABLE summary_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, group_username TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', target_users TEXT NOT NULL DEFAULT '[]', provider_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'brief', custom_prompt TEXT NOT NULL DEFAULT '', schedule_time TEXT NOT NULL DEFAULT '08:00', enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_status TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    legacy.exec("INSERT INTO summary_tasks(group_username, group_name, format, created_at, updated_at) VALUES ('g@chatroom', '某个群', 'brief', 1, 1)")
    legacy.close()

    const items = listSummaryTasks(dir).items
    expect(items).toHaveLength(1)
    expect(items[0]?.webhookUrl).toBe('')
    expect(items[0]?.webhookTarget).toBe('')
    // 补列之后写入必须能成功（不补列时这里会报 no column named webhook_url）。
    const id = items[0]?.id ?? 0
    expect(saveSummaryTask(dir, task({ id, webhookUrl: OK_URL, webhookTarget: '文件传输助手' })).ok).toBe(true)
    expect(listSummaryTasks(dir).items[0]?.webhookUrl).toBe(OK_URL)
  })
})

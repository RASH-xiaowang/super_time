// @vitest-environment node
/**
 * 消息列表下游投递的请求体、附件预算、资源上传和并发防重。
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchCreatedMessageListRecord,
  dispatchMessageListRecord,
  dispatchPendingMessageListRecords,
} from '../src/query/message-list-dispatch.ts'
import {
  completeAiReplyMessageListRecord,
  getMessageListRecord,
  ingestMessageListWebhook,
  insertAiReplyMessageListRecord,
  insertMessageListRecord,
  listMessageListRecords,
  listMessageListRules,
  reserveAiReplyMessageListRecord,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'
import {
  MESSAGE_LIST_ATTACHMENT_MAX_BYTES,
  stageMessageListAttachment,
} from '../src/query/message-list-attachments.ts'
import { featherRequestCapacityError } from '../src/query/ai-reply/provider.ts'
import {
  JPEG_DATA_URL,
  PNG_BYTES,
  PNG_DATA_URL,
  cleanupMessageListFixture,
  decrypted,
  dispatchDeps,
  root,
  setupMessageListFixture,
} from './message-list-spec-fixtures.ts'

beforeEach(setupMessageListFixture)
afterEach(cleanupMessageListFixture)

describe('下游投递：请求体与附件', () => {
  it('大肥鱼 /send/text 的 AI 回复请求体严格为 {talker,text}', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    const inserted = insertAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      chatUsername: 'wxid_wang',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      text: '在的，你说',
      sourceRef: 'ai-reply:wxid_self:wxid_wang:1000:3',
    })
    let body: Record<string, unknown> = {}
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(body).toEqual({ talker: 'wxid_wang', text: '在的，你说' })
  })

  it('/send/text 遇到有附件的记录时在出网前显式失败', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      text: '不能丢图',
      images: [{ url: 'https://cdn.example/a.png' }],
    })
    let calls = 0
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('/send/text 不支持附件')
    expect(result.record).toMatchObject({ status: 'failed', attempts: 0 })
    expect(calls).toBe(0)
  })

  it('记录无地址快照、由规则补解析出 /send/text 时仍使用大肥鱼请求体', async () => {
    const inserted = insertAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      chatUsername: 'wxid_wang',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      text: '规则补地址',
      sourceRef: 'ai-reply:wxid_self:wxid_wang:1000:30',
    })
    expect(inserted.record?.webhookUrl).toBe('')
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    let body: Record<string, unknown> = {}
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(body).toEqual({ talker: 'wxid_wang', text: '规则补地址' })
  })

  it('/send/text 返回 HTTP 200 但 ok=false 时落为失败', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    const inserted = insertAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      chatUsername: 'wxid_wang',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      text: '桥接拒绝',
      sourceRef: 'ai-reply:wxid_self:wxid_wang:1000:31',
    })
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => new Response('{"ok":false,"error":"发送失败"}', { status: 200 })),
    )
    expect(result.ok).toBe(false)
    expect(result.record?.status).toBe('failed')
    expect(result.error).toContain('未确认发送成功')
    expect(result.record?.error).toContain('发送失败')
  })

  it('/webhook/<token> 的 AI 回复请求体严格为 {target,message}', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = insertAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      chatUsername: 'wxid_wang',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      text: '上班！！！',
      sourceRef: 'ai-reply:wxid_self:wxid_wang:1000:4',
    })
    let body: Record<string, unknown> = {}
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(body).toEqual({ target: '小王', message: '上班！！！' })
    expect(body.talker).toBeUndefined()
    expect(body.text).toBeUndefined()
    expect(body.recordId).toBeUndefined()
  })

  it('/webhook/<token> 的群聊请求体使用 target=群名 + mention=成员', async () => {
    expect(saveMessageListRule(decrypted, {
      chatName: '智能回复机器人·ai-1群',
      targetName: 'Y.M',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = ingestMessageListWebhook(decrypted, {
      target: '智能回复机器人·ai-1群',
      mention: 'Y.M',
      message: '憨憨，上班',
    })
    let body: Record<string, unknown> = {}
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('{"ok":true,"id":"job-group-1"}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(body).toEqual({
      target: '智能回复机器人·ai-1群',
      message: '憨憨，上班',
      mention: 'Y.M',
    })
    expect(result.record?.jobId).toBe('job-group-1')
  })

  it('手工私聊即使会话名与备注名不同，也不会误判为群聊', async () => {
    expect(saveMessageListRule(decrypted, {
      chatName: '客户会话',
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      chatName: '客户会话',
      targetName: '小王',
      text: '私聊正文',
    })
    let body: Record<string, unknown> = {}
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(body).toEqual({ target: '小王', message: '私聊正文' })
  })

  it('Feather 正文与图片混发会在出网前明确失败', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '带图消息',
      images: [{ url: 'https://cdn.example/a.png' }],
    })
    let calls = 0
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('只能发送正文或附件')
    expect(calls).toBe(0)
    expect(result.record?.attempts).toBe(0)
  })

  it('Feather 图片先按字节上传 spool，再只以 resource_ids 触发附件任务', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '',
      images: [
        { url: 'https://cdn.example/a.png', name: 'a.png' },
        { dataUrl: JPEG_DATA_URL, name: 'b.jpg' },
      ],
    })
    const requests: Array<{ url: string; method: string; body: BodyInit | null | undefined }> = []
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (url, init) => {
        if (String(url).startsWith('https://cdn.example/')) {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        }
        requests.push({ url, method: String(init?.method), body: init?.body })
        if (String(url).endsWith('/resources')) {
          const bytes = init?.body instanceof Uint8Array ? init.body : new Uint8Array()
          const sha = createHash('sha256').update(bytes).digest('hex')
          const name = new Headers(init?.headers).get('x-feather-filename') ?? 'resource'
          const id = String(requests.length).padStart(40, 'a')
          return new Response(JSON.stringify({
            ok: true,
            id,
            name,
            size: bytes.byteLength,
            sha256: sha,
          }), { status: 201 })
        }
        return new Response('{"ok":true,"id":"job_attachment_1"}', { status: 202 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(requests).toHaveLength(3)
    expect(requests[0]?.url).toBe('http://192.0.2.10:17890/webhook/test-token/resources')
    expect(requests[1]?.url).toBe('http://192.0.2.10:17890/webhook/test-token/resources')
    expect(requests[2]?.url).toBe('http://192.0.2.10:17890/webhook/test-token')
    expect(JSON.parse(String(requests[2]?.body))).toEqual({
      target: '小王',
      resource_ids: [
        '1'.padStart(40, 'a'),
        '2'.padStart(40, 'a'),
      ],
      type: 'attachments',
    })
    expect(result.record).toMatchObject({
      status: 'queued',
      jobState: 'queued',
      jobId: 'job_attachment_1',
      attempts: 1,
    })
  })

  it('legacy 多图按 URL 与解码 data URL 合计执行 20 MB 内联总预算', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '预算对象',
      webhookUrl: 'https://downstream.example/budget',
    }).ok).toBe(true)
    const largePng = Buffer.alloc(3_500_000)
    PNG_BYTES.copy(largePng)
    const dataUrl = 'data:image/png;base64,' + largePng.toString('base64')
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '预算对象',
      chatUsername: 'wxid_budget',
      text: '',
      images: Array.from({ length: 6 }, (_value, index) => ({ localId: index + 1 })),
    })

    expect(largePng.byteLength * 5).toBeLessThan(MESSAGE_LIST_ATTACHMENT_MAX_BYTES)
    expect(largePng.byteLength * 6).toBeGreaterThan(MESSAGE_LIST_ATTACHMENT_MAX_BYTES)
    expect(dataUrl.length).toBeGreaterThan(largePng.byteLength)
    let calls = 0
    const result = await dispatchMessageListRecord(decrypted, inserted.id ?? 0, {
      ...dispatchDeps(async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      }),
      decodeImage: async () => ({ url: dataUrl }),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('内联附件累计超过 20 MB')
    expect(calls).toBe(0)
    expect(result.record).toMatchObject({ status: 'failed', attempts: 0 })
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)?.error)
      .toContain('内联附件累计超过 20 MB')
  })

  it('Feather 资源上传失败时不发送附件任务，也不增加发送尝试次数', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '',
      images: [{ dataUrl: PNG_DATA_URL, name: 'a.png' }],
    })
    const calls: string[] = []
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (url) => {
        calls.push(url)
        return new Response('{"ok":false,"message":"sha256 mismatch"}', { status: 400 })
      }),
    )
    expect(result.ok).toBe(false)
    expect(calls).toEqual(['http://192.0.2.10:17890/webhook/test-token/resources'])
    expect(result.record).toMatchObject({ status: 'failed', attempts: 0 })
    expect(result.record?.error).toContain('资源上传失败')
  })

  it('通用附件经本机 spool 上传为 Feather 资源，记录中不保存本机路径', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const source = join(root, 'report.pdf')
    const bytes = Buffer.from('%PDF-1.7\n跨机附件测试\n')
    writeFileSync(source, bytes)
    const staged = await stageMessageListAttachment(decrypted, { path: source })
    expect(staged.ok).toBe(true)
    expect(staged.attachment?.stagedId).toMatch(/^[0-9a-f]{40}$/)
    expect(staged.attachment?.name).toBe('report.pdf')

    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '',
      images: staged.attachment === undefined ? [] : [staged.attachment],
    })
    expect(inserted.record?.images[0]).toMatchObject({
      stagedId: staged.attachment?.stagedId,
      name: 'report.pdf',
      size: bytes.byteLength,
      mime: 'application/pdf',
    })
    expect(JSON.stringify(inserted.record)).not.toContain(source)

    const requests: Array<{ url: string; bytes?: Uint8Array; body?: string }> = []
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (url, init) => {
        if (String(url).endsWith('/resources')) {
          const uploaded = init?.body instanceof Uint8Array ? init.body : new Uint8Array()
          requests.push({ url: String(url), bytes: uploaded })
          return new Response(JSON.stringify({
            ok: true,
            id: 'c'.repeat(40),
            name: 'report.pdf',
            size: uploaded.byteLength,
            sha256: createHash('sha256').update(uploaded).digest('hex'),
          }), { status: 201 })
        }
        requests.push({ url: String(url), body: String(init?.body) })
        return new Response('{"ok":true,"id":"job_pdf_1"}', { status: 202 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(requests).toHaveLength(2)
    expect(Buffer.from(requests[0]?.bytes ?? new Uint8Array())).toEqual(bytes)
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({
      target: '小王',
      resource_ids: ['c'.repeat(40)],
      type: 'attachments',
    })
  })

  it('Webhook 入站携带 stagedId 时拒绝整条请求且不落库', () => {
    const inserted = ingestMessageListWebhook(decrypted, {
      target: '小王',
      message: '伪造附件引用',
      attachments: [{
        stagedId: 'd'.repeat(40),
        name: 'secret.pdf',
        size: 100,
      }],
    })
    expect(inserted.ok).toBe(false)
    expect(inserted.error).toContain('stagedId')
    expect(inserted.record).toBeUndefined()
    expect(listMessageListRecords(decrypted).total).toBe(0)
  })

  it('Feather 上传响应 SHA 或大小与本地不一致时拒绝发送', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '',
      images: [{ dataUrl: PNG_DATA_URL }],
    })
    let calls = 0
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => {
        calls += 1
        return new Response(JSON.stringify({
          ok: true,
          id: 'a'.repeat(40),
          name: 'image.png',
          size: 99,
          sha256: 'b'.repeat(64),
        }), { status: 201 })
      }),
    )
    expect(result.ok).toBe(false)
    expect(calls).toBe(1)
    expect(result.record?.attempts).toBe(0)
    expect(result.record?.error).toContain('校验失败')
  })

  it('/webhook/<token> 由规则补解析地址时仍使用 {target,message}', async () => {
    const inserted = insertAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      chatUsername: 'wxid_wang',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      text: '规则补地址',
      sourceRef: 'ai-reply:wxid_self:wxid_wang:1000:32',
    })
    expect(inserted.record?.webhookUrl).toBe('')
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    let body: Record<string, unknown> = {}
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(body).toEqual({ target: '小王', message: '规则补地址' })
  })

  it('/webhook/<token> 的失败响应会保留在消息列表', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)
    const inserted = insertAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      chatUsername: 'wxid_wang',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      text: '发送失败',
      sourceRef: 'ai-reply:wxid_self:wxid_wang:1000:33',
    })
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => new Response('webhook unavailable', { status: 503 })),
    )
    expect(result.ok).toBe(false)
    expect(result.record).toMatchObject({
      id: inserted.id,
      source: 'ai_reply',
      status: 'failed',
    })
    expect(result.record?.error).toContain('HTTP 503')
  })

  it('重复 sourceRef 的 created=false 结果不会再次出网', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    const input = {
      targetName: '小王',
      targetUsername: 'wxid_wang',
      text: '只发一次',
      sourceRef: 'ai-reply:wxid_self:wxid_wang:1000:5',
    }
    const first = insertAiReplyMessageListRecord(decrypted, input)
    const duplicate = insertAiReplyMessageListRecord(decrypted, input)
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response('{"ok":true}', { status: 200 })
    }
    await dispatchCreatedMessageListRecord(decrypted, first, dispatchDeps(fetchImpl))
    const skipped = await dispatchCreatedMessageListRecord(decrypted, duplicate, dispatchDeps(fetchImpl))
    expect(calls).toBe(1)
    expect(skipped.created).toBe(false)
  })

  it('同一记录被后台批量和即时投递同时选中时只出网一次', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '只发一次',
    })
    let calls = 0
    let release: (() => void) | undefined
    const fetchImpl = async () => {
      calls += 1
      await new Promise<void>((resolve) => { release = resolve })
      return new Response('{"ok":true}', { status: 200 })
    }
    const first = dispatchMessageListRecord(decrypted, inserted.id ?? 0, dispatchDeps(fetchImpl))
    await vi.waitFor(() => expect(calls).toBe(1))
    const second = await dispatchPendingMessageListRecords(decrypted, dispatchDeps(fetchImpl))
    // 第一条已被数据库原子认领为 dispatching，批量查询只取 pending，因此不会再选中它。
    expect(second).toEqual({ dispatched: 0, failed: 0 })
    release?.()
    expect((await first).ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('Feather target 按 UTF-16 127/128 边界在落库前拒绝超长值', () => {
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)

    const exact = insertMessageListRecord(decrypted, {
      targetName: '客'.repeat(127),
      text: '边界内',
    })
    const over = insertMessageListRecord(decrypted, {
      targetName: '客'.repeat(128),
      text: '边界外',
    })

    expect(exact.ok).toBe(true)
    expect(over.ok).toBe(false)
    expect(over.error).toContain('127')
    expect(over.record).toBeUndefined()
    expect(listMessageListRecords(decrypted).total).toBe(1)
  })

  it('Feather 规则保存也拒绝超长触发对象和首次触发文本', () => {
    const longTarget = saveMessageListRule(decrypted, {
      targetName: '客'.repeat(128),
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    })
    const longGreeting = saveMessageListRule(decrypted, {
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
      greetingText: '😀'.repeat(256),
    })

    expect(longTarget.ok).toBe(false)
    expect(longTarget.error).toContain('127')
    expect(longGreeting.ok).toBe(false)
    expect(longGreeting.error).toContain('511')
    expect(listMessageListRules(decrypted).total).toBe(0)
  })

  it('Feather message 按 UTF-16 511/512 边界拒绝超长正文，emoji 不被半截写入', () => {
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)

    const exact = insertMessageListRecord(decrypted, {
      targetName: '正文边界',
      text: '😀'.repeat(255) + '你',
    })
    const over = insertMessageListRecord(decrypted, {
      targetName: '正文边界',
      text: '😀'.repeat(256),
    })

    expect(exact.ok).toBe(true)
    expect(exact.record?.text.length).toBe(511)
    expect(over.ok).toBe(false)
    expect(over.error).toContain('511')
    expect(over.record).toBeUndefined()
    expect(listMessageListRecords(decrypted).total).toBe(1)
  })

  it('普通微信 AI 回复在任何 Webhook 规则前也不会写入超过 511 的正文', () => {
    const result = insertAiReplyMessageListRecord(decrypted, {
      targetName: 'AI 边界',
      text: '😀'.repeat(256),
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:511',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('511')
    expect(result.record).toBeUndefined()
    expect(listMessageListRecords(decrypted).total).toBe(0)
  })

  it('AI 回复预约补全同样拒绝 512 个 UTF-16 code unit，原记录保持空白 pending', () => {
    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      targetName: 'AI 预约边界',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:512',
    })
    expect(reserved.ok).toBe(true)

    const completed = completeAiReplyMessageListRecord(decrypted, reserved.id ?? 0, {
      text: '😀'.repeat(256),
    })

    expect(completed.ok).toBe(false)
    expect(completed.error).toContain('511')
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)).toMatchObject({
      status: 'pending',
      text: '',
    })
  })

  it('记录落库后才补上 Feather 规则时，dispatch 在出网前按真实容量失败', async () => {
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '迟到规则',
      text: '😀'.repeat(256),
    })
    expect(inserted.ok).toBe(true)
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'http://192.0.2.10:17890/webhook/test-token',
    }).ok).toBe(true)

    let calls = 0
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('511')
    expect(result.record).toMatchObject({ status: 'failed', attempts: 0 })
    expect(calls).toBe(0)
  })

  it('Feather JSON 请求体按 8192/8193 字节边界拒绝超限请求', () => {
    const base = { target: '小王' }
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, padding: '' }), 'utf8')
    const atLimit = { ...base, padding: 'x'.repeat(8192 - overhead) }
    const overLimit = { ...base, padding: 'x'.repeat(8193 - overhead) }

    expect(Buffer.byteLength(JSON.stringify(atLimit), 'utf8')).toBe(8192)
    expect(featherRequestCapacityError({ target: '小王', request: atLimit })).toBeUndefined()
    expect(featherRequestCapacityError({ target: '小王', request: overLimit }))
      .toContain('8192')
  })
})

// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MESSAGE_LIST_ATTACHMENT_MAX_BYTES,
  createPublicHttpFetch,
  decodeMessageListImageDataUrl,
  readStagedAttachment,
  stageMessageListAttachment,
  validateMessageListImages,
} from '../src/query/message-list-attachments.ts'
import {
  uploadFeatherResource,
  uploadMessageListImages,
} from '../src/query/ai-reply/feather-resources.ts'
import {
  ingestMessageListWebhook,
  listMessageListRecords,
} from '../src/query/message-list-store.ts'

const WEBHOOK = 'http://192.0.2.10:17890/webhook/test-token'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  PNG_MAGIC.copy(bytes)
  return bytes
}

function pngDataUrl(size: number): string {
  return 'data:image/png;base64,' + pngBytes(size).toString('base64')
}

function requestBytes(body: BodyInit | null | undefined): Uint8Array {
  return body instanceof Uint8Array ? body : new Uint8Array()
}

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('消息列表附件预算与入站边界', () => {
  it('以注入阈值覆盖 19.99 / 20 / 20.01 MB 比例边界', () => {
    const limits = { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 }
    for (const size of [99, 100]) {
      const result = validateMessageListImages(
        [{ dataUrl: pngDataUrl(size) }],
        { mode: 'webhook', limits },
      )
      expect(result.ok).toBe(true)
    }
    const over = validateMessageListImages(
      [{ dataUrl: pngDataUrl(101) }],
      { mode: 'webhook', limits },
    )
    expect(over).toMatchObject({ ok: false })
    if (!over.ok) expect(over.error).toContain('单个附件超过')
  })

  it('data URL 预算按解码字节计算，不把 base64 膨胀算进 20 MB', () => {
    const dataUrl = pngDataUrl(100)
    expect(dataUrl.length).toBeGreaterThan(100)
    expect(validateMessageListImages(
      [{ dataUrl }],
      { mode: 'webhook', limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 } },
    ).ok).toBe(true)

    const overTotal = validateMessageListImages(
      [{ dataUrl: pngDataUrl(60) }, { dataUrl: pngDataUrl(60) }],
      { mode: 'webhook', limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 } },
    )
    expect(overTotal.ok).toBe(false)
    if (!overTotal.ok) expect(overTotal.error).toContain('总大小超过')
  })

  it('拒绝非法 base64、非图片 MIME 和 MIME 与文件头不一致', () => {
    for (const dataUrl of [
      'data:image/png;base64,AA=A',
      'data:image/svg+xml;base64,' + PNG_MAGIC.toString('base64'),
      'data:image/png;base64,'
        + Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x00]).toString('base64'),
    ]) {
      expect(validateMessageListImages([{ dataUrl }], { mode: 'webhook' }).ok).toBe(false)
    }
    expect(decodeMessageListImageDataUrl(
      'data:image/png;base64,' + 'A'.repeat(140),
    )).toBeUndefined()
  })

  it('严格区分本机 localId/stagedId 与 Webhook 入站来源', () => {
    const staged = { stagedId: 'a'.repeat(40), size: 100, mime: 'application/pdf', name: 'a.pdf' }
    expect(validateMessageListImages([staged], {
      mode: 'local',
      limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 },
    }).ok).toBe(true)
    expect(validateMessageListImages([{ localId: 7 }], { mode: 'local' }).ok).toBe(true)

    for (const value of [
      [{ stagedId: 'g'.repeat(40) }],
      [{ localId: 0 }],
      [{ localId: 1, url: 'https://cdn.example/a.png' }],
      [{ stagedId: 'a'.repeat(40), mime: 'not a mime' }],
      [{ url: 'file:///C:/secret.png' }],
      [{ url: 'https://user:secret@cdn.example/a.png' }],
      [{ url: 'https://cdn.example/' + 'a'.repeat(4_100) }],
    ]) {
      expect(validateMessageListImages(value, { mode: 'local' }).ok).toBe(false)
    }
  })

  it('入站 URL 拒绝 loopback、私网、链路本地和云元数据字面量', () => {
    for (const url of [
      'http://127.0.0.1/private.png',
      'http://2130706433/private.png',
      'http://0x7f000001/private.png',
      'http://127.1/private.png',
      'http://10.1.2.3/private.png',
      'http://172.16.0.2/private.png',
      'http://192.168.1.2/private.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/private.png',
      'http://[fd00:ec2::254]/latest/meta-data',
      'http://localhost/private.png',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(
        validateMessageListImages([{ url }], { mode: 'webhook' }),
        url,
      ).toMatchObject({ ok: false })
    }
    expect(validateMessageListImages(
      [{ url: 'https://cdn.example/a.png' }],
      { mode: 'webhook' },
    ).ok).toBe(true)
  })

  it('Webhook 的 stagedId、localId、非法项和 10 个附件都拒绝整条请求', () => {
    const root = mkdtempSync(join(tmpdir(), 'message-list-boundary-'))
    roots.push(root)
    const decrypted = join(root, 'decrypted')

    const requests = [
      { attachments: [{ stagedId: 'a'.repeat(40) }] },
      { attachments: [{ localId: 1, createTime: 1, sender: '' }] },
      { attachments: ['https://cdn.example/a.png', 'C:\\secret.png'] },
      { attachments: ['http://169.254.169.254/latest/meta-data'] },
      { images: [], attachments: [] },
      { attachments: Array.from({ length: 10 }, (_value, index) => (
        'https://cdn.example/' + String(index) + '.png'
      )) },
    ]
    for (const payload of requests) {
      const result = ingestMessageListWebhook(decrypted, {
        target: '边界对象',
        message: '不能部分落库',
        ...payload,
      })
      expect(result.ok).toBe(false)
      expect(result.record).toBeUndefined()
    }
    expect(listMessageListRecords(decrypted).total).toBe(0)
  })
})

describe('本机 staged 附件链路', () => {
  it('暂存成功后可读，读取时执行动态剩余预算与图片头一致性校验', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-list-stage-'))
    roots.push(root)
    const decrypted = join(root, 'decrypted')
    const source = join(root, 'fixture.png')
    writeFileSync(source, pngBytes(64))

    const staged = await stageMessageListAttachment(decrypted, { path: source })
    expect(staged.ok).toBe(true)
    expect(staged.attachment).toMatchObject({
      name: 'fixture.png',
      size: 64,
      mime: 'image/png',
    })
    const attachment = staged.attachment
    if (attachment === undefined) throw new Error('stage result missing attachment')

    await expect(readStagedAttachment(decrypted, attachment, 64)).resolves.toMatchObject({
      name: 'fixture.png',
      mime: 'image/png',
    })
    await expect(readStagedAttachment(decrypted, attachment, 10))
      .rejects.toThrow('当前剩余预算')
    await expect(readStagedAttachment(
      decrypted,
      { ...attachment, mime: 'image/jpeg' },
      64,
    )).rejects.toThrow('MIME 与文件名扩展名不一致')
  })

  it('显式通用 MIME 不能绕过 PNG 扩展名及文件头校验', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-list-stage-mime-'))
    roots.push(root)
    const decrypted = join(root, 'decrypted')
    const spool = join(decrypted, 'message-list-spool')
    mkdirSync(spool, { recursive: true })
    const pngId = '1'.repeat(40)
    const badPngId = '2'.repeat(40)
    writeFileSync(join(spool, pngId + '.bin'), pngBytes(32))
    writeFileSync(
      join(spool, badPngId + '.bin'),
      Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]),
    )

    await expect(readStagedAttachment(decrypted, {
      stagedId: pngId,
      name: 'fixture.png',
      size: 32,
      mime: 'application/octet-stream',
    }, 64)).rejects.toThrow('MIME 与文件名扩展名不一致')

    await expect(readStagedAttachment(decrypted, {
      stagedId: badPngId,
      name: 'fixture.png',
      size: 5,
      mime: 'image/png',
    }, 64)).rejects.toThrow('MIME 与文件头不一致')
  })

  it('图片扩展名与文件头不一致时失败，并清理已创建的半成品', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-list-stage-bad-'))
    roots.push(root)
    const decrypted = join(root, 'decrypted')
    const source = join(root, 'not-really.png')
    writeFileSync(source, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]))

    const staged = await stageMessageListAttachment(decrypted, { path: source })
    expect(staged.ok).toBe(false)
    if (!staged.ok) expect(staged.error).toContain('扩展名与文件头不一致')
    const spool = join(decrypted, 'message-list-spool')
    expect(readdirSync(spool).filter((name) => name.endsWith('.bin'))).toEqual([])
  })
})

describe('Feather 跨机资源上传边界', () => {
  it('远程附件 DNS 解析到私网时在 fetch 前阻断', async () => {
    let calls = 0
    const guardedFetch = createPublicHttpFetch({
      lookup: async () => [{ address: '10.0.0.8', family: 4 }],
      fetchImpl: async () => {
        calls += 1
        return new Response(pngBytes(8), { status: 200 })
      },
    })
    await expect(guardedFetch('https://cdn.example/private.png'))
      .rejects.toThrow('解析到本机、私网或保留地址')
    expect(calls).toBe(0)
  })

  it('每次重定向都会重新解析 DNS，公网跳到私网时阻断第二跳', async () => {
    const calls: string[] = []
    const guardedFetch = createPublicHttpFetch({
      lookup: async (hostname) => [{
        address: hostname === 'internal.example' ? '10.0.0.9' : '93.184.216.34',
        family: 4,
      }],
      fetchImpl: async (url) => {
        calls.push(url)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://internal.example/secret' },
        })
      },
    })
    await expect(guardedFetch('https://public.example/start.png'))
      .rejects.toThrow('解析到本机、私网或保留地址')
    expect(calls).toEqual(['https://public.example/start.png'])
  })

  it('公网 DNS 和公网重定向可正常跟随', async () => {
    const calls: string[] = []
    const guardedFetch = createPublicHttpFetch({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (url) => {
        calls.push(url)
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn2.example/final.png' },
          })
        }
        return new Response(pngBytes(8), { status: 200 })
      },
    })
    const response = await guardedFetch('https://public.example/start.png')
    expect(response.status).toBe(200)
    expect(calls).toEqual([
      'https://public.example/start.png',
      'https://cdn2.example/final.png',
    ])
  })

  it('资源 id 必须是严格 40 位小写十六进制', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const upload = (id: string) => uploadFeatherResource(
      WEBHOOK,
      { bytes, name: 'tiny.bin', mime: 'application/octet-stream' },
      {
        fetchImpl: async () => new Response(JSON.stringify({
          ok: true,
          id,
          name: 'tiny.bin',
          size: bytes.byteLength,
          sha256,
        }), { status: 201 }),
      },
    )
    for (const id of ['a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'A'.repeat(40)]) {
      await expect(upload(id)).rejects.toThrow('资源上传响应无效')
    }
    await expect(upload('a'.repeat(40))).resolves.toMatchObject({ id: 'a'.repeat(40) })
  })

  it('19.99 MB / 20 MB 通过，20 MB + 1 字节在出网前失败', async () => {
    const buffer = Buffer.alloc(MESSAGE_LIST_ATTACHMENT_MAX_BYTES + 1)
    const belowLimit = buffer.subarray(0, MESSAGE_LIST_ATTACHMENT_MAX_BYTES - 10 * 1024)
    const atLimit = buffer.subarray(0, MESSAGE_LIST_ATTACHMENT_MAX_BYTES)
    let postedBytes = 0
    const below = await uploadFeatherResource(
      WEBHOOK,
      { bytes: belowLimit, name: 'below.bin', mime: 'application/octet-stream' },
      {
        fetchImpl: async (_url, init) => {
          const bytes = requestBytes(init?.body)
          postedBytes = bytes.byteLength
          return new Response(JSON.stringify({
            ok: true,
            id: 'd'.repeat(40),
            name: 'below.bin',
            size: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }), { status: 201 })
        },
      },
    )
    expect(below.size).toBe(MESSAGE_LIST_ATTACHMENT_MAX_BYTES - 10 * 1024)
    expect(postedBytes).toBe(MESSAGE_LIST_ATTACHMENT_MAX_BYTES - 10 * 1024)

    const resource = await uploadFeatherResource(
      WEBHOOK,
      { bytes: atLimit, name: 'limit.bin', mime: 'application/octet-stream' },
      {
        fetchImpl: async (_url, init) => {
          const bytes = requestBytes(init?.body)
          postedBytes = bytes.byteLength
          return new Response(JSON.stringify({
            ok: true,
            id: 'a'.repeat(40),
            name: 'limit.bin',
            size: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }), { status: 201 })
        },
      },
    )
    expect(resource.size).toBe(MESSAGE_LIST_ATTACHMENT_MAX_BYTES)
    expect(postedBytes).toBe(MESSAGE_LIST_ATTACHMENT_MAX_BYTES)

    await expect(uploadFeatherResource(
      WEBHOOK,
      { bytes: buffer, name: 'over.bin', mime: 'application/octet-stream' },
    )).rejects.toThrow('单附件上限')
    expect(postedBytes).toBe(MESSAGE_LIST_ATTACHMENT_MAX_BYTES)
  })

  it('资源响应 size 或 SHA 与实际上传不一致时明确失败', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const responseFor = (size: number, sha: string) => async () => new Response(JSON.stringify({
      ok: true,
      id: 'b'.repeat(40),
      name: 'tiny.bin',
      size,
      sha256: sha,
    }), { status: 201 })

    await expect(uploadFeatherResource(
      WEBHOOK,
      { bytes, name: 'tiny.bin', mime: 'application/octet-stream' },
      { fetchImpl: responseFor(4, sha256) },
    )).rejects.toThrow('校验失败')
    await expect(uploadFeatherResource(
      WEBHOOK,
      { bytes, name: 'tiny.bin', mime: 'application/octet-stream' },
      { fetchImpl: responseFor(3, 'c'.repeat(64)) },
    )).rejects.toThrow('校验失败')

    await expect(uploadFeatherResource(
      WEBHOOK,
      { bytes, name: 'tiny.bin', mime: 'application/octet-stream' },
      {
        fetchImpl: async () => new Response(JSON.stringify({
          ok: true,
          id: 'b'.repeat(40),
          name: 'tiny.bin',
          size: 3,
          sha256,
        }), { status: 206 }),
      },
    )).rejects.toThrow('HTTP 206')
  })

  it('响应 Content-Length 与实际字节不一致时识别为截断', async () => {
    const body = JSON.stringify({
      ok: true,
      id: 'c'.repeat(40),
      name: 'tiny.bin',
      size: 3,
      sha256: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'),
    })
    await expect(uploadFeatherResource(
      WEBHOOK,
      { bytes: new Uint8Array([1, 2, 3]), name: 'tiny.bin', mime: 'application/octet-stream' },
      {
        fetchImpl: async () => new Response(body, {
          status: 201,
          headers: { 'content-length': String(Buffer.byteLength(body) + 5) },
        }),
      },
    )).rejects.toThrow('响应不完整')

    await expect(uploadMessageListImages(
      WEBHOOK,
      [{ url: 'https://cdn.example/a.png' }],
      '',
      {
        limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 },
        fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-length': '10' },
        }),
      },
    )).rejects.toThrow('响应不完整')
  })

  it('远程附件无 Content-Length 时仍按流式读取硬截断', async () => {
    await expect(uploadMessageListImages(
      WEBHOOK,
      [{ url: 'https://cdn.example/oversized.png' }],
      '',
      {
        limits: { maxBytes: 4, totalMaxBytes: 4, maxCount: 9 },
        fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          status: 200,
        }),
      },
    )).rejects.toThrow('超过大小上限')
  })

  it('远程下载拒绝 206 部分内容，不会把局部字节上传成完整附件', async () => {
    let calls = 0
    await expect(uploadMessageListImages(
      WEBHOOK,
      [{ url: 'https://cdn.example/photo.png' }],
      '',
      {
        limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 },
        fetchImpl: async () => {
          calls += 1
          return new Response(pngBytes(20), {
            status: 206,
            headers: { 'content-length': '20' },
          })
        },
      },
    )).rejects.toThrow('HTTP 206')
    expect(calls).toBe(1)
  })

  it('无名 URL 保留路径文件名，资源上传请求体长度严格匹配', async () => {
    const pdf = Buffer.from('%PDF-1.7\nsmall attachment\n', 'utf8')
    const sha256 = createHash('sha256').update(pdf).digest('hex')
    let postedName = ''
    let postedLength = ''
    let postedBytes = 0
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'GET') {
        expect(url).toBe('https://cdn.example/files/report.pdf')
        return new Response(pdf, { status: 200 })
      }
      expect(url).toBe(WEBHOOK + '/resources')
      const headers = init?.headers as Record<string, string>
      postedName = headers['x-feather-filename'] ?? ''
      postedLength = headers['content-length'] ?? ''
      const bytes = requestBytes(init?.body)
      postedBytes = bytes.byteLength
      return new Response(JSON.stringify({
        ok: true,
        id: 'e'.repeat(40),
        name: postedName,
        size: bytes.byteLength,
        sha256,
      }), { status: 201 })
    }

    await expect(uploadMessageListImages(
      WEBHOOK,
      [{ url: 'https://cdn.example/files/report.pdf' }],
      '',
      {
        fetchImpl,
        limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 },
      },
    )).resolves.toEqual(['e'.repeat(40)])
    expect(postedName).toBe('report.pdf')
    expect(postedBytes).toBe(pdf.byteLength)
    expect(postedLength).toBe(String(pdf.byteLength))
  })

  it('远程流中途失败时不接受已收到的部分字节', async () => {
    let calls = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pngBytes(8))
        controller.error(new Error('stream failed'))
      },
    })
    await expect(uploadMessageListImages(
      WEBHOOK,
      [{ url: 'https://cdn.example/photo.png' }],
      '',
      {
        limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 },
        fetchImpl: async () => {
          calls += 1
          return new Response(stream, { status: 200 })
        },
      },
    )).rejects.toThrow('stream failed')
    expect(calls).toBe(1)
  })

  it('后续附件物化失败时，前面已物化的附件也不会启动上传', async () => {
    let calls = 0
    await expect(uploadMessageListImages(
      WEBHOOK,
      [
        { dataUrl: pngDataUrl(16) },
        { dataUrl: 'data:image/png;base64,AA==' },
      ],
      '',
      {
        limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 },
        fetchImpl: async () => {
          calls += 1
          return new Response('{}', { status: 201 })
        },
      },
    )).rejects.toThrow('MIME、base64 或图片内容无效')
    expect(calls).toBe(0)
  })

  it('第二项资源上传失败时不向调用方返回部分 resource id', async () => {
    let uploadCalls = 0
    await expect(uploadMessageListImages(
      WEBHOOK,
      [{ dataUrl: pngDataUrl(16) }, { dataUrl: pngDataUrl(17) }],
      '',
      {
        limits: { maxBytes: 100, totalMaxBytes: 100, maxCount: 9 },
        fetchImpl: async (_url, init) => {
          uploadCalls += 1
          const bytes = requestBytes(init?.body)
          if (uploadCalls === 2) return new Response('{}', { status: 400 })
          return new Response(JSON.stringify({
            ok: true,
            id: 'f'.repeat(40),
            name: 'image.png',
            size: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }), { status: 201 })
        },
      },
    )).rejects.toThrow('HTTP 400')
    expect(uploadCalls).toBe(2)
  })

  it('多个 staged 附件的总预算在读取下一份文件前生效，且不上传任何资源', async () => {
    const root = mkdtempSync(join(tmpdir(), 'message-list-stage-budget-'))
    roots.push(root)
    const decrypted = join(root, 'decrypted')
    const firstPath = join(root, 'first.png')
    const secondPath = join(root, 'second.png')
    writeFileSync(firstPath, pngBytes(10))
    writeFileSync(secondPath, pngBytes(8))
    const first = await stageMessageListAttachment(decrypted, { path: firstPath })
    const second = await stageMessageListAttachment(decrypted, { path: secondPath })
    if (first.attachment === undefined || second.attachment === undefined) {
      throw new Error('stage result missing attachment')
    }
    let calls = 0
    await expect(uploadMessageListImages(
      WEBHOOK,
      [first.attachment, second.attachment],
      '',
      {
        decryptedDir: decrypted,
        limits: { maxBytes: 20, totalMaxBytes: 15, maxCount: 9 },
        fetchImpl: async () => {
          calls += 1
          return new Response('{}', { status: 201 })
        },
      },
    )).rejects.toThrow('当前剩余预算')
    expect(calls).toBe(0)
  })

  it('累计预算超限和数量 10 时不上传任何资源', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response('{}', { status: 201 })
    }
    await expect(uploadMessageListImages(
      WEBHOOK,
      [{ dataUrl: pngDataUrl(10) }, { dataUrl: pngDataUrl(11) }],
      '',
      {
        fetchImpl,
        limits: { maxBytes: 20, totalMaxBytes: 20, maxCount: 9 },
      },
    )).rejects.toThrow('总大小超过')
    await expect(uploadMessageListImages(
      WEBHOOK,
      Array.from({ length: 10 }, (_value, index) => ({
        dataUrl: pngDataUrl(8 + index),
      })),
      '',
      { fetchImpl },
    )).rejects.toThrow('最多发送 9 个附件')
    expect(calls).toBe(0)
  })
})

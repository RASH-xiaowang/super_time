/**
 * N13：**LLM 之外**的四条出网点也要有重试。
 *
 * M7 的有界重试只覆盖 LLM/embedding（验收范围如此），于是公众号封面、远端表情、朋友圈
 * 视频/封面、whisper 引擎/模型下载这四处仍然是「一次网络抖动 = 整件事失败」，
 * 用户只能自己再点一次。本用例打桩 **全局 fetch**（与 `cdn-switch.spec.ts` 同款手法），
 * 断言的是**行为**：真的重发了几次、不可重试的状态码一次就放弃、退避按 `Retry-After`。
 *
 * 另一组断言是 N24 的回归：开关判定必须仍在**发请求之前** —— 关掉开关时哪怕 fetch
 * 永远失败（真出网会重试两轮），调用次数也必须是 0。
 *
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CDN_DISABLED_MESSAGE } from '../src/query/cdn-policy.ts'
import { resolveArticleCoverDataUrl } from '../src/query/article-cover.ts'
import { fetchEmoticonRemote } from '../src/query/media-image.ts'
import { fetchSnsVideoDataUrl } from '../src/query/sns-video.ts'
import { WHISPER_DOWNLOAD_FILES, whisperDownloadModel } from '../src/query/whisper.ts'
import { at } from '../../tests/helpers/strict-index.ts'

const scratch: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x01, 0x02, 0x03])
/** 明文 MP4（`ftyp` 从第 4 字节起），代表「服务端已解密好的字节」。 */
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(24, 0x11)])
const COVER_HTML = Buffer.from('<html><meta property="og:image" content="https://mmbiz.qpic.cn/n13-cover.png"></html>', 'utf8')

const okBytes = (payload: Buffer, status = 200) => ({
  ok: true,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  text: async () => payload.toString('utf8'),
  // 流式下载（whisper）读的是 body 的 reader；一次性给完整份再正常结束。
  body: new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(payload)); c.close() },
  }),
})

const statusOnly = (status: number, retryAfter: string | null = null) => ({
  ok: false,
  status,
  headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) },
  arrayBuffer: async () => new ArrayBuffer(0),
  text: async () => 'err ' + status,
})

/** 按「第几次请求」返回不同结果的桩；记录每次请求的 URL。 */
function scriptedFetch(steps: Array<{ status: number } | { bytes: Buffer; status?: number }>): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    calls.push(String(input))
    const step = at(steps, Math.min(calls.length - 1, steps.length - 1), 'steps')
    if ('status' in step && !('bytes' in step)) return statusOnly(step.status)
    const s = step as { bytes: Buffer; status?: number }
    return okBytes(s.bytes, s.status ?? 200)
  })
  return calls
}

describe('N13：公众号封面（article-cover）', () => {
  it('文章页 503 会自动重发一次，第 3 次请求（图片）成功后返回 data URL', async () => {
    const url = 'https://mp.weixin.qq.com/s/n13-' + String(Date.now()) + Math.random()
    // 第一次 = 文章页 503（可重试）；第二次 = 文章页正文；第三次 = 封面图字节
    const calls = scriptedFetch([{ status: 503 }, { bytes: COVER_HTML }, { bytes: PNG }])
    const r = await resolveArticleCoverDataUrl(url, tmp('n13-cover-'))
    expect(calls.length, '503 之后必须真的重发文章页').toBe(3)
    expect(r.url?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('401 一次就放弃（重试只会浪费时间，还可能触发风控）', async () => {
    const url = 'https://mp.weixin.qq.com/s/n13-401-' + String(Date.now()) + Math.random()
    const calls = scriptedFetch([{ status: 401 }, { bytes: COVER_HTML }])
    const r = await resolveArticleCoverDataUrl(url, tmp('n13-cover401-'))
    expect(calls.length).toBe(1)
    expect(r.url).toBeUndefined()
    expect(r.error).toBe('文章或封面获取失败')
  })
})

describe('N13：远端表情取图（media-image）', () => {
  it('503 后重试到成功：拿回 data URL 并落进 decoded 缓存', async () => {
    const dir = tmp('n13-emo-')
    const calls = scriptedFetch([{ status: 503 }, { bytes: PNG }])
    const r = await fetchEmoticonRemote('https://cdn.example/n13-e.gif', dir, 'a'.repeat(32))
    expect(calls.length).toBe(2)
    expect(r.url?.startsWith('data:image/png;base64,')).toBe(true)
    expect(existsSync(join(dir, 'a'.repeat(32) + '.png'))).toBe(true)
  })

  it('404 一次就放弃（表情链过期属于永久失败）', async () => {
    const calls = scriptedFetch([{ status: 404 }, { bytes: PNG }])
    const r = await fetchEmoticonRemote('https://cdn.example/n13-miss.gif', tmp('n13-emo404-'), 'b'.repeat(32))
    expect(calls.length).toBe(1)
    expect(r.error).toContain('404')
  })
})

describe('N13：朋友圈视频/封面（sns-video）', () => {
  it('503 后重试到成功', async () => {
    const calls = scriptedFetch([{ status: 503 }, { bytes: MP4 }])
    const r = await fetchSnsVideoDataUrl('https://cdn.example/n13-v.mp4')
    expect(calls.length).toBe(2)
    expect(r.url?.startsWith('data:video/mp4;base64,')).toBe(true)
  })

  it('429 按 Retry-After 等待：到点之前不重发，到点之后才重发', async () => {
    // 用假时钟把「等多久」变成确定性断言：若实现忽略 Retry-After 而用退避（500ms），
    // 在 500ms 处就会看到第二次请求 —— 这条会在那一格变红。
    vi.useFakeTimers()
    const calls: number[] = []
    vi.stubGlobal('fetch', async () => {
      calls.push(Date.now())
      return calls.length === 1 ? statusOnly(429, '1') : okBytes(MP4)
    })
    const pending = fetchSnsVideoDataUrl('https://cdn.example/n13-429.mp4')
    await vi.advanceTimersByTimeAsync(999)
    expect(calls.length, 'Retry-After: 1 秒未到就重发了').toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    const r = await pending
    expect(calls.length).toBe(2)
    expect(calls[1]! - calls[0]!).toBe(1000)
    expect(r.url?.startsWith('data:video/mp4;base64,')).toBe(true)
  })
})

describe('N13：whisper 下载（whisper）', () => {
  it('503 后重试到成功：模型文件真的落盘', async () => {
    const modelsDir = tmp('n13-whisper-')
    const fileName = WHISPER_DOWNLOAD_FILES.find(([id]) => id === 'tiny')![1]
    const payload = Buffer.from('ggml-model-bytes')
    const calls = scriptedFetch([{ status: 503 }, { bytes: payload }])
    const r = await whisperDownloadModel('tiny', modelsDir, () => {})
    expect(calls.length).toBe(2)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(modelsDir, fileName)).toString()).toBe(payload.toString())
    // 半成品不能留在正式名上（.part 是唯一的中间态）
    expect(existsSync(join(modelsDir, fileName + '.part'))).toBe(false)
  })
})

describe('N24 回归：开关判定仍在发请求之前（重试包装不能绕过它）', () => {
  const neverFetch = (): void => {
    vi.stubGlobal('fetch', () => {
      throw new Error('不该出网：开关已关闭')
    })
  }

  it('公众号封面：cdnEnabled=false → 0 次请求', async () => {
    neverFetch()
    const r = await resolveArticleCoverDataUrl('https://mp.weixin.qq.com/s/n24-before-' + String(Date.now()), tmp('n24-b-'), { cdnEnabled: false })
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })

  it('远端表情：cdnEnabled=false → 0 次请求', async () => {
    neverFetch()
    const r = await fetchEmoticonRemote('https://cdn.example/n24-b.gif', tmp('n24-b2-'), 'c'.repeat(32), { cdnEnabled: false })
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })

  it('朋友圈视频：cdnEnabled=false → 0 次请求', async () => {
    neverFetch()
    const r = await fetchSnsVideoDataUrl('https://cdn.example/n24-b.mp4', undefined, { cdnEnabled: false })
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })
})

describe('N13：whisper 模型下载的断点续传', () => {
  it('已有 .part 时按它的长度发 Range，206 追加写后拼出完整文件', async () => {
    const modelsDir = tmp('n13-resume-')
    const fileName = WHISPER_DOWNLOAD_FILES.find(([id]) => id === 'tiny')![1]
    const full = Buffer.from('0123456789abcdefghij')
    const head = full.subarray(0, 10)
    const tail = full.subarray(10)
    writeFileSync(join(modelsDir, fileName + '.part'), head)

    const seenRanges: Array<string | undefined> = []
    vi.stubGlobal('fetch', async (_input: unknown, init: { headers?: Record<string, string> }) => {
      seenRanges.push(init?.headers?.range)
      return {
        ok: true,
        status: 206,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(tail.length) : null) },
        body: new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(tail)); c.close() },
        }),
      }
    })

    const r = await whisperDownloadModel('tiny', modelsDir, () => {})
    expect(seenRanges[0], '续传起点没带上').toBe('bytes=10-')
    expect(r.ok).toBe(true)
    expect(readFileSync(join(modelsDir, fileName)).toString()).toBe(full.toString())
    expect(existsSync(join(modelsDir, fileName + '.part'))).toBe(false)
  })

  it('中途断流：不删 .part（否则下一次没法续传），且半成品绝不落成正式模型', async () => {
    const modelsDir = tmp('n13-drop-')
    const fileName = WHISPER_DOWNLOAD_FILES.find(([id]) => id === 'tiny')![1]
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      let step = 0
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '4' : null) },
        body: new ReadableStream({
          pull(c) {
            if (step === 0) { step = 1; c.enqueue(new Uint8Array([1, 2])); return }
            c.error(new Error('connection reset'))
          },
        }),
      }
    })
    const r = await whisperDownloadModel('tiny', modelsDir, () => {})
    expect(r.ok).toBe(false)
    expect(calls, '每个镜像各试一次（连接层重试由 fetchWithRetry 负责，这里是 body 断流）').toBeGreaterThan(1)
    expect(existsSync(join(modelsDir, fileName)), '截断的字节被当成了正式模型').toBe(false)
    expect(existsSync(join(modelsDir, fileName + '.part'))).toBe(true)
  })

  it('流提前结束（短读）不算成功：长度对不上就报错', async () => {
    const modelsDir = tmp('n13-short-')
    const fileName = WHISPER_DOWNLOAD_FILES.find(([id]) => id === 'tiny')![1]
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      // 声明 100 字节，实际只给 2 字节就正常 end —— 旧实现会把这份截断的文件 rename 成模型
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '100' : null) },
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close() } }),
    }))
    const r = await whisperDownloadModel('tiny', modelsDir, () => {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('下载不完整')
    expect(existsSync(join(modelsDir, fileName))).toBe(false)
  })
})

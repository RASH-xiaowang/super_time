import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * W3-5.5：whisper 引擎固定 tag + 下载可取消。
 *
 * 这一条本来只有半截能测：「固定 tag」改的是 URL 形状（可以在模块加载前后各取一次常量来钉），
 * 「可取消」改的是下载中途的行为（用注入的 fetch 真跑出来）。两条都钉。
 */

/** 用假 fetch 把一个模型文件吐成若干块；`onChunk` 在每块之后被调用，可以在那里 abort。 */
function stubFetch(chunks: Uint8Array[], onChunk?: (i: number) => void): () => void {
  const original = globalThis.fetch
  let i = 0
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      controller.enqueue(chunks[i])
      onChunk?.(i)
      i += 1
    },
  }))) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('W3-5.5 引擎固定 tag', () => {
  const envKey = 'DSH_WECHAT_WHISPER_ENGINE_TAG'
  let saved: string | undefined

  beforeEach(() => { saved = process.env[envKey]; delete process.env[envKey] })
  afterEach(() => {
    if (saved === undefined) delete process.env[envKey]
    else process.env[envKey] = saved
    vi.resetModules()
  })

  it('显式给出的 tag 被原样采用（这是「固定版本」的实际落点）', async () => {
    process.env[envKey] = 'v1.7.4'
    vi.resetModules()
    const mod = await import('../src/query/whisper.ts')
    expect(mod.WHISPER_ENGINE_TAG).toBe('v1.7.4')
  })

  it('env 为空时回落 latest，保护已经配好镜像的环境（与改动前一致）', async () => {
    process.env[envKey] = '   '
    vi.resetModules()
    const mod = await import('../src/query/whisper.ts')
    expect(mod.WHISPER_ENGINE_TAG).toBe('latest')
  })

  it('引擎 URL 由 tag 拼出；裸 releases/latest 已不存在', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/query/whisper.ts', import.meta.url), 'utf8')
    expect(src).toContain('${WHISPER_ENGINE_TAG}')
    expect(src).not.toContain('releases/latest/download')
  })
})

describe('W3-5.5 下载可取消', () => {
  it('已 abort 的信号会在发出请求前就停下（一次网络往返都不浪费）', async () => {
    const mod = await import('../src/query/whisper.ts')
    const dir = mkdtempSync(join(tmpdir(), 'w55-cancel-'))
    const ctl = new AbortController()
    ctl.abort()
    const restore = stubFetch([new Uint8Array([1, 2, 3])])
    try {
      await expect(mod.streamUrlToFile('https://example.invalid/m.bin', join(dir, 'm.bin'), 1000, () => {}, ctl.signal))
        .rejects.toMatchObject({ code: 'WHISPER_DOWNLOAD_CANCELED' })
    } finally {
      restore()
    }
  })

  it('中途取消：留下 .part、不生成正式模型、错误可识别', async () => {
    const mod = await import('../src/query/whisper.ts')
    const dir = mkdtempSync(join(tmpdir(), 'w55-part-'))
    const ctl = new AbortController()
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7])]
    // 第 1 块之后取消：进度回调已经跑过一次，.part 里有东西。
    const restore = stubFetch(chunks, (i) => { if (i === 1) ctl.abort() })
    try {
      // 这一层**抛**而不是返回 ok:false：取消不是「下载失败」这个语义的一种，
      // 是调用方（Remote）该决定怎么措辞的事。真正的用户可见文案在 remotes/voicellm.ts。
      await expect(mod.whisperDownloadModel('tiny', dir, () => {}, ctl.signal))
        .rejects.toMatchObject({ code: 'WHISPER_DOWNLOAD_CANCELED' })
      expect(existsSync(join(dir, 'ggml-tiny.bin'))).toBe(false)
      expect(existsSync(join(dir, 'ggml-tiny.bin.part'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('取消不会被当成「这个镜像不行」而接着轮换镜像', async () => {
    const mod = await import('../src/query/whisper.ts')
    const dir = mkdtempSync(join(tmpdir(), 'w55-mirror-'))
    const ctl = new AbortController()
    let attempts = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      attempts += 1
      ctl.abort()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() },
      }))
    }) as unknown as typeof fetch
    try {
      await mod.whisperDownloadModel('tiny', dir, () => {}, ctl.signal).catch(() => { /* 取消走的是抛出 */ })
      expect(attempts).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  it('不传 signal 时行为不变（老调用点照旧跑完并落正式文件）', async () => {
    const mod = await import('../src/query/whisper.ts')
    const dir = mkdtempSync(join(tmpdir(), 'w55-plain-'))
    const restore = stubFetch([new Uint8Array([1, 2, 3]), new Uint8Array([4])])
    try {
      const result = await mod.whisperDownloadModel('tiny', dir, () => {})
      expect(result.ok).toBe(true)
      expect(result.file).toBe('ggml-tiny.bin')
      expect(statSync(join(dir, 'ggml-tiny.bin')).size).toBe(4)
    } finally {
      restore()
    }
  })
})

describe('W3-5.5 取消槽隔离', () => {
  it('下载用独立控制槽，不与搜索/索引/问答互相打断', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/gateway-core.ts', import.meta.url), 'utf8')
    const decls = src.match(/readonly _\w+Jobs = new Map<string, AbortController>\(\)/g) ?? []
    expect(decls.length).toBeGreaterThanOrEqual(4)
    expect(decls).toContain('readonly _whisperDownloadJobs = new Map<string, AbortController>()')
  })

  it('取消槽在 finally 里释放（不会泄漏到下一次下载）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/remotes/voicellm.ts', import.meta.url), 'utf8')
    expect(src).toContain('ctl?.done()')
  })
})
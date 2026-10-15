/**
 * 内联分析的**异步转写**守卫（2026-10-13，用户报「消息同步慢、会话列表更慢」）。
 *
 * 根因：`analyzeVisibleMessages` 对每条语音消息做转写，而旧链路用 `spawnSync` 等 whisper
 * —— 2–4 秒里 worker 被**完全独占**，所有查询排队（用户日志实测 `getSessions` 被顶成
 * 2202ms、`analyzeVisibleMessages` 连续 1.8–4.4s）。修法：分析路径换**异步 spawn**
 * （`transcribeOneVoiceAsync` / `whisperOneAsync`），whisper 在子进程跑时事件循环照常服务。
 *
 * 两条判据：
 *  · 接线锚点（全环境）：分析循环必须 `await` 转写器、remote 必须接异步实现、
 *    whisper 必须走异步 spawn —— 退回同步形状的任何一步都红；
 *  · 事件循环自由度的真机证据（`SUPERTIME_WHISPER_E2E=1` 时跑，用仓库自带的
 *    whisper-cli.exe + ggml-tiny.bin 真转写一段生成的静音 WAV）：转写期间 30ms 计时器
 *    必须持续得到回调 —— 同步版这一步会把计时器冻住（本机可判，CI 不跑）。
 * @vitest-environment node
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { whisperOneAsync } from '../src/query/voice-transcribe.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8')

/** 生成一段 0.8s 的 16kHz 16bit 单声道静音 WAV（44 字节头 + PCM）。 */
function makeSilenceWav(path: string): void {
  const sampleRate = 16000
  const seconds = 0.8
  const dataLen = sampleRate * seconds * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataLen, 40)
  writeFileSync(path, buf)
}

describe('异步转写的接线（源码锚点，全环境）', () => {
  it('哨兵：三份都真读到了东西（读空 ⇒ 下面的断言全恒真）', () => {
    expect(read('../src/laya/analysis.ts').length).toBeGreaterThan(500)
    expect(read('../src/remotes/laya.ts').length).toBeGreaterThan(500)
    expect(read('../src/query/voice-transcribe.ts').length).toBeGreaterThan(500)
  })

  it('分析循环必须 await 转写器（退回同步调用 ⇒ whisper 期间 worker 又被独占）', () => {
    expect(read('../src/laya/analysis.ts'), '分析循环没有 await 转写器').toContain('await input.transcribe(target.localId, svrId)')
  })

  it('remote 必须接异步转写实现（同步版 spawnSync 会把 2–4s 的独占带回来）', () => {
    expect(read('../src/remotes/laya.ts'), 'remote 没有接 transcribeOneVoiceAsync').toContain('transcribeOneVoiceAsync')
    expect(read('../src/remotes/laya.ts'), 'remote 必须 await 异步转写').toContain('await transcribeOneVoiceAsync(')
  })

  it('whisper 必须走异步 spawn（child.on close 是事件循环自由的形状）', () => {
    const vt = read('../src/query/voice-transcribe.ts')
    expect(vt, '没有异步 whisper 入口').toContain('async function whisperOneAsync')
    expect(vt, '异步版必须监听子进程 close').toContain("child.on('close'")
    expect(vt, '异步转写入口缺失').toContain('async function transcribeVoiceTextAsync')
  })
})

describe('事件循环自由度：真 whisper 转写期间计时器照常走（本机可判）', () => {
  const bin = join(HERE, '..', '..', '..', '..', 'wechat', 'whisper', 'bin', 'whisper-cli.exe')
  const model = join(HERE, '..', '..', '..', '..', 'wechat', 'whisper', 'ggml-tiny.bin')

  it.skipIf(process.env.SUPERTIME_WHISPER_E2E !== '1')('转写期间 30ms 计时器持续回调（同步版会把它冻住 2–4 秒）', async () => {
    const wav = join(HERE, 'silence-e2e.wav')
    makeSilenceWav(wav)
    const outBase = join(HERE, 'silence-e2e-out')
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 30)
    try {
      const r = await whisperOneAsync(bin, model, wav, outBase)
      // 静音段的转写结果可能是空/乱码 —— 断言的是**过程**（计时器活着），不是结果。
      expect(typeof r).toBe('string')
      expect(ticks, '转写期间事件循环被独占（计时器一次都没回调）').toBeGreaterThanOrEqual(2)
    } finally {
      clearInterval(timer)
      for (const f of [wav, outBase + '.txt']) {
        try { unlinkSync(f) } catch { /* 没生成就算了 */ }
      }
    }
  }, 300_000)
})

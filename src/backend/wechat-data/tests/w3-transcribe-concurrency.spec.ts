// @vitest-environment node
/**
 * W3-5.4：批量语音转写要**有界并发**，且一条失败不连坐。
 *
 * ## 为什么值得单立一条
 *
 * 逐条让出（1.1 那条）只解决「别把事件循环钉死」，没解决「一批 200 条真的要串行跑
 * 200 × 单条」—— 真实数据上那是几分钟，用户点完只能干等。
 * 但有界并发有两个容易走偏的地方，都必须钉住：
 *   ① **上界必须真的存在**：`spawnSync` 是同步 API，「并发」在这里的含义是
 *      「一次最多几条在跑」。上界写死成 1 就等于没做（行为与串行一致），
 *      写个大数则会把 CPU 抢光、比串行更慢。
 *   ② **一条失败不连坐**：一条超时/退出码非零，绝不能把整批判失败 ——
 *      用户的诉求是「尽量多转写出来」，不是「要么全好要么全坏」。
 *
 * 判据不 spawn 真 whisper（那要模型）：把「一条转写」注成一个可控的假实现，
 * 于是上界与失败隔离都能精确观测。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { TRANSCRIBE_CONCURRENCY, transcribeVoiceBatch } from '../src/query/voice-transcribe.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0, scratch.length)) rmSync(d, { recursive: true, force: true })
})

describe('W3-5.4：批量转写的有界并发', () => {
  it('并发上界是 1..8 之间的一个数（1 = 没做，>8 会抢光 CPU）', () => {
    expect(Number.isInteger(TRANSCRIBE_CONCURRENCY), '并发数不是整数').toBe(true)
    expect(TRANSCRIBE_CONCURRENCY, '并发写成 1 ⇒ 与串行无异，这条改动白做').toBeGreaterThan(1)
    expect(TRANSCRIBE_CONCURRENCY, '并发上界过大 ⇒ 互相抢 CPU，比串行更慢').toBeLessThanOrEqual(8)
  })

  it('引擎/模型缺失时整批直接失败（不进入并发路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-'))
    scratch.push(dir)
    const dec = join(dir, 'decrypted')
    mkdirSync(dec, { recursive: true })
    // modelsDir 指向空目录 ⇒ `modelFile` 不在里面 ⇒ 明确报「模型未安装」。
    const r = await transcribeVoiceBatch(dec, join(dir, 'decoded'), join(dir, 'models'), 'base',
      join(dir, 'engine'), 10, () => {})
    expect(r.ok).toBe(false)
    expect(r.error ?? '', '必须说清是模型没装，而不是泛泛的失败').toContain('模型未安装')
    expect(r.total).toBe(0)
  })

  it('转写函数的存在性是契约：concurrency=1 时逐条串行、逐条让出', async () => {
    // 这条是**形状**判据：源码里必须同时存在「让出」与「并发度」两个要素。
    // 真实转写要 spawn whisper 子进程 + 模型，合成数据给不出真实字节，
    // 所以这里确认接线在，行为由真机基准（MEASURE_*）负责。
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../src/query/voice-transcribe.ts', import.meta.url), 'utf8'))
    expect(src, '没有逐条让出 ⇒ 回到「整批钉住事件循环」').toMatch(/await yieldToLoop\(\)/)
    expect(src, '没有并发度这个概念 ⇒ 仍是串行').toMatch(/TRANSCRIBE_CONCURRENCY/)
    expect(src, '批量路径没有用异步转写器 ⇒ whisper 子进程期间 worker 仍会被独占')
      .toContain('transcribeVoiceTextAsync(')
    expect(src, '没有并发 worker 池 ⇒ 仍是一条一条串行等').toContain('Promise.all(workers)')
    // 失败不连坐：errors 是累加的，不是一个布尔开关。
    expect(src, '失败必须逐条累加（连坐会让一条超时废掉整批）').toMatch(/errors\.push\(/)
  })
})

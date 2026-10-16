// @vitest-environment node
/**
 * W2-8.6：AI 年报叙述 —— **分段** LLM + 进度 + 取消。
 *
 * ## 这条在守什么
 *
 * 「一次性把整年消息塞给 LLM」走不通：真实账号一年几十万条文本，远超上下文窗口，
 * 而失败的形态是 provider 静默截断或报错，界面上只表现为「AI 年报是空的」。
 * 所以必须**按段**取材、逐段调用。分段同时给了进度一个诚实的分母（段数）。
 *
 * ## 四条不许退化的纪律
 *
 * ① 每段一次 LLM 调用，**不合并**（合并就回到「塞不下」）；段数在 12 个月之外
 *    只由「某个月超预算」产生，且受 `MAX_SEGMENTS` 硬上界约束，截断要如实说。
 * ② 进度分母是段数（`phase: 'segment'` 的 `done/total`），扫描阶段总量未知
 *    （`total: 0`）—— 编一个百分比就是骗界面。
 * ③ 取消必须真的贯通到**流里面**（不只是段边界）：一段 600 token 的生成有好几秒，
 *    用户在这期间点「停止」要立刻生效；且取消 ⇒ **一个字节都不写**。
 * ④ 某一段失败 ⇒ 已算完的段留着、失败如实说；**不抛错吞掉整份**，也不假装全部成功。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnnualNarrRemotes } from '../src/remotes/annual-narr.ts'
import { MAX_SEGMENTS, SEGMENT_CHAR_BUDGET, collectAnnualSegments } from '../src/query/annual-segments.ts'
import type { Context } from '@deepseek-ai/cordis'

let root = ''
let decrypted = ''
const USER = 'wxid_alpha000'

/** 造一个有文本消息的解密根。 */
function makeRoot(months: number[], perMonth: number): void {
  root = mkdtempSync(join(tmpdir(), 'wx-86-'))
  decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  const s = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  s.exec('CREATE TABLE SessionTable (username TEXT, type INTEGER, content TEXT)')
  s.prepare('INSERT INTO SessionTable (username, type, content) VALUES (?, ?, ?)').run(USER, 1, '')
  s.close()
  const table = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  const m = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  m.exec('CREATE TABLE "' + table + '" (local_id INTEGER, local_type INTEGER, create_time INTEGER, message_content BLOB)')
  m.exec('BEGIN')
  const ins = m.prepare('INSERT INTO "' + table + '" (local_id, local_type, create_time, message_content) VALUES (?, ?, ?, ?)')
  let id = 0
  for (const month of months) {
    for (let i = 0; i < perMonth; i += 1) {
      const ts = Math.floor(new Date(2024, month - 1, 5, 12, 0, 0).getTime() / 1000) + i
      ins.run(id += 1, 1, ts, Buffer.from('<msg><content>第 ' + String(id) + ' 条聊天内容</content></msg>', 'utf8'))
    }
  }
  m.exec('COMMIT')
  m.close()
}

interface Ev { phase: string; done: number; total: number }

/**
 * 按 `StreamChunk` 的真形状发一段文本（`block-start` + `text-delta`）。
 * 之前写成 `{ type: 'text', text }` 那种简化形状，BlockAssembler 一个块都攒不出来 ——
 * 全空输出，而用例报的是「ok 为 false」，看起来像功能没实现。
 * @param text - 要发的文本。
 */
async function* emitText(text: string): AsyncGenerator<unknown> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
}

/** 造一个可操控的 remotes 实例。 */
function makeRemotes(opts: {
  onEvent?: (e: Ev) => void
  llm?: (prompt: string) => AsyncGenerator<unknown>
  onStreamChunk?: () => void
}) {
  const events: Ev[] = []
  const ctrl = { onProgress: undefined as undefined | ((p: Ev) => void), signal: undefined as AbortSignal | undefined }
  let aborted = false
  const rc = {
    normalizeJobId: (jobId?: unknown) => String(jobId ?? '').trim(),
    dirs: () => ({ decrypted, decoded: join(root, 'decoded') }),
    op: () => {},
    streamControl: () => {
      const ac = new AbortController()
      ctrl.signal = ac.signal
      return {
        onProgress: (p: Ev) => { events.push(p); ctrl.onProgress?.(p); opts.onEvent?.(p) },
        signal: ac.signal,
      }
    },
    finishStreamJob: () => { aborted = true; void aborted },
    ctx: () => ({
      llm: {
        stream: async function* (o: { messages: Array<{ content: Array<{ text: string }> }> }) {
          const text = o.messages[0]?.content?.[0]?.text ?? ''
          if (opts.llm) { yield* opts.llm(text); return }
          const month = /\d\d 月/.exec(text)?.[0] ?? '段'
          yield* emitText('小结 ' + month)
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
    }) as unknown as Context,
    privacyGate: (_f: string, _s: unknown, texts: string[]) => texts,
  }
  return { remotes: createAnnualNarrRemotes(rc), events, ctrl }
}

beforeEach(() => { /* 每个用例自己 makeRoot */ })
afterEach(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* 下一条用例自己会报 */ } })

describe('W2-8.6 取材按月分段，且段数有硬上界', () => {
  it('三个月 ⇒ 三段，段名带上月份', async () => {
    makeRoot([1, 2, 3], 20)
    const r = await collectAnnualSegments(decrypted, 2024)
    expect(r.segments.length).toBe(3)
    expect(r.segments.map(s => s.label)).toEqual(['01 月', '02 月', '03 月'])
    expect(r.truncated).toBe(false)
    expect(r.segments.every(s => s.chars <= SEGMENT_CHAR_BUDGET)).toBe(true)
  })

  it('一个月超预算 ⇒ 切成编号子段（不是硬塞进一次调用）', async () => {
    makeRoot([5], 4000)   // 4000 行 × ~20 字 ⇒ 远大于单段预算
    const r = await collectAnnualSegments(decrypted, 2024)
    expect(r.segments.length, '超预算却不切段 ⇒ 一次 LLM 调用放不下').toBeGreaterThan(1)
    expect(r.segments.every(s => s.chars <= SEGMENT_CHAR_BUDGET)).toBe(true)
    expect(r.segments[1]?.label, '子段要带序号，否则界面看不出是同一个月').toContain('第 2 段')
  })

  it('段数受 MAX_SEGMENTS 约束，且截断要如实说', async () => {
    makeRoot([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 4000)
    const r = await collectAnnualSegments(decrypted, 2024)
    expect(r.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS)
    expect(r.truncated, '被 MAX_SEGMENTS 截断了却没说 ⇒ 界面会让人以为覆盖了整年').toBe(true)
  })

  it('本地年份之外的消息一段都不取', async () => {
    makeRoot([1], 5)
    const r = await collectAnnualSegments(decrypted, 2025)
    expect(r.segments).toEqual([])
  })
})

describe('W2-8.6 分段 LLM、进度与取消', () => {
  it('每段一次 LLM 调用；进度分母是段数', async () => {
    makeRoot([1, 2, 3], 30)
    let calls = 0
    const { remotes, events } = makeRemotes({ llm: async function* () { calls += 1; yield* emitText('小结') } })
    const r = await remotes.generateAnnualNarrative({ year: 2024, jobId: 'j-1' })
    expect(r.ok).toBe(true)
    expect(r.segments.length).toBe(3)
    expect(calls, '不是每段一次调用 ⇒ 合并了就又回到「塞不下」').toBe(3)
    const seg = events.filter(e => e.phase === 'segment')
    // 每段两条（进入段 done=i、段完成 done=i+1）—— 与导出的 write 0/1 → 1/1 同一形状。
    expect(seg.length).toBe(6)
    expect(seg.every(e => e.total === 3)).toBe(true)
    expect(seg[0]).toMatchObject({ phase: 'segment', done: 0, total: 3 })
    // 最后一条必须是 3/3，否则界面收不了尾
    expect(seg[seg.length - 1]).toMatchObject({ phase: 'segment', done: 3, total: 3 })
    // 扫描阶段总量未知（不许编一个百分比骗界面）
    expect(events.some(e => e.phase === 'collect' && e.total === 0)).toBe(true)
  })

  it('第一段生成途中取消 ⇒ AbortError，且整条流被当场掐断（不是等它自己跑完）', async () => {
    makeRoot([1, 2, 3], 30)
    let aborted = 0
    let streamFinished = false
    const ac = new AbortController()
    const rc = {
      normalizeJobId: (jobId?: unknown) => String(jobId ?? '').trim(),
      dirs: () => ({ decrypted, decoded: join(root, 'decoded') }),
      op: () => {},
      // ⚠ 进度回调**不** abort：取消必须从**流内部**发起。否则段边界那一查
      //    （循环开头那次 `if (ctrl.signal?.aborted)` + 生成后的 `throwIfCancelled`）
      //   照样能拦住，这条用例就证明不了「流里也能停」。
      streamControl: () => ({ onProgress: () => {}, signal: ac.signal }),
      finishStreamJob: () => { aborted += 1 },
      ctx: () => ({
        llm: {
          stream: async function* () {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: '第一段' }
            // 生成途中点「停止」—— abort 发生在流内部。
            ac.abort()
            yield { type: 'text-delta', index: 0, text: '用户在這段生成期间點了停止' }
            streamFinished = true
          },
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
      }) as unknown as Context,
      privacyGate: (_f: string, _s: unknown, texts: string[]) => texts,
    }
    const err = await createAnnualNarrRemotes(rc).generateAnnualNarrative({ year: 2024, jobId: 'j-2' }).catch((e: unknown) => e)
    expect((err as Error).name, '取消必须是 AbortError（界面据此不弹错误框）').toBe('AbortError')
    expect(streamFinished, '整条流被跑完了 ⇒ 取消只发生在段边界，「流里也能停」是假的').toBe(false)
    expect(aborted, '取消路径也要清在飞槽，否则下一次同名 jobId 会撞上「上一个还在跑」').toBeGreaterThan(0)
  })

  it('某一段 LLM 失败 ⇒ 已算完的段留着，失败如实说，不假装全部成功', async () => {
    makeRoot([1, 2, 3], 30)
    let n = 0
    const { remotes } = makeRemotes({
      llm: async function* () {
        n += 1
        if (n === 2) throw new Error('provider 500')
        yield* emitText('第 ' + String(n) + ' 段小结')
      },
    })
    const r = await remotes.generateAnnualNarrative({ year: 2024, jobId: 'j-3' })
    expect(r.ok, '有一段失败了却报告成功').toBe(false)
    expect(r.segments.length).toBe(3)
    expect(r.segments[1]?.ok).toBe(false)
    expect(r.segments[1]?.text, '失败原因要带上段名，否则用户不知道是哪个月坏了').toContain('生成失败')
    expect(r.text).toContain('第 1 段小结')
    expect(r.text, '失败那段的内容不该混进全文').not.toContain('第 2 段小结')
  })

  it('未配置默认模型 ⇒ 每段如实标记未生成，不崩', async () => {
    makeRoot([1, 2], 30)
    const events: Ev[] = []
    const rc = {
      normalizeJobId: (jobId?: unknown) => String(jobId ?? '').trim(),
      dirs: () => ({ decrypted, decoded: join(root, 'decoded') }),
      op: () => {},
      streamControl: () => ({ onProgress: (p: Ev) => { events.push(p) }, signal: new AbortController().signal }),
      finishStreamJob: () => {},
      ctx: () => ({ llm: { stream: async function* () { yield* emitText('不该被调到') } }, agentDefaultModel: { currentSelection: () => ({ provider: '', model: '' }) } }) as unknown as Context,
      privacyGate: (_f: string, _s: unknown, texts: string[]) => texts,
    }
    const r = await createAnnualNarrRemotes(rc).generateAnnualNarrative({ year: 2024, jobId: 'j-4' })
    expect(r.ok).toBe(false)
    expect(r.segments.every(s => !s.ok)).toBe(true)
    expect(r.segments.every(s => s.text.includes('未配置默认模型'))).toBe(true)
  })

  it('该年没有文本消息 ⇒ 空结果，不调 LLM', async () => {
    makeRoot([], 0)
    let calls = 0
    const { remotes } = makeRemotes({ llm: async function* () { calls += 1; yield* emitText('x') } })
    const r = await remotes.generateAnnualNarrative({ year: 2024, jobId: 'j-5' })
    expect(r.segments).toEqual([])
    expect(calls).toBe(0)
    expect(r.ok).toBe(true)
  })
})

describe('W2-8.6 取消贯通到流里（这一条是判据的核心）', () => {
  it('流途中取消 ⇒ AbortError，且 finishStreamJob 被调用', async () => {
    makeRoot([1, 2, 3], 30)
    let calls = 0
    let aborted = 0
    let streamAbortSeen = false
    const rc = {
      normalizeJobId: (jobId?: unknown) => String(jobId ?? '').trim(),
      dirs: () => ({ decrypted, decoded: join(root, 'decoded') }),
      op: () => {},
      streamControl: () => {
        const ac = new AbortController()
        // 第一个 chunk 一吐出来就 abort —— 模拟「用户在生成期间点了停止」
        void calls
        return {
          onProgress: () => {
            if (calls === 1 && !streamAbortSeen) { streamAbortSeen = true; ac.abort() }
          },
          signal: ac.signal,
        }
      },
      finishStreamJob: () => { aborted += 1 },
      ctx: () => ({
        llm: {
          stream: async function* () {
            calls += 1
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: '第一段' }
            yield { type: 'text-delta', index: 0, text: '（这段很长，用户在這段生成期间點了停止）' }
          },
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
      }) as unknown as Context,
      privacyGate: (_f: string, _s: unknown, texts: string[]) => texts,
    }
    const err = await createAnnualNarrRemotes(rc).generateAnnualNarrative({ year: 2024, jobId: 'j-6' }).catch((e: unknown) => e)
    expect((err as Error).name, '取消必须是 AbortError（界面据此不弹错误框）').toBe('AbortError')
    expect(streamAbortSeen, '没在流途中触发取消 ⇒ 这条用例没有测到「流里也能停」').toBe(true)
    expect(aborted, '取消路径也要清在飞槽，否则下一次同名 jobId 会撞上「上一个还在跑」').toBeGreaterThan(0)
  })
})
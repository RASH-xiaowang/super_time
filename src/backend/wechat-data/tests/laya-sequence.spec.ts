/**
 * `laya/build-sequence.ts` 与 `laya/runtime.ts` 后处理的对齐守卫。
 *
 * ## 为什么是「逐 token」而不是「看起来对」
 * 这套输入构造是 Python `laya/common.py` 的手工复刻。差一个 token，模型给出的概率完全不同
 * ——PoC 期间已经踩过一次：输入 state 传 str 与传 dict 的序列化不同（`json.dumps` 带空格），
 * 表现成「模型输出偏差 3e-6 但答案差 0.46」的假警报（docs/LAYA-TRIAGE-FEASIBILITY.md §2.3）。
 *
 * ## 怎么在没有模型/没有 Python 的 CI 上守住
 * fixture（`tools/laya/dump-fixtures.py` 生成）里带了一张 **tokenTable**：
 * Python 侧 tokenizer 对每段文本的编码结果。测试拿它当 tokenizer 用——
 * **查不到就抛**，于是任何与 Python 不同的调用文本都会立刻失败，
 * 比「序列长度对得上」强得多。后处理同理：fixture 存了 torch 的原始 logits 与
 * `laya.predict()` 的最终答案，JS 必须从同样的 logits 还原出同样的答案。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildSequence, collateItems, pythonJsonDumps, renderOptions, serializeState, toInternal,
  type LayaItem, type LayaTokenizer,
} from '../src/laya/build-sequence.ts'
import { defaultChatQuestions, DEFAULT_QUESTION_ORDER } from '../src/laya/presets.ts'
import { postprocessAnswers } from '../src/laya/runtime.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'laya-sequence.json'), 'utf8')) as {
  cfg: { maxLen: number; headMaxLen: number; temperature: number[]; temperatureByOptions: Record<string, number> }
  specialIds: { cls: number; sep: number; mask: number; pad: number }
  questions: Record<string, { type: string; instructions: string; criteria?: unknown }>
  tokenTable: Record<string, number[]>
  cases: Array<{
    name: string
    state: Record<string, unknown>
    items: Array<{ qid: string; ids: number[]; markers: number[]; qtype: number }>
    batch: { inputIds: number[][]; attentionMask: number[][]; markerPos: number[][]; markerMask: boolean[][]; qtype: number[] }
    logits: number[][]
    answers: Record<string, Record<string, unknown>>
  }>
}

/**
 * 只认 fixture 里记过的编码结果的 tokenizer。
 * 未记录的文本一律抛错——这正是我们要的判别力：调用文本与 Python 不一致时立刻红。
 */
const fakeTokenizer: LayaTokenizer = {
  clsId: FIX.specialIds.cls,
  sepId: FIX.specialIds.sep,
  maskId: FIX.specialIds.mask,
  padId: FIX.specialIds.pad,
  encode: (text: string): number[] => {
    const ids = FIX.tokenTable[text]
    if (ids === undefined) {
      throw new Error(`fixture 未记录这段文本的编码，说明它与 Python 侧不一致：${JSON.stringify(text.slice(0, 120))}`)
    }
    return ids
  },
}

describe('laya 输入构造与 Python 的对齐（fixture 驱动）', () => {
  it('fixture 的命题组与 presets.ts 一致（防两边漂移）', () => {
    const fromPresets = defaultChatQuestions()
    const shape = (q: { type: string; instructions: string; criteria?: unknown }) => {
      if (q.type === 'choice' || q.type === 'score') {
        return { type: q.type, instructions: q.instructions, criteria: q.criteria }
      }
      return { type: q.type, instructions: q.instructions }
    }
    const a = Object.fromEntries(Object.entries(fromPresets).map(([k, v]) => [k, shape(v as never)]))
    const b = Object.fromEntries(Object.entries(FIX.questions).map(([k, v]) => [k, shape(v)]))
    // 键序也要一致：选项顺序会变 token 序列，所以逐个键比对而不是只比集合
    expect(Object.keys(a)).toEqual(Object.keys(b))
    expect(a).toEqual(b)
  })

  it('DEFAULT_QUESTION_ORDER 覆盖默认命题组且顺序稳定', () => {
    expect([...DEFAULT_QUESTION_ORDER]).toEqual(Object.keys(defaultChatQuestions()))
  })

  it('renderOptions 与 Python 的选项文本逐字一致（choice / score / noul）', () => {
    for (const [qid, q] of Object.entries(FIX.questions)) {
      const internal = toInternal(q as never)
      const opts = renderOptions(internal)
      if (q.type === 'choice') {
        expect(opts).toEqual(Object.entries(q.criteria as Record<string, string>).map(([k, v]) => `${k}: ${v}`))
      } else if (q.type === 'score') {
        expect(opts).toEqual((q.criteria as string[]).map((c, i) => `level ${i}: ${c}`))
      } else {
        // noul 的选项文本由 laya 内置（英文默认值）——刻意不动，改了概率就不可比
        expect(opts).toEqual([
          'false: no, the statement does not hold',
          'true: yes, the statement holds',
        ])
      }
      expect(opts.length).toBeGreaterThan(0)
      expect(qid.length).toBeGreaterThan(0)
    }
  })

  it('serializeState 复刻 Python json.dumps 的空格形态', () => {
    expect(pythonJsonDumps({ a: 1, b: [1, 2], c: '中文' })).toBe('{"a": 1, "b": [1, 2], "c": "中文"}')
    expect(pythonJsonDumps('纯字符串')).toBe('"纯字符串"')
    expect(serializeState('直接传字符串')).toBe('直接传字符串')
    // 每个 case 的 state 序列化结果必须正是 fixture 里记录过的键
    for (const c of FIX.cases) {
      const text = serializeState(c.state as never)
      expect(FIX.tokenTable[text], `state 文本未被 fixture 记录：${text.slice(0, 60)}`).toBeDefined()
    }
  })

  it('buildSequence 逐 token 与 Python 相同（3 个 case × 6 命题）', () => {
    let checked = 0
    for (const c of FIX.cases) {
      for (const item of c.items) {
        const q = FIX.questions[item.qid]
        const seq = buildSequence(fakeTokenizer, c.state as never, toInternal(q as never),
          FIX.cfg.maxLen, FIX.cfg.headMaxLen)
        expect(seq.ids, `${c.name} / ${item.qid} 的 token 序列不同`).toEqual(item.ids)
        expect(seq.markers, `${c.name} / ${item.qid} 的选项 marker 位置不同`).toEqual(item.markers)
        checked += 1
      }
    }
    expect(checked).toBe(FIX.cases.length * 6)
  })

  it('collateItems 与 Python 的 padding / marker 掩码一致', () => {
    for (const c of FIX.cases) {
      const items: LayaItem[] = c.items.map((it) => ({ qid: it.qid, ids: it.ids, markers: it.markers, qtype: it.qtype }))
      const batch = collateItems(items, FIX.specialIds.pad)
      expect(batch.inputIds).toEqual(c.batch.inputIds)
      expect(batch.attentionMask).toEqual(c.batch.attentionMask)
      expect(batch.markerPos).toEqual(c.batch.markerPos)
      expect(batch.markerMask).toEqual(c.batch.markerMask)
      expect(batch.qtype).toEqual(c.batch.qtype)
    }
  })

  it('postprocessAnswers 从同样的 logits 还原出 laya.predict 的答案', () => {
    let noulChecked = 0
    let choiceChecked = 0
    let scoreChecked = 0
    for (const c of FIX.cases) {
      const items: LayaItem[] = c.items.map((it) => ({ qid: it.qid, ids: it.ids, markers: it.markers, qtype: it.qtype }))
      const answers = postprocessAnswers({
        logits: c.logits.flat(),
        items,
        questions: FIX.questions as never,
        qids: c.items.map((it) => it.qid),
        optCols: c.batch.markerPos[0]?.length ?? 0,
        temperatures: { base: FIX.cfg.temperature, byOptions: FIX.cfg.temperatureByOptions },
      })
      expect(answers).toHaveLength(c.items.length)
      for (const a of answers) {
        const py = c.answers[a.qid] as {
          probabilities?: Record<string, number>; score?: number; noul?: number
        }
        if (a.kind === 'choice') {
          const pv = py.probabilities ?? {}
          const pyTop = Object.entries(pv).sort((x, y) => y[1] - x[1])[0]?.[0] ?? ''
          expect(a.top, `${c.name} / ${a.qid} 的 Top-1 不同`).toBe(pyTop)
          for (const opt of a.options) {
            expect(Math.abs(opt.probability - (pv[opt.key] ?? 0)),
              `${c.name} / ${a.qid} / ${opt.key} 概率差过大`).toBeLessThan(5e-4)
          }
          choiceChecked += 1
        } else if (a.kind === 'score') {
          expect(Math.abs((a.score ?? 0) - (py.score ?? 0)), `${c.name} / ${a.qid} 的分数不同`).toBeLessThan(5e-4)
          scoreChecked += 1
        } else {
          expect(Math.abs((a.yes ?? 0) - (py.noul ?? 0))).toBeLessThan(5e-4)
          noulChecked += 1
        }
      }
    }
    // 三类题型都被覆盖到（否则断言可能整段空转）
    expect(choiceChecked).toBeGreaterThan(0)
    expect(scoreChecked).toBeGreaterThan(0)
    expect(noulChecked).toBeGreaterThan(0)
  })
})

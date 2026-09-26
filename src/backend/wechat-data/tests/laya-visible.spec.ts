/**
 * 逐条分析的守卫：结果缓存的读写语义 + 会话级门禁。
 *
 * 缓存这条链路最容易「静默失效」——写进去了读不出来、换了模型还命中旧结果、
 * 清缓存清错会话，界面上看不出来（只是分析结果永远是旧的）。这里把语义钉住。
 *
 * 真机链路（真实 Msg_ 库 → 取上下文 → 推理 → 落缓存）不在单测里跑（要 1.2 GB 模型），
 * 由一次性真机 e2e 承担（那脚本没入库，所以那一半不可复跑 —— 写在这里是为了别把它算进本文件的覆盖面）；
 * 本文件只守**不需要模型**就能判定的部分。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAnalysisCache, layaCachePath, layaModelKey, readAnalysisCache, writeAnalysisCache,
} from '../src/laya/store.ts'
import { analyzeVisibleMessages } from '../src/laya/analysis.ts'
import type { LayaAnswer } from '../src/laya/runtime.ts'

const dirs: string[] = []

/** 造一个「数据根 + decrypted」的临时布局，返回 decrypted 路径。 */
function makeDecrypted(): string {
  const root = mkdtempSync(join(tmpdir(), 'laya-store-'))
  dirs.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return decrypted
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const answers: LayaAnswer[] = [
  {
    qid: 'is_upset', kind: 'noul', question: '对方不高兴吗',
    options: [{ key: 'false', label: '没有不高兴', probability: 0.97 }, { key: 'true', label: '不高兴', probability: 0.03 }],
    top: 'false', topProbability: 0.97, yes: 0.03, confidence: 0.8,
  },
  {
    qid: 'tension', kind: 'score', question: '紧张程度', options: [], top: '3',
    topProbability: 0.2, score: 3.1, scale: 10, confidence: 0.3,
  },
]

describe('laya 逐条分析的缓存', () => {
  it('库不存在时读缓存返回空 Map（不抛、不建库）', () => {
    const decrypted = makeDecrypted()
    const got = readAnalysisCache(decrypted, 'wxid_a', 'k1', [1, 2, 3])
    expect(got.size).toBe(0)
    expect(existsSync(layaCachePath(decrypted))).toBe(false)
  })

  it('写入后能原样读出（含来源文本与语音标记）', () => {
    const decrypted = makeDecrypted()
    writeAnalysisCache(decrypted, 'wxid_a', 'k1', [
      { localId: 101, sourceText: '那你说。', fromVoice: false, answers },
      { localId: 102, sourceText: '转写出来的语音文本', fromVoice: true, answers },
    ])
    const got = readAnalysisCache(decrypted, 'wxid_a', 'k1', [101, 102, 999])
    expect([...got.keys()]).toEqual([101, 102])
    expect(got.get(101)?.sourceText).toBe('那你说。')
    expect(got.get(101)?.fromVoice).toBe(false)
    expect(got.get(102)?.fromVoice).toBe(true)
    // 答案对象要保真（概率、分值都在）
    expect(got.get(101)?.answers.find((a) => a.qid === 'tension')?.score).toBe(3.1)
  })

  it('模型指纹变了就不命中（换模型自动失效，不用手工清库）', () => {
    const decrypted = makeDecrypted()
    writeAnalysisCache(decrypted, 'wxid_a', 'k1', [{ localId: 101, sourceText: 'x', fromVoice: false, answers }])
    expect(readAnalysisCache(decrypted, 'wxid_a', 'k2', [101]).size).toBe(0)
    expect(readAnalysisCache(decrypted, 'wxid_a', 'k1', [101]).size).toBe(1)
  })

  it('会话之间互不串味', () => {
    const decrypted = makeDecrypted()
    writeAnalysisCache(decrypted, 'wxid_a', 'k1', [{ localId: 1, sourceText: 'a', fromVoice: false, answers }])
    writeAnalysisCache(decrypted, 'wxid_b', 'k1', [{ localId: 1, sourceText: 'b', fromVoice: false, answers }])
    expect(readAnalysisCache(decrypted, 'wxid_a', 'k1', [1]).get(1)?.sourceText).toBe('a')
    expect(readAnalysisCache(decrypted, 'wxid_b', 'k1', [1]).get(1)?.sourceText).toBe('b')
    // 按会话清：只清 a
    const removed = clearAnalysisCache(decrypted, 'wxid_a')
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(readAnalysisCache(decrypted, 'wxid_a', 'k1', [1]).size).toBe(0)
    expect(readAnalysisCache(decrypted, 'wxid_b', 'k1', [1]).size).toBe(1)
  })

  it('modelKey 取不到文件时退化为 unknown，不抛', () => {
    const decrypted = makeDecrypted()
    expect(layaModelKey(join(decrypted, 'nope.onnx'))).toBe('unknown')
    // 真文件：大小 + mtime 变化都会换 key
    const f = join(decrypted, 'm.onnx')
    writeFileSync(f, 'abc')
    const k1 = layaModelKey(f)
    writeFileSync(f, 'abcdef')
    const k2 = layaModelKey(f)
    expect(k1).not.toBe(k2)
    expect(k1.startsWith('3-')).toBe(true)
    const st = statSync(f)
    utimesSync(f, st.atime, new Date(st.mtimeMs + 60_000))
    expect(layaModelKey(f)).not.toBe(k2)
  })
})

describe('analyzeVisibleMessages 的会话级门禁', () => {
  it('模型未就绪时整体返回 ok=false + 一句话原因（明细交给 UI 从 status 渲染）', async () => {
    const decrypted = makeDecrypted()
    const r = await analyzeVisibleMessages({
      decryptedDir: decrypted,
      decodedDir: decrypted,
      talker: 'wxid_a',
      targets: [{ localId: 1, sortSeq: 1000 }],
      modelDir: join(decrypted, 'no-model'),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('本地决策模型未就绪')
    expect(r.items).toEqual([])
  })

  it('缺会话 / 空目标各自有明确原因', async () => {
    const decrypted = makeDecrypted()
    const base = { decryptedDir: decrypted, decodedDir: decrypted, modelDir: join(decrypted, 'no-model') }
    const noTalker = await analyzeVisibleMessages({ ...base, talker: '  ', targets: [{ localId: 1, sortSeq: 1 }] })
    expect(noTalker.error).toBe('缺少会话')
    const noTarget = await analyzeVisibleMessages({ ...base, talker: 'wxid_a', targets: [] })
    expect(noTarget.error).toBe('没有要分析的消息')
  })
})

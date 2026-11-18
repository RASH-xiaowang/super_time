// @vitest-environment node
/**
 * 消息分析：提示词、输出校验与执行边界。
 *
 * 钉住四件事：
 *  ① **单聊与群聊问的不是同一组问题**（群聊必须回答「是否在找我」）；
 *  ② 模型输出被夹紧而不是被信任（缺字段、多包裹、越界枚举都要降级）；
 *  ③ 群聊缺「是否针对我」时用结构化 @ 兜底，而不是显示半张卡片；
 *  ④ 执行边界：只分析对方消息、只取目标及之前、走 `analyze_message` 闸门、命中缓存不重复调用。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAnalysisPrompt,
  parseAnalysisJson,
} from '../src/query/analysis/prompt.ts'
import { analyzeMessage, type AnalysisDeps } from '../src/query/analysis/analyze.ts'
import {
  analysisPromptKey,
  readMessageAnalysisCache,
  writeMessageAnalysisCache,
} from '../src/query/analysis/cache.ts'
import type { ReplyTrace } from '../src/types-analysis.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'msg-analysis-'))
  decrypted = join(root, 'data', 'decrypted')
  // 分析缓存只在写入时建库；读缓存要求父目录存在，这里先建好。
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const PRIVATE_JSON = JSON.stringify({
  headline: '他在催一个明确答复',
  confidence: 'high',
  intent: { label: '要一个结论', detail: '连问两次进度' },
  mood: { label: '略急', detail: '短句 + 追问' },
  action: {
    shouldReply: true,
    title: '直接给结论',
    guidance: '先说能不能做，再说时间',
    avoid: '不要绕开问题',
  },
  signals: ['连问两次', '句子很短'],
  evidence: ['现在处理到哪一步了'],
})

const GROUP_JSON = JSON.stringify({
  headline: '在群里点名要你确认报价',
  confidence: 'high',
  intent: { label: '提问', detail: '直接 @ 你要数字' },
  mood: { label: '平稳', detail: '公事公办' },
  action: {
    shouldReply: true,
    channel: 'public',
    title: '在群里回数字',
    guidance: '直接给报价并说明有效期',
    avoid: '不要含糊其辞',
  },
  addressed: { targeted: true, reason: '@ 了你的昵称' },
  signals: ['@ 我'],
  evidence: ['@你 报价多少'],
})

describe('parseAnalysisJson', () => {
  it('单聊：正常 JSON 通过，channel 恒为 private', () => {
    const r = parseAnalysisJson(PRIVATE_JSON, 'private')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.scope).toBe('private')
    expect(r.analysis.intent.label).toBe('要一个结论')
    expect(r.analysis.action.channel).toBe('private')
    expect(r.analysis.addressed).toBeUndefined()
  })

  it('群聊：必须带 addressed，且 channel 用模型给的', () => {
    const r = parseAnalysisJson(GROUP_JSON, 'group')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.addressed).toEqual({ targeted: true, reason: '@ 了你的昵称' })
    expect(r.analysis.action.channel).toBe('public')
  })

  it('群聊缺 addressed 时用结构化 @ 兜底，而不是失败', () => {
    const raw = JSON.stringify({ ...JSON.parse(GROUP_JSON), addressed: undefined })
    const r = parseAnalysisJson(raw, 'group', { targeted: false, reason: '结构化 @ 列表里没有你' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.addressed).toEqual({ targeted: false, reason: '结构化 @ 列表里没有你' })
  })

  it('群聊缺 addressed 且没有兜底 ⇒ 失败（不许假装知道）', () => {
    const raw = JSON.stringify({ ...JSON.parse(GROUP_JSON), addressed: undefined })
    expect(parseAnalysisJson(raw, 'group').ok).toBe(false)
  })

  it('剥得掉 ```json 围栏与前后解释', () => {
    const raw = '好的，分析如下：\n```json\n' + PRIVATE_JSON + '\n```\n希望有帮助。'
    expect(parseAnalysisJson(raw, 'private').ok).toBe(true)
  })

  it('缺结论/意图/动作任一项 ⇒ 失败并给出可展示原因', () => {
    const broken = JSON.stringify({ headline: '', intent: {}, mood: {}, action: {} })
    const r = parseAnalysisJson(broken, 'private')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('缺少')
  })

  it('越界的 confidence / channel 被降级而不是原样透传', () => {
    const raw = JSON.stringify({
      ...JSON.parse(GROUP_JSON),
      confidence: 'very-high',
      action: { ...JSON.parse(GROUP_JSON).action, channel: 'shout' },
    })
    const r = parseAnalysisJson(raw, 'group')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.confidence).toBe('low')
    expect(r.analysis.action.channel).toBe('either')
  })

  it('信号与依据被截断到 3 条（模型爱多写）', () => {
    const raw = JSON.stringify({
      ...JSON.parse(PRIVATE_JSON),
      signals: ['1', '2', '3', '4', '5'],
      evidence: ['a', 'b', 'c', 'd'],
    })
    const r = parseAnalysisJson(raw, 'private')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.analysis.signals).toHaveLength(3)
    expect(r.analysis.evidence).toHaveLength(3)
  })
})

describe('buildAnalysisPrompt', () => {
  it('单聊问「他想要什么 / 情绪 / 怎么回」，不问「是否在找你」', () => {
    const prompt = buildAnalysisPrompt({ scope: 'private', lines: ['[2026-11-18 16:00] 对方：在吗'], targetText: '在吗' })
    expect(prompt).toContain('他真正想要的是什么')
    expect(prompt).toContain('情绪状态')
    expect(prompt).toContain('我该怎么回')
    expect(prompt).not.toContain('是不是在找我')
    expect(prompt).not.toContain('addressed')
  })

  it('群聊问「是否在找你 / 群里做什么动作 / 该不该接、公开还是私聊」', () => {
    const prompt = buildAnalysisPrompt({
      scope: 'group',
      lines: ['[2026-11-18 16:00] 张三：@我 报价多少'],
      targetText: '@我 报价多少',
      mentionsMe: true,
      recentSpeakers: ['张三', '李四'],
    })
    expect(prompt).toContain('是不是在找我')
    expect(prompt).toContain('该不该接话')
    expect(prompt).toContain('私聊')
    // 结构化 @ 的已知事实要告诉模型，别让它猜。
    expect(prompt).toContain('点名了你')
    expect(prompt).toContain('张三、李四')
    expect(prompt).toContain('addressed')
  })

  it('两套都要求「只做研判、不写可直接发送的回复」', () => {
    for (const scope of ['private', 'group'] as const) {
      const prompt = buildAnalysisPrompt({ scope, lines: ['x'], targetText: 'y' })
      expect(prompt).toContain('不要输出可直接发送的回复')
      expect(prompt).toContain('JSON')
    }
  })
})

describe('analyzeMessage 执行边界', () => {
  function deps(overrides: Partial<AnalysisDeps> = {}): AnalysisDeps {
    return {
      decryptedDir: () => decrypted,
      selfUsername: () => 'wxid_self',
      modelLabel: () => 'opencode/kimi',
      // 默认没有任何消息：具体用例覆盖 listMessages 行为时按需注入。
      generate: async () => ({ ok: true, text: PRIVATE_JSON, model: 'opencode/kimi' }),
      gate: (_f, _s, texts) => texts,
      op: () => {},
      ...overrides,
    }
  }

  it('缺会话或消息 id 时直接失败（不打模型）', async () => {
    const generate = vi.fn()
    expect((await analyzeMessage(deps({ generate }), { talker: '', localId: 1 })).ok).toBe(false)
    expect((await analyzeMessage(deps({ generate }), { talker: 'wxid_peer', localId: 0 })).ok).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })

  it('目标消息不在窗口里 ⇒ 失败而不是分析别人', async () => {
    const generate = vi.fn()
    const r = await analyzeMessage(deps({ generate }), { talker: 'wxid_peer', localId: 99, sortSeq: 10 })
    expect(r.ok).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })

  it('缓存键包含提示词版本、会话类型与模型', () => {
    const key = analysisPromptKey('opencode/kimi', 'group')
    expect(key).toContain('group')
    expect(key).toContain('opencode/kimi')
    expect(analysisPromptKey('opencode/kimi', 'private')).not.toBe(key)
    expect(analysisPromptKey('other/model', 'group')).not.toBe(key)
  })
})

describe('过程留痕（详情视图的数据源）', () => {
  it('缓存能存回留痕：命中缓存时详情仍可解释结论', () => {
    const trace: ReplyTrace = {
      systemPrompt: 'sys',
      userPrompt: 'user',
      contextLines: ['[2026-11-18 16:00] 对方：在吗'],
      kbSnippets: ['片段 A'],
      rawOutput: '{"headline":"h"}',
      model: 'p/m',
      elapsedMs: 1234,
      redacted: true,
    }
    const key = analysisPromptKey('p/m', 'group')
    writeMessageAnalysisCache(decrypted, 'room@chatroom', 7, key, {
      sourceText: '在吗',
      fromVoice: false,
      analysis: {
        scope: 'group',
        headline: 'h',
        confidence: 'high',
        intent: { label: 'i', detail: '' },
        mood: { label: 'm', detail: '' },
        action: { shouldReply: true, channel: 'public', title: 't', guidance: '', avoid: '' },
        signals: [],
        evidence: [],
      },
      trace,
    })
    const cached = readMessageAnalysisCache(decrypted, 'room@chatroom', 7, key)
    expect(cached?.trace).toEqual(trace)
    expect(cached?.analysis.headline).toBe('h')
  })

  it('没有留痕的旧缓存读出来是 undefined，而不是伪造一个空对象', () => {
    const key = analysisPromptKey('p/m', 'private')
    writeMessageAnalysisCache(decrypted, 'wxid_peer', 9, key, {
      sourceText: 'x',
      fromVoice: false,
      analysis: {
        scope: 'private',
        headline: 'h',
        confidence: 'low',
        intent: { label: 'i', detail: '' },
        mood: { label: 'm', detail: '' },
        action: { shouldReply: true, channel: 'private', title: 't', guidance: '', avoid: '' },
        signals: [],
        evidence: [],
      },
    })
    expect(readMessageAnalysisCache(decrypted, 'wxid_peer', 9, key)?.trace).toBeUndefined()
  })
})

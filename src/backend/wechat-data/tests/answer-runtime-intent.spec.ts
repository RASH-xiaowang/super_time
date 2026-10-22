/**
 * Answer runtime v2：意图识别与线程状态纯逻辑测试。
 *
 * 这些用例不碰数据库、不联网，只钉住主运行时依赖的契约：
 * 中文相对时间、会话 / 联系人继承、消息引用、媒体追问、显式覆盖、
 * 空历史、历史截断，以及旧意图 API 的兼容映射。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  classifyAnswerIntent,
  classifyAnswerIntentWithLlm,
  inferMediaTypesFromText,
  mapLegacyIntent,
  resolveAnswerTimeRange,
  toLegacyIntent,
  type AnswerIntentDecision,
} from '../src/query/answer-runtime/intent.ts'
import {
  advanceThreadState,
  applyThreadState,
  buildThreadState,
  THREAD_STATE_MAX_CHARS,
  THREAD_STATE_MAX_MESSAGES,
  type ThreadState,
} from '../src/query/answer-runtime/thread-state.ts'
import { at } from '../../tests/helpers/strict-index.ts'

const NOW = new Date('2026-10-21T10:00:00')

const KB_HINTS = new Set(['search_kb', 'search_semantic'])
const MESSAGE_HINTS = new Set(['search_messages', 'get_message_context', 'get_session_messages'])
const STRUCTURED_HINTS = new Set(['search_contacts', 'aggregate_messages', 'search_files', 'search_favorites'])

function expectKnownHints(decision: AnswerIntentDecision): void {
  expect(decision.toolHints.length).toBeGreaterThan(0)
  for (const hint of decision.toolHints) {
    expect(KB_HINTS.has(hint) || MESSAGE_HINTS.has(hint) || STRUCTURED_HINTS.has(hint)).toBe(true)
  }
}

function stateWith(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    turns: 1,
    history: [
      { role: 'user', content: '上周三我和李四聊了什么？' },
      { role: 'assistant', content: '你们聊了合同和交付时间。' },
    ],
    activeContact: '李四',
    lastEntity: '李四',
    lastIntent: 'timeline',
    lastTimeRange: { from: '2026-10-14', to: '2026-10-14' },
    lastTimeGranularity: 'day',
    ...overrides,
  }
}

describe('classifyAnswerIntent 中文相对时间', () => {
  it('解析昨天 / 上周三 / 上个月 / 最近 N 天', () => {
    expect(resolveAnswerTimeRange('昨天聊了什么', { now: NOW })).toMatchObject({
      from: '2026-10-20',
      to: '2026-10-20',
      granularity: 'day',
    })
    expect(resolveAnswerTimeRange('上周三聊了什么', { now: NOW })).toMatchObject({
      from: '2026-10-14',
      to: '2026-10-14',
    })
    expect(resolveAnswerTimeRange('上个月的项目', { now: NOW })).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      granularity: 'month',
    })
    expect(resolveAnswerTimeRange('最近7天聊了啥', { now: NOW })).toMatchObject({
      from: '2026-10-15',
      to: '2026-10-21',
    })
  })

  it('「那上周呢」相对上一轮时间窗递进，而不是按今天重算', () => {
    const decision = classifyAnswerIntent('那上周呢？', {
      now: NOW,
      history: [{ role: 'user', content: '昨天聊了什么？' }],
      context: {
        lastTimeRange: { from: '2026-10-20', to: '2026-10-20' },
        lastIntent: 'timeline',
      },
    })
    expect(decision.scopeHints?.from).toBe('2026-10-13')
    expect(decision.scopeHints?.to).toBe('2026-10-13')
    expect(decision.scopeHints?.timeRange?.source).toBe('progression')
    expect(decision.kind).toBe('timeline')
  })

  it('「最近一次」是排序而非时间窗', () => {
    const decision = classifyAnswerIntent('最近一次转账给谁？', { now: NOW })
    expect(decision.legacy).toBe('recency_lookup')
    expect(decision.scopeHints?.from).toBeUndefined()
    expect(decision.scopeHints?.to).toBeUndefined()
  })

  it('完整起止范围优先于单日期，不会被截成结束日', () => {
    expect(resolveAnswerTimeRange(
      '请总结2026-09-16至2026-10-16的聊天',
      { now: NOW },
    )).toMatchObject({
      from: '2026-09-16',
      to: '2026-10-16',
      granularity: 'range',
      source: 'explicit',
    })
    expect(resolveAnswerTimeRange(
      '2026年9月16日到2026年10月16日聊了什么',
      { now: NOW },
    )).toMatchObject({
      from: '2026-09-16',
      to: '2026-10-16',
    })
  })

  it('「最近一个月（截至某日）」以截止日为锚点，不按当前时间漂移', () => {
    expect(resolveAnswerTimeRange(
      '最近一个月（截至2026-10-16）聊了什么',
      { now: NOW },
    )).toMatchObject({
      from: '2026-09-16',
      to: '2026-10-16',
      granularity: 'range',
      source: 'explicit',
    })
  })
})

describe('classifyAnswerIntent 会话 / 联系人 / 消息引用', () => {
  it('「这个群第二条」识别当前会话与序号', () => {
    const history = [
      { role: 'user' as const, content: '这个群里昨天提到过报价吗？' },
      { role: 'assistant' as const, content: '提到过两次。' },
    ]
    const decision = classifyAnswerIntent('这个群第二条消息说了什么', {
      currentSession: 'group@chatroom',
      history,
      now: NOW,
    })
    expect(decision.kind).toBe('lookup')
    expect(decision.scopeHints?.session).toBe('group@chatroom')
    expect(decision.scopeHints?.ordinal).toBe(2)
    expect(decision.scopeHints?.messageRef?.kind).toBe('ordinal')
    expect(decision.toolHints[0]).toBe('get_message_context')
    expect(decision.needsClarification).toBeUndefined()
    expectKnownHints(decision)
  })

  it('「他」有历史联系人时继承，没有时要求澄清', () => {
    const inherited = classifyAnswerIntent('他最近发过什么文件？', {
      knownEntities: ['李四'],
      history: [{ role: 'user', content: '和李四聊过合同' }],
      now: NOW,
    })
    expect(inherited.kind).toBe('content_media')
    expect(inherited.scopeHints?.contact).toBe('李四')
    expect(inherited.needsClarification).toBeUndefined()

    const ambiguous = classifyAnswerIntent('他最近发过什么文件？', { now: NOW })
    expect(ambiguous.kind).toBe('clarify')
    expect(ambiguous.needsClarification).toBe(true)
    expect(ambiguous.candidateKind).toBe('content_media')
    expect(ambiguous.toolHints).toEqual([])
  })

  it('「刚才那个文件」继承媒体引用并保留会话', () => {
    const decision = classifyAnswerIntent('刚才那个文件里写了什么？', {
      currentSession: 'team@chatroom',
      history: [
        { role: 'user', content: '[文件] 2026-10-20 报价单.xlsx' },
        { role: 'assistant', content: '看到了，是报价单。' },
      ],
      context: {
        activeSession: 'team@chatroom',
        lastReferencedMessage: 'team@chatroom:42',
      },
      now: NOW,
    })
    expect(decision.kind).toBe('content_media')
    expect(decision.scopeHints?.mediaTypes).toContain('file')
    expect(decision.scopeHints?.session).toBe('team@chatroom')
    expect(decision.toolHints).toContain('get_message_context')
  })

  it('「最近和「z_卖酒」聊了什么」把引号名识别为会话，不再提示 list_sessions', () => {
    const decision = classifyAnswerIntent('最近和「z_卖酒」聊了什么？', { now: NOW })

    expect(decision.kind).toBe('timeline')
    expect(decision.scopeHints?.session).toBe('z_卖酒')
    expect(decision.scopeHints?.timeRange).toMatchObject({
      from: '2026-10-15',
      to: '2026-10-21',
      source: 'explicit',
    })
    expect(decision.toolHints).toContain('get_session_messages')
    expect(decision.toolHints).not.toContain('list_sessions')
  })
})

describe('classifyAnswerIntent 结构化问法', () => {
  it('识别聚合 / 关系 / 时间线 / 开放问答', () => {
    expect(classifyAnswerIntent('最近7天哪个群消息最多？', { now: NOW }).kind).toBe('aggregate')
    expect(classifyAnswerIntent('我和王五认识吗？', { knownEntities: ['王五'], now: NOW }).kind).toBe('relation')
    expect(classifyAnswerIntent('上周都聊了什么？', { now: NOW }).kind).toBe('timeline')
    expect(classifyAnswerIntent('上周三我和李四聊了什么？', { knownEntities: ['李四'], now: NOW }).kind).toBe('timeline')
    expect(classifyAnswerIntent('这份合同有什么风险？', { now: NOW }).kind).toBe('open_qa')
    expect(classifyAnswerIntent('你好', { now: NOW }).kind).toBe('open_qa')
  })

  it('空问题要求澄清，不产生工具调用', () => {
    const decision = classifyAnswerIntent('   ', { now: NOW })
    expect(decision.kind).toBe('clarify')
    expect(decision.needsClarification).toBe(true)
    expect(decision.toolHints).toEqual([])
    expect(decision.reason).toContain('空问题')
  })

  it('LLM 只能补低置信结果，不能推翻明确规则', async () => {
    const clear = await classifyAnswerIntentWithLlm(
      '我一共转了多少笔？',
      { now: NOW },
      () => ({ kind: 'open_qa', confidence: 0.99, reason: '模型误判' }),
    )
    expect(clear.kind).toBe('aggregate')
    expect(clear.classifier).toBe('rules')

    const vague = await classifyAnswerIntentWithLlm(
      '那个东西怎么样了',
      { now: NOW },
      () => ({ kind: 'lookup', confidence: 0.88, reason: '模型确认是查找' }),
    )
    expect(vague.kind).toBe('lookup')
    expect(vague.classifier).toBe('hybrid')
  })

  it('LLM 失败时回退规则结果', async () => {
    const decision = await classifyAnswerIntentWithLlm(
      '那个东西怎么样了',
      { now: NOW },
      () => { throw new Error('offline') },
    )
    expect(decision.kind).toBe('clarify')
    expect(decision.signals).toContain('classifier:llm_failed')
  })
})

describe('intent 兼容映射', () => {
  it('旧 IntentKind 双向映射', () => {
    expect(mapLegacyIntent('aggregation')).toBe('aggregate')
    expect(mapLegacyIntent('comparison')).toBe('relation')
    expect(toLegacyIntent('lookup', { recency: true })).toBe('recency_lookup')
    expect(toLegacyIntent('lookup')).toBe('entity_lookup')
    expect(toLegacyIntent('relation', { comparison: true })).toBe('comparison')
    expect(toLegacyIntent('timeline')).toBe('time_range')
  })

  it('媒体类型识别可处理占位符与扩展名', () => {
    expect(inferMediaTypesFromText('[图片] 这张图')).toContain('image')
    expect(inferMediaTypesFromText('报价单.xlsx')).toContain('file')
    expect(inferMediaTypesFromText('录音.mp3')).toContain('voice')
  })
})

describe('buildThreadState / applyThreadState', () => {
  it('从历史继承会话、联系人和引用消息', () => {
    const history = [
      { role: 'user' as const, content: '在「项目群」里李四发的那个文件呢？' },
      { role: 'assistant' as const, content: '在 2026-10-20 的文件里。' },
    ]
    const state = buildThreadState(
      history,
      { turns: 0, lastReferencedMessage: 'team@chatroom:7' },
      { username: 'team@chatroom' },
      NOW,
    )
    expect(state.activeSession).toBe('team@chatroom')
    expect(state.turns).toBe(1)
    expect(state.lastReferencedMessage).toBe('team@chatroom:7')
    expect(state.history).toHaveLength(2)
  })

  it('空历史不会凭空产生联系人，且保留显式范围', () => {
    const state = buildThreadState([], undefined, { from: '2026-10-01', to: '2026-10-02' }, NOW)
    expect(state.turns).toBe(0)
    expect(state.activeContact).toBeUndefined()
    expect(state.lastTimeRange).toEqual({ from: '2026-10-01', to: '2026-10-02' })

    const applied = applyThreadState('他最近说了什么？', state, { now: NOW })
    expect(applied.contact).toBeUndefined()
    expect(applied.from).toBe('2026-10-01')
    expect(applied.reason.some(reason => reason.includes('需要澄清'))).toBe(true)
  })

  it('「那上周呢」相对上一轮时间窗递进', () => {
    const state = stateWith()
    const applied = applyThreadState('那上周呢？', state, { now: NOW })
    expect(applied.from).toBe('2026-10-07')
    expect(applied.to).toBe('2026-10-07')
    expect(applied.timeRange?.source).toBe('progression')
    expect(applied.reason.join('\n')).toContain('时间递进')
  })

  it('用户重述完整区间时覆盖遗留硬筛选，并解除下一轮的硬锁', () => {
    const state = stateWith({
      lastTimeRange: { from: '2026-10-16', to: '2026-10-16' },
      lastTimeHard: true,
    })
    const applied = applyThreadState(
      '请总结2026-09-16至2026-10-16的聊天',
      state,
      { now: NOW },
    )

    expect(applied.from).toBe('2026-09-16')
    expect(applied.to).toBe('2026-10-16')
    expect(applied.timeRange?.source).toBe('explicit')
    expect(applied.overrides).toContain('timeRange')
    expect(applied.timeHard).toBe(false)
    expect(applied.reason.join('\n')).toContain('覆盖遗留硬筛选')
  })

  it('显式时间覆盖继承时间', () => {
    const applied = applyThreadState('去年9月3号呢？', stateWith(), { now: NOW })
    expect(applied.from).toBe('2025-09-03')
    expect(applied.to).toBe('2025-09-03')
    expect(applied.overrides).toContain('timeRange')
  })

  it('「这个群第二条」继承当前会话与引用', () => {
    const state = stateWith({
      activeSession: 'team@chatroom',
      lastReferencedMessage: 'team@chatroom:8',
    })
    const applied = applyThreadState('这个群第二条消息呢？', state, {
      currentSession: 'team@chatroom',
      now: NOW,
    })
    expect(applied.session).toBe('team@chatroom')
    expect(applied.referencedMessage).toBe('team@chatroom:8')
    expect(applied.overrides).toContain('session')
    expect(applied.intent).toBe('lookup')
    expect(applied.messageRef?.ordinal).toBe(2)
  })

  it('媒体追问继承引用，且显式联系人覆盖继承联系人', () => {
    const state = stateWith({
      activeSession: 'team@chatroom',
      lastReferencedMessage: 'team@chatroom:9',
    })
    const media = applyThreadState('刚才那个文件呢？', state, { now: NOW })
    expect(media.referencedMessage).toBe('team@chatroom:9')
    expect(media.mediaTypes).toContain('file')

    const override = applyThreadState('王五的资料发我', state, {
      knownEntities: ['李四', '王五'],
      now: NOW,
    })
    expect(override.contact).toBe('王五')
    expect(override.overrides).toContain('contact')
  })

  it('历史按条数与字符预算截断', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `${String(i)}:${'内容'.repeat(700)}`,
    }))
    const state = buildThreadState(many, undefined, undefined, NOW)
    expect(state.history?.length).toBeLessThanOrEqual(THREAD_STATE_MAX_MESSAGES)
    const total = (state.history ?? []).reduce((sum, m) => sum + m.content.length, 0)
    expect(total).toBeLessThanOrEqual(THREAD_STATE_MAX_CHARS)
    expect(state.historyOmitted).toBeGreaterThan(0)

    const overflow = state.history ?? []
    expect(at(overflow, overflow.length - 1).content).toContain('29:')
  })

  it('advanceThreadState 追加一轮且不无限增长', () => {
    const next = advanceThreadState(stateWith(), {
      question: '那上周呢？',
      answer: '上周主要聊了交付。',
      intent: 'timeline',
      applied: {
        from: '2026-10-07',
        to: '2026-10-07',
        reason: ['时间递进'],
        timeRange: {
          from: '2026-10-07',
          to: '2026-10-07',
          granularity: 'day',
          source: 'progression',
          label: '前移一周',
        },
      },
    })
    expect(next.turns).toBe(2)
    expect(next.lastTimeRange).toEqual({ from: '2026-10-07', to: '2026-10-07' })
    expect(next.lastTimeGranularity).toBe('day')
    expect(next.history?.length).toBeLessThanOrEqual(THREAD_STATE_MAX_MESSAGES)
  })
})

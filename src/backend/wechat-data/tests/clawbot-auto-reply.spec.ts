/**
 * AI 自动回复守卫（M3，2026-10-13）。
 *
 * 守的是三组命题：
 *  ① **决策**：开关关着就一定不回；开了就回；知识库「开了但没选库」⇒ 回但不检索
 *     （**不是**「所有库」—— 那会把别的库内容端上来）；
 *  ② **候选筛选**：只回用户发来的文本（自己的回显、图片/语音/文件都不回）；
 *     一批多条**只回最后一条**（服务端不给消息时间，「刚绑定拉回历史」只能靠这条压上界）；
 *  ③ **执行器的失败纪律**：ask 抛错 / 空答案 / 发送失败 —— 一律**记账返回、不抛**、
 *     不写「已回复」的假记录；开关现读（关掉之后不再入队）。
 *
 * 全程注入假 ask 与假 send —— 这套用例一个字节都不出网。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PENDING,
  MAX_REPLY_CHARS,
  createAutoReplyRunner,
  decideAutoReply,
  isReplyable,
  pickReplyTarget,
  truncateReply,
  type AutoReplyRunnerDeps,
  type ClawbotAskContext,
  type ReplyableMessage,
} from '../src/query/clawbot/clawbot-auto-reply.ts'
import type { ClawbotInstanceConfig, ClawbotSendResult, OperationCategory, OperationStatus } from '../src/types.ts'

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await new Promise((r) => { setImmediate(r) }) }

function cfg(patch: Partial<ClawbotInstanceConfig> = {}): ClawbotInstanceConfig {
  return { slot: 1, autoReply: false, kbEnabled: false, kbId: null, systemPrompt: '', splitReply: false, ...patch }
}

function msg(patch: Partial<ReplyableMessage> = {}): ReplyableMessage {
  return { direction: 'in', msgType: 'text', content: '在吗', ...patch }
}

interface OpRecord { category: OperationCategory, action: string, status: OperationStatus, target: string, detail: string }

interface HarnessOverrides {
  /** `null` = 明确「未注入 ask」（装配缺失场景）；缺省 = 注入一个成功实现。 */
  ask?: AutoReplyRunnerDeps['ask'] | null
  send?: AutoReplyRunnerDeps['send']
  config?: ClawbotInstanceConfig
}

function makeRunner(over: HarnessOverrides = {}): {
  runner: ReturnType<typeof createAutoReplyRunner>,
  ops: OpRecord[],
  asks: Array<{ slot: number, text: string, kbId: number | null }>,
  sends: Array<{ slot: number, text: string }>,
  replied: Array<{ slot: number, id: number }>,
  setConfig: (c: ClawbotInstanceConfig) => void,
} {
  const ops: OpRecord[] = []
  const asks: Array<{ slot: number, text: string, kbId: number | null }> = []
  const sends: Array<{ slot: number, text: string }> = []
  const replied: Array<{ slot: number, id: number }> = []
  let current = over.config ?? cfg()
  const defaultAsk: NonNullable<AutoReplyRunnerDeps['ask']> = async (slot, text, kbId) => {
    asks.push({ slot, text, kbId })
    return { ok: true, answer: '收到' }
  }
  const deps: AutoReplyRunnerDeps = {
    readConfig: () => current,
    send: over.send ?? (async (slot: number, text: string): Promise<ClawbotSendResult> => {
      sends.push({ slot, text })
      return { ok: true, id: 99 }
    }),
    op: (category, action, status, target, detail) => { ops.push({ category, action, status, target: target ?? '', detail: detail ?? '' }) },
    onReplied: (info) => { replied.push(info) },
    ...(over.ask === null ? {} : { ask: over.ask ?? defaultAsk }),
  }
  return {
    runner: createAutoReplyRunner(deps),
    ops, asks, sends, replied,
    setConfig: (c: ClawbotInstanceConfig) => { current = c },
  }
}

describe('① 决策：只认开关，不看消息内容', () => {
  it('开关关着 ⇒ 不回（默认值，也是「无人值守出网」的第一道防线）', () => {
    expect(decideAutoReply(cfg())).toMatchObject({ should: false, kbId: null })
  })

  it('开了就回；知识库「开了但没选库」⇒ 回但不检索', () => {
    expect(decideAutoReply(cfg({ autoReply: true }))).toMatchObject({ should: true, kbId: null })
    expect(decideAutoReply(cfg({ autoReply: true, kbEnabled: true })), '没选库时不许把「所有库」当成作用域').toMatchObject({ should: true, kbId: null })
    expect(decideAutoReply(cfg({ autoReply: true, kbEnabled: true, kbId: 7 }))).toMatchObject({ should: true, kbId: 7 })
  })

  it('知识库开关关着时，即便配了库 id 也不检索（开关优先于残留配置）', () => {
    expect(decideAutoReply(cfg({ autoReply: true, kbEnabled: false, kbId: 7 }))).toMatchObject({ should: true, kbId: null })
  })
})

describe('② 候选筛选：只回「用户发来的文本」，一批只回一条', () => {
  it('只认入站文本', () => {
    expect(isReplyable(msg())).toBe(true)
    expect(isReplyable(msg({ direction: 'out' })), '回自己的消息 = 自己跟自己说话').toBe(false)
    expect(isReplyable(msg({ msgType: 'image' })), '图片/语音/文件不做自动回复').toBe(false)
    expect(isReplyable(msg({ msgType: null }))).toBe(false)
    expect(isReplyable(msg({ content: '   ' }))).toBe(false)
  })

  it('一批多条只取最后一条，并报出跳过了几条', () => {
    const batch = [msg({ content: '一' }), msg({ content: '二' }), msg({ msgType: 'image' }), msg({ content: '三' })]
    const { target, dropped } = pickReplyTarget(batch)
    expect(target?.content).toBe('三')
    expect(dropped, '跳过的条数要如实报出（审计里说清这一批被压掉了多少）').toBe(2)
    expect(pickReplyTarget([]).target).toBeNull()
    expect(pickReplyTarget([msg({ direction: 'out' })]).target).toBeNull()
  })

  it('超长回复截断并注明', () => {
    const long = '啊'.repeat(MAX_REPLY_CHARS + 50)
    const t = truncateReply(long)
    expect(t.length).toBeLessThan(long.length)
    expect(t).toContain('已截断')
    expect(truncateReply('  短  ')).toBe('短')
  })
})

describe('③ 执行器：一问一答、失败不抛、开关现读', () => {
  it('开关开着：ask 一次（带实例 slot 与 kbId）→ 发送一次 → 审计 ok → 事件一条', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true, kbEnabled: true, kbId: 9 }) })
    h.runner.consider(1, [msg({ content: '今天有什么安排' })])
    await flush()
    expect(h.asks).toEqual([{ slot: 1, text: '今天有什么安排', kbId: 9 }])
    expect(h.sends).toEqual([{ slot: 1, text: '收到' }])
    expect(h.replied).toEqual([{ slot: 1, id: 99 }])
    const ok = h.ops.filter(o => o.action === 'clawbot_auto_reply' && o.status === 'ok')
    expect(ok).toHaveLength(1)
    expect(ok[0]?.detail).toContain('知识库 9')
  })

  it('开关关着：一个字节都不出去（连 ask 都不调、也不记账 —— 无声是常态）', async () => {
    const h = makeRunner()
    h.runner.consider(1, [msg()])
    await flush()
    expect(h.asks).toEqual([])
    expect(h.sends).toEqual([])
    expect(h.ops).toEqual([])
  })

  it('ask 抛错 / 返回失败 / 空答案 ⇒ 不发送、记 fail、**不抛出**（调用方是长轮询循环）', async () => {
    const boom = makeRunner({ ask: async () => { throw new Error('未配置默认模型') }, config: cfg({ autoReply: true }) })
    boom.runner.consider(1, [msg()])
    await flush()
    expect(boom.sends).toEqual([])
    expect(boom.ops.at(-1)).toMatchObject({ action: 'clawbot_auto_reply', status: 'fail' })
    expect(boom.ops.at(-1)?.detail).toContain('未配置默认模型')

    const bad = makeRunner({ ask: async () => ({ ok: false, answer: '', error: '上游 500' }), config: cfg({ autoReply: true }) })
    bad.runner.consider(1, [msg()])
    await flush()
    expect(bad.sends).toEqual([])
    expect(bad.ops.at(-1)?.detail).toContain('上游 500')

    const empty = makeRunner({ ask: async () => ({ ok: true, answer: '   ' }), config: cfg({ autoReply: true }) })
    empty.runner.consider(1, [msg()])
    await flush()
    expect(empty.sends).toEqual([])
    expect(empty.ops.at(-1)?.detail).toContain('空答案')
  })

  it('发送失败 ⇒ 不许发事件、不许写「已回复」的 ok 记录', async () => {
    const h = makeRunner({
      send: async (): Promise<ClawbotSendResult> => ({ ok: false, id: null, error: '还没有可用会话' }),
      config: cfg({ autoReply: true }),
    })
    h.runner.consider(1, [msg()])
    await flush()
    expect(h.replied).toEqual([])
    expect(h.ops.filter(o => o.status === 'ok')).toEqual([])
    expect(h.ops.at(-1)?.detail).toContain('还没有可用会话')
  })

  it('未注入 ask（测试态 / 装配缺失）⇒ 记一行 fail，不发送（不许静默）', async () => {
    const h = makeRunner({ ask: null, config: cfg({ autoReply: true }) })
    h.runner.consider(1, [msg()])
    await flush()
    expect(h.sends).toEqual([])
    expect(h.ops.at(-1)?.detail).toContain('ask 能力未注入')
  })

  it('开关现读：关着时进的消息不入队；打开之后才走（两侧都钉）', async () => {
    const h = makeRunner()
    h.runner.consider(1, [msg({ content: '关着的时候' })])
    await flush()
    expect(h.asks, '关着的时候一个 ask 都不该发生').toEqual([])
    h.setConfig(cfg({ autoReply: true }))
    h.runner.consider(1, [msg({ content: '打开之后' })])
    await flush()
    expect(h.asks.map(a => a.text)).toEqual(['打开之后'])
  })

  it('积压超过上限 ⇒ 丢弃并记账（不许无界排队）', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }) })
    for (let i = 0; i < MAX_PENDING + 3; i += 1) h.runner.consider(1, [msg({ content: `第${String(i)}条` })])
    await flush()
    expect(h.ops.some(o => (o.detail ?? '').includes('积压'))).toBe(true)
  })

  it('一批多条只回最后一条，并留一行「跳过 N 条」', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }) })
    h.runner.consider(1, [msg({ content: '一' }), msg({ content: '二' }), msg({ content: '三' })])
    await flush()
    expect(h.asks.map(a => a.text)).toEqual(['三'])
    expect(h.ops.some(o => (o.detail ?? '').includes('只回最后一条'))).toBe(true)
  })

  it('多实例互不影响：两个 slot 各回各的（消息与回复都不串）', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }) })
    h.runner.consider(2, [msg({ content: '二号的消息' })])
    h.runner.consider(3, [msg({ content: '三号的消息' })])
    await flush()
    expect(h.asks.map(a => ({ slot: a.slot, text: a.text }))).toEqual([
      { slot: 2, text: '二号的消息' },
      { slot: 3, text: '三号的消息' },
    ])
    expect(h.sends.map(s => s.slot)).toEqual([2, 3])
  })

  /*
   * 2026-10-18 用户截图「不能关联上下文和识别图中内容」：
   * 目标消息之前的最近对话与图片必须交给 ask 管道；读上下文/图片失败也要照常回复，
   * 不许因为「历史读不出来」就整条不发。
   */
  it('最近对话与图片随 ask 一起送出（图片含 MIME，供模型读图）', async () => {
    const calls: Array<{ text: string, ctx: ClawbotAskContext | undefined }> = []
    const deps: AutoReplyRunnerDeps = {
      readConfig: () => cfg({ autoReply: true }),
      ask: async (_slot, text, _kbId, _sp, context) => {
        calls.push({ text, ctx: context })
        return { ok: true, answer: '看到了，右边那辆是……' }
      },
      send: async () => ({ ok: true, id: 1 }),
      op: () => {},
      onReplied: () => {},
      history: () => [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀，有事吗' },
        { role: 'user', content: '[图片]' },
      ],
      images: async () => [{ data: 'aGVsbG8=', mediaType: 'image/jpeg', name: 'wx-image-7' }],
    }
    createAutoReplyRunner(deps).consider(1, [msg({ id: 9, content: '分析一下图中右边那辆车是什么车？' })])
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ctx?.history?.map(m => m.content)).toEqual(['你好', '你好呀，有事吗', '[图片]'])
    expect(calls[0]?.ctx?.images).toEqual([{ data: 'aGVsbG8=', mediaType: 'image/jpeg', name: 'wx-image-7' }])
  })

  it('上下文/图片读取抛错 ⇒ 按空处理，照样回复（不阻断）', async () => {
    const calls: Array<{ text: string, ctx: ClawbotAskContext | undefined }> = []
    const sends: string[] = []
    const deps: AutoReplyRunnerDeps = {
      readConfig: () => cfg({ autoReply: true }),
      ask: async (_slot, text, _kbId, _sp, context) => {
        calls.push({ text, ctx: context })
        return { ok: true, answer: '收到' }
      },
      send: async (_slot, text) => { sends.push(text); return { ok: true, id: 2 } },
      op: () => {},
      onReplied: () => {},
      history: () => { throw new Error('history db down') },
      images: async () => { throw new Error('media cache down') },
    }
    createAutoReplyRunner(deps).consider(1, [msg({ id: 9 })])
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ctx).toEqual({})
    expect(sends).toEqual(['收到'])
  })
})

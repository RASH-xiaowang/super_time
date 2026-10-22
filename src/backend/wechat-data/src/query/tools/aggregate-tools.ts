/**
 * 聚合类检索工具（2026-10-16 新增）。
 *
 * ## 为什么它必须是一个**独立工具**而不是检索的一个参数
 *
 * 「我一共收到多少笔转账」「哪个群消息最多」这类问题的答案**不在任何一条消息里** ——
 * 它需要 `COUNT(*)` / `GROUP BY`。改造前检索管线只有「片段召回」一种操作，
 * 于是模型从 10 条片段里「数出」一个数（实测答「14 条」，真实 282 条），
 * 或者干脆说「判断不了」。
 *
 * 把它做成独立工具之后，模型可以**明确地**选择「这次要统计而不是检索」——
 * 而不是靠一堆正则去猜意图（`classifyIntent` 的 `AGG_RE` 就是那种猜法，
 * 实测漏掉了「哪个群聊消息最多」）。
 *
 * ## 与 `retrieval/aggregate.ts` 的关系
 *
 * 那个模块是**实现**（跑 SQL），这里是**工具包装**（参数校验 + 结果整形）。
 * 刻意不合并：实现要能被流水线直接调用（不必经过工具层），
 * 而工具层要处理「模型给的参数不可信」这件事（实现层不该关心）。
 *
 * @module query/tools/aggregate-tools
 */
import { runAggregate, pickDimension, resolveWindow } from '../retrieval/aggregate.ts'
import { argInt, argString, type RetrievalTool, type ToolResult } from './types.ts'

/** 聚合统计消息（计数 / 排名 / 去重）。 */
export const aggregateMessagesTool: RetrievalTool = {
  name: 'aggregate_messages',
  category: 'aggregate',
  description:
    '对聊天记录做**确定性统计**（SQL COUNT/GROUP BY），返回准确数字。'
    + '适用于「一共多少条/多少笔」「哪个群/谁最多」「跟多少人聊过」「哪天消息最多」这类问题。'
    + '**这类问题的答案不在任何一条消息里**，必须用本工具 —— 不要用 search_messages 去数片段，那样得到的是片段数而不是真实总数。',
  parameters: {
    type: 'object',
    properties: {
      dimension: {
        type: 'string',
        enum: ['keyword', 'session', 'day', 'distinct'],
        description:
          '统计维度：keyword = 按关键词数消息条数（「一共多少笔转账」）；'
          + 'session = 按会话分组排名（「哪个群最多」）；'
          + 'day = 按天分组排名（「哪天最多」）；'
          + 'distinct = 去重计数（「跟多少人聊过」）。不填则按问题自动判断。',
      },
      keywords: {
        type: 'array', items: { type: 'string' },
        description: 'dimension=keyword 时要统计的关键词（1-6 个）',
      },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      username: { type: 'string', description: '限定某个会话（不填 = 全库）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const question = argString(args['question'])
    const dimArg = argString(args['dimension'])
    const keywords = Array.isArray(args['keywords'])
      ? (args['keywords'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 6)
      : []
    // 执行上下文里的范围是服务端锁定值，不能被模型参数覆盖。
    const from = ctx.scope?.from || argString(args['from'])
    const to = ctx.scope?.to || argString(args['to'])
    const username = ctx.scope?.username || argString(args['username'])

    // 维度：模型给了就用它，没给就按问题自动判断（`pickDimension` 是确定性规则）。
    // 为什么允许模型覆盖：它能看到完整对话上下文，而 `pickDimension` 只看这一句问题。
    const dim = dimArg === 'keyword' || dimArg === 'session' || dimArg === 'day' || dimArg === 'distinct'
      ? dimArg
      : pickDimension(question || keywords.join(' '))

    // `runAggregate` 的维度判定走问题文本，这里把模型给的维度**编码进问题**，
    // 避免为了传一个枚举去改它的签名（它还要被流水线直接调用）。
    const dimHint = dim === 'session' ? '哪个最多'
      : dim === 'day' ? '哪天最多'
        : dim === 'distinct' ? '跟多少人聊过'
          : ''
    const q = [question, dimHint].filter(Boolean).join(' ')

    const facts = runAggregate({
      decryptedDir: ctx.decryptedDir,
      question: q,
      terms: keywords,
      ...(username ? { scope: { username } } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    })
    if (facts.length === 0) {
      return {
        tool: 'aggregate_messages', ok: true, hits: [],
        note: '没有可统计的数据（索引不存在或该范围内没有消息）',
        elapsedMs: Date.now() - started,
      }
    }
    const win = resolveWindow({
      decryptedDir: ctx.decryptedDir, question: q,
      ...(from ? { from } : {}), ...(to ? { to } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    })
    const range = win.lo === 0 && win.hi === 0 ? '全部时间'
      : `${new Date(win.lo * 1000).toISOString().slice(0, 10)} ~ ${new Date(win.hi * 1000).toISOString().slice(0, 10)}`
    return {
      tool: 'aggregate_messages', ok: true, hits: [],
      facts: facts.map(f => ({ title: f.title, body: f.body })),
      note: `统计维度 ${dim} · ${range} · 全库 ${facts[0]?.total ?? 0} 条消息`,
      elapsedMs: Date.now() - started,
    }
  },
}

/** 聚合类工具集。 */
export const AGGREGATE_TOOLS: readonly RetrievalTool[] = [aggregateMessagesTool]

/** 供测试直接用的维度判定（避免测试去构造完整工具调用）。 */
export { pickDimension }

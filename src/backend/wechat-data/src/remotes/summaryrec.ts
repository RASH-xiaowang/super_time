
/**
 * 总结记录（每日/周期总结生成、记录删除、推荐回复） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { collectDayMessages, collectPeriodMessages } from '../query/daily-summary.ts'
import { buildReplyPrompt, collectReplyContext, collectReplyKbSnippets, parseReplyCandidates } from '../query/reply-suggest.ts'
import { deleteSummaryRecord as delRec } from '../query/summary-tasks.ts'
import { DailySummaryResult, OperationCategory, OperationStatus, PeriodSummaryResult, ReplySuggestResult, SummaryTaskMutationResult, SummaryTaskRunResult } from '../types.ts'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Compact, readable daily digest for the no-LLM fallback (short per-message previews). */
function compactDailyDigest(lines: string[]): string {
  const parts: string[] = []
  let lastSession = ''
  let shown = 0
  for (const line of lines) {
    const m = line.match(/^【(.+?)】/)
    if (m && m[1]) { lastSession = m[1]; parts.push('\n【' + lastSession + '】'); continue }
    if (shown >= 6) { parts.push('……'); break }
    const s = line.replace(/\s+/g, ' ').slice(0, 48)
    parts.push('- ' + s + (line.length > 48 ? '…' : ''))
    shown += 1
  }
  return parts.join('\n')
}

export interface createSummaryRecordRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  ctx: () => Context
  privacyBlocked: (feature: string, detail?: string) => string | null
  privacyGate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => { ok: true; texts: string[] } | { ok: false; error: string }
  runSummaryTask: (options: { id: number }) => Promise<SummaryTaskRunResult>
  selfUsername: () => string
  getSchedBusy: () => boolean
  setSchedBusy: (v: boolean) => void
}

export function createSummaryRecordRemotes(rc: createSummaryRecordRemotesInputs) {
  return {
    async generateDailySummary(options: { date: string; provider?: string; model?: string }): Promise<DailySummaryResult> {
      const { lines, count, sessions, total, types, hourly, topSessions } = collectDayMessages(rc.dirs().decrypted, options.date)
      // 出站拦截要在这里判：再往下就是「未配置默认模型」的早退分支，它会盖掉拦截提示
      const blockedDay = rc.privacyBlocked('daily_summary')
      if (blockedDay !== null) {
        rc.op('task', 'generate_daily_summary', 'skip', options.date, blockedDay)
        return {
          summary: '⛔ ' + blockedDay + '\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）'),
          date: options.date, sessions, messages: count, total, types, hourly, topSessions,
        }
      }
      const ctx = rc.ctx()
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '')
      let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '')
      const llm = ctx.llm
      // Plain-text summarization: avoid a default vision/experimental model that returns empty text. Respect an explicit selection.
      if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
        try {
          const ms = await llm.listModels(useProvider)
          const chatModelRe = /chat|flash|pro|v4/i
          const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
            ?? ms.find(m => !/vision|image|exp/i.test(m.id))
            ?? ms[0]
          if (pick && pick.id) useModel = pick.id
        } catch { /* keep */ }
      }
      if (!useProvider || !useModel) {
        const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）')
        rc.op('task', 'generate_daily_summary', 'fail', options.date, '未配置默认模型或 LLM 服务')
        return { summary: fallback, date: options.date, sessions, messages: count, total, types, hourly, topSessions }
      }
      const prompt = '请总结 ' + options.date + ' 当天的微信聊天内容，输出简洁的中文要点：\n\n' + lines.join('\n')
      const gate = rc.privacyGate('daily_summary', { sessions, messages: count }, [prompt])
      if (!gate.ok) {
        rc.op('task', 'generate_daily_summary', 'skip', options.date, gate.error)
        return {
          summary: '⛔ ' + gate.error + '\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）'),
          date: options.date, sessions, messages: count, total, types, hourly, topSessions,
        }
      }
      const userMsg = createUserMessage({
        content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
        source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
      })
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = {
        provider: useProvider,
        model: useModel,
        messages: [userMsg],
        system: '你是微信每日总结助手，用中文输出简洁的当日聊天要点总结。',
        maxTokens: 1024,
      }
      let summary = ''
      try {
        for await (const chunk of llm.stream(opts)) assembler.push(chunk)
        summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      } catch (e) {
        summary = 'LLM 调用失败: ' + (e as Error).message
      }
      const finalSummary = summary ||
        (lines.length > 0
          ? '模型未返回内容（请为默认模型配置 DEEPSEEK_API_KEY 或其它 LLM 密钥）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）')
          : '（当天没有可用的文本消息）')
      const ok = !finalSummary.startsWith('LLM 调用失败')
      rc.op('task', 'generate_daily_summary', ok ? 'ok' : 'fail', options.date, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120))
      return { summary: finalSummary, date: options.date, sessions, messages: count, total, types, hourly, topSessions }
    },

    deleteSummaryRecord(options: { id: number }): SummaryTaskMutationResult {
      const r = delRec(rc.dirs().decrypted, options.id)
      rc.op('delete', 'delete_summary_record', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
      return r
    },

    async generatePeriodSummary(options: { from: string; to: string; provider?: string; model?: string }): Promise<PeriodSummaryResult> {
      const collected = collectPeriodMessages(rc.dirs().decrypted, options.from, options.to)
      const { lines, count, sessions, total, types, hourly, topSessions } = collected
      // 同每日总结：拦截要在「未配置默认模型」早退之前判
      const blockedPeriod = rc.privacyBlocked('period_summary')
      if (blockedPeriod !== null) {
        rc.op('task', 'generate_period_summary', 'skip', `${options.from}~${options.to}`, blockedPeriod)
        return {
          summary: '⛔ ' + blockedPeriod + '\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || ''),
          from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions,
        }
      }
      const ctx = rc.ctx()
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '')
      let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '')
      const llm = ctx.llm
      if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
        try {
          const ms = await llm.listModels(useProvider)
          const chatModelRe = /chat|flash|pro|v4/i
          const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
            ?? ms.find(m => !/vision|image|exp/i.test(m.id))
            ?? ms[0]
          if (pick && pick.id) useModel = pick.id
        } catch { /* keep */ }
      }
      if (!useProvider || !useModel) {
        const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '')
        rc.op('task', 'generate_period_summary', 'fail', `${options.from}~${options.to}`, '未配置默认模型或 LLM 服务')
        return { summary: fallback, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions }
      }
      const prompt = '请总结 ' + options.from + ' 至 ' + options.to + ' 的微信聊天内容，输出简洁的中文要点：\n\n' + lines.join('\n')
      const gate = rc.privacyGate('period_summary', { sessions, messages: count }, [prompt])
      if (!gate.ok) {
        rc.op('task', 'generate_period_summary', 'skip', `${options.from}~${options.to}`, gate.error)
        return {
          summary: '⛔ ' + gate.error + '\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || ''),
          from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions,
        }
      }
      const userMsg = createUserMessage({ content: [{ type: 'text', text: gate.texts[0] ?? prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } })
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = { provider: useProvider, model: useModel, messages: [userMsg], system: '你是微信周期总结助手，用中文输出简洁的要点总结。', maxTokens: 1024 }
      let summary = ''
      try { for await (const chunk of llm.stream(opts)) assembler.push(chunk); summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim() } catch (e) { summary = 'LLM 调用失败: ' + (e as Error).message }
      const finalSummary = summary || (lines.length > 0 ? '模型未返回内容。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '') : '（该周期没有可用的文本消息）')
      const ok = !finalSummary.startsWith('LLM 调用失败')
      rc.op('task', 'generate_period_summary', ok ? 'ok' : 'fail', `${options.from}~${options.to}`, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120))
      return { summary: finalSummary, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions }
    },

    async suggestReplies(options: { username?: string; kbId?: number; count?: number }): Promise<ReplySuggestResult> {
      const talker = String(options.username ?? '').trim()
      if (talker === '') return { ok: false, error: '缺少会话' }
      const want = Math.max(1, Math.min(Math.trunc(options.count ?? 3), 5))
      const { lines, latestPeer, count } = collectReplyContext(rc.dirs().decrypted, talker, rc.selfUsername())
      if (count === 0) return { ok: false, error: '这个会话还没有可用的对话内容' }
      const kbId = Math.trunc(Number(options.kbId ?? 0))
      const snippets = kbId > 0
        ? collectReplyKbSnippets(rc.dirs().decrypted, kbId, latestPeer || lines[lines.length - 1] || '', 3)
        : []
      const blocked = rc.privacyBlocked('suggest_reply')
      if (blocked !== null) return { ok: false, error: blocked }
      const llm = rc.ctx().llm
      const defaultModel = (rc.ctx() as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      if (!sel || !sel.provider || !sel.model) return { ok: false, error: 'LLM/模型不可用' }
      const prompt = buildReplyPrompt(lines, snippets, want)
      const gate = rc.privacyGate('suggest_reply', { sessions: 1, messages: count }, [prompt])
      if (!gate.ok) return { ok: false, error: gate.error }
      const userMsg = createUserMessage({
        content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
        source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
      })
      const assembler = new BlockAssembler()
      const opts: GenerateOptions = {
        provider: sel.provider, model: sel.model, messages: [userMsg],
        system: '你是微信聊天助手。只输出候选回复本身，不要解释、不要客套，也不要复述上下文。',
      }
      try {
        for await (const chunk of llm.stream(opts)) assembler.push(chunk)
      } catch (e) {
        rc.op('task', 'suggest_replies', 'fail', talker, (e as Error).message)
        return { ok: false, error: (e as Error).message }
      }
      const raw = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      const replies = parseReplyCandidates(raw, want)
      if (replies.length === 0) {
        rc.op('task', 'suggest_replies', 'fail', talker, '模型没给出可用的候选')
        return { ok: false, error: '模型没给出可用的候选回复' }
      }
      rc.op('task', 'suggest_replies', 'ok', talker, `${replies.length} 条 · 上下文 ${count} 条 · 知识库 ${snippets.length} 段`)
      const base: ReplySuggestResult = { ok: true, replies, messageCount: count, kbSnippetCount: snippets.length }
      return snippets.length === 0 && kbId > 0
        ? { ...base, degraded: '知识库里没有相关内容，这次只用了会话上下文' }
        : base
    },

  }
}

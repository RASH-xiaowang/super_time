
/**
 * 总结任务（每日/周期总结的排程与运行） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { collectDayMessages } from '../query/daily-summary.ts'
import { buildSummaryPrompt, type SummaryFormat } from '../query/summary-prompt.ts'
import { deleteSummaryTask as delTask, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from '../query/summary-tasks.ts'
import { pushSummaryToWebhook } from '../query/summary-webhook.ts'
import { redactWebhookEndpoint } from '../net/webhook-endpoint.ts'
import { OperationCategory, OperationStatus, SummaryRecord, SummaryTask, SummaryTaskInput, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot } from '../types.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PrivacyGateFn } from '../gateway-privacy.ts'
import { BlockAssembler, GenerateOptions, createUserMessage } from '@deepseek-ai/dsh-llm'

export interface createSummaryRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  ctx: () => Context
  privacyGate: PrivacyGateFn
}

export function createSummaryRemotes(rc: createSummaryRemotesInputs) {
  return {
    listSummaryTasks(): SummaryTaskSnapshot {
      const snapshot = listTasks(rc.dirs().decrypted)
      /**
       * 地址里的 token 就是凭据：完整值只留在本机库里，**跨 Remote 边界一律脱敏**。
       * 与 AI 回复默认 Webhook 同一口径（`default-webhook-store.ts` 的 `viewOf`）。
       * 保存时把 `***` 原样传回来会被 `normalizeSummaryWebhookUrl` 判成 `keep`，
       * 所以「看到脱敏地址 → 直接保存」不会覆盖真实 token。
       */
      return {
        ...snapshot,
        items: snapshot.items.map(task => ({
          ...task,
          webhookUrl: redactWebhookEndpoint(task.webhookUrl),
        })),
      }
    },

    saveSummaryTask(options: { task: SummaryTaskInput }): SummaryTaskMutationResult {
      const r = saveTask(rc.dirs().decrypted, options.task)
      rc.op('task', 'save_summary_task', r.ok ? 'ok' : 'fail', options.task.groupUsername, r.error ?? `id=${r.id ?? ''}`)
      return r
    },

    deleteSummaryTask(options: { id: number }): SummaryTaskMutationResult {
      const r = delTask(rc.dirs().decrypted, options.id)
      rc.op('delete', 'delete_summary_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
      return r
    },

    toggleSummaryTask(options: { id: number; enabled: boolean }): SummaryTaskMutationResult {
      const r = toggleTask(rc.dirs().decrypted, options.id, options.enabled)
      rc.op('task', 'toggle_summary_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? (options.enabled ? '启用' : '停用'))
      return r
    },

    async runSummaryTask(options: { id: number }): Promise<SummaryTaskRunResult> {
      const tasks = listTasks(rc.dirs().decrypted).items
      const task = tasks.find(t => t.id === options.id)
      if (!task) return { ok: false, error: '任务不存在' }
      const prev = new Date()
      prev.setDate(prev.getDate() - 1)
      const date = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`
      const { lines, count } = collectDayMessages(rc.dirs().decrypted, date, 50, task.groupUsername)
      const ctx = rc.ctx()
      const llm = ctx.llm
      const defaultModel = (ctx as unknown as {
        agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      }).agentDefaultModel
      const sel = defaultModel?.currentSelection()
      let summary = ''
      let status = 'done'
      let errMsg = ''
      // 出网拦截已随开关移除（2026-09-30）：这里只剩「模型不可用」这一条早退。
      if (!sel || !sel.provider || !sel.model) {
        status = 'error'
        errMsg = 'LLM/模型不可用'
      } else {
        /**
         * prompt 走**共用构造器**（`summary-prompt.ts`），不再自己写一份格式表。
         *
         * 这里原本有一份独立 map，`brief` 写着「3-5 句话以内」、`bullets` 写着
         * 「控制在 10 条以内」—— 于是改共用的那份时定时任务不跟着变，两处口径漂了。
         * 现在只有一个来源；`scope` 传群名，`targets` 传关注成员（给 {group} / {targets} 用）。
         */
        const prompt = buildSummaryPrompt({
          from: date,
          to: date,
          lines,
          stats: { total: count, sessions: 1, messages: lines.length },
          format: (task.format || 'brief') as SummaryFormat,
          customPrompt: task.customPrompt || '',
          scope: task.groupName || task.groupUsername,
          targets: task.targetUsers.length > 0 ? task.targetUsers.join('、') : '',
        })
        const [gated] = rc.privacyGate('summary_task', { sessions: 1, messages: count }, [prompt])
        const userMsg = createUserMessage({ content: [{ type: 'text', text: gated ?? prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } })
        const assembler = new BlockAssembler()
        /**
         * 刻意**不传 `maxTokens`**：过去这里是 `maxTokens: 1024`，一段长群聊的总结会被
         * 硬生生截在半句话上。篇幅交给 prompt 里「按素材量决定」那条 + 模型自身的输出上限。
         */
        const opts: GenerateOptions = { provider: sel.provider, model: sel.model, messages: [userMsg], system: '你是微信每日总结助手，按要求的格式输出总结。' }
        try {
          for await (const chunk of llm.stream(opts)) assembler.push(chunk)
          summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
        } catch (e) {
          status = 'error'
          errMsg = (e as Error).message
        }
      }
      const rec: SummaryRecord = {
        id: 0,
        taskId: task.id,
        groupUsername: task.groupUsername,
        summaryDate: date,
        summary,
        messageCount: count,
        status,
        error: errMsg,
        createdAt: Date.now(),
      }
      saveRec(rc.dirs().decrypted, rec)
      const done = status === 'done'

      /**
       * 推送（2026-11-18）：只把**生成成功且有内容**的总结发出去。
       *
       * 失败不改 `status` —— 总结确实生成了、也落库了，把它标成 error 会让用户以为
       * 白跑一轮（下一轮还要重新花 token）。推送原因单独带回，界面显示
       * 「已生成，但推送失败：…」，并把它写进 `last_error` 让任务列表能看见。
       */
      let webhookResult: SummaryTaskRunResult['webhook']
      let lastError = errMsg
      if (done && summary !== '' && task.webhookUrl.trim() !== '') {
        const pushed = await pushSummaryToWebhook({
          webhookUrl: task.webhookUrl,
          target: task.webhookTarget.trim() || task.groupName || task.groupUsername,
          message: summary,
        })
        webhookResult = {
          ok: pushed.ok,
          endpoint: pushed.endpoint,
          ...(pushed.status === undefined ? {} : { status: pushed.status }),
          ...(pushed.error === undefined ? {} : { error: pushed.error }),
        }
        if (!pushed.ok) lastError = '推送失败：' + (pushed.error ?? '未知原因')
        rc.op('task', 'push_summary_webhook', pushed.ok ? 'ok' : 'fail', pushed.endpoint, pushed.error ?? `id=${String(task.id)}`)
      }

      // update task last run state
      updateSummaryTaskRunState(rc.dirs().decrypted, task.id, Date.now(), status, lastError)
      rc.op('task', 'run_summary_task', done ? 'ok' : 'fail', task.groupUsername, lastError || `共 ${count} 条消息`)
      const result: SummaryTaskRunResult = done ? { ok: true, summary, messageCount: count } : { ok: false, error: errMsg || '生成失败' }
      if (webhookResult !== undefined) result.webhook = webhookResult
      return result
    },

  }
}

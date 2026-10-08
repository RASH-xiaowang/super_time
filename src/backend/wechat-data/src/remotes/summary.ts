
/**
 * 总结任务（每日/周期总结的排程与运行） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { collectDayMessages } from '../query/daily-summary.ts'
import { deleteSummaryTask as delTask, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from '../query/summary-tasks.ts'
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
      return listTasks(rc.dirs().decrypted)
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
        // build the prompt from the task's format (mirror daily_summary.rs summary_formats)
        const targets = task.targetUsers.length > 0 ? task.targetUsers.join('、') : '全部成员'
        const formats: Record<string, string> = {
          brief: '请用简洁的中文概括当天聊天记录的重点，3-5 句话以内，不要分点。',
          detailed: '请对当天聊天记录做详细总结：按主题分点（Markdown 列表），包含关键事件、讨论的话题、达成的共识与结论；只依据记录内容，不编造。',
          bullets: '请用 Markdown 无序列表提炼当天聊天记录的核心要点，每条一句话，控制在 10 条以内。',
          story: '请以第三人称、叙事的方式回顾当天聊天记录：谁和谁聊了什么、发生了什么、有什么进展或插曲，读起来像一篇日记。',
          custom: (task.customPrompt || '').replace(/\{date\}/g, date).replace(/\{group\}/g, task.groupName || task.groupUsername).replace(/\{targets\}/g, targets),
        }
        const fmtPrompt = formats[task.format || 'brief'] || formats['brief'] || ''
        const prompt = '群聊【' + task.groupName + '】(' + task.groupUsername + ') ' + date + ' 的聊天记录如下：\n\n' + lines.join('\n') + '\n\n' + fmtPrompt
        const [gated] = rc.privacyGate('summary_task', { sessions: 1, messages: count }, [prompt])
        const userMsg = createUserMessage({ content: [{ type: 'text', text: gated ?? prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } })
        const assembler = new BlockAssembler()
        const opts: GenerateOptions = { provider: sel.provider, model: sel.model, messages: [userMsg], system: '你是微信每日总结助手，按要求的格式输出总结。', maxTokens: 1024 }
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
      // update task last run state
      updateSummaryTaskRunState(rc.dirs().decrypted, task.id, Date.now(), status, errMsg)
      const done = status === 'done'
      rc.op('task', 'run_summary_task', done ? 'ok' : 'fail', task.groupUsername, errMsg || `共 ${count} 条消息`)
      return done ? { ok: true, summary, messageCount: count } : { ok: false, error: errMsg || '生成失败' }
    },

  }
}

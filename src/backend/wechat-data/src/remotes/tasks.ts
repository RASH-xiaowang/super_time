
/**
 * 任务与笔记（待办 / 笔记 / 交接提醒） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { collectPeriodMessages } from '../query/daily-summary.ts'
import { importHandoffTasks, listHandoffReminds } from '../query/handoff.ts'
import { deleteNote as deleteNoteRow, listNotes, saveNote as saveNoteRow } from '../query/notes.ts'
import { listSummaryTasks as listTasks } from '../query/summary-tasks.ts'
import { deleteTask, insertTask, listTasks as listWechatTasks, setTaskStatus } from '../query/wechat-tasks.ts'
import { HandoffRemindsSnapshot, NoteMutationResult, NotesSnapshot, OperationCategory, OperationStatus, TaskMutationResult, TasksSnapshot } from '../types.ts'

export interface createTasksRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
}

export function createTasksRemotes(rc: createTasksRemotesInputs) {
  return {
    getNotes(kbId: number, options?: { query?: string; limit?: number }): NotesSnapshot {
      return listNotes(rc.dirs().decrypted, kbId, options)
    },

    saveNote(kbId: number, options: {
      id?: number
      title: string
      body?: string
      tags?: string[] | string
      sourceKind?: 'manual' | 'ask'
      sourceUsername?: string
      sourceQuestion?: string
    }): NoteMutationResult {
      const r = saveNoteRow(rc.dirs().decrypted, kbId, options)
      // 只用于留痕，因此必须容错：kbId 变成独立参数后，漏传 options 会让 `options.title`
      // 直接抛 TypeError，把 `saveNoteRow` 那句「知识库标识无效」的守卫信息顶掉。
      rc.op('edit', 'save_note', r.ok ? 'ok' : 'fail', options?.title ?? '', r.error ?? `id=${r.id ?? ''}`)
      return r
    },

    deleteNote(kbId: number, options: { id: number }): NoteMutationResult {
      const r = deleteNoteRow(rc.dirs().decrypted, kbId, options?.id)
      rc.op('delete', 'delete_note', r.ok ? 'ok' : 'fail', `id=${options?.id ?? ''}`, r.error ?? '')
      return r
    },

    listTasks(): TasksSnapshot {
      return listWechatTasks(rc.dirs().decrypted)
    },

    addTask(options: { title: string; dueAt?: number }): TaskMutationResult {
      const r = insertTask(rc.dirs().decrypted, options)
      rc.op('task', 'add_task', r.ok ? 'ok' : 'fail', options.title, r.error ?? '')
      return r
    },

    deleteTask(options: { id: number }): TaskMutationResult {
      const r = deleteTask(rc.dirs().decrypted, options.id)
      rc.op('delete', 'delete_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '')
      return r
    },

    setTaskStatus(options: { id: number; status: 'open' | 'done' }): TaskMutationResult {
      const r = setTaskStatus(rc.dirs().decrypted, options.id, options.status)
      rc.op('task', 'set_task_status', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? options.status)
      return r
    },

    extractTasks(options?: { days?: number }): TaskMutationResult {
      const days = options?.days ?? 7
      const to = new Date()
      const from = new Date(to.getTime() - days * 86400000)
      const { lines } = collectPeriodMessages(rc.dirs().decrypted, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), 50)
      const re = /(记得|待办|要做|提醒|别忘了|稍后|待处理|deadline)/i
      let added = 0
      for (const line of lines) {
        if (re.test(line)) {
          const title = line.trim().slice(0, 60) || '待办'
          const r = insertTask(rc.dirs().decrypted, { title })
          if (r.ok) added += 1
        }
      }
      rc.op('task', 'extract_tasks', 'ok', '', `新增 ${added} 条待办`)
      return { ok: true, added }
    },

    syncHandoffTasks(): TaskMutationResult {
      const r = importHandoffTasks(rc.dirs().decrypted)
      rc.op('task', 'sync_handoff_tasks', r.ok ? 'ok' : 'fail', '', r.error ?? `导入 ${r.added ?? 0} 条`)
      return r
    },

    getHandoffReminds(): HandoffRemindsSnapshot {
      return listHandoffReminds(rc.dirs().decrypted)
    },

  }
}

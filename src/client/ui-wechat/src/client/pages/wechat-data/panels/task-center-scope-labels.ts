import type { TaskInfo } from '@deepseek-ai/dsh-wechat-data/types'
import { withEnterprise } from './enterprise-identity.ts'

/**
 * 右栏标题（选中任务时带上任务名，用户才知道列表被筛过）。
 * @param task - 当前选中的任务（null = 未选中）。
 * @returns 标题文案。
 */
export function triggerPaneTitle(task: TaskInfo | null): string {
  return task === null ? '任务触发记录' : `任务触发记录 · ${task.name}`
}

/**
 * 选中任务的会话/目标一行（`chatName → targetName`；单聊且同名时不重复）。
 * @param task - 任务。
 * @returns 展示文案。
 */
export function taskScopeLabel(task: TaskInfo): string {
  const chatName = task.chatName || task.chatUsername || '未知会话'
  const targetName = task.targetName || task.targetUsername || '未知对象'
  if (task.chatType === 'private' && chatName === targetName) {
    return withEnterprise(chatName, task.chatEnterpriseName || task.targetEnterpriseName)
  }
  return `${withEnterprise(chatName, task.chatEnterpriseName)} → ${withEnterprise(targetName, task.targetEnterpriseName)}`
}

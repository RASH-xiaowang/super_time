/**
 * 任务中心复用库的**叶子路径模块**。
 *
 * `task-center.ts` 与 `message-list-store.ts` 都写同一个 `wechat_task_center.db`。
 * 如果消息列表直接从 `task-center.ts` 取路径，会与扫描文件形成
 * `message-list → task-center → task-center-scan → message-list` 的循环依赖。
 * 这里只提供路径与存在性判断，不 import 任何 store，供两边共用。
 *
 * @module query/task-db
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 任务中心/消息列表共用的库文件名。 */
export const TASK_DB_FILE = 'wechat_task_center.db'

/** 库路径（`decryptedDir` 的父目录下，与待办/摘要等同族）。 */
export function taskDbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), TASK_DB_FILE)
}

/** 库是否存在（区分「确实还没有数据」与「库打不开」）。 */
export function taskStoreExists(decryptedDir: string): boolean {
  return existsSync(taskDbPath(decryptedDir))
}

/** 兼容旧调用点的短名字（任务中心与消息列表都在用）。 */
export const storeExists = taskStoreExists

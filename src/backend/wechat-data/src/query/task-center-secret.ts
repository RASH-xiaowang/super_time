/**
 * 任务凭据的**按需回读**（2026-10-21，编辑抽屉「眼睛」）。
 *
 * 单独成文件的理由：
 *  ① `query/task-center.ts` 已接近 M21 单文件上限（把这段搬出去而不是继续加豁免）；
 *  ② 这是一条**与列表/扫描/投递方向相反**的敏感读：列表永远只回 `triggerSecretSet`
 *     布尔快照，只有桌面端本机界面在用户显式点「眼睛」时才走到这里。
 *
 * 安全边界：HTTP 远程通道已把 `revealTaskTriggerSecret` 列入 LOCAL_ONLY（手机/浏览器调
 * 不到）；调用方不写日志/操作留痕、不落盘；界面拿到后只在当前抽屉内存里使用，关闭即丢弃。
 */
import { withWritableDb } from './db-open.ts'
import { parseSecretJson } from './rpa/template.ts'
import { storeExists, taskCellNum, taskDbPath, taskErrorText } from './task-center.ts'
import type { TaskTriggerSecretRevealResult } from '../types.ts'

/**
 * 读取某任务已保存的凭据原文（唯一回读入口）。
 * @param decryptedDir - 解密数据根。
 * @param id - 任务 id。
 * @returns 触发方式 + 凭据字段原文；任务不存在/库读不了时 `ok=false` + 可读错误。
 */
export function revealTaskTriggerSecret(decryptedDir: string, id: unknown): TaskTriggerSecretRevealResult {
  const taskId = taskCellNum(id)
  if (taskId <= 0) return { ok: false, error: '任务 id 不正确' }
  if (!storeExists(decryptedDir)) return { ok: false, error: '任务不存在' }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      const row = db.prepare(
        'SELECT trigger_method AS method, trigger_secret AS secret FROM task_info WHERE id = ?',
      ).get(taskId) as Record<string, unknown> | undefined
      if (row === undefined) return { ok: false, error: '任务不存在' }
      return {
        ok: true,
        triggerMethod: String(row['method'] ?? ''),
        secrets: parseSecretJson(row['secret']),
      }
    })
  } catch (e) {
    return { ok: false, error: taskErrorText(e) }
  }
}

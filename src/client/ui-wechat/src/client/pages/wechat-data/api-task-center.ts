/**
 * 「任务信息 / 任务触发记录」的取数与写入口（2026-10-19）。
 *
 * 与其余 `api-*.ts` 一样：只经 `ctx.remote.wechatData.*` 调后端，不读盘、不 import 后端实现。
 * 数据形状全部来自生成类型 `@deepseek-ai/dsh-wechat-data/types`（单一真源在
 * `src/backend/wechat-data/src/types-taskcenter.ts`）。
 *
 * 缓存口径：任务列表与触发记录**不进快照缓存**。它们会被后台定时扫描改写，
 * 且面板本来就靠 `useFreshData` 做「打开即查最新」；再套一层 SWR 只会让
 * 「新建任务后左列表没变」这类不一致多一条来源。写操作成功后统一广播
 * `TASK_CENTER_UPDATED_EVENT`，让任务信息面板、右栏记录与聊天侧新建弹窗
 * **读同一份后端数据**同时刷新。
 */
import type {
  TaskCallbackDispatchResult,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoSnapshot,
  TaskInfoStatus,
  TaskTriggerQuery,
  TaskTriggerScanResult,
  TaskTriggerSnapshot,
} from '@deepseek-ai/dsh-wechat-data/types'
import { remote, unwrap } from './api-core.ts'
import { notifyTaskCenterUpdated } from './task-center-events.ts'

/** 任务列表（最新在前）。 */
export async function apiListTaskInfos(): Promise<TaskInfoSnapshot> {
  return unwrap(await remote().listTaskInfos())
}

/** 触发记录（可按任务过滤；最新在前）。 */
export async function apiListTaskTriggers(options?: TaskTriggerQuery): Promise<TaskTriggerSnapshot> {
  return unwrap(await remote().listTaskTriggers(options))
}

/** 新建 / 更新任务（`options.id` 缺省 = 新建）。 */
export async function apiSaveTaskInfo(options: TaskInfoInput): Promise<TaskInfoMutationResult> {
  const r = unwrap(await remote().saveTaskInfo(options))
  if (r.ok) notifyTaskCenterUpdated()
  return r
}

/** 删除任务（关联的触发记录保留：任务已删但记录仍是历史事实）。 */
export async function apiDeleteTaskInfo(options: { id: number }): Promise<TaskInfoMutationResult> {
  const r = unwrap(await remote().deleteTaskInfo(options))
  if (r.ok) notifyTaskCenterUpdated()
  return r
}

/** 标记「待完善 / 已完善」—— 已完善才参与触发与回调投递。 */
export async function apiSetTaskInfoStatus(options: { id: number; status: TaskInfoStatus }): Promise<TaskInfoMutationResult> {
  const r = unwrap(await remote().setTaskInfoStatus(options))
  if (r.ok) notifyTaskCenterUpdated()
  return r
}

/** 立即扫描一次新消息（面板「立即检查」按钮 / 调试用；常驻扫描在网关定时器里）。 */
export async function apiScanTaskTriggers(): Promise<TaskTriggerScanResult> {
  const r = unwrap(await remote().scanTaskTriggers())
  if (r.created > 0) notifyTaskCenterUpdated()
  return r
}

/** 手动重投一条触发记录的回调。 */
export async function apiDispatchTaskCallback(options: { triggerId: number }): Promise<TaskCallbackDispatchResult> {
  const r = unwrap(await remote().dispatchTaskCallback(options))
  notifyTaskCenterUpdated()
  return r
}

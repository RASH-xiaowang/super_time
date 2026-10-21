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
  RpaVendorCatalog,
  TaskCallbackDispatchResult,
  TaskBatchMutationResult,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoSnapshot,
  TaskInfoStatus,
  TaskTriggerQuery,
  TaskTriggerScanResult,
  TaskTriggerSecretRevealResult,
  TaskTriggerSnapshot,
} from '@deepseek-ai/dsh-wechat-data/types'
import { remote, unwrap } from './api-core.ts'
import { notifyTaskCenterUpdated } from './task-center-events.ts'

/** 任务列表（最新在前）。 */
export async function apiListTaskInfos(): Promise<TaskInfoSnapshot> {
  return unwrap(await remote().listTaskInfos())
}

/**
 * 触发方式目录（内置 `webhook` + 已注册 RPA 厂商描述符）。
 *
 * 面板打开时取一次；编辑抽屉的触发方式选择器与动态表单都按它渲染。
 * **不缓存**（目录随应用版本变化，读旧目录会让新厂商字段显示不出来）；失败由面板显示错误条。
 */
export async function apiListRpaVendors(): Promise<RpaVendorCatalog> {
  return unwrap(await remote().listRpaVendors())
}

/**
 * 回读某任务已保存的凭据原文（编辑抽屉「眼睛」用）。
 *
 * 只有一个任务、一次点击；**不要缓存**，也不要打印返回值。结果自带 `ok`：
 * `ok=false` 时把 `error` 交给调用方显示（后端在远程通道/无效 id/无凭据时都会拒绝）。
 * @param id - 任务 id。
 * @returns 原文映射（键 = 描述符里的 secret 字段 key）与触发方式；失败只带 error。
 */
export async function apiRevealTaskTriggerSecret(id: number): Promise<TaskTriggerSecretRevealResult> {
  // 与其它 Remote 方法一样：传输层包一层 RemoteResult，这里拆开拿到业务结果；
  // 业务结果自身带 ok（任务不存在等是业务错误，不抛异常，交给眼睛控件显示）。
  return unwrap(await remote().revealTaskTriggerSecret({ id }))
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

/** 批量删除任务配置；关联触发记录保留。 */
export async function apiDeleteTaskInfos(options: { ids: number[] }): Promise<TaskBatchMutationResult> {
  const r = unwrap(await remote().deleteTaskInfos(options))
  if (r.ok) notifyTaskCenterUpdated()
  return r
}

/** 批量删除触发记录；后端会在同一事务里重算任务统计。 */
export async function apiDeleteTaskTriggers(options: { ids: number[] }): Promise<TaskBatchMutationResult> {
  const r = unwrap(await remote().deleteTaskTriggers(options))
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

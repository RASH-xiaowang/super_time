/**
 * 「任务信息 / 任务触发记录」的 @Remote 处理器（2026-10-19）。
 *
 * 机构与 `remotes/tasks.ts` / `remotes/media.ts` 一致：类里保留 @Remote 装饰器与签名
 * （协议层按名字枚举），方法体只做转发 + 操作留痕；真正的读写与扫描在
 * `query/task-center.ts`。这里额外承担两件装配职责：
 *  ① **图片解码依赖**：`wechatBaseDir` / `aesKey` / `xorKey` 由网关侧解析后经 ctx 注入
 *     （query 层刻意不 import `gateway-support` / `image-key`，避免反向依赖）；
 *  ② **扫描 + 投递的合体入口**：定时器与面板「立即检查」共用 `scanAndDispatch()`，
 *     先同步扫描、再 await 一批 pending 投递，把 dispatched 数回填进扫描结果。
 */
import { decodeImageDataUrlAsync } from '../query/media-image-async.ts'
import {
  deleteTaskInfo,
  deleteTaskInfos,
  deleteTaskTriggers,
  dispatchPendingTaskCallbacks,
  dispatchTaskCallback,
  listTaskInfos,
  listTaskTriggers,
  saveTaskInfo,
  scanTaskTriggers,
  setTaskInfoStatus,
} from '../query/task-center.ts'
import type { PendingDispatchResult, TaskDispatchDeps } from '../query/task-center.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type {
  TaskCallbackDispatchResult,
  TaskBatchMutationResult,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoSnapshot,
  TaskInfoStatus,
  TaskTriggerQuery,
  TaskTriggerScanResult,
  TaskTriggerSnapshot,
} from '../types.ts'
import type { OperationCategory, OperationStatus } from '../types.ts'

/** 网关侧注入的图片解码上下文（每次调用现取：用户可能在运行中换账号/换密钥）。 */
export interface TaskCenterImageContext {
  /** 微信账号根目录（解密原始图片用）；空 = 只读已解码缓存。 */
  wechatBaseDir?: string
  aesKey?: string
  xorKey: number
}

export interface createTaskCenterRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  /** 登录账号 wxid（扫描的单聊「对方」判定 + 水位初始化）。 */
  selfUsername: () => string
  /** 隐私闸：脱敏 + 审计（触发文本发出去前必须过；两种触发方式同一口径）。 */
  privacyGate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  /** 图片解码所需的本机上下文（网关侧用 `rawWechatBase` + `resolveImageKeyPair` 组装）。 */
  imageContext: () => TaskCenterImageContext
  /** 测试注入的 fetch；生产省略 = 全局 fetch。 */
  fetchImpl?: RetryFetch
}

/** 错误文本（Error.message 优先）。 */
function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

export function createTaskCenterRemotes(rc: createTaskCenterRemotesInputs) {
  const dirs = (): { decrypted: string; decoded: string } => rc.dirs()

  /**
   * 组装一次投递依赖。密钥/账号根在这里**每次现取**：换数据目录或换图片密钥后，
   * 下一次投递就该用新的，缓存住会让旧密钥一直生效（`resolveImageKeyPair` 的注释同款理由）。
   */
  const dispatchDeps = (): TaskDispatchDeps => {
    const decrypted = dirs().decrypted
    const decoded = dirs().decoded
    const image = rc.imageContext()
    const deps: TaskDispatchDeps = {
      decodeImage: (username, localId) => decodeImageDataUrlAsync(
        decrypted, decoded, username, localId,
        image.wechatBaseDir, image.aesKey, image.xorKey,
      ),
      gate: (feature, stats, texts) => rc.privacyGate(feature, stats, texts),
    }
    if (rc.fetchImpl !== undefined) deps.fetchImpl = rc.fetchImpl
    return deps
  }

  /** 只扫描（同步）：记录落库即返回，不等投递 HTTP（网关调度器把投递拆成独立单飞）。 */
  const scanOnce = (): TaskTriggerScanResult =>
    scanTaskTriggers(dirs().decrypted, { selfUsername: rc.selfUsername() })

  /** 只投递待发记录（异步）：与扫描分开调度，慢请求不会堵住新消息的触发。 */
  const dispatchPending = (): Promise<PendingDispatchResult> =>
    dispatchPendingTaskCallbacks(dirs().decrypted, dirs().decoded, dispatchDeps())

  /** 扫描 + 投递的合体入口（保留给测试/一次性调用；网关走上面两个分开的调度器）。 */
  const scanAndDispatch = async (): Promise<TaskTriggerScanResult> => {
    const result = scanOnce()
    try {
      const pending: PendingDispatchResult = await dispatchPending()
      result.dispatched = pending.dispatched
      if (pending.failed > 0) {
        result.errors = [...(result.errors ?? []), ...(pending.errors ?? [])].slice(0, 10)
      }
    } catch (e) {
      result.errors = [...(result.errors ?? []), '投递待发回调失败：' + errorText(e)].slice(0, 10)
    }
    return result
  }

  return {
    listTaskInfos(): TaskInfoSnapshot {
      return listTaskInfos(dirs().decrypted)
    },

    saveTaskInfo(options: TaskInfoInput): TaskInfoMutationResult {
      const r = saveTaskInfo(dirs().decrypted, options, rc.selfUsername())
      const target = options?.name ?? ('id=' + String(options?.id ?? ''))
      rc.op('task', 'save_task_info', r.ok ? 'ok' : 'fail', target, r.ok ? 'id=' + String(r.id ?? '') : (r.error ?? ''))
      return r
    },

    deleteTaskInfo(options: { id: number }): TaskInfoMutationResult {
      const r = deleteTaskInfo(dirs().decrypted, options?.id)
      rc.op('task', 'delete_task_info', r.ok ? 'ok' : 'fail', 'id=' + String(options?.id ?? ''), r.error ?? '')
      return r
    },

    deleteTaskInfos(options: { ids: number[] }): TaskBatchMutationResult {
      const r = deleteTaskInfos(dirs().decrypted, options?.ids)
      rc.op(
        'task', 'delete_task_infos', r.ok ? 'ok' : 'fail',
        'count=' + String(options?.ids?.length ?? 0), r.error ?? ('removed=' + String(r.removed)),
      )
      return r
    },

    deleteTaskTriggers(options: { ids: number[] }): TaskBatchMutationResult {
      const r = deleteTaskTriggers(dirs().decrypted, options?.ids)
      rc.op(
        'task', 'delete_task_triggers', r.ok ? 'ok' : 'fail',
        'count=' + String(options?.ids?.length ?? 0), r.error ?? ('removed=' + String(r.removed)),
      )
      return r
    },

    setTaskInfoStatus(options: { id: number; status: TaskInfoStatus }): TaskInfoMutationResult {
      const r = setTaskInfoStatus(dirs().decrypted, options?.id, options?.status, rc.selfUsername())
      rc.op('task', 'set_task_info_status', r.ok ? 'ok' : 'fail', 'id=' + String(options?.id ?? ''), r.error ?? String(options?.status ?? ''))
      return r
    },

    listTaskTriggers(options?: TaskTriggerQuery): TaskTriggerSnapshot {
      return listTaskTriggers(dirs().decrypted, options)
    },

    /** 面板「立即检查」与后台定时器共用：扫描 + 顺手投递待发记录。 */
    scanTaskTriggers(): Promise<TaskTriggerScanResult> {
      return scanAndDispatch()
    },

    scanAndDispatch,
    scanOnce,
    dispatchPending,

    async dispatchTaskCallback(options: { triggerId: number }): Promise<TaskCallbackDispatchResult> {
      const r = await dispatchTaskCallback(dirs().decrypted, dirs().decoded, options?.triggerId, dispatchDeps())
      rc.op(
        'task', 'dispatch_task_callback', r.ok ? 'ok' : 'fail',
        'id=' + String(options?.triggerId ?? ''), r.error ?? r.status,
      )
      return r
    },
  }
}

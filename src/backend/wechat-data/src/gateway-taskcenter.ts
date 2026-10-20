/**
 * WechatDataGateway 方法面 · **任务信息 / 任务触发记录 / 回调投递**（2026-10-19）。
 *
 * 单独成环的理由与 db-health / clawbot 同款：这一族方法（任务配置 + 触发记录 + 回调）
 * 不属于现有的 read / ask / media / export / voice / config / laya / db-health 任何一层，
 * 硬塞进去只会让下一刀再拆一次。本文件插在 `GatewayLayaOps` 与 `GatewayDbHealth` 之间，
 * 对外方法面逐名增加 7 个（`gateway-remote-surface.spec.ts` / 契约用例守）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）与两个装配点；处理器体在
 * `remotes/task-center.ts`（与其它域一致），真正的读写/扫描/投递在 `query/task-center.ts`。
 * 另外实现 core 的启动钩子（{@link scanTaskTriggersBackground}）：关键词触发是**常驻**能力，
 * 不该等用户打开面板才开始扫。
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  TaskCallbackDispatchResult,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoSnapshot,
  TaskInfoStatus,
  TaskTriggerQuery,
  TaskTriggerScanResult,
  TaskTriggerSnapshot,
} from './types.ts'
import { createTaskCenterRemotes } from './remotes/task-center.ts'
import { rawWechatBase } from './gateway-support.ts'
import { resolveImageKeyPair } from './query/image-key.ts'
import { GatewayLayaOps } from './gateway-laya-ops.ts'

/** 投递一拍的结果形状（与 `query/task-center-callback.ts` 的 `PendingDispatchResult` 相容）。 */
interface TaskDispatchOutcome {
  dispatched: number
  failed: number
  errors?: string[]
}

/** 错误文本（Error.message 优先；扫描/投递失败只记日志）。 */
function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/** 方法面的一层：继承链上的一环，不单独实例化。 */
export abstract class GatewayTaskCenter extends GatewayLayaOps {
  /**
   * 任务列表（最新在前）。
   *
   * 任务只有配置，触发记录才由后续新消息产生（见 `query/task-center.ts` 文件头）。
   * @returns TaskInfoSnapshot：任务列表 + 总数；读不到库时 `readError` 非空
   *   （与「确实还没有任务」区分，见 N1 口径）。
   */
  @Remote('listTaskInfos')
  listTaskInfos(): TaskInfoSnapshot {
    return this.taskCenterRemotes().listTaskInfos()
  }

  /**
   * 新建 / 更新任务配置（`options.id` 缺省 = 新建）。
   *
   * 校验失败返回**中文原因**而不是静默修正：会话必填、群聊必须选目标用户、关键词至少 1 个
   * （去重、每个 ≤64 字、最多 20 个）、`photoLimit` 夹 0..9、回调地址非空时必须是合法
   * http/https；「已完善」还要求回调地址 + 关键词 + 群聊目标齐全。
   * @param options - 任务配置（`id` 缺省 = 新建）。
   * @returns TaskInfoMutationResult：`ok` + 任务 id / 状态；失败带 `error`。
   */
  @Remote('saveTaskInfo')
  saveTaskInfo(options: TaskInfoInput): TaskInfoMutationResult {
    return this.taskCenterRemotes().saveTaskInfo(options)
  }

  /**
   * 删除任务配置。**关联触发记录保留**：记录里存了任务名/会话/对象快照，任务删了它仍是
   * 已经发生过的事实（列表与回调重试都还能用）。
   * @param options.id - 任务 id。
   * @returns TaskInfoMutationResult：`ok` 表示确实删掉了一行。
   */
  @Remote('deleteTaskInfo')
  deleteTaskInfo(options: { id: number }): TaskInfoMutationResult {
    return this.taskCenterRemotes().deleteTaskInfo(options)
  }

  /**
   * 标记任务「待完善 / 已完善」。
   *
   * 只有「已完善」任务参与触发扫描与回调投递。由「待完善」变「已完善」时会把扫描水位
   * 重置为该会话当前最大 `sort_seq` —— 否则一启用就会把历史消息全部触发一遍。
   * @param options.id - 任务 id。
   * @param options.status - `incomplete`（待完善） / `ready`（已完善）。
   * @returns TaskInfoMutationResult：`ok` + 落库后的状态；缺回调地址/关键词等前置条件时带 `error`。
   */
  @Remote('setTaskInfoStatus')
  setTaskInfoStatus(options: { id: number; status: TaskInfoStatus }): TaskInfoMutationResult {
    return this.taskCenterRemotes().setTaskInfoStatus(options)
  }

  /**
   * 触发记录列表（triggered_at 倒序，最新在前）。
   * @param options.taskId - 只看某个任务（缺省 = 全部任务）。
   * @param options.limit - 最多返回多少条（夹 1..200，默认 100）。
   * @returns TaskTriggerSnapshot：记录列表 + 总数；读不到库时 `readError` 非空。
   */
  @Remote('listTaskTriggers')
  listTaskTriggers(options?: TaskTriggerQuery): TaskTriggerSnapshot {
    return this.taskCenterRemotes().listTaskTriggers(options)
  }

  /**
   * 立即扫描一次（面板「立即检查」/ 调试用；常驻扫描见 {@link scanTaskTriggersBackground}）。
   *
   * 只扫「已完善」任务；逐任务失败不连坐（`errors` 只保留前 10 条）。扫描完顺手投递
   * 一批 `pending` 回调，投递成功数回填在 `dispatched`。
   * 与后台节拍走同一个单飞调度器：手动点击撞上后台扫描时复用同一拍，不会并发开库。
   * @returns TaskTriggerScanResult：参与任务数 / 检查消息数 / 新建记录数 / 投递成功数。
   */
  @Remote('scanTaskTriggers')
  async scanTaskTriggers(): Promise<TaskTriggerScanResult> {
    // 手动入口要如实回报「投递了几条」，所以这里额外 await 一次投递；
    // 后台节拍不等（见 `scheduleTaskTriggerScan` 的注释）。
    const result = await this.scheduleTaskTriggerScan()
    const pending = await this.scheduleTaskDispatch()
    result.dispatched = pending.dispatched
    if (pending.failed > 0) {
      result.errors = [...(result.errors ?? []), ...(pending.errors ?? [])].slice(0, 10)
    }
    return result
  }

  /**
   * 手动重投一条触发记录的回调（面板上对失败记录点「重试」）。
   *
   * 只投「任务已完善 + 配了回调地址」的记录；正文先过隐私闸（`task_callback`：脱敏 + 审计）。
   * 图片逐张按需解码，单张失败只在请求体里带 `error`，不影响整条投递。
   * @param options.triggerId - 触发记录 id。
   * @returns TaskCallbackDispatchResult：`ok` + `sent`/`failed`/`skipped`；失败带可读 `error`。
   */
  @Remote('dispatchTaskCallback')
  async dispatchTaskCallback(options: { triggerId: number }): Promise<TaskCallbackDispatchResult> {
    return this.taskCenterRemotes().dispatchTaskCallback(options)
  }

  /**
   * 启动钩子：**同步节拍到达时立即扫**（2026-10-19 提速），10s 定时器只作兜底。
   *
   * 之前只有一颗 30s 定时器：微信刚写入的新消息，要等最多 30s 才被判定 —— 用户看到
   * 的就是「触发很慢」。现在 `GatewayCore` 的实时同步回调在 `synced.length > 0` 时
   * 直接调这里，延迟降到「同步完成 + 一次扫描」。
   *
   * 失败只记日志：一次扫描失败（库被占用、分片正在重解密）不能把常驻能力停掉。
   */
  protected override scanTaskTriggersBackground(): void {
    void this.scheduleTaskTriggerScan()
  }

  /** 正在跑的扫描（单飞：同一时刻只允许一个扫描开任务库）。 */
  protected _taskScan: Promise<TaskTriggerScanResult> | null = null

  /** 扫描期间又来了请求：结束后补跑**一拍**（不是每个请求各跑一次）。 */
  protected _taskScanQueued = false

  /** 正在跑的投递（与扫描分开单飞：回调 HTTP 再慢也不能卡住扫描）。 */
  protected _taskDispatch: Promise<TaskDispatchOutcome> | null = null

  /** 投递期间又来了请求：结束后补跑一拍。 */
  protected _taskDispatchQueued = false

  /**
   * 单飞 + 合并的**扫描**调度器。
   *
   * 为什么必须合并：同步节拍、兜底定时器、面板「立即检查」三处都会触发；不合并会出现
   * 两个并发扫描同时 `withWritableDb` 打开同一个任务库，把同一批消息记两遍（UNIQUE 只挡住
   * 记录重复，但外部回调会被真的投递两次）。
   *
   * 关键提速点：扫描与**投递**解耦 —— 记录落库后立刻广播 `task-center/updated`，然后
   * 投递在后台单飞跑；回调地址慢/超时不会拖住下一拍扫描，面板也不会等 HTTP 才看到记录。
   * @returns 这一拍（或正在跑的那一拍）的扫描结果；`dispatched` 由手动入口另行合并。
   */
  protected scheduleTaskTriggerScan(): Promise<TaskTriggerScanResult> {
    if (this._taskScan !== null) {
      this._taskScanQueued = true
      return this._taskScan
    }
    let scan: TaskTriggerScanResult
    try {
      scan = this.taskCenterRemotes().scanOnce()
    } catch (e) {
      scan = { ok: false, tasks: 0, scanned: 0, created: 0, dispatched: 0, error: errorText(e) }
    }
    if (scan.created > 0) this.emitTaskCenterUpdated(scan.created, 0)
    // 投递不 await：先把扫描这一拍收干净，回调 HTTP 在后台单飞跑（慢请求不卡下一拍）。
    void this.scheduleTaskDispatch()
    this._taskScan = Promise.resolve(scan).finally(() => {
      this._taskScan = null
      if (this._taskScanQueued) {
        this._taskScanQueued = false
        void this.scheduleTaskTriggerScan()
      }
    })
    return this._taskScan
  }

  /**
   * 单飞 + 合并的**回调投递**调度器。
   *
   * 与扫描分开：一次投递最多 10 条、每条 2 次尝试 / 15s 超时，最坏能跑上百秒；
   * 如果把它塞在扫描的 Promise 里（旧实现），这期间所有新消息的触发都会被堵住。
   * @returns 这一拍（或正在跑的那一拍）的投递摘要。
   */
  protected scheduleTaskDispatch(): Promise<TaskDispatchOutcome> {
    if (this._taskDispatch !== null) {
      this._taskDispatchQueued = true
      return this._taskDispatch
    }
    this._taskDispatch = this.taskCenterRemotes().dispatchPending()
      .then((pending) => {
        if (pending.dispatched > 0) this.emitTaskCenterUpdated(0, pending.dispatched)
        return pending
      })
      .catch((e: unknown): TaskDispatchOutcome => {
        console.warn('[task-center] 后台投递失败：' + errorText(e))
        return { dispatched: 0, failed: 0, errors: ['投递待发回调失败：' + errorText(e)] }
      })
      .finally(() => {
        this._taskDispatch = null
        if (this._taskDispatchQueued) {
          this._taskDispatchQueued = false
          void this.scheduleTaskDispatch()
        }
      })
    return this._taskDispatch
  }

  /** 广播「任务中心已变」，让面板立刻回源（而不是等下一次微信同步事件）。 */
  protected emitTaskCenterUpdated(created: number, dispatched: number): void {
    try {
      this._ctx.emit('task-center/updated', { created, dispatched })
    } catch { /* 事件尽力而为：面板下次同步仍会回源 */ }
  }

  protected _taskCenterRemotes?: ReturnType<typeof createTaskCenterRemotes>

  /**
   * 任务信息域的处理器（体在 `remotes/task-center.ts`）；这里只组装 ctx 与转发。
   *
   * 图片解码上下文（账号根 + AES/XOR 密钥）按 `gateway-read.ts#createChatCollectTask`
   * 同一套方式解析：**只在网关层**调 `rawWechatBase` / `resolveImageKeyPair`，
   * query 层不 import gateway 侧（避免 query → gateway 的反向依赖）。
   * @returns 装配好的处理器（惰性建一次，之后复用）。
   */
  protected taskCenterRemotes(): ReturnType<typeof createTaskCenterRemotes> {
    return (this._taskCenterRemotes ??= createTaskCenterRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      selfUsername: () => this.selfUsername(),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      imageContext: () => {
        const base = rawWechatBase(this._dirs.decrypted)
        const { aesKey, xorKey } = resolveImageKeyPair(this._dirs.decrypted)
        return {
          ...(base === '' ? {} : { wechatBaseDir: base }),
          ...(aesKey === undefined ? {} : { aesKey }),
          xorKey,
        }
      },
    }))
  }
}

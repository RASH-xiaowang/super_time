import type { TaskCallbackDispatchResult, TaskBatchMutationResult, TaskInfoInput, TaskInfoMutationResult, TaskInfoSnapshot, TaskInfoStatus, TaskTriggerQuery, TaskTriggerScanResult, TaskTriggerSnapshot } from './types.ts';
import { createTaskCenterRemotes } from './remotes/task-center.ts';
import { GatewayLayaOps } from './gateway-laya-ops.ts';
/** 投递一拍的结果形状（与 `query/task-center-callback.ts` 的 `PendingDispatchResult` 相容）。 */
interface TaskDispatchOutcome {
    dispatched: number;
    failed: number;
    errors?: string[];
}
/** 方法面的一层：继承链上的一环，不单独实例化。 */
export declare abstract class GatewayTaskCenter extends GatewayLayaOps {
    /**
     * 任务列表（最新在前）。
     *
     * 任务只有配置，触发记录才由后续新消息产生（见 `query/task-center.ts` 文件头）。
     * @returns TaskInfoSnapshot：任务列表 + 总数；读不到库时 `readError` 非空
     *   （与「确实还没有任务」区分，见 N1 口径）。
     */
    listTaskInfos(): TaskInfoSnapshot;
    /**
     * 新建 / 更新任务配置（`options.id` 缺省 = 新建）。
     *
     * 校验失败返回**中文原因**而不是静默修正：会话必填、群聊必须选目标用户、关键词至少 1 个
     * （去重、每个 ≤64 字、最多 20 个）、`photoLimit` 夹 0..9、回调地址非空时必须是合法
     * http/https；「已完善」还要求回调地址 + 关键词 + 群聊目标齐全。
     * @param options - 任务配置（`id` 缺省 = 新建）。
     * @returns TaskInfoMutationResult：`ok` + 任务 id / 状态；失败带 `error`。
     */
    saveTaskInfo(options: TaskInfoInput): TaskInfoMutationResult;
    /**
     * 删除任务配置。**关联触发记录保留**：记录里存了任务名/会话/对象快照，任务删了它仍是
     * 已经发生过的事实，仍可用于列表查看。当前投递要求所属任务存在且已完善，因此删除后
     * 的 pending / failed 记录不能再重新投递。
     * @param options.id - 任务 id。
     * @returns TaskInfoMutationResult：`ok` 表示确实删掉了一行。
     */
    deleteTaskInfo(options: {
        id: number;
    }): TaskInfoMutationResult;
    /**
     * 批量删除任务配置。**关联触发记录保留**：与单条删除同一语义，记录里的任务/会话/
     * 对象快照仍可用于回看历史。
     * @param options.ids - 任务 id 列表；去重后 1..500 条，超过上限整单拒绝。
     * @returns TaskBatchMutationResult：`removed` 是实际删除行数（不存在的 id 不计入）。
     */
    deleteTaskInfos(options: {
        ids: number[];
    }): TaskBatchMutationResult;
    /**
     * 批量删除触发记录，并在同一事务里重算受影响任务的触发次数与最近触发时间。
     *
     * 删除记录不会删除微信原始消息；任务配置也不受影响。若任一步写入失败，整单回滚。
     * @param options.ids - 触发记录 id 列表；去重后 1..500 条，超过上限整单拒绝。
     * @returns TaskBatchMutationResult：`removed` 是实际删除的记录数。
     */
    deleteTaskTriggers(options: {
        ids: number[];
    }): TaskBatchMutationResult;
    /**
     * 标记任务「待完善 / 已完善」。
     *
     * 只有「已完善」任务参与触发扫描与回调投递。由「待完善」变「已完善」时会把扫描水位
     * 重置为该会话当前最大 `sort_seq` —— 否则一启用就会把历史消息全部触发一遍。
     * @param options.id - 任务 id。
     * @param options.status - `incomplete`（待完善） / `ready`（已完善）。
     * @returns TaskInfoMutationResult：`ok` + 落库后的状态；缺回调地址/关键词等前置条件时带 `error`。
     */
    setTaskInfoStatus(options: {
        id: number;
        status: TaskInfoStatus;
    }): TaskInfoMutationResult;
    /**
     * 触发记录列表（triggered_at 倒序，最新在前）。
     * @param options.taskId - 只看某个任务（缺省 = 全部任务）。
     * @param options.search - 在正文、任务名、会话/对象、关键词与回调错误里包含搜索；`%` / `_` 按普通字符处理。
     * @param options.limit - 最多返回多少条（夹 1..200，默认 100）。
     * @param options.cursor - 上一页返回的 `nextCursor`；缺省为第一页。
     * @returns TaskTriggerSnapshot：记录列表 + 真实总数 + 下一页游标；读不到库时 `readError` 非空。
     */
    listTaskTriggers(options?: TaskTriggerQuery): TaskTriggerSnapshot;
    /**
     * 立即扫描一次（面板「立即检查」/ 调试用；常驻扫描见 {@link scanTaskTriggersBackground}）。
     *
     * 只扫「已完善」任务；逐任务失败不连坐（`errors` 只保留前 10 条）。扫描完顺手投递
     * 一批 `pending` 回调，投递成功数回填在 `dispatched`。
     * 与后台节拍走同一个单飞调度器：手动点击撞上后台扫描时复用同一拍，不会并发开库。
     * @returns TaskTriggerScanResult：参与任务数 / 检查消息数 / 新建记录数 / 投递成功数。
     */
    scanTaskTriggers(): Promise<TaskTriggerScanResult>;
    /**
     * 手动重投一条触发记录的回调（面板上对失败记录点「重新投递」）。
     *
     * 只投「任务已完善 + 配了回调地址」的记录；正文先过隐私闸（`task_callback`：脱敏 + 审计）。
     * 图片逐张按需解码，单张失败只在请求体里带 `error`，不影响整条投递。
     * @param options.triggerId - 触发记录 id。
     * @returns TaskCallbackDispatchResult：`ok` + `sent`/`failed`/`skipped`；失败带可读 `error`。
     */
    dispatchTaskCallback(options: {
        triggerId: number;
    }): Promise<TaskCallbackDispatchResult>;
    /**
     * 启动钩子：**同步节拍到达时立即扫**（2026-10-19 提速），10s 定时器只作兜底。
     *
     * 之前只有一颗 30s 定时器：微信刚写入的新消息，要等最多 30s 才被判定 —— 用户看到
     * 的就是「触发很慢」。现在 `GatewayCore` 的实时同步回调在 `synced.length > 0` 时
     * 直接调这里，延迟降到「同步完成 + 一次扫描」。
     *
     * 失败只记日志：一次扫描失败（库被占用、分片正在重解密）不能把常驻能力停掉。
     */
    protected scanTaskTriggersBackground(): void;
    /** 正在跑的扫描（单飞：同一时刻只允许一个扫描开任务库）。 */
    protected _taskScan: Promise<TaskTriggerScanResult> | null;
    /** 扫描期间又来了请求：结束后补跑**一拍**（不是每个请求各跑一次）。 */
    protected _taskScanQueued: boolean;
    /** 正在跑的投递（与扫描分开单飞：回调 HTTP 再慢也不能卡住扫描）。 */
    protected _taskDispatch: Promise<TaskDispatchOutcome> | null;
    /** 投递期间又来了请求：结束后补跑一拍。 */
    protected _taskDispatchQueued: boolean;
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
    protected scheduleTaskTriggerScan(): Promise<TaskTriggerScanResult>;
    /**
     * 单飞 + 合并的**回调投递**调度器。
     *
     * 与扫描分开：一次投递最多 10 条、每条 2 次尝试 / 15s 超时，最坏能跑上百秒；
     * 如果把它塞在扫描的 Promise 里（旧实现），这期间所有新消息的触发都会被堵住。
     * @returns 这一拍（或正在跑的那一拍）的投递摘要。
     */
    protected scheduleTaskDispatch(): Promise<TaskDispatchOutcome>;
    /** 广播「任务中心已变」，让面板立刻回源（而不是等下一次微信同步事件）。 */
    protected emitTaskCenterUpdated(created: number, dispatched: number): void;
    protected _taskCenterRemotes?: ReturnType<typeof createTaskCenterRemotes>;
    /**
     * 任务信息域的处理器（体在 `remotes/task-center.ts`）；这里只组装 ctx 与转发。
     *
     * 图片解码上下文（账号根 + AES/XOR 密钥）按 `gateway-read.ts#createChatCollectTask`
     * 同一套方式解析：**只在网关层**调 `rawWechatBase` / `resolveImageKeyPair`，
     * query 层不 import gateway 侧（避免 query → gateway 的反向依赖）。
     * @returns 装配好的处理器（惰性建一次，之后复用）。
     */
    protected taskCenterRemotes(): ReturnType<typeof createTaskCenterRemotes>;
}
export {};

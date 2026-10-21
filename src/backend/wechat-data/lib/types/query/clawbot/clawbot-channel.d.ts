/**
 * ClawBot 接收通道 —— 绑定后的消息长轮询**循环**（生命周期与退避）。
 *
 * ## 职责边界
 *
 * - 协议层（`clawbot-ilink.ts`）：单次请求的形状与错误；
 * - **本模块**：把单次请求串成常驻循环（退避、会话过期恢复、游标推进、批后回调）；
 * - 装配层（`remotes/clawbot.ts`）：把本模块的依赖接到真实库 / 事件 / 审计上。
 *
 * 工厂化（`createClawbotChannel`）而不是模块级单例：状态与循环归**装配方**持有 ——
 * 测试里多个用例互不串扰，生产里一个网关一个通道。
 *
 * ## 循环语义（照 WeClaw monitor.go，改动处都写了理由）
 *
 * 1. **网络失败**：指数退避 3s → 60s；到第 5 次记一条「若持续请重新绑定」的警告；
 * 2. **服务端 `errcode=-14`（会话过期）**：游标非空 ⇒ 清空游标并保存、5s 后重连
 *    （游标坏了可以靠重拉恢复）；游标**已经是空**还 -14 ⇒ 凭证本身过期，
 *    **停循环**并把错误交给 `onError`（原版每 5s 无限重试一个已死的凭证，
 *    只会刷日志；恢复动作是重新绑定，停下来的状态界面看得见）；
 * 3. **其他服务端错误**（ret≠0 且 errcode≠0）：记日志 + 1s 间隔继续
 *    （原版这里不回退直接 continue，服务器半开时会变成热循环）；
 * 4. **成功**：消息批先交 `insertMessages` 落库（去重由它兜底），落库成功后才
 *    保存新游标；两件事都成功才清失败计数并更新 `lastPollAt`。落库或存游标失败
 *    时保留旧游标、按指数退避重拉，避免把未持久化的批次跳过。
 *
 * @module query/clawbot/clawbot-channel
 */
import type { IlinkUpdates, WeixinMessage } from './clawbot-ilink.ts';
/** 连续失败多少次时写一条「可能需要重新绑定」的警告（照 WeClaw 的 5）。 */
export declare const MAX_CONSECUTIVE_FAILURES = 5;
/** 首次退避（毫秒），之后翻倍到 {@link MAX_BACKOFF_MS}。 */
export declare const INITIAL_BACKOFF_MS = 3000;
/** 退避上限。 */
export declare const MAX_BACKOFF_MS = 60000;
/** 会话过期（-14）后重连前的等待。 */
export declare const SESSION_EXPIRED_BACKOFF_MS = 5000;
/** 其他服务端错误后的间隔（防热循环，见模块头注 ③）。 */
export declare const SERVER_ERROR_BACKOFF_MS = 1000;
/** 服务端表示「会话过期」的错误码。 */
export declare const ERR_CODE_SESSION_EXPIRED = -14;
/** 通道对外状态（`checkClawbotEnv` 的第二项直接用）。 */
export interface ClawbotChannelState {
    running: boolean;
    /** 最近一次错误的中文说明（`null` = 正常）；会话过期等终态错误会一直留着直到重新绑定。 */
    lastError: string | null;
    /** 最近一次成功轮询的本地时间（没成功过为 `null`）。 */
    lastPollAt: number | null;
}
/**
 * 一次 `getUpdates` 的接收代次租约。
 *
 * `isCurrent()` 在响应回来时判断这一批是否仍属于当前会话；清空、解绑、删除或
 * 重新绑定都会让旧租约失效。`canAdvanceStaleBuf()` 进一步区分「只是清空消息，
 * 同一绑定会话仍可安全推进游标」与「绑定会话已变化，不能再写旧游标」。
 */
export interface ClawbotBatchLease {
    isCurrent: () => boolean;
    canAdvanceStaleBuf: () => boolean;
    /**
     * 这一批启动时读到的持久会话代次。清空/重启/被别的实例接管后，旧批次即使
     * 进程内代次还没变，也必须靠它拒绝写消息、墓碑与游标。
     */
    sessionEpoch?: number;
    /**
     * clear 时已落库的最大 message_id。stale 成功批次里 `id <= clearWatermark`
     * 是清空前的旧消息，`id > clearWatermark` 是同一响应中 clear 后的新消息。
     */
    clearWatermark?: number;
}
/** 装配方提供的依赖（全是直调 / 注入，本模块不 import 库与事件）。 */
export interface ClawbotChannelDeps {
    /**
     * 在每次长轮询前取一个接收代次租约。缺省 = 不做代次校验（旧测试与单次调用）。
     */
    beginBatch?: () => ClawbotBatchLease;
    /**
     * 一次消息长轮询（真实实现 = `clawbot-ilink.ts#getUpdates` 绑定凭证后的偏函数）。
     * 第二参数是通道生命周期发出的 AbortSignal：实现应把它透传给网络请求，使
     * `stop()` 能真正中断在飞请求，而不是等超时/响应回来后再被丢弃。
     */
    getUpdates: (buf: string, signal?: AbortSignal) => Promise<IlinkUpdates>;
    /** 读同步游标（绑定行的 `sync_buf` 列）。 */
    readBuf: () => string;
    /** 存同步游标。 */
    saveBuf: (buf: string, expectedSessionEpoch?: number) => void;
    /**
     * 跨进程记住 clear 竞态下的旧消息 id。缺省只靠本循环内存抑制；
     * 生产装配应写入当前绑定会话的 tombstone。
     */
    suppressMessages?: (msgIds: readonly number[], expectedSessionEpoch?: number) => void;
    /** 一批消息落库（自动跳过重复 `message_id`）；没有新增时返回 null。 */
    insertMessages: (msgs: readonly WeixinMessage[], expectedSessionEpoch?: number) => {
        lastId: number;
        delta: number;
    } | null;
    /** 有新增消息时回调（装配方发 `clawbot/message` 事件；本模块不碰事件系统）。 */
    onMessages: (info: {
        lastId: number;
        delta: number;
    }) => void;
    /** 错误状态变化回调（装配方写入 `checkClawbotEnv` 的通道项）。 */
    onError: (error: string | null) => void;
    /** 退避休眠（测试注入即时实现）；实现可接收 AbortSignal，在停止时立刻拒绝。 */
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** 日志出口（缺省 `console.log`；测试可静音）。 */
    log?: (message: string) => void;
}
/** 通道句柄：`start` 幂等、`stop` 后再次 `start` 也能跑（重新绑定路径）。 */
export interface ClawbotChannel {
    start: () => void;
    stop: () => void;
    state: () => ClawbotChannelState;
}
/** 第 failures 次失败后的退避（3s 起、翻倍、封顶 60s）。 */
export declare function backoffMs(failures: number): number;
/**
 * 创建一个通道句柄。
 *
 * 循环挂在 `start()` 里以 `void` 启动（**不阻塞调用方**：网关启动路径不该等一轮
 * 长轮询）；`stop()` 同时置停止位并 abort 当前通道的 AbortController。只要
 * 装配层把 signal 透传给网络请求与休眠，正在飞的请求/退避都能立刻收尾。
 * @param deps - 依赖（见 {@link ClawbotChannelDeps}）。
 * @returns 通道句柄。
 */
export declare function createClawbotChannel(deps: ClawbotChannelDeps): ClawbotChannel;

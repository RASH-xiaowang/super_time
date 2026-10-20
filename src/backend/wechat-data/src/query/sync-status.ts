/**
 * 实时同步的对外修订（2026-10-18；Alpha `getDataRevision` 的同类物）。
 *
 * ## 为什么单独一份
 *
 * `sync.ts` 每拍只回调「哪些分片变了」，而聊天面板真正要判断的是「这次变化
 * 值不值得再拉一次消息增量」。把这个判断下推到 renderer，最坏就是每秒一次
 * RPC + 一次消息 SQL；把「修订」放在后端进程内存里，renderer 可以 1s 轮询这个
 * **纯内存读**，只有 `messageChanged` 时才真的查库。
 *
 * ## 口径
 *
 * - `revision`：每发生一次「快照确实被改写」+1（只在 `onSync` 真被调用时推进，
 *   空拍不推进 —— 否则轮询方会空转）；
 * - `messageChanged`：这一拍里是否包含消息分片（`message_<n>.db` / `biz_message_<n>.db`），
 *   聊天面板据此决定要不要拉增量消息、做就地改对账；
 * - `shards`：最近一拍变过的分片/库名（封顶，避免异常情况下快照无限增长）；
 * - `updatedAt`：最近一拍的本地时间戳（诊断用，不参与判断）。
 */

/** 聊天面板轮询用的「实时同步修订」快照。 */
export interface DataRevision {
  /** 单调递增：每发布一次「快照有变化」+1。 */
  revision: number
  /** 最近一次发布的时间戳（毫秒）。 */
  updatedAt: number
  /** 最近一拍变过的分片/库名（形如 `message_0.db:wal(0p/w3)`，封顶见下）。 */
  shards: string[]
  /** 最近一拍是否动了消息分片 —— 只有 true 才值得拉消息增量。 */
  messageChanged: boolean
}

/** 消息分片名：`message_<n>.db` 或 `biz_message_<n>.db`（后面可跟 `:via(...)` 后缀）。 */
const MESSAGE_SHARD = /^(?:biz_)?message_\d+\.db(?::|$)/

/** 快照里保留的分片名上限：诊断信息，不需要全量。 */
const MAX_SHARDS = 32

const EMPTY: DataRevision = { revision: 0, updatedAt: 0, shards: [], messageChanged: false }
let state: DataRevision = EMPTY

/**
 * 发布一拍：实时同步落地新数据后由网关调用（空列表不调用，空拍不推进 revision）。
 * @param changed - 本拍真正变过的分片/库名列表。
 * @returns 无（读取方用 {@link readDataRevision}）。
 */
export function publishDataRevision(changed: readonly string[]): void {
  state = {
    revision: state.revision + 1,
    updatedAt: Date.now(),
    shards: changed.slice(0, MAX_SHARDS),
    messageChanged: changed.some((name) => MESSAGE_SHARD.test(name)),
  }
}

/**
 * 读取当前修订快照。
 * @returns 防御性副本：调用方改它不会污染下一拍。
 */
export function readDataRevision(): DataRevision {
  return { ...state, shards: state.shards.slice() }
}

/** 重置（测试用；生产里进程生命周期内只有一条同步循环）。 */
export function forgetDataRevision(): void {
  state = EMPTY
}

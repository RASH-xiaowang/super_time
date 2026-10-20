/**
 * 在途写撤销闸（Phase 2，Alpha mutation epoch 的单机简化版）。
 *
 * ## 解决什么
 *
 * 后端重启后，队列里可能还压着「重启前发起、重启后才执行」的写请求（保存/删除/配置）。
 * 旧 worker 的进程已经被换掉，但这些请求在宿主队列里没有过期，落到新 worker 上仍然会
 * 执行 —— 也就是 Alpha 用 mutation epoch 挡掉的那类「旧代际写」。
 *
 * ## 边界（必须诚实）
 *
 * - 只能挡住**还没执行**的写：请求入队时记 epoch，真正派发前再比一次；已经开始跑的
 *   RPC 无法从这里撤回（那需要后端事务级 epoch，当前协议没有）。
 * - epoch 只在**后端重启**时 bump；锁屏/切号/数据修订的 bump 需要宿主再接事件，
 *   后续 Phase 2b 补。
 * - 默认是 **shadow**：只记录、不改行为；用 `SUPERTIME_MUTATION_GATE=enforce` 才拒绝。
 *   这样先观察一轮，避免误伤长队列里的正常写。
 *
 * ## 为什么不做成 Remote
 *
 * 这是宿主层的调用策略，不该出现在方法面（212 个 Remote 是业务面）；渲染层也不需要知道。
 */

/** 写方法名前缀：只收窄到明确会改本地数据/配置的动作。`cancel` 故意不在内（它用来停任务）。 */
const WRITE_PREFIXES = [
  'save', 'delete', 'update', 'create', 'restore', 'import',
  'send', 'clear', 'mark', 'apply', 'set', 'remove',
  'edit', 'reset', 'bind', 'unbind', 'rename', 'move', 'copy', 'write', 'upload',
]

/** 当前 epoch；初始 0，后端每次重启 +1。 */
let epoch = 0
/** 最近一次观察到的 backend restarts；第一次观察只播种，不 bump。 */
let lastRestarts = null
/** shadow | enforce */
let mode = process.env.SUPERTIME_MUTATION_GATE === 'enforce' ? 'enforce' : 'shadow'
/** 测试/诊断计数。 */
let revoked = 0
let lastBumpReason = ''

/**
 * 是否为本闸认定的写方法。
 * @param method - Remote 方法名。
 * @returns 形如 `save*` / `delete*` / `set*` 的写方法返回 true。
 */
function isWriteMethod(method) {
  if (typeof method !== 'string' || method === '') return false
  return WRITE_PREFIXES.some((prefix) => method.startsWith(prefix))
}

/**
 * 观察后端状态；restarts 的**变化**就是一次代际切换。
 * @param status - `wechat:backend-state` 同源状态对象（至少含 restarts）。
 * @returns 本次是否 bump。
 */
function observeBackendStatus(status) {
  const restarts = Number(status?.restarts)
  if (!Number.isFinite(restarts)) return false
  if (lastRestarts === null) {
    lastRestarts = restarts
    return false
  }
  if (restarts === lastRestarts) return false
  lastRestarts = restarts
  epoch += 1
  lastBumpReason = 'backend-restart'
  return true
}

/**
 * 请求入队前取代际令牌。
 * @param method - Remote 方法名。
 * @returns `{ epoch, write, method }`；读请求也会带 token，但 check 永远放过。
 */
function beginMutation(method) {
  return { epoch, write: isWriteMethod(method), method: String(method || '') }
}

/**
 * 派发前校验。
 * @param token - `beginMutation()` 的返回值。
 * @returns 需要拒绝时返回带 `code` 的 Error；shadow 或未过期返回 null。
 */
function checkMutation(token) {
  if (!token || !token.write || token.epoch === epoch) return null
  revoked += 1
  const err = new Error(
    `该写请求发起于后端上一代（epoch ${token.epoch} → ${epoch}），已撤销，请重试`,
  )
  err.code = 'MUTATION_DISPATCH_REVOKED'
  err.details = { method: token.method, issuedEpoch: token.epoch, currentEpoch: epoch }
  if (mode !== 'enforce') return null
  return err
}

/**
 * 显式代际切换（配置/许可/数据根变化等宿主事件）。
 * @param reason - 诊断原因，写进 stats。
 * @returns 新 epoch。
 */
function bumpMutationEpoch(reason) {
  epoch += 1
  lastBumpReason = String(reason || 'explicit')
  return epoch
}

/** 只给测试/诊断：当前代际与模式。 */
function mutationGateStats() {
  return { epoch, mode, revoked, lastBumpReason }
}

/** 测试注入：切换 shadow/enforce、清空状态（避免用例互相污染）。 */
function setMutationGateMode(nextMode) {
  mode = nextMode === 'enforce' ? 'enforce' : 'shadow'
}

/** 测试注入：重置 epoch 与观察值。 */
function resetMutationGate() {
  epoch = 0
  lastRestarts = null
  revoked = 0
  lastBumpReason = ''
  mode = 'shadow'
}

module.exports = {
  isWriteMethod,
  observeBackendStatus,
  bumpMutationEpoch,
  beginMutation,
  checkMutation,
  mutationGateStats,
  setMutationGateMode,
  resetMutationGate,
}

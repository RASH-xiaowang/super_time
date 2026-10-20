/**
 * 同步的**节奏与失败退避**：间隔常量、失败退避、日志节流。
 *
 * ## 为什么单独成文件
 *
 * `sync.ts` 已经贴着本仓的「单文件 1000 行」硬上限，而这套退避逻辑（2026-09-29 修 bug 时加的）
 * 有 100 多行注释与状态 —— 塞回去当场把 `sync.ts` 顶到 1012 行、被
 * `m21-file-size-ratchet.spec.ts` 咬红。按本仓既有做法（如 `image-warm.ts` 从 core 外提）
 * 把这块**有独立语义**的东西搬出来，而不是删注释。
 *
 * ## 这一层解决什么（2026-09-29 实测的 bug）
 *
 * `sync.ts` 的四个同步函数在 catch 里原先都是 `lastState.delete(key)`（"下一轮再来"）——
 * 对**锁竞争**这类瞬时故障是对的，对**持续失败**（密钥失效、源库正被微信写着导致副本撕裂）
 * 就是灾难：实测日志里 9 个目标**每 10 秒各自**重解密一次、各打一行 `decrypt invalid`，
 * 25 秒涨 1.9 KB（≈6.6 MB/小时）；而 `message_1.db` 原始文件有 **153 MB** ——
 * 每 10 秒解一遍纯属白烧 CPU，且 100 秒内看不出收敛。
 *
 * ## 口径（三条，都是实测踩出来的）
 *
 * 1. **按目标退避，不看签名**：第一次失败后 10s 内不再试，之后 20s / 40s / … 上限 5min。
 *    ⚠️ 第一版是"源签名一变就立刻重试"，**实测无效**：微信一直在写这些库，签名每轮都在变
 *    ⇒ 退避永远被重置，等于没退避。真实使用中"数据晚 10–20 秒进来"远好过
 *    "每 10 秒重解一个 153 MB 的库"。
 * 2. **成功一次立刻清零**：恢复正常节奏，不残留任何延迟。
 * 3. **日志按时间节流**（每目标每分钟最多一行）；连续失败到第三次时补一句可照做的成因提示。
 */

/**
 * 实时同步的轮询间隔（`sync.ts` 的兜底调度用它，退避的第一档也用它）。
 * 放在这里是为了让"退避以轮询为基本单位"这件事**只有一个出处**。
 */
export const SYNC_INTERVAL_MS = 10_000

/**
 * 监听没挂上时的兜底轮询间隔（2026-10-18）。
 *
 * `fs.watch` 在部分文件系统（网络盘、部分移动盘）上会丢事件甚至直接报错。此时
 * 10s 轮询就是**唯一**的新鲜度来源；监听正常时它只是兜底。所以监听未挂载期间改用
 * 更短的间隔（3s），挂上后回落到 `SYNC_INTERVAL_MS` —— 用「有监听 ↔ 无监听」这
 * 一个事实决定节奏，不引入新的调参面。
 */
export const SYNC_FALLBACK_FAST_MS = 3_000

/** 退避上限：持续失败时 5 分钟试一次足够（用户修好密钥/关掉微信后能自然恢复）。 */
export const SYNC_FAILURE_MAX_MS = 5 * 60_000
/** 日志节流窗口：同一目标每分钟最多一行（9 个目标 ⇒ 峰值 ~9 行/分钟，不再是每秒刷屏）。 */
export const SYNC_LOG_THROTTLE_MS = 60_000
/** 超过这么久没有新的失败，就当上一段故障已经过去，计数从 1 重新开始。 */
export const SYNC_FAILURE_EPISODE_MS = 10 * 60_000

/** 每个目标的失败状态（模块级：同一个后端进程里只有一条同步循环）。 */
const syncFailures = new Map<string, {
  /** 失败当轮的源签名（只用于日志对照，**不参与**退避判定 —— 见文件头注释第 1 条）。 */
  sigKey: string
  /** 本段故障里连续失败的次数。 */
  count: number
  /** 到这一刻之前不再重试。 */
  nextAt: number
  /** 当前退避时长（写进日志，便于判断"是不是卡住了"）。 */
  delay: number
  /** 最近一次失败的时刻（用于判定"上一段故障是否已经过去"）。 */
  lastAt: number
  /** 最近一次**打日志**的时刻（时间节流用）。 */
  lastLoggedAt: number
}>()

/**
 * 该目标现在是否处于失败退避期内。
 * @param key - 目标键（分片名 / `session.db` / label）。
 * @returns true = 跳过本轮（不重解密）。
 */
export function syncFailureBackoffActive(key: string): boolean {
  const f = syncFailures.get(key)
  if (f === undefined) return false
  // 很久没有新的失败 ⇒ 上一段故障已经结束，清掉记录、放行一次探测。
  if (Date.now() - f.lastAt > SYNC_FAILURE_EPISODE_MS) { syncFailures.delete(key); return false }
  return Date.now() < f.nextAt
}

/**
 * 记一次失败。
 * @param key - 目标键。
 * @param sigKey - 当前源签名串（仅记录，便于对照日志）。
 * @param message - 失败原因。
 * @returns 是否**现在**该打日志（受时间节流约束）。
 */
export function noteSyncFailure(key: string, sigKey: string, message: string): boolean {
  const prev = syncFailures.get(key)
  const now = Date.now()
  const continued = prev !== undefined && now - prev.lastAt <= SYNC_FAILURE_EPISODE_MS
  const count = continued ? prev.count + 1 : 1
  const delay = Math.min(SYNC_INTERVAL_MS * 2 ** (count - 1), SYNC_FAILURE_MAX_MS)
  const shouldLog = prev === undefined || now - prev.lastLoggedAt >= SYNC_LOG_THROTTLE_MS
  syncFailures.set(key, {
    sigKey,
    count,
    nextAt: now + delay,
    delay,
    lastAt: now,
    lastLoggedAt: shouldLog ? now : prev.lastLoggedAt,
  })
  if (!shouldLog) return false
  // 单目标这一行**只陈述事实**（第几次、退避多久）：
  // 「是什么原因」要看**同一次 tick 里别的目标成不成**，那是 tick 级才知道的信息
  // （见 `sync.ts` 的 `failingTargets()` 用法）。这里写死"多半是密钥失效"曾经误导过一次：
  // 2026-09-29 实测中真正的原因是**这个数据根当时根本没有密钥文件**，
  // 而另一次是「微信正独占/正在写那几个大库」——两者都表现成同一句 `decrypt invalid`。
  console.error('[wechat-sync]', key, message,
    `（第 ${String(count)} 次、退避 ${String(Math.round(delay / 1000))}s）`)
  return true
}

/**
 * 最近还在失败的目标（用于 tick 级判读：**是全部解不开，还是只有一部分**）。
 *
 * 为什么要这个：`decrypt invalid` 这一个字符串对应**至少两种**完全不同的原因 ——
 *   ① **密钥问题**（没有密钥文件 / 密钥映射过期）：所有目标**都**解不开；
 *   ② **读到撕裂副本**（微信正独占或正在写那几个大库）：只有**被写的那几个**解不开，
 *      同一轮里别的目标照样成功。
 * 只看单个目标分不出这两者，于是"该不该让用户去重新获取密钥"就无从判断。
 * @param withinMs - 只统计这么久之内失败过的目标（默认 2 分钟）。
 * @returns 目标键数组（可能为空）。
 */
export function failingTargets(withinMs = 2 * 60_000): string[] {
  const now = Date.now()
  const out: string[] = []
  for (const [key, f] of syncFailures) if (now - f.lastAt <= withinMs) out.push(key)
  return out
}

/**
 * 本 tick 里成功过的目标键（由 {@link noteSyncSuccess} 累积）。
 *
 * 为什么要有这个出口：`lastState` 是**乐观**记录的（`sync.ts` 在动手前就 `set`），
 * 所以「Map 里有没有某个键」**不能**当「它这次解成功了」用 —— 失败那条路会保留签名
 * （见 `noteSyncFailure` 的注释）。落盘那份账必须是成功子集，否则会把没解成功的目标
 * 也标成「已解密」，下次启动就跳过它 ⇒ 永久显示旧数据。
 * 而四个同步函数里一共有 8 处成功调用点，逐处改签名既啰嗦又容易漏，
 * 于是把「成功」这件事在**唯一的收口点**上攒成一份、tick 结束时一次取走。
 */
const syncSuccesses: string[] = []

/**
 * 取走并清空「本 tick 成功过的目标键」。
 * @returns 成功过的目标键数组（可能为空）。
 */
export function takeSyncSuccesses(): string[] {
  const out = syncSuccesses.slice()
  syncSuccesses.length = 0
  return out
}

/** 目标成功一次 ⇒ 清掉它的失败记录（下次失败从第一档重新计，且立即恢复日志可见性）。 */
export function noteSyncSuccess(key: string): void {
  syncFailures.delete(key)
  syncSuccesses.push(key)
}

/** 清空全部退避状态（测试用；生产里不需要）。 */
export function forgetSyncFailures(): void {
  syncFailures.clear()
}

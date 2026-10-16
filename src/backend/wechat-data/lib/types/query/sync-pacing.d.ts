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
 * 实时同步的轮询间隔（`sync.ts` 的 `setInterval` 用它，退避的第一档也用它）。
 * 放在这里是为了让"退避以轮询为基本单位"这件事**只有一个出处**。
 */
export declare const SYNC_INTERVAL_MS = 10000;
/** 退避上限：持续失败时 5 分钟试一次足够（用户修好密钥/关掉微信后能自然恢复）。 */
export declare const SYNC_FAILURE_MAX_MS: number;
/** 日志节流窗口：同一目标每分钟最多一行（9 个目标 ⇒ 峰值 ~9 行/分钟，不再是每秒刷屏）。 */
export declare const SYNC_LOG_THROTTLE_MS = 60000;
/** 超过这么久没有新的失败，就当上一段故障已经过去，计数从 1 重新开始。 */
export declare const SYNC_FAILURE_EPISODE_MS: number;
/**
 * 该目标现在是否处于失败退避期内。
 * @param key - 目标键（分片名 / `session.db` / label）。
 * @returns true = 跳过本轮（不重解密）。
 */
export declare function syncFailureBackoffActive(key: string): boolean;
/**
 * 记一次失败。
 * @param key - 目标键。
 * @param sigKey - 当前源签名串（仅记录，便于对照日志）。
 * @param message - 失败原因。
 * @returns 是否**现在**该打日志（受时间节流约束）。
 */
export declare function noteSyncFailure(key: string, sigKey: string, message: string): boolean;
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
export declare function failingTargets(withinMs?: number): string[];
/**
 * 取走并清空「本 tick 成功过的目标键」。
 * @returns 成功过的目标键数组（可能为空）。
 */
export declare function takeSyncSuccesses(): string[];
/** 目标成功一次 ⇒ 清掉它的失败记录（下次失败从第一档重新计，且立即恢复日志可见性）。 */
export declare function noteSyncSuccess(key: string): void;
/** 清空全部退避状态（测试用；生产里不需要）。 */
export declare function forgetSyncFailures(): void;

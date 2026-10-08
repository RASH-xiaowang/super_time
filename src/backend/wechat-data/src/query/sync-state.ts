/**
 * 同步的**跨进程签名账**：把「哪个目标的源文件、已被成功解密成什么版本」落到磁盘。
 *
 * ## 为什么要单独成文件
 *
 * `sync.ts` 已经贴着本仓的「单文件 1000 行」硬上限（实测 937 行，见
 * `src/backend/tests/m21-file-size-ratchet.spec.ts` 的 `LIMIT`），这套持久化有独立语义，
 * 按本仓既有做法（`sync-pacing.ts`、`image-warm.ts`）另起模块而不是往里塞。
 *
 * ## 这一层解决什么问题（实测）
 *
 * `sync.ts` 的 `lastState` 是**进程内存里的 `Map`**。它只在同一个后端进程内有意义：
 * 后端一重启就是空的 ⇒ 每个目标的 `prev === undefined` ⇒
 * `syncChangedShards` / `syncSessionDb` / `syncContactDb` / `syncPlainDatabase`
 * 一律把 `mode` 判成 `'full'` ⇒ **每次冷启动都把全树整库重解密一遍**，
 * 哪怕微信侧一个字节都没变、磁盘上的解密产物已经是��新的。
 *
 * 代价是实打实的：`sync.ts` 里 `message_1` 一次 ≈ **147 MB / 37456 页**（见该文件第 45 轮的
 * `[sync-trace]` 诊断注释），而 `fullDecryptFile` 每个调度步只处理 64 页
 * ⇒ 单个分片就是几百个让出点。这段整库重解密是「启动后首屏取数排不上队」的**已定位根因**
 * （`docs/PERF-THEME-LEDGER-2026-09-29.md` 第四节第 7 条，第 42 轮对照实验）：
 * 台账量到的 `前置 12 个页签 → 60153ms` 与「单点该面板只要 517ms」的差别就在这里。
 *
 * ## 为什么这样改**不会**拖慢「新消息可见」
 *
 * 本层只补一件事：**把「上次成功的源签名」跨进程记住**。判定逻辑一行没动 ——
 * 源签名没变 ⇒ 命中 `sync.ts` 里既有的「未变就 continue」分支（零工作量）；
 * 只有 WAL 变了 ⇒ 仍走既有的 `'wal'` 增量补丁路径；主库变了 ⇒ 仍走 `'full'`。
 * 也就是说实时同步的节奏与新鲜度**完全不受影响**，受益的只有「启动时不必白解一遍」。
 *
 * ## 失败方向：这一层的每一条分支都倒向「把活干完」
 *
 * 状态文件读不出来、版本不认识、条目形状不对、解密产物不存在或不是合法 SQLite ——
 * **一律按「没有这份账」处理，回到整库重解密**。理由很直接：
 * 误跳过一次的后果是**永久显示旧数据且没有任何提示**（面板照常出数，只是数是旧的），
 * 而多解一遍的代价只是启动慢几秒。把这一层写反了这个仓的规矩就是反的
 * （见 `docs/CONTRIBUTING.md` 第 5 节「存在性断言等于没断言」那条同源的口径）。
 *
 * 落点选在**数据根**（`decryptedDir` 的上一级，与 `all_keys.json` 同级）而不是解密目录里：
 * 它描述的是**源**的状态，不是产物的状态；放数据根也便于用户自己删掉它强制重来一次。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 与 `sync.ts` 的 `ShardSig` 同形（刻意不复用导出，避免两处形状漂移）。 */
export interface SyncSourceSig { main: string; wal: string }

const STATE_FILE = 'sync-state.json'

/** 账本格式版本：将来改结构时靠它把旧文件判成「不认识」⇒ 回到重解密。 */
const STATE_VERSION = 1

interface StateShape {
  version: number
  entries: Record<string, SyncSourceSig>
}

/** 已确认成功、等待落盘的条目（按目标键去重，后写覆盖先写）。 */
const pending = new Map<string, SyncSourceSig>()

function statePath(decryptedDir: string): string {
  return join(dirname(decryptedDir), STATE_FILE)
}

/** 只把「两个字段都是非空字符串」的条目认下来 —— 别的形状一律当没有。 */
function isSigShape(v: unknown): v is SyncSourceSig {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['main'] === 'string' && typeof o['wal'] === 'string'
}

/**
 * 读回上次成功解密时的源签名。
 *
 * 任何一步不成立（文件不存在 / 读失败 / JSON 坏了 / 版本不认识 / 条目形状不对）
 * 都返回一个**空 Map**，也就是「没有这份账」⇒ 调用方会整库重解密。
 * @param decryptedDir - 解密快照根（用于推出数据根）。
 * @returns 目标键 → 上次成功的源签名。空 = 没有可用的账。
 */
export function loadSyncSourceState(decryptedDir: string): Map<string, SyncSourceSig> {
  const out = new Map<string, SyncSourceSig>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(statePath(decryptedDir), 'utf8'))
  } catch {
    return out
  }
  if (typeof parsed !== 'object' || parsed === null) return out
  const rec = parsed as Record<string, unknown>
  if (rec['version'] !== STATE_VERSION) return out
  const entries = rec['entries']
  if (typeof entries !== 'object' || entries === null) return out
  for (const [key, sig] of Object.entries(entries as Record<string, unknown>)) {
    if (isSigShape(sig)) out.set(key, { main: sig.main, wal: sig.wal })
  }
  return out
}

/**
 * 记一次「这个目标的源签名已经成功解密成产物了」。
 *
 * 只写内存、不落盘：落盘由 {@link flushSyncSourceState} 在一个 tick 结束时统一做一次，
 * 免得每个目标各写一遍文件（同一轮 tick 里成功目标常有 8 个以上）。
 * @param key - 目标键（分片名 / `session.db` / label，与 `noteSyncSuccess` 的键同一个）。
 * @param sig - 刚刚成功解密的**源**签名。
 */
export function noteSyncSourceState(key: string, sig: SyncSourceSig): void {
  pending.set(key, { main: sig.main, wal: sig.wal })
}

/**
 * 把待落盘的条目并进既有账本并原子写回。
 *
 * 合并而不是覆盖：tick 内确认成功的目标只是账本的一部分，其余条目来自上一轮，
 * 直接覆盖会把没轮到它们的目标的账抹掉 ⇒ 下次启动它们会被误判成「没解过」。
 * @param decryptedDir - 解密快照根（用于推出数据根）。
 * @returns 是否真的写了盘（没有待写条目时为 false，便于测试与日志判读）。
 */
export function flushSyncSourceState(decryptedDir: string): boolean {
  if (pending.size === 0) return false
  const base = loadSyncSourceState(decryptedDir)
  for (const [key, sig] of pending) base.set(key, sig)
  pending.clear()
  const body: StateShape = { version: STATE_VERSION, entries: Object.fromEntries(base) }
  const target = statePath(decryptedDir)
  const tmp = target + '.tmp-' + String(process.pid) + '-' + String(Date.now())
  try {
    // 为什么用 tmp+rename 而不是直接写：写到一半崩掉会留下半截 JSON，
    // 下次启动读到它就「解析失败」⇒ 整树重解密（能自愈，但白烧一次 CPU）。
    writeFileSync(tmp, JSON.stringify(body), 'utf8')
    renameSync(tmp, target)
    return true
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 临时文件清理是尽力而为 */ }
    // 账本写不下去**不能**让同步失败：它是优化，不是数据。
    return false
  }
}

/** 清空待落盘条目（测试用）。 */
export function forgetPendingSyncSourceState(): void {
  pending.clear()
}
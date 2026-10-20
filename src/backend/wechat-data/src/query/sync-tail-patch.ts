/**
 * 主库**尾部增量**解密（2026-10-13，用户报「会话列表和消息窗口的新消息加载还是很慢」）。
 *
 * ## 背景与实测
 *
 * SQLite WAL 模式下，检查点把帧**追加**到主库文件尾部、不重写既有页（页 1 的头也
 * 不改——那是 WAL 读者安全性的根基）。而本仓旧路径把「主库签名变了」一律当整库重解：
 * 本机 message_0 是 82MB / 20026 页量级，轻负载实测一次 full ≈ 192ms；活跃聊天时检查点
 * 密集，6s 全量冷却（FULL_DECRYPT_COOLDOWN_MS）与整库重解叠加 ⇒ 新消息最坏滞后 6 秒多。
 * 尾部增量只解**新增的那几页**（一次检查点通常只长几页到几十页），毫秒级；且它不占
 * 冷却名额——冷却继续只卡真·全量。
 *
 * ## 正确性口径（宁可慢，不可错）
 *
 * 尾部路径必须同时满足：主库变大且增量为整页数、增量不超过 TAIL_MAX_PAGES、
 * 增量小于既有体积（翻倍式暴涨 = 疑似 rebuild，回全量）。拼好后还要过两道验：
 * `looksDecrypted`（头字节）与 **`PRAGMA quick_check`**（结构自检）——任何一道不通过，
 * 调用方退回整库重解。`quick_check` 是本方案的安全网：就算「只追加不重写」这个
 * 前提对某个微信版本不成立，坏快照也会在这里被拦下，绝不会发出去。
 *
 * @module query/sync-tail-patch
 */
import { open } from 'node:fs/promises'
import { withDb } from './db-open.ts'
import { yieldToLoop } from './search-build.ts'
import { PAGE_SZ, decryptPage } from './sqlcipher-page.ts'

/** 尾部增量允许的最大页数（2048 页 = 8MB）。再大就退回全量（收益趋近于零）。 */
export const TAIL_MAX_PAGES = 2048
/** 每解这么多页让出一次事件循环（与 query-yield-discipline 同一口径）。 */
const TAIL_YIELD_PAGES = 512

/**
 * 从「mtime:size」签名里取文件大小（字节）。
 * @param sig - ShardSig.main / .wal 的形状。
 * @returns 大小；解析不了为 null。
 */
function sizeOf(sig: string): number | null {
  const at = sig.lastIndexOf(':')
  if (at < 0) return null
  const n = Number(sig.slice(at + 1))
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * 判定一次「主库变化」能否走尾部增量。
 * @param prevMain - 上一次的主库签名（`mtime:size`）。
 * @param curMain - 当前签名。
 * @returns 可行则给出**原始文件内的偏移与页数**；否则 null（走全量）。
 */
export function tailAppendPlan(prevMain: string, curMain: string): { offset: number; pages: number } | null {
  const prevSize = sizeOf(prevMain)
  const curSize = sizeOf(curMain)
  if (prevSize === null || curSize === null || curSize <= prevSize) return null
  const delta = curSize - prevSize
  if (delta % PAGE_SZ !== 0) return null
  const pages = delta / PAGE_SZ
  if (pages > TAIL_MAX_PAGES || delta >= prevSize) return null
  return { offset: prevSize, pages }
}

/**
 * 解密原始主库**尾部**的 `pageCount` 页（自 `offset` 起），**追加**到 staging 快照末尾。
 * 每 {@link TAIL_YIELD_PAGES} 页让出一次事件循环（单线程 worker 上不能钉住别家的请求）。
 * @param rawDb - 原始加密主库路径。
 * @param stagingDb - 已就位的 staging 快照（旧快照的副本；新页追加到它尾部）。
 * @param offset - 原始文件内的字节偏移（上一次签名的大小）。
 * @param pageCount - 新增页数。
 * @param encKey - 派生密钥。
 * @returns 实际追加的页数。
 */
export async function decryptTailAppend(
  rawDb: string, stagingDb: string, offset: number, pageCount: number, encKey: Buffer,
): Promise<number> {
  const input = await open(rawDb, 'r')
  const output = await open(stagingDb, 'a')
  try {
    const page = Buffer.alloc(PAGE_SZ)
    let written = 0
    for (let i = 0; i < pageCount; i += 1) {
      const { bytesRead } = await input.read(page, 0, PAGE_SZ, offset + i * PAGE_SZ)
      if (bytesRead < PAGE_SZ) break
      const plain = decryptPage(encKey, page, 1 + Math.floor((offset + i * PAGE_SZ) / PAGE_SZ))
      await output.write(plain)
      written += 1
      if (written % TAIL_YIELD_PAGES === 0) await yieldToLoop()
    }
    return written
  } finally {
    await input.close().catch(() => { /* 只读句柄 */ })
    await output.close().catch(() => { /* 追加句柄 */ })
  }
}

/**
 * 对 staging 快照跑一次 `PRAGMA quick_check`（只读、随用随关，连接纪律见 db-open.ts）。
 * @param stagingDb - staging 快照路径。
 * @returns 自检通过为 true；任何异常（打不开 / 缺表 / 结构坏）为 false。
 */
/**
 * 快照的 schema 还能不能被 SQLite 正常加载（2026-10-18，增量补丁的前置自愈判据）。
 *
 * `quick_check` 只有在目标还能打开时才有意义；快照坏到 `sqlite_master` 都读不出时，
 * 补丁只会一路报错、最后还是整库重解密。同步循环先用这个便宜判据：目标 schema 坏 ⇒
 * 直接走整库重解（自愈），不要在一块坏快照上继续打补丁。
 * @param file - 快照分片路径。
 * @returns 能读到 `sqlite_master` 首行即 true；打不开/结构坏都 false。
 */
export function schemaIntact(file: string): boolean {
  try {
    const row = withDb(file, (db) => db.prepare('SELECT 1 AS ok FROM sqlite_master LIMIT 1').get())
    return row !== undefined
  } catch { return false }
}

export function tailQuickCheckOk(stagingDb: string): boolean {
  try {
    const row = withDb(stagingDb, (db) => db.prepare('PRAGMA quick_check').get()) as { quick_check?: string } | undefined
    return row?.quick_check === 'ok'
  } catch {
    return false
  }
}

/**
 * 启动后的**低优先级预热**（W3-1.3 / W3-3.4）。
 *
 * ## 它解决什么
 *
 * 两类数据此前都是「第一次用到时当场算」：
 *   · `shardCatalog` —— 逐张消息分片开库、枚举 `Msg_*` 表、读列。冷启动后第一次进
 *     会话列表/搜索要付这笔钱（`sessions.ts` 的诊断显示单次 78ms 里有 41 次开库）。
 *   · `contact_fts` —— 成员搜索的 FTS 表。**第一次搜索**时才发现没建，于是那次搜索
 *     要等整份 contact.db 灌进去（大账号上是「点了搜索转好久圈」）。
 *
 * ## 三条设计约束
 *
 *   ① **不阻塞启动**：调用方用 `setImmediate` + `void` 排到当前 tick 之后（见
 *      gateway 的 init）。窗口出现的路径上不该绑着一次可能几百毫秒的预热。
 *   ② **不抢写闸**：`contact_fts` 真要建表时走 `withIndexWrite` 同一个闸；拿不到就
 *      本次跳过（`busy`），下次预热再来。反过来「等锁」会把同步的成员搜索一起堵住。
 *   ③ **失败只留痕**：预热是优化，不是功能。炸了也不能让后端起不来。
 *
 * 本文件不 import react/cordis，纯 Node —— 单测可以直接喂一个合成数据根验证
 * 「预热后确实能命中」。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from './db-open.ts'

import { shardCatalog } from './meta.ts'
import { searchIndexPath } from './search-scaffold.ts'
import { ensureContactFts } from './members.ts'

/** 一次预热的结果（日志与单测都用它）。 */
export interface PrewarmReport {
  /** 分片目录：解析到几张分片（0 = 没解析到任何分片，可能数据根还没配）。 */
  shards: number
  /** contact_fts 的状态。 */
  fts: 'ready' | 'busy' | 'unavailable' | 'no-index-db' | 'skipped'
  ftsError: string
}

/**
 * 跑一次启动预热。
 *
 * 顺序有意：**先分片目录、后 contact_fts**。前者是纯读（不会失败到哪儿去），
 * 后者要写索引库；把便宜的放前面，失败的也先暴露出来。
 *
 * 不在本函数里建索引库：那会让启动多一次全量建索引的写入，而用户可能只是想让窗口
 * 赶紧出来。真要建时搜索路径自己会建（`searchGlobalMembers` → `ensureContactFts`）。
 *
 * @param decryptedDir - 已解密数据根。
 * @returns 报告（不抛）。
 */
export function prewarmAfterInit(decryptedDir: string): PrewarmReport {
  const report: PrewarmReport = { shards: 0, fts: 'skipped', ftsError: '' }
  // 注意这里**没有** try/catch：第一版包了，后来发现
  // `shardCatalog` → `dirSig` 自己把 readdir 失败吗下了（返回 null），
  // 所以这个 catch 根本走不到 —— 死分支比没有分支更坏（会让人以为它在保护什么）。
  // 「分片目录读不动」的可见性由 `dirSig` d5d责，不在这里重复。
  report.shards = shardCatalog(decryptedDir).length

  const p = searchIndexPath(decryptedDir)
  if (!existsSync(p)) {
    report.fts = 'no-index-db'
    return report
  }
  try {
    const db = new DatabaseSync(p)
    try {
      report.fts = ensureContactFts(db, decryptedDir)
    } finally {
      db.close()
    }
  } catch (e) {
    report.fts = 'unavailable'
    report.ftsError = e instanceof Error ? e.message : String(e)
  }
  return report
}

/** 预热是否值得留痕（有内容 or 有异常）。 */
export function prewarmIsNotable(r: PrewarmReport): boolean {
  // 有内容（分片真解析出来了）、或者有异常（FTS 失败/写闸被占）才留痕。
  return r.shards > 0 || r.ftsError !== '' || r.fts === 'busy'
}

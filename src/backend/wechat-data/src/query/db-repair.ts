/**
 * 损坏库修复链路（W3-11.7）：**体检 → 本地清残留 → 只重解密仍坏的那几个 → 复检**。
 *
 * ## 为什么值得单独一个模块
 *
 * `wechat-host.js` 的处方说「库文件已损坏 ⇒ 到数据库健康体检，必要时对该库重新解密」，
 * 而修复这件事此前**没有任何一条代码路径**：`decryptAllDbs` 只会被「立即解密」整库调用
 * （22 个库一律重解），用户即使知道「坏的是哪个」也无从下手。本模块把处方补成动作：
 *
 *   ① `checkDecryptedIntegrity`（db-health.ts）逐库体检，拿到损坏清单；
 *   ② **先在本地清掉上一代残留的 `-wal`/`-shm`（一个字节都不读原始库）**，再复检 ——
 *      这是 2026-10-13 真机那条 `message/message_0.db` 的病灶：主文件完好，旁边躺着一份
 *      795 帧 / 3.2MB 的上一代 WAL，于是每次读都 `database disk image is malformed`。
 *      重解密治不了它（换的只是主文件，旁文件还在），而重解密要读微信目录里那个 80MB+
 *      的原始分片 —— 既没用，又正是用户说的「别和微信抢资源」；
 *   ③ 仍坏的按 rel 键映射回原始 `db_storage` —— **原始库不在的修不了**，
 *      如实记进 `unrepairable`，不假装修过；
 *   ④ `decryptAllDbs(..., onlyRel)` 只重解密这几个（不整库重解）；
 *   ⑤ 复检一遍，用「found / repaired / stillCorrupted」回答「原来坏几个、现在好了几个」。
 *
 * ## 为什么修完必须复检
 *
 * 重解密「成功」只代表文件被原子替换了，不代表它现在是好的（密钥错、源本身撕裂都会
 * 让新的产物同样坏）。不复检就把 `ok` 报出去，用户看到「修复完成」再刷新一次，
 * 读到的是同一句 malformed —— 那比不修更糟。
 *
 * @module query/db-repair
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DbIntegrityResult, DbRepairResult } from '../types.ts'
import { checkDecryptedIntegrity } from './db-health.ts'
import { decryptAllDbs } from './decrypt-all.ts'
import { discardSupersededWal, strayWalBlocks } from './snapshot-sidecars.ts'

/**
 * 修复解密快照里损坏的库：本地清残留 → 仍坏的从本机原始 `db_storage` 重新解密**且仅这几个**。
 *
 * 与「立即解密」共用同一条原子发布路径（`decryptAllDbs` ⇒ `sync.ts#atomicReplace`），
 * 所以修复期间并发只读查询看到的仍是旧快照（目标被占用时重试，不会半途替换）。
 * @param rawDbDir - raw WeChat db_storage dir（config 的 `db_dir`）。未配置/不存在时
 *   由 `decryptAllDbs` 给出配置类错误，本函数原样带回 `error`。
 * @param decryptedDir - decrypted snapshot root.
 * @param onProgress - per-database progress callback（done/total/message）；total 随着
 *   修复范围走（损坏几个就是几），不是全库总数。
 * @returns 修复结果（一个都没坏时 `found: 0` 且 `ok: true`，不做任何写操作）。
 */
export async function repairCorruptDbs(
  rawDbDir: string,
  decryptedDir: string,
  onProgress?: (done: number, total: number, message: string) => void,
): Promise<DbRepairResult> {
  const before: DbIntegrityResult = await checkDecryptedIntegrity(decryptedDir)
  if (before.corrupted.length === 0) {
    return {
      ok: true, checked: before.checked, found: 0, repaired: 0,
      stillCorrupted: [], failed: [], unrepairable: [], unreadable: before.unreadable,
      uncheckable: before.uncheckable,
    }
  }

  // ① 本地那一半：只删旁文件（`-wal`/`-shm`），**不读原始库**。有残留才复检 ——
  //    复检是整库扫描（本机好几个百兆分片），没动过就不该白扫一遍。
  let touched = false
  for (const c of before.corrupted) {
    const abs = join(decryptedDir, c.file)
    if (strayWalBlocks(abs)) {
      touched = true
      await discardSupersededWal(abs)
    }
  }
  const local: DbIntegrityResult = touched ? await checkDecryptedIntegrity(decryptedDir) : before
  const repairedLocally = touched
    ? before.corrupted.filter((c) => !local.corrupted.some((l) => l.file === c.file)).length
    : 0

  // ② 仍坏的 → 原始库必须还在：raw 不在的（被微信清理 / 数据根换过）修不了，
  //    记进 unrepairable 让界面说清「为什么这个修不好」，而不是静默跳过。
  const repairable: string[] = []
  const unrepairable: Array<{ file: string; reason: string }> = []
  for (const c of local.corrupted) {
    const raw = join(rawDbDir, c.file)
    if (!rawDbDir || !existsSync(raw)) {
      unrepairable.push({ file: c.file, reason: '原始 db_storage 里没有对应文件（可能已被微信清理或数据目录已更改）' })
    } else {
      repairable.push(c.file)
    }
  }
  const finish = (r: { failed: Array<{ db: string; error: string }>; error?: string } | null, after: DbIntegrityResult): DbRepairResult => {
    const repairableSet = new Set(repairable)
    const stillCorrupted = after.corrupted.filter((c) => repairableSet.has(c.file))
    return {
      ok: stillCorrupted.length === 0 && (r?.failed.length ?? 0) === 0 && unrepairable.length === 0
        && (r?.error === undefined),
      checked: before.checked,
      found: before.corrupted.length,
      repaired: repairedLocally + (repairable.length - stillCorrupted.length),
      stillCorrupted,
      failed: r?.failed ?? [],
      unrepairable,
      unreadable: after.unreadable,
      uncheckable: after.uncheckable,
      ...(r?.error !== undefined ? { error: r.error } : {}),
    }
  }

  // 本地就修干净了（`message_0.db` 那一类）⇒ 原始库一个字节都不碰。
  if (repairable.length === 0) return finish(null, local)

  const r = await decryptAllDbs(
    rawDbDir,
    decryptedDir,
    (done, total, _failed, message) => { onProgress?.(done, total, message) },
    repairable,
  )
  if (r.error !== undefined) {
    return {
      ok: false, checked: before.checked, found: before.corrupted.length,
      repaired: repairedLocally, stillCorrupted: local.corrupted.filter((c) => repairable.includes(c.file)),
      failed: [], unrepairable, unreadable: local.unreadable, uncheckable: local.uncheckable,
      error: r.error,
    }
  }

  // ③ 复检：只认「修过的那几个」的当前状态。别的库这一轮没动，它的旧结论不翻案。
  const after: DbIntegrityResult = await checkDecryptedIntegrity(decryptedDir)
  return finish(r, after)
}

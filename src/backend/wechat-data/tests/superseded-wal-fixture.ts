/**
 * 「上一代残留的 WAL」现场生成器（2026-10-13 真机故障的夹具）。
 *
 * ## 真机现场（`decrypted/message/message_0.db`）
 *
 * 主文件一个字节都没坏，旁边却躺着一份 **795 帧 / 3.2MB 的上一代 WAL**：
 * `PRAGMA page_count` 读成 20054、`integrity_check` 报
 * `2nd reference to page 19803` / `Rowid 6541 out of order`，界面上就是
 * `database disk image is malformed`；把 `-wal` 拿走，同一个主文件立刻 `ok`。
 *
 * ## 为什么夹具要这么造
 *
 * SQLite 应用 WAL 时不校验它属于哪个主文件，只要帧自洽就盖上去。所以「poison」要成立，
 * 那份 WAL 必须是一代**部分页**的写入（page 1 + 被改过的少数页），而主文件要是**另一代**
 * （页布局不同）—— 两者一混，页树就自相矛盾。两层都不能省：
 *   · 只换 WAL、主文件还是原来那代 ⇒ 什么都不会发生（本来就是一伙的）；
 *   · WAL 覆盖了整棵树 ⇒ 结果退化成那份 WAL 自己那一代，照样自洽。
 * 所以这里是：基线库 → 只改少量行产出一份部分页 WAL → 另一份 `VACUUM` 过的库当主文件。
 * @module tests/superseded-wal-fixture
 */
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 同一目录里可能被调多次（一条用例里既造对照组又造现场），文件名必须唯一。 */
let seq = 0
function next(dir: string, stem: string): string {
  seq += 1
  return join(dir, `${stem}-${String(seq)}.db`)
}

/**
 * 造「上一代残留的 WAL」。
 * @param dir - 放夹具文件的目录（调用方自备临时目录）。
 * @returns `staleMain` = 它本该配的那份主文件；`wal` = 那份部分页 WAL 的留档路径。
 */
export function makeSupersededWal(dir: string): { staleMain: string; wal: string } {
  const stale = next(dir, 'stale')
  let db = new DatabaseSync(stale)
  db.exec('CREATE TABLE t (a INTEGER, b TEXT)')
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO t VALUES (?, ?)')
  for (let i = 0; i < 5000; i += 1) ins.run(i, 'x'.repeat(300))
  db.exec('COMMIT')
  db.close()

  db = new DatabaseSync(stale)
  db.exec('PRAGMA journal_mode=WAL')
  // 自动 checkpoint 会把帧挪回主文件、把 WAL 重置掉 —— 关掉它，帧才留得住。
  db.exec('PRAGMA wal_autocheckpoint=0')
  db.exec("UPDATE t SET b = 'zz' WHERE a < 50")
  const wal = stale.replace(/\.db$/, '.wal')
  copyFileSync(stale + '-wal', wal)
  db.close()
  return { staleMain: stale, wal }
}

/**
 * 造**另一代**主文件：表结构与页布局都不同（对一份 400 行 / 700 字节的库 `VACUUM` 过）。
 * @param dir - 放夹具文件的目录。
 * @returns 那份主文件的路径。
 */
export function makeOtherGeneration(dir: string): string {
  const other = next(dir, 'next-gen')
  const db = new DatabaseSync(other)
  db.exec('CREATE TABLE u (q BLOB)')
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO u VALUES (?)')
  for (let i = 0; i < 400; i += 1) ins.run('q'.repeat(700))
  db.exec('COMMIT')
  db.exec('VACUUM')
  db.close()
  return other
}

/**
 * 读一次 `PRAGMA integrity_check`：`'ok'`，否则给出前两条判词（抛错也如实记成一行）。
 * @param file - 待读的库。
 * @returns 判词字符串。
 */
export function verdictOf(file: string): string {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const v = db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0]))
      return v.length === 1 ? String(v[0]) : v.slice(0, 2).join(' | ')
    } finally { db.close() }
  } catch (e) {
    return 'threw: ' + (e as Error).message
  }
}

/**
 * 把「另一代主文件 + 上一代 WAL」摆成一套现场，返回被污染的主文件路径。
 * @param dir - 放夹具文件的目录。
 * @param baseName - 被污染主文件的名字（调用方按快照目录里的相对路径取）。
 * @param wal - 上一代那份 WAL（由 {@link makeSupersededWal} 给出）。
 * @returns 被污染的主文件路径。
 */
export function plantPoisonedPair(dir: string, baseName: string, wal: string): string {
  const target = join(dir, baseName)
  copyFileSync(makeOtherGeneration(dir), target)
  copyFileSync(wal, target + '-wal')
  return target
}

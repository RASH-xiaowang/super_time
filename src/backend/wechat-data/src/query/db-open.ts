/**
 * 生产侧的一次性只读连接（P0-1 / CODE-AUDIT-2026-09-26）。
 *
 * ## 为什么要有这个文件
 *
 * `query/**` 里原先各处自己写「try 内 `new DatabaseSync` → 成功路径 `db.close()` → catch 吞掉」。
 * 那个形状**在异常路径上必然漏 close**：`db` 是 try 块内的 `const`，catch 里根本拿不到它，
 * 于是「库损坏 / SQLITE_BUSY / 缺表」一次就泄漏一个 SQLite 句柄。
 * 病因与后果本仓在测试助手 `src/backend/tests/helpers/temp-db.ts` 里已经实测并写明了 ——
 * Windows 下同一进程只要还有一条连接开着，`rmSync` 就**确定性地**报 `EPERM` 且重试无效，
 * 所以泄漏不只是「占资源」，而是「解密目录 / 备份再也替换不掉」。
 * 修复过去只落在测试助手，生产 `query/` 层仍在犯同一个错 —— 本文件把它收口到一处。
 *
 * ## 语义
 *
 * 只读打开 → 跑回调 → **无论成败**都 close（`finally`）。回调可以 `return` 提前退出，
 * 不必记得关连接；抛错也一样，错误原样上抛给调用方决定怎么降级。
 *
 * @module query/db-open
 */
import { DatabaseSync } from '../sqlite-connection.ts'
export { configureSqliteCachePolicy, DatabaseSync } from '../sqlite-connection.ts'

/**
 * 以只读方式打开一个库，跑完 `fn` 后无条件关闭。
 *
 * 需要可写连接的调用点**不要**用它（本助手只覆盖读路径 —— 那正是漏 close 的高发区）。
 * @param file - 数据库文件绝对路径（必须已存在，只读打开不会创建）。
 * @param fn - 收到连接的回调；它的返回值即本函数的返回值。
 * @returns `fn` 的返回值。
 * @throws 打开失败或 `fn` 抛出的异常原样抛出（连接已在 finally 里关掉）。
 */
export function withDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return fn(db)
  } finally {
    // close 自己抛错不许盖掉 fn 的原始错误（「库损坏」比「关不上」更值得看见）。
    try {
      if (db.isOpen) db.close()
    } catch { /* 连接已失效：交给 isOpen 兜底，不掩盖原始错误 */ }
  }
}

/**
 * 以**可写**方式打开一个库，跑完 `fn` 后无条件关闭。
 *
 * 与 `withDb` 分开的理由只有一条：那颗 helper 刻意只覆盖读路径（P0-1 的口径），
 * 而"能不能写"是行为差别，不该靠调用点传参去记。写路径同样会漏 —— 表现是 UPDATE / DELETE
 * 抛错之后连接留在进程里（Windows 上那个库从此换不掉、也删不掉），所以形状与读路径一致：
 * 无论成败都关，错误原样上抛。
 * @param file - 数据库文件路径（不存在时由 SQLite 创建；调用点若要求"必须已存在"要先自己判）。
 * @param fn - 收到连接的回调；它的返回值即本函数的返回值。
 * @returns `fn` 的返回值。
 * @throws 打开失败或 `fn` 抛出的异常原样抛出（连接已在 finally 里关掉）。
 */
export function withWritableDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file)
  try {
    return fn(db)
  } finally {
    try {
      if (db.isOpen) db.close()
    } catch { /* 连接已失效：交给 isOpen 兜底，不掩盖原始错误 */ }
  }
}

/**
 * 异步版：连接必须**跨过 await** 才关得掉（P1-2 的让出型查询必需）。
 *
 * ## 为什么不能把 `await` 写进 {@link withDb} 的回调里
 *
 * `withDb` 的 `finally` 在 `fn` **同步返回**的那一刻就跑了。回调里只要有 `await`，
 * 它返回的是一个还没 settle 的 Promise ⇒ 连接在第一次让出时就被关掉，
 * 游标(`iterate()`)随后接着读一个已关闭的连接 —— 表现是「偶发的 database is not open」，
 * 而且只在数据大到真的让出过一次的时候才出现（小库上恒绿，是最难查的那一类）。
 *
 * 所以让出型查询一律走这一版：打开 → 等回调真的算完 → 无论成败都关。
 * @param file - 数据库文件绝对路径（必须已存在，只读打开不会创建）。
 * @param fn - 收到连接的异步回调；它 resolve 的值即本函数 resolve 的值。
 * @returns `fn` resolve 出来的值。
 * @throws 打开失败或 `fn` reject 的原因原样抛出（连接已在 finally 里关掉）。
 */
export async function withDbAsync<T>(file: string, fn: (db: DatabaseSync) => Promise<T>): Promise<T> {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return await fn(db)
  } finally {
    try {
      if (db.isOpen) db.close()
    } catch { /* 同上：不掩盖原始错误 */ }
  }
}

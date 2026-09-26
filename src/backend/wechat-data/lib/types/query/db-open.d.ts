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
import { DatabaseSync } from 'node:sqlite';
/**
 * 以只读方式打开一个库，跑完 `fn` 后无条件关闭。
 *
 * 需要可写连接的调用点**不要**用它（本助手只覆盖读路径 —— 那正是漏 close 的高发区）。
 * @param file - 数据库文件绝对路径（必须已存在，只读打开不会创建）。
 * @param fn - 收到连接的回调；它的返回值即本函数的返回值。
 * @returns `fn` 的返回值。
 * @throws 打开失败或 `fn` 抛出的异常原样抛出（连接已在 finally 里关掉）。
 */
export declare function withDb<T>(file: string, fn: (db: DatabaseSync) => T): T;

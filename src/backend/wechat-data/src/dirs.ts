/**
 * WeChat data root resolution + one-time bootstrap.
 *
 * The migrated plugin owns its data under the DeepSeek Harness home instead
 * of reading st_control's working tree in place. The root is
 * `$DSH_HOME/wechat-data` (default `~/.dsh/wechat-data`), overridable with
 * `DSH_WECHAT_DATA_DIR`. Inside the root the layout mirrors st_control's
 * `data/wechat` directory so the query modules keep working unchanged:
 *
 *   <root>/decrypted/          decrypted SQLite libraries (read)
 *   <root>/decoded_images/     decoded image cache (read/write)
 *   <root>/message_edits.db    edit store (write)
 *   <root>/daily_summary.db    daily-summary store (write)
 *   <root>/wechat_search.db    search index (write)
 *   <root>/backups/            backup snapshots (write)
 *   <root>/exports/            CSV/TXT exports (write)
 *   <root>/config.json         WeChat config (read/write)
 *   <root>/all_keys.json       generated keys info (write)
 *
 * On first use the root is bootstrapped from the source `data/wechat`
 * directory (default `C:/Users/28361/Desktop/ST/st_control/data/wechat`,
 * overridable with `DSH_WECHAT_SOURCE_DIR`): `decrypted`, `decoded_images`
 * and existing write stores are copied once; later runs read/write only the
 * DSH-owned root. SQLite 主库的 `-wal` 随主库一起拷（`-shm` 不拷，见
 * `copyFileWithWal` —— WAL 模式下新数据可能整代都还压在 `-wal` 里，只拷主库
 * 会静默落后一代）。Legacy env overrides `DSH_WECHAT_DECRYPTED_DIR` /
 * `DSH_WECHAT_DECODED_DIR` bypass the root entirely (explicit user pinning).
 */
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Legacy explicit override env var for the decrypted dir (bypasses the root). */
export const DECRYPTED_DIR_ENV = 'DSH_WECHAT_DECRYPTED_DIR'
/** Legacy explicit override env var for the decoded images dir. */
export const DECODED_DIR_ENV = 'DSH_WECHAT_DECODED_DIR'
/** Data-root override env var (highest precedence over the DSH home default). */
export const DATA_DIR_ENV = 'DSH_WECHAT_DATA_DIR'
/** Bootstrap source override env var. */
export const SOURCE_DIR_ENV = 'DSH_WECHAT_SOURCE_DIR'

/** Default bootstrap source: unset — bootstrap requires an explicit env override. */
export const DEFAULT_SOURCE_DIR = ''

/** Subdirectories/files copied from the source during bootstrap. */
const BOOTSTRAP_ITEMS = ['decrypted', 'decoded_images', 'message_edits.db', 'daily_summary.db', 'wechat_search.db', 'wechat_tasks.db', 'config.json', 'secrets.json', 'keys.json', 'all_keys.json'] as const

/** Suffixes that are never copied as standalone entries (SQLite runtime artifacts). */
const SKIP_SUFFIXES = ['-wal', '-shm'] as const

/** SQLite 主库文件头的前 16 字节。 */
const SQLITE_FILE_HEADER = 'SQLite format 3\u0000'

/** True when a name is a SQLite runtime artifact (e.g. session.db-wal). */
function isRuntimeArtifact(name: string): boolean {
  return SKIP_SUFFIXES.some(suffix => name.endsWith(suffix))
}

/**
 * 是否为**真的** SQLite 主库：只读 16 字节文件头，不打开库（打开会建 `-shm`、也可能触发恢复）。
 * @param path - 候选文件路径。
 * @returns 文件头匹配 `SQLite format 3\0` 时为 true。
 */
function isSqliteDatabase(path: string): boolean {
  let fd: number | undefined
  try {
    const header = Buffer.alloc(16)
    fd = openSync(path, 'r')
    return readSync(fd, header, 0, 16, 0) === 16 && header.toString('latin1') === SQLITE_FILE_HEADER
  } catch {
    return false
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already closed */ } }
  }
}

/**
 * 拷贝一个文件；若它是真的 SQLite 主库，连它的 `-wal` 一起拷（顺序：主库先，`-wal` 后）。
 *
 * 为什么必须连 `-wal` 一起拷：WAL 模式下新提交的数据可能**整代都还在 `-wal` 里**（主库只在
 * checkpoint 时才被回填）。H9 已在构建 COMMIT 后尽力 `PRAGMA wal_checkpoint(TRUNCATE)`，但
 * **有并发读者（游标未读完）时它拿不到锁**（实测返回 `{busy:1, checkpointed:0}` 且不抛错），
 * 所以「只拷主库」在源端应用/读者还在跑时必然静默拷出**上一代**索引（实测 rows 少一半、
 * built_at 是旧的）。
 *
 * 为什么不拷 `-shm`：它是 WAL 索引（可重建的临时结构），SQLite 明确要求**不可**连同库文件
 * 一起搬 —— 陈旧/异机的 `-shm` 会让读者按错误的 WAL 视图去读。目标端第一次打开时会自己
 * 按 `-wal` 重建它。
 *
 * 为什么先看文件头：`-wal` 只有**真的** SQLite 主库才有语义。非库文件旁边的同名文件不是
 * SQLite 状态，照旧按运行时产物跳过（`dirs.spec.ts` 有一条断言钉着这个行为）。
 *
 * 为什么主库在前、`-wal` 在后：回放 WAL 只会把库**向前**推进。若两次拷贝之间源端又把 WAL
 * 重置/截断了，我们拷到的 `-wal` 盐值已失效 → SQLite 按校验和直接忽略它，退化成「主库那份
 * 自洽（略旧）的快照」；反过来先拷 `-wal` 再拷主库，则可能出现「用旧 WAL 帧覆盖主库里更新
 * 的页」的降级回放。
 * @param src - 源文件路径。
 * @param dest - 目标文件路径。
 * @returns 连带拷了 `-wal` 时返回 true。
 */
function copyFileWithWal(src: string, dest: string): boolean {
  cpSync(src, dest, { recursive: false })
  if (!isSqliteDatabase(src)) return false
  const walSrc = src + '-wal'
  if (!existsSync(walSrc)) return false
  cpSync(walSrc, dest + '-wal', { recursive: false })
  return true
}

/**
 * Recursively copy a directory/file, carrying SQLite `-wal` sidecars with their main database
 * and skipping `-shm` runtime files.
 * @param src - source path.
 * @param dest - destination path.
 * @param walCarried - collects destination paths of the `-wal` sidecars that were carried over.
 */
function copyTree(src: string, dest: string, walCarried: string[]): void {
  const st = statSync(src)
  if (!st.isDirectory()) {
    const name = src.split(/[\\/]/).pop() ?? ''
    // `-wal`/`-shm` 不单独拷：`-wal` 只作为所属主库的副产物拷（见 copyFileWithWal）。
    if (isRuntimeArtifact(name)) return
    if (copyFileWithWal(src, dest)) walCarried.push(dest + '-wal')
    return
  }
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (isRuntimeArtifact(entry.name)) continue
    copyTree(join(src, entry.name), join(dest, entry.name), walCarried)
  }
}

/**
 * Resolve the plugin-owned WeChat data root.
 * @param env - environment mapping (defaults to process.env).
 * @returns the absolute data root path.
 */
export function resolveWechatDataRoot(env: Record<string, string | undefined> = process.env): string {
  const explicit = env[DATA_DIR_ENV]
  if (explicit !== undefined && explicit.trim().length > 0) return resolve(explicit.trim())
  return resolve(join(resolveDshHome(undefined, env), 'wechat-data'))
}

/**
 * Resolve the decrypted-dir the queries read.
 * @param env - environment mapping.
 * @returns explicit override when pinned, otherwise `<root>/decrypted`.
 */
export function resolveDecryptedDir(env: Record<string, string | undefined> = process.env): string {
  const pinned = env[DECRYPTED_DIR_ENV]
  if (pinned !== undefined && pinned.trim().length > 0) return resolve(pinned.trim())
  return join(resolveWechatDataRoot(env), 'decrypted')
}

/**
 * Resolve the decoded-images cache dir.
 * @param env - environment mapping.
 * @returns explicit override when pinned, otherwise `<root>/decoded_images`.
 */
export function resolveDecodedDir(env: Record<string, string | undefined> = process.env): string {
  const pinned = env[DECODED_DIR_ENV]
  if (pinned !== undefined && pinned.trim().length > 0) return resolve(pinned.trim())
  return join(resolveWechatDataRoot(env), 'decoded_images')
}

/**
 * Resolve the bootstrap source directory.
 * @param env - environment mapping.
 * @returns the source dir, or null when unset/empty.
 */
export function resolveSourceDir(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env[SOURCE_DIR_ENV]
  if (explicit !== undefined && explicit.trim().length > 0) return resolve(explicit.trim())
  return null
}

/**
 * One-time bootstrap: copy `decrypted`/`decoded_images` and any existing
 * write stores from the source into the DSH-owned data root. Idempotent —
 * a root that already contains `decrypted` is left untouched. Explicit
 * legacy overrides bypass the root, so nothing is copied in that mode.
 *
 * SQLite 主库的 `-wal` 会随主库一起拷（见 copyFileWithWal）；`walCarried` 就是给调用方
 * 留痕迹用的 —— 「这次拷的是不是最新一代」不能只靠猜。
 * @param env - environment mapping.
 * @returns what was copied (or skipped), for observability.
 */
export function bootstrapWechatData(
  env: Record<string, string | undefined> = process.env,
): { root: string; copied: string[]; skipped: boolean; walCarried: string[] } {
  const root = resolveWechatDataRoot(env)
  if (env[DECRYPTED_DIR_ENV] !== undefined && env[DECRYPTED_DIR_ENV].trim().length > 0) {
    return { root, copied: [], skipped: true, walCarried: [] }
  }
  const decrypted = join(root, 'decrypted')
  if (existsSync(decrypted)) return { root, copied: [], skipped: true, walCarried: [] }
  const source = resolveSourceDir(env)
  if (source === null || !existsSync(source)) {
    return { root, copied: [], skipped: true, walCarried: [] }
  }
  const copied: string[] = []
  const walCarried: string[] = []
  for (const item of BOOTSTRAP_ITEMS) {
    const src = join(source, item)
    const dest = join(root, item)
    if (!existsSync(src)) continue
    copyTree(src, dest, walCarried)
    copied.push(item)
  }
  return { root, copied, skipped: false, walCarried }
}

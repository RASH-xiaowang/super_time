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
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from './sqlite-connection.ts'
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
 * 拷一个 SQLite 库：优先 `VACUUM INTO`（自洽单文件），退路是「主库 + `-wal`」两次读。
 *
 * ## 为什么要 `VACUUM INTO`（W2-8.5）
 *
 * N11 已经把「只拷主库会静默落后一代」这件事修掉了 —— 办法是把 `-wal` 一起带过去。
 * 但那是**两次独立的文件读**，中间源端还在跑：checkpoint 期间 SQLite 是**直接把页写进
 * 主库文件**的，于是拷贝到的主库可能停在「回填了一半」的那一代，而 `-wal` 又已经被
 * 回填过的帧留在里面 —— 两半拼起来不是任何一代，SQLite 会报 malformed 或读出脏页。
 * 这就是撕裂窗口：它不需要任何 bug，只需要源端还在写。
 *
 * `VACUUM INTO` 是 SQLite 官方的「一致性单文件快照」入口（在线备份 API 的 SQL 形态）：
 * 它在一个读事务里把库整份重写到一个**新**文件，写出来的必然自洽、天然没有 `-wal`。
 * 撕裂窗口不是被「缩小」了，是从根上不存在了。
 *
 * ## 退路（不能省）
 *
 * `VACUUM INTO` 会失败：文件头是 SQLite 但内容坏了、目录只读导致 `-shm` 建不出来、
 * 目标路径已存在等等。这时必须**退回**「主库 + `-wal`」—— 宁可有一对可能撕裂的页，
 * 也不能让 bootstrap 直接失败把用户挡在门外。
 *
 * @param src - 源文件路径。
 * @param dest - 目标文件路径（`VACUUM INTO` 要求它尚不存在）。
 * @param vacuumed - 收集「走了 `VACUUM INTO`」的目标路径，给调用方留痕迹。
 * @returns 连带拷了 `-wal` 时返回 true（走了退路）。
 */
function copyFileWithWal(src: string, dest: string, vacuumed: string[]): boolean {
  if (isSqliteDatabase(src) && existsSync(src + '-wal') && vacuumInto(src, dest)) {
    vacuumed.push(dest)
    return false
  }
  cpSync(src, dest, { recursive: false })
  if (!isSqliteDatabase(src)) return false
  const walSrc = src + '-wal'
  if (!existsSync(walSrc)) return false
  cpSync(walSrc, dest + '-wal', { recursive: false })
  return true
}

/** 把路径转成 SQL 字符串字面量（单引号按 SQL 规则写两遍）。 */
function sqlString(p: string): string {
  return "'" + p.split("'").join("''") + "'"
}

/**
 * 用 `VACUUM INTO` 给源库取一份自洽快照（W2-8.5）。
 *
 * 只读打开：源目录不该被 bootstrap 改动。只读打开不了（`-shm` 建不出来等）就交回退路，
 * 不去用读写打开 —— 那会在源目录里留下 `-shm`/`-wal` 副作用。
 *
 * @param src - 源库路径。
 * @param dest - 目标路径（必须尚不存在，`VACUUM INTO` 不肯覆盖）。
 * @returns 成功时 true。
 */
function vacuumInto(src: string, dest: string): boolean {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(src, { readOnly: true })
    db.exec('VACUUM INTO ' + sqlString(dest))
    db.close()
    return true
  } catch {
    // 失败时可能已经写了一半：必须清掉，否则退路里的 cpSync 会撞上「目标已存在」。
    if (db !== undefined) { try { db.close() } catch { /* 已经关过了 */ } }
    try { rmSync(dest, { force: true }) } catch { /* 清不掉就让退路自己报错 */ }
    return false
  }
}

/**
 * Recursively copy a directory/file, carrying SQLite `-wal` sidecars with their main database
 * and skipping `-shm` runtime files.
 * @param src - source path.
 * @param dest - destination path.
 * @param walCarried - collects destination paths of the `-wal` sidecars that were carried over.
 * @param vacuumed - collects destination paths that came from a `VACUUM INTO` snapshot.
 */
function copyTree(src: string, dest: string, walCarried: string[], vacuumed: string[]): void {
  const st = statSync(src)
  if (!st.isDirectory()) {
    const name = src.split(/[\\/]/).pop() ?? ''
    // `-wal`/`-shm` 不单独拷：`-wal` 只作为所属主库的副产物拷（见 copyFileWithWal）。
    if (isRuntimeArtifact(name)) return
    if (copyFileWithWal(src, dest, vacuumed)) walCarried.push(dest + '-wal')
    return
  }
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (isRuntimeArtifact(entry.name)) continue
    copyTree(join(src, entry.name), join(dest, entry.name), walCarried, vacuumed)
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
 * 源端有活的 `-wal` 时，那个库**不按文件拷**，而是走 SQLite 的 `VACUUM INTO` 取一份
 * 自洽快照（W2-8.5）—— 「拷主库 + 拷 -wal」两次读之间源端可能正在 checkpoint，
 * 拷到的是一对**撕裂**的页/帧。`-wal` 那条路只作为 `VACUUM INTO` 失败时的退路。
 *
 * 留痕迹用的字段有两个：`vacuumed`（走了自洽快照）与 `walCarried`（走了退路）。
 * 「这次拷的是不是最新一代」不能只靠猜。
 * @param env - environment mapping.
 * @returns what was copied (or skipped), for observability.
 */
export function bootstrapWechatData(
  env: Record<string, string | undefined> = process.env,
): { root: string; copied: string[]; skipped: boolean; walCarried: string[]; vacuumed: string[] } {
  const root = resolveWechatDataRoot(env)
  if (env[DECRYPTED_DIR_ENV] !== undefined && env[DECRYPTED_DIR_ENV].trim().length > 0) {
    return { root, copied: [], skipped: true, walCarried: [], vacuumed: [] }
  }
  const decrypted = join(root, 'decrypted')
  if (existsSync(decrypted)) return { root, copied: [], skipped: true, walCarried: [], vacuumed: [] }
  const source = resolveSourceDir(env)
  if (source === null || !existsSync(source)) {
    return { root, copied: [], skipped: true, walCarried: [], vacuumed: [] }
  }
  const copied: string[] = []
  const walCarried: string[] = []
  const vacuumed: string[] = []
  for (const item of BOOTSTRAP_ITEMS) {
    const src = join(source, item)
    const dest = join(root, item)
    if (!existsSync(src)) continue
    copyTree(src, dest, walCarried, vacuumed)
    copied.push(item)
  }
  return { root, copied, skipped: false, walCarried, vacuumed }
}

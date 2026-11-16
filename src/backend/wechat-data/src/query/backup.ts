/**
 * Backup manager: list / create / delete local snapshots of the decrypted
 * WeChat DBs. Plain create makes a timestamped directory copy; encrypted
 * create writes an AES-256-GCM `.wcb` bundle (scrypt key, HMAC-authenticated
 * header, per-file IVs) that restoreBackup decrypts back to a directory.
 */
import { closeSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'
import { StreamWriter, partialPath, reportProgress, throwIfCancelled } from './zip.ts'
import type { StreamControl } from './zip.ts'
import type { BackupEntry, BackupPreviewSnapshot, BackupRestoreResult } from '../types.ts'
import { yieldToLoop } from './search-build.ts'

const MAGIC = Buffer.from('DSHWCB1\n', 'utf8')
const SALT_LEN = 16
const VERSION = 1

/** `.wcb` 头长度上限（P1-08）：真实头只有几百字节，8MB 足够容纳任意大账号的文件清单。 */
const MAX_HEADER_BYTES = 8 * 1024 * 1024
/**
 * 单个分片明文上限（P1-08）：任何真实微信库分片都远小于 2GB。
 * 与「必须放得进备份文件剩余字节」一起校验，恶意头无法在认证后要求分配任意大 Buffer。
 */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024

/** Backup root dir: sibling of the decrypted dir. */
function backupDir(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'backups')
}
/** 恢复前要求的**绝对**余量下限：即便明文很小，也要留这么多给系统与后续操作。 */
const RESTORE_HEADROOM_MIN = 64 * 1024 * 1024
/** 恢复前要求的**比例**余量：明文越大，留给系统与后续操作的比例余量也越大。 */
const RESTORE_HEADROOM_RATIO = 0.1

/**
 * 恢复前的磁盘空间预检（W2-8.4）。
 *
 * ## 为什么要有
 *
 * 恢复是「读一个 .wcb、解密、把明文整份写出来」，空间需求 = 备份里所有分片的明文字节和。
 * 原来这件事一次都不查，于是空间不够时的失败形态是：解到第 N 个分片，
 * `writeFileSync` 抛 ENOSPC —— 用户已经等了（scrypt + 逐块解密都不便宜），
 * 磁盘上却躺着一个半截的 `.restored` 目录，而且**报错文案只有 errno**，
 * 没人知道「差多少」。头里本来就记着每个分片的明文字节数，
 * 所以这件事完全可以在**一个字节都不写**之前说清楚。
 *
 * ## 两条不许省的性质
 *
 * ① `statfsSync` 自己失败时**放行**。个别文件系统/权限组合下它会 `EPERM`；
 *    预检的目的是「少踩坑」，不是变成一个新的阻塞点 —— 因为预检失败就把
 *    恢复功能整个堵死，比不预检更糟。
 * ② 余量要**大于**明文本身（64MB 与 10% 取大者）。恢复出来的目录不是终点：
 *    用户下一步通常要拿它当数据根用，系统本身也要空间。
 *
 * @param dir - 备份所在目录（恢复出来的目录与它同盘，所以按它算剩余空间）。
 * @param plainBytes - 这次恢复要落盘的明文总字节数。
 * @returns ok=false 时带一句可读的 `error`（含需要多少、还剩多少）。
 */
function ensureRestoreSpace(dir: string, plainBytes: number): { ok: boolean; error?: string } {
  const need = plainBytes + Math.max(RESTORE_HEADROOM_MIN, Math.ceil(plainBytes * RESTORE_HEADROOM_RATIO))
  let free: number
  try {
    const st = statfsSync(dir)
    free = Number(st.bavail) * Number(st.bsize)
  } catch {
    return { ok: true }
  }
  if (free >= need) return { ok: true }
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1)
  return {
    ok: false,
    error: `磁盘空间不足：本次恢复要写入约 ${gb(plainBytes)} GB 明文，连同余量需要约 ${gb(need)} GB，当前只剩 ${gb(free)} GB。未写入任何文件。`,
  }
}

/**
 * SQLite 运行时 sidecar（P2-03）：`-wal` / `-shm` / `-journal` 记录的是**某一时刻**的页状态，
 * 单独复制到别处后可能被回放，轻则带回陈旧数据，重则把恢复出来的库改坏。
 *
 * 取舍：这里选择**排除**而不是恢复前 checkpoint —— 备份对象是解密流程发布的快照，
 * 备份代码不该为了复制再打开/写源库（那会改动用户数据，也绕开解密层的原子发布约定）。
 * 代价是源库若真有未 checkpoint 的已提交事务不会进备份；对「已发布的解密快照」这个
 * 前提来说它们本来就该已经落在 `.db` 主体里。
 */
function skipName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('-wal') || lower.endsWith('-shm') || lower.endsWith('-journal')
}

function collectFiles(root: string): Array<{ abs: string; rel: string; size: number }> {
  const out: Array<{ abs: string; rel: string; size: number }> = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skipName(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.push({ abs: p, rel: relative(root, p).split('\\').join('/'), size: statSync(p).size })
    }
  }
  walk(root)
  return out
}

function dirSize(dir: string): number {
  let size = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else try { size += statSync(p).size } catch { /* skip */ }
    }
  }
  walk(dir)
  return size
}

/** Bounded content summary (items + .db count + capability composition); caps the walk. */
function dirSummary(dir: string): string {
  let items = 0
  let db = 0
  const dbNames = new Set<string>()
  const walk = (d: string, depth: number): void => {
    if (items > 20000 || depth > 6) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skipName(e.name)) continue
      items += 1
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name.endsWith('.db')) { db += 1; dbNames.add(e.name.toLowerCase()) }
    }
  }
  try { walk(dir, 0) } catch { /* keep partial counts */ }
  const has = (kw: string): boolean => Array.from(dbNames).some(n => n.includes(kw))
  const parts: string[] = []
  if (has('sns')) parts.push('朋友圈')
  if (has('msg') || has('micro') || has('wxmsg')) parts.push('会话')
  if (has('contact') || has('address')) parts.push('通讯录')
  if (has('favorite') || has('fav')) parts.push('收藏')
  const comp = parts.length > 0 ? '（含 ' + parts.join('/') + ' 库）' : ''
  return (db > 0 ? `${items} 项 · ${db} 个库` : `${items} 项`) + comp
}

/** Integrity check: dir backup looks like a DB snapshot; enc has the .wcb header. */
function backupOk(path: string, kind: 'dir' | 'enc'): boolean {
  try {
    if (kind === 'enc') {
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(MAGIC.length)
        readSync(fd, buf, 0, MAGIC.length, 0)
        return buf.equals(MAGIC)
      } finally { closeSync(fd) }
    }
    let hasDb = false
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.isDirectory()) {
        for (const sub of readdirSync(join(path, e.name))) {
          if (sub.endsWith('.db')) { hasDb = true; break }
        }
      } else if (e.name.endsWith('.db')) { hasDb = true; break }
      if (hasDb) break
    }
    return hasDb
  } catch {
    return false
  }
}

/**
 * Preview a backup's contents (bounded file/db list) before restore.
 * @param decryptedDir - decrypted data root.
 * @param name - backup name.
 * @returns the preview snapshot (bounded items) or an empty result.
 */
export function previewBackup(decryptedDir: string, name: string): BackupPreviewSnapshot {
  const dir = backupDir(decryptedDir)
  const p = join(dir, name)
  if (!existsSync(p)) return { items: [], total: 0 }
  const st = statSync(p)
  const items: BackupPreviewSnapshot['items'] = []
  const push = (rel: string, size: number, isDir: boolean): void => {
    if (items.length >= 500) return
    items.push({ name: rel, size, isDir })
  }
  if (st.isDirectory()) {
    const walk = (d: string, prefix: string): void => {
      if (items.length >= 500) return
      let entries: Array<{ n: string; isDir: boolean }> = []
      try { entries = readdirSync(d, { withFileTypes: true }).map(e => ({ n: e.name, isDir: e.isDirectory() })) } catch { return }
      for (const e of entries) {
        if (skipName(e.n)) continue
        if (items.length >= 500) return
        const abs = join(d, e.n)
        const rel = prefix ? prefix + '/' + e.n : e.n
        if (e.isDir) {
          push(rel, 0, true)
          walk(abs, rel)
        } else {
          let size = 0
          try { size = statSync(abs).size } catch { /* skip */ }
          push(rel, size, false)
        }
      }
    }
    walk(p, '')
  } else {
    push(name, st.size, false)
  }
  return { items, total: items.length }
}

/**
 * List existing backups (name, size, modified, kind).
 * @param decryptedDir - decrypted data root.
 * @returns backup items plus total count.
 */
export function listBackups(decryptedDir: string): { items: BackupEntry[]; total: number } {
  const dir = backupDir(decryptedDir)
  if (!existsSync(dir)) return { items: [], total: 0 }
  const items: BackupEntry[] = []
  for (const name of readdirSync(dir).sort().reverse()) {
    // 恢复临时目录（`.restored` / `.partial-*`）不是备份：列出来会让用户以为多了一份
    // 可用快照，也会把「恢复失败后清理」变成看起来成功的假象（P3-03）。
    if (name.endsWith('.restored') || name.includes('.partial-')) continue
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) {
        items.push({ name, path: p, size: dirSize(p), modified: Math.floor(st.mtimeMs / 1000), kind: 'dir', summary: dirSummary(p), ok: backupOk(p, 'dir') })
      } else if (name.endsWith('.wcb')) {
        items.push({ name, path: p, size: st.size, modified: Math.floor(st.mtimeMs / 1000), kind: 'enc', summary: 'AES-256 加密备份', ok: backupOk(p, 'enc') })
      }
    } catch { /* skip unreadable */ }
  }
  return { items, total: items.length }
}

/**
 * Create a timestamped directory backup of the decrypted DBs.
 *
 * 先在同级目录复制到临时名、全部成功后再改名 —— 直接往最终名字里复制时，某个子目录
 * 复制失败会留下一个**看起来成功、实际缺库**的备份（旧实现甚至 `catch {}` 吞掉失败后
 * 照常返回成功条目，用户以为备份好了）；这里把「部分失败」显式报出去并清掉半成品。
 * @param decryptedDir - decrypted data root.
 * @returns the created backup entry.
 */
export async function createBackup(decryptedDir: string, ctrl?: StreamControl): Promise<BackupEntry> {
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14)
  const name = 'wechat_backup_' + ts
  const dir = backupDir(decryptedDir)
  reportProgress(ctrl, 'prepare', 0, 0)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  const tmp = partialPath(target)
  mkdirSync(tmp, { recursive: true })
  const failed: string[] = []
  try {
    if (existsSync(decryptedDir)) {
      const subs = readdirSync(decryptedDir, { withFileTypes: true })
        .filter((sub) => sub.isDirectory() && !sub.name.startsWith('.'))
      reportProgress(ctrl, 'files', 0, subs.length)
      for (let i = 0; i < subs.length; i += 1) {
        const sub = subs[i]!
        throwIfCancelled(ctrl?.signal)
        // 2026-09-28：逐个子目录让出。真实 @Remote 探针实测 `createBackup` 冷跑
        // **206ms 且一次都不让出**（`working/probe-remote.txt`，当时最长的独占项）——
        // `cpSync` 是同步阻塞的整树复制，本机一个 `message` 目录就有 350MB 级的分片。
        // 放在**每次复制之前**：让出的是"上一轮已经干完的活"。
        await yieldToLoop()
        throwIfCancelled(ctrl?.signal)
        try {
          // P2-03：整树复制时排除 WAL/SHM/journal sidecar（见 skipName 的取舍说明）。
          cpSync(join(decryptedDir, sub.name), join(tmp, sub.name), {
            recursive: true,
            filter: (src) => !skipName(basename(src)),
          })
        } catch (e) {
          throwIfCancelled(ctrl?.signal)
          failed.push(sub.name + '（' + (e as Error).message + '）')
        }
        throwIfCancelled(ctrl?.signal)
        reportProgress(ctrl, 'files', i + 1, subs.length)
      }
    }
    if (failed.length > 0) {
      throw new Error('备份不完整：' + String(failed.length) + ' 个子目录复制失败 —— ' + failed.join('；'))
    }
    // 同名（同一秒内重复点）时先挪开旧的：Windows 上 rename 到已存在的目录会失败。
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(tmp, target)
  } catch (e) {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw e
  }
  const st = statSync(target)
  reportProgress(ctrl, 'done', 1, 1)
  return { name, path: target, size: dirSize(target), modified: Math.floor(st.mtimeMs / 1000), kind: 'dir' }
}

/**
 * Create an encrypted `.wcb` backup bundle.
 *
 * 写盘走 temp + rename：旧实现直接往最终名字里流式写，中途失败（磁盘满、取消、进程被掐）
 * 会留下一个长度不对却带着合法 MAGIC 的 `.wcb` —— 用户以为备份好了，恢复时才发现截断。
 * 另外旧实现用 `out.write()` 但不看返回值（大备份未落盘的数据在内存里堆积），
 * 且错误监听是在写完之后才挂上（循环里出错会变成未捕获异常）。
 * @param decryptedDir - decrypted data root.
 * @param password - encryption password.
 * @param ctrl - 可选的进度/取消（逐个文件上报；取消后不留半成品）。
 * @returns the created backup entry.
 */
export async function createEncryptedBackup(decryptedDir: string, password: string, ctrl?: StreamControl): Promise<BackupEntry> {
  throwIfCancelled(ctrl?.signal)
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14)
  const name = 'wechat_backup_' + ts + '.wcb'
  const dir = backupDir(decryptedDir)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  const tmp = partialPath(target)
  const salt = randomBytes(SALT_LEN)
  const key = scryptSync(password, salt, 32)
  const files = collectFiles(decryptedDir)
  const header = {
    version: VERSION,
    files: files.map(f => ({
      name: f.rel,
      size: f.size,
      iv: randomBytes(12).toString('base64'),
    })),
  }
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8')
  const mac = createHmac('sha256', key).update(headerBuf).digest()
  const sink = await StreamWriter.create(tmp)
  let written = 0
  try {
    const put = async (buf: Buffer): Promise<void> => {
      await sink.write(buf)
      written += buf.length
      reportProgress(ctrl, 'encrypt', written, 0)
    }
    await put(MAGIC)
    await put(salt)
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(headerBuf.length)
    await put(lenBuf)
    await put(headerBuf)
    await put(mac)
    for (let i = 0; i < files.length; i += 1) {
      throwIfCancelled(ctrl?.signal)
      const f = header.files[i]
      const src = files[i]
      if (!f || !src) continue
      const iv = Buffer.from(f.iv, 'base64')
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      for await (const chunk of createReadStream(src.abs) as AsyncIterable<Buffer>) {
        throwIfCancelled(ctrl?.signal)
        await put(cipher.update(chunk))
      }
      await put(cipher.final())
      await put(cipher.getAuthTag())
      reportProgress(ctrl, 'files', i + 1, files.length)
    }
    await sink.end()
    renameSync(tmp, target)
  } catch (e) {
    // abort 会关流并删掉临时文件；失败路径必须走它，否则半成品以最终名字存在。
    await sink.abort()
    // end() 之后再出错时 abort() 是空操作（它不能删一个已经正常收尾的文件），
    // 但这里的 tmp 是临时文件，必须清掉。
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw e
  }
  const st = statSync(target)
  reportProgress(ctrl, 'done', 1, 1)
  return { name, path: target, size: st.size, modified: Math.floor(st.mtimeMs / 1000), kind: 'enc' }
}

/**
 * 备份名必须是 `backups/` 下的单层名字（P1-09）：拒绝路径分隔符、盘符与 `.`/`..`。
 * @param name - 调用方给的备份名。
 * @returns 是否是安全的单层名字。
 */
function isPlainBackupName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return false
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return false
  return true
}

/**
 * 把 `.wcb` 头里的分片相对路径落到 `targetRoot` 内（P1-08）。
 *
 * 拒绝：空名、NUL、绝对路径（POSIX/UNC）、盘符、空段、`.` / `..` 段、Windows 非法字符
 * （`:` 还可指向备用数据流）、结尾是空格或点的段。最后用 `resolve` + `relative`
 * 再确认一次结果没有越出 `targetRoot`（按路径段，不比字符串前缀）。
 * @param targetRoot - 本次恢复的临时目录。
 * @param raw - 头里的 `name` 字段（不可信）。
 * @returns 绝对路径；名字不合法时返回 null。
 */
function resolveRestoreTarget(targetRoot: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\u0000')) return null
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) return null
  // 控制字符任何平台都不该出现在文件名里。
  if (parts.some(p => /[\u0000-\u001f]/.test(p))) return null
  // Windows 专属限制：非法字符（`:` 还可指向备用数据流）与结尾空格/点。
  // 只在该平台启用，避免把 POSIX 上合法备份里的文件名误判成攻击。
  if (process.platform === 'win32' && parts.some(p => /[<>:"|?*]/.test(p) || /[. ]$/.test(p))) return null
  const abs = resolve(targetRoot, normalized)
  const rel = relative(targetRoot, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../') || isAbsolute(rel)) return null
  return abs
}

/** 头里的单文件大小：非负、安全整数，且不超过 {@link MAX_ENTRY_BYTES}（P1-08）。 */
function isValidEntrySize(size: unknown): size is number {
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= MAX_ENTRY_BYTES
}

/** `.wcb` 头里一个分片的声明。 */
interface WcbHeaderFile {
  name: string
  size: number
  iv: string
}

/**
 * 解析并校验 `.wcb` 头（P1-08）。调用方必须在 HMAC 校验**之后**调用。
 * @param buf - 头 JSON 字节。
 * @returns 分片清单；形状/大小/IV 不合法时返回 null（对外统一报「备份头异常」）。
 */
function parseWcbHeader(buf: Buffer): WcbHeaderFile[] | null {
  let value: unknown
  try { value = JSON.parse(buf.toString('utf8')) } catch { return null }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const files = (value as { files?: unknown }).files
  if (!Array.isArray(files)) return null
  const out: WcbHeaderFile[] = []
  for (const item of files) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const f = item as Record<string, unknown>
    if (typeof f['name'] !== 'string') return null
    if (!isValidEntrySize(f['size'])) return null
    if (typeof f['iv'] !== 'string') return null
    // AES-GCM nonce 必须是 12 字节；长度不对时 createDecipheriv 必然抛错，提前按头异常处理。
    if (Buffer.from(f['iv'], 'base64').length !== 12) return null
    out.push({ name: f['name'], size: f['size'], iv: f['iv'] })
  }
  return out
}

/**
 * Restore an encrypted `.wcb` backup into `<backups>/<name>.restored`.
 * @param decryptedDir - decrypted data root.
 * @param name - backup file name (must end .wcb).
 * @param password - encryption password.
 * @returns restore result with the extracted path.
 */
export function restoreEncryptedBackup(decryptedDir: string, name: string, password: string): BackupRestoreResult {
  const dir = backupDir(decryptedDir)
  if (!isPlainBackupName(name) || !name.endsWith('.wcb')) return { ok: false, error: '加密备份不存在' }
  const src = join(dir, name)
  if (!existsSync(src)) return { ok: false, error: '加密备份不存在' }
  const target = join(dir, name.slice(0, -'.wcb'.length) + '.restored')
  // 先解到同目录的临时目录，成功后才换名：失败时不会在 `.restored` 留下半截明文，
  // 也不会提前删掉上一次成功恢复出来的目录（P3-03）。
  const tmp = partialPath(target)
  let tmpCreated = false
  let fd: number | null = null
  try {
    fd = openSync(src, 'r')
    const magic = readExactFd(fd, MAGIC.length)
    if (!magic.equals(MAGIC)) return { ok: false, error: '不是有效的加密备份文件' }
    const salt = readExactFd(fd, SALT_LEN)
    const lenBuf = readExactFd(fd, 4)
    const headerLen = lenBuf.readUInt32BE(0)
    // P1-08：头长度必须在**分配之前**设上限。否则一个 4 字节的恶意长度就能在 MAC
    // 校验之前要求分配/读取任意大的 Buffer。
    if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) return { ok: false, error: '备份头异常：头长度不合法' }
    const headerBuf = readExactFd(fd, headerLen)
    const mac = readExactFd(fd, 32)
    const key = scryptSync(password, salt, 32)
    const expect = createHmac('sha256', key).update(headerBuf).digest()
    if (!mac.equals(expect)) return { ok: false, error: '密码错误或文件被篡改' }
    // P1-08：头形状、单文件大小与路径都在**认证之后、写盘之前**统一校验。
    const files = parseWcbHeader(headerBuf)
    if (files === null) return { ok: false, error: '备份头异常：文件清单不合法' }
    const plans: Array<{ f: WcbHeaderFile; outPath: string }> = []
    for (const f of files) {
      const outPath = resolveRestoreTarget(tmp, f.name)
      if (outPath === null) return { ok: false, error: '备份头异常：文件路径不合法' }
      plans.push({ f, outPath })
    }
    // W2-8.4：预检放在这里，两个位置都不能挪 ——
    //   ① 必须在**密码校验之后**：否则用户密码打错了却看到「磁盘空间不足」，
    //      会被引到完全错误的方向上去查；
    //   ② 必须在**解密写盘之前**：.wcb 头里已经记着每个分片的明文字节数，
    //      所以不必解密也知道要落多少盘；等解到一半才发现 ENOSPC，
    //      用户白等一场，磁盘上还留着一个半截目录。
    const plainBytes = files.reduce((n, f) => n + f.size, 0)
    if (!Number.isSafeInteger(plainBytes)) return { ok: false, error: '备份头异常：文件总大小不合法' }
    const space = ensureRestoreSpace(dir, plainBytes)
    if (!space.ok) return { ok: false, error: space.error }
    // P1-08：声明的大小还必须真的放得进备份文件的剩余字节 —— 一个只有几百字节的
    // 恶意备份不能靠 `size: 2GB` 让 readExactFd 在认证后立刻申请 2GB。
    const bodyStart = MAGIC.length + SALT_LEN + 4 + headerLen + 32
    const bodyBytes = files.reduce((n, f) => n + f.size + 16, 0)
    if (bodyStart + bodyBytes > statSync(src).size) return { ok: false, error: '备份头异常：文件长度超出备份大小' }
    mkdirSync(tmp, { recursive: true })
    tmpCreated = true
    for (const { f, outPath } of plans) {
      const iv = Buffer.from(f.iv, 'base64')
      const cipherText = readExactFd(fd, f.size)
      const tag = readExactFd(fd, 16)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      let plain: Buffer
      try {
        plain = Buffer.concat([decipher.update(cipherText), decipher.final()])
      } catch {
        return { ok: false, error: '解密校验失败（数据损坏或密码错误）' }
      }
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, plain)
    }
    // 成功后才替换旧目录；恢复目录是整份新写的，旧的 WAL/SHM 不会残留。
    // 先把旧目录挪成 `.partial-` 再换名：换名若失败还能把它挪回来，
    // 不会出现「旧的已被删、新的没换上」这种用户数据丢失。
    let previous: string | null = null
    if (existsSync(target)) {
      previous = partialPath(target + '.old')
      renameSync(target, previous)
    }
    try {
      renameSync(tmp, target)
    } catch (e) {
      if (previous !== null) {
        try { renameSync(previous, target) } catch { /* 回滚失败时旧目录仍在 .partial- 下，不掩盖原错误 */ }
      }
      throw e
    }
    tmpCreated = false
    if (previous !== null) {
      try { rmSync(previous, { recursive: true, force: true }) } catch { /* 残留的 .partial- 不会被 listBackups 列出 */ }
    }
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    if (fd !== null) closeSync(fd)
    // 只清理**本次**创建的临时目录；用户已有的 target 不动（成功路径已换名，走到这里时 tmpCreated=false）。
    if (tmpCreated) {
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不掩盖原错误 */ }
    }
  }
}

function readExactFd(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size)
  let off = 0
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, null)
    if (n <= 0) throw new Error('备份文件读取被截断')
    off += n
  }
  return buf
}

/**
 * Delete one backup by name.
 * @param decryptedDir - decrypted data root.
 * @param name - backup name to delete.
 * @returns ok, or an error description when the backup cannot be removed.
 */
export function deleteBackup(decryptedDir: string, name: string): { ok: boolean; error?: string } {
  // P1-09：旧实现用 `target.startsWith(dir)`，`../backups-old` 也满足前缀
  // （字符串前缀，且没带分隔符语义）⇒ 能删到 backups 目录外。现在只接受单层名字，
  // resolve 之后再按路径段确认一次。
  if (!isPlainBackupName(name)) return { ok: false, error: '备份不存在' }
  const dir = resolve(backupDir(decryptedDir))
  const target = resolve(dir, name)
  const rel = relative(dir, target)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../') || isAbsolute(rel)) {
    return { ok: false, error: '备份不存在' }
  }
  if (!existsSync(target)) return { ok: false, error: '备份不存在' }
  try {
    rmSync(target, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

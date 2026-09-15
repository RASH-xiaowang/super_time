/**
 * Backup manager: list / create / delete local snapshots of the decrypted
 * WeChat DBs. Plain create makes a timestamped directory copy; encrypted
 * create writes an AES-256-GCM `.wcb` bundle (scrypt key, HMAC-authenticated
 * header, per-file IVs) that restoreBackup decrypts back to a directory.
 */
import { closeSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'
import { StreamWriter, partialPath, reportProgress, throwIfCancelled } from './zip.ts'
import type { StreamControl } from './zip.ts'
import type { BackupEntry, BackupPreviewSnapshot, BackupRestoreResult } from '../types.ts'

const MAGIC = Buffer.from('DSHWCB1\n', 'utf8')
const SALT_LEN = 16
const VERSION = 1

/** Backup root dir: sibling of the decrypted dir. */
function backupDir(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'backups')
}

function skipName(name: string): boolean {
  return name.endsWith('-wal') || name.endsWith('-shm')
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
export function createBackup(decryptedDir: string): BackupEntry {
  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14)
  const name = 'wechat_backup_' + ts
  const dir = backupDir(decryptedDir)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  const tmp = partialPath(target)
  mkdirSync(tmp, { recursive: true })
  const failed: string[] = []
  try {
    if (existsSync(decryptedDir)) {
      for (const sub of readdirSync(decryptedDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        if (sub.name.startsWith('.')) continue
        try {
          cpSync(join(decryptedDir, sub.name), join(tmp, sub.name), { recursive: true })
        } catch (e) {
          failed.push(sub.name + '（' + (e as Error).message + '）')
        }
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
      reportProgress(ctrl, 'write', written, 0)
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
  return { name, path: target, size: st.size, modified: Math.floor(st.mtimeMs / 1000), kind: 'enc' }
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
  const src = join(dir, name)
  if (!name.endsWith('.wcb') || !existsSync(src)) return { ok: false, error: '加密备份不存在' }
  const target = join(dir, name.replace(/\.wcb$/, '') + '.restored')
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  let fd: number | null = null
  try {
    fd = openSync(src, 'r')
    const magic = readExactFd(fd, MAGIC.length)
    if (!magic.equals(MAGIC)) return { ok: false, error: '不是有效的加密备份文件' }
    const salt = readExactFd(fd, SALT_LEN)
    const lenBuf = readExactFd(fd, 4)
    const headerLen = lenBuf.readUInt32BE(0)
    const headerBuf = readExactFd(fd, headerLen)
    const mac = readExactFd(fd, 32)
    const key = scryptSync(password, salt, 32)
    const expect = createHmac('sha256', key).update(headerBuf).digest()
    if (!mac.equals(expect)) return { ok: false, error: '密码错误或文件被篡改' }
    const header = JSON.parse(headerBuf.toString('utf8')) as { files: Array<{ name: string; size: number; iv: string }> }
    for (const f of header.files) {
      const iv = Buffer.from(f.iv, 'base64')
      const cipherText = readExactFd(fd, f.size)
      const tag = readExactFd(fd, 16)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const outPath = join(target, f.name.split('/').join(process.platform === 'win32' ? '\\' : '/'))
      mkdirSync(dirname(outPath), { recursive: true })
      try {
        const plain = Buffer.concat([decipher.update(cipherText), decipher.final()])
        writeFileSync(outPath, plain)
      } catch {
        return { ok: false, error: '解密校验失败（数据损坏或密码错误）' }
      }
    }
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    if (fd !== null) closeSync(fd)
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
  const dir = backupDir(decryptedDir)
  const target = join(dir, name)
  if (!target.startsWith(dir) || !existsSync(target)) return { ok: false, error: '备份不存在' }
  try {
    rmSync(target, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

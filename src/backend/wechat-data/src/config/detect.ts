/**
 * WeChat 安装位置与账号目录的发现（配置层的一部分）。
 *
 * 为什么放在这一层（M24）：它读的是「本机配置」——`%APPDATA%/Tencent/xwechat/config/*.ini`、
 * 注册表 `HKCU\Software\Tencent\Weixin\InstallPath` 与磁盘上的 `db_storage` 目录 —— 而且
 * `keys/service.ts`（从进程内存取图密钥时要拿本机 wxid 清单）与 `query/config.ts`（解析自身
 * wxid）都要用。它必须在 keys 之下、且不 import 包内任何模块，否则双向依赖又会回来。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Common WeChat 4.x data bases (parents of `xwechat_files`) to scan. */
const DEFAULT_DATA_BASES = [
  'E:\\Tencent',
  'D:\\Tencent',
  'C:\\Tencent',
  process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Tencent') : '',
  process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Documents') : '',
].filter(Boolean)

/**
 * WeChat 4.x data bases recorded per-user in
 * `%APPDATA%/Tencent/xwechat/config/*.ini` — each line is the data root chosen
 * at install/first login (e.g. `E:\Tencent\Weixin`, the parent of
 * `xwechat_files`). The client rewrites these files on every login, so this is
 * the authoritative source for a customized data location.
 */
function iniDataBases(): string[] {
  const configDir = process.env.APPDATA
    ? join(process.env.APPDATA, 'Tencent', 'xwechat', 'config')
    : ''
  if (!configDir || !existsSync(configDir)) return []
  const bases: string[] = []
  for (const name of readdirSync(configDir)) {
    if (!name.endsWith('.ini')) continue
    try {
      for (const line of readFileSync(join(configDir, name), 'utf8').split(/\r?\n/)) {
        const base = line.trim()
        if (base) bases.push(base)
      }
    } catch { /* unreadable ini is skipped */ }
  }
  return bases
}

/**
 * WeChat 4.x install path from `HKCU\Software\Tencent\Weixin\InstallPath`
 * (Windows only; '' elsewhere). The install dir is also a valid data base when
 * the user kept the default data layout.
 */
export function weixinInstallPath(): string {
  if (process.platform !== 'win32') return ''
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Tencent\\Weixin', '/v', 'InstallPath'],
      { encoding: 'utf8', windowsHide: true },
    )
    const match = /\sInstallPath\s+REG_\w+\s+(.+)/i.exec(out)
    return (match?.[1] ?? '').trim()
  } catch { /* registry absent or reg.exe unavailable */ }
  return ''
}

/** Version-folder pattern under the WeChat install dir (e.g. 4.1.12.26). */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

/**
 * WeChat version folder name inside the install dir.
 * @param installDir - install path (defaults to the registry InstallPath).
 * @returns the version, or '' when the install dir is unknown.
 */
export function weixinVersion(installDir?: string): string {
  const dir = installDir ?? weixinInstallPath()
  if (!dir || !existsSync(dir)) return ''
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && VERSION_DIR_RE.test(entry.name)) return entry.name
    }
  } catch { /* unreadable install dir */ }
  return ''
}

/**
 * Collect the `xwechat_files` roots to scan: default data bases, per-user
 * config ini files, and the registry install path, deduped
 * case-insensitively. A configured base may itself already be the
 * `xwechat_files` dir, so both join forms are added; the account loop filters
 * by `db_storage` presence.
 * @returns absolute candidate roots (existence caller-checked).
 */
export function collectScanRoots(): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  const add = (base: string): void => {
    if (!base) return
    for (const root of [join(base, 'xwechat_files'), base]) {
      const key = root.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      roots.push(root)
    }
  }
  for (const base of [...DEFAULT_DATA_BASES, ...iniDataBases(), weixinInstallPath()]) add(base)
  return roots
}

/**
 * Detect installed WeChat 4.x accounts by scanning `xwechat_files` roots.
 * @param roots - explicit scan roots; defaults to {@link collectScanRoots}.
 * @returns detected accounts with db_dir, last active and db file count.
 */
export function detectWechatAccounts(
  roots?: readonly string[],
): Array<{ wxid: string; db_dir: string; last_active?: number; db_files?: number }> {
  const out: Array<{ wxid: string; db_dir: string; last_active?: number; db_files?: number }> = []
  for (const root of roots ?? collectScanRoots()) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const dbStorage = join(dir, 'db_storage')
      if (!existsSync(dbStorage)) continue
      // wxid is the dir name before the instance suffix (e.g. wxid_xxx_63e5)
      const wxid = normalizeWxidDir(entry.name) || '未知账号'
      let lastActive: number | undefined
      try {
        const msgDir = join(dbStorage, 'message')
        if (existsSync(msgDir)) {
          let newest = 0
          for (const f of readdirSync(msgDir)) {
            try { newest = Math.max(newest, statSync(join(msgDir, f)).mtimeMs) } catch { /* skip */ }
          }
          lastActive = newest ? Math.floor(newest / 1000) : undefined
        }
      } catch { /* skip */ }
      const acct: { wxid: string; db_dir: string; last_active?: number; db_files?: number } = { wxid, db_dir: dbStorage }
      if (lastActive) acct.last_active = lastActive
      const dbs = scanDbFiles(dbStorage)
      if (dbs.length > 0) acct.db_files = dbs.length
      out.push(acct)
    }
  }
  return out
}

/**
 * Normalize a WeChat account dir name to the real wxid (strip instance suffix).
 * Account dirs look like `wxid_xxxxxx` or `wxid_xxxxxx_f312`; the wxid itself
 * has no underscore, so everything after the second underscore is the instance
 * id (mirrors st_control config/paths.rs normalize_wxid_dir).
 * @param name - account directory name (e.g. wxid_a1z2r51mzqlf22_63e5).
 * @returns the real wxid (input unchanged when it is not a wxid_ name).
 */
export function normalizeWxidDir(name: string): string {
  if (!name.startsWith('wxid_')) return name
  const rest = name.slice('wxid_'.length)
  const pos = rest.indexOf('_')
  return pos >= 0 ? 'wxid_' + rest.slice(0, pos) : name
}

/** Recursively collect .db files under a dir (depth-limited). */
export function scanDbFiles(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return []
  const out: string[] = []
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...scanDbFiles(p, depth + 1))
      else if (e.name.endsWith('.db') && !e.name.includes('-wal') && !e.name.includes('-shm')) out.push(p)
    }
  } catch { /* skip */ }
  return out
}

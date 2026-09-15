/**
 * 从配置/密钥文件里解析运行时需要的路径与身份（配置层的一部分）。
 *
 * 为什么放在这一层（M24）：它们全部是「读 config.json / all_keys.json + 环境变量」的纯解析，
 * 不含任何查询逻辑；`keys/**` 也可能需要同样的解析能力，放在这里就不会再出现
 * keys → query 的反向依赖。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from './wechat-config.ts'
import { detectWechatAccounts, normalizeWxidDir } from './detect.ts'

/** Self wxid from a db_dir path (the account dir is the parent of db_storage). */
function wxidFromDbDir(dbDir: string): string {
  const d = (dbDir || '').trim().replace(/[\\/]+$/, '')
  if (!d) return ''
  const parts = d.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? ''
  const acct = last.startsWith('wxid_') ? last : (parts[parts.length - 2] ?? '')
  return normalizeWxidDir(acct)
}

/**
 * Read all_keys.json info (format + count).
 * @param decryptedDir - decrypted data root.
 * @returns key format, key count and whether the file was loaded.
 */
export function getKeysInfo(decryptedDir: string): { keyFormat?: string; keyCount: number; loaded: boolean } {
  const p = join(decryptedDir, '..', 'all_keys.json')
  if (!existsSync(p)) return { keyCount: 0, loaded: false }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const keys = Object.keys(raw).filter(k => !k.startsWith('_'))
    const base: { keyCount: number; loaded: boolean; keyFormat?: string } = { keyCount: keys.length, loaded: true }
    if (typeof raw['_key_format'] === 'string') base.keyFormat = raw['_key_format']
    return base
  } catch {
    return { keyCount: 0, loaded: false }
  }
}

/**
 * Resolve the logged-in account wxid (self). Mirrors st_control's cfg.wxid()
 * which derives it from the account directory name. Resolution order:
 * env DSH_WECHAT_SELF_WXID -> config.json db_dir -> all_keys.json _db_dir ->
 * machine account scan. Unknown when every source is missing.
 * @param decryptedDir - decrypted data root (configPath locates config.json).
 * @returns the self wxid, or '' when it cannot be determined.
 */
export function resolveSelfUsername(decryptedDir: string): string {
  const envVal = process.env['DSH_WECHAT_SELF_WXID']
  if (envVal && envVal.trim().length > 0) return envVal.trim()
  const cfg = getConfig(decryptedDir)
  const dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
  const fromDbDir = wxidFromDbDir(dbDir)
  if (fromDbDir) return fromDbDir
  try {
    const keysPath = join(decryptedDir, '..', 'all_keys.json')
    if (existsSync(keysPath)) {
      const raw = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, unknown>
      const fromKeys = wxidFromDbDir(typeof raw['_db_dir'] === 'string' ? raw['_db_dir'] : '')
      if (fromKeys) return fromKeys
    }
  } catch { /* ignore */ }
  const accounts = detectWechatAccounts()
  for (const a of accounts) {
    if (a.wxid && a.wxid.startsWith('wxid_')) return normalizeWxidDir(a.wxid)
  }
  return ''
}

/**
 * Resolve the raw WeChat `db_storage` directory the realtime sync watches.
 * Resolution order: config.json `db_dir`, then all_keys.json `_db_dir` (the
 * st_control layout records it even when no config.json exists), then the
 * `DSH_WECHAT_BASE_DIR` account pin with `db_storage` appended. Empty when
 * every source is missing — callers must fail loud, not skip silently.
 * @param decryptedDir - decrypted data root (locates config.json/all_keys.json).
 * @param env - environment mapping (defaults to process.env).
 * @returns the raw db_storage path, or '' when it cannot be resolved.
 */
export function resolveRawDbDir(
  decryptedDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const cfg = getConfig(decryptedDir)
  const fromCfg = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'].trim() : ''
  if (fromCfg) return fromCfg
  try {
    const keysPath = join(decryptedDir, '..', 'all_keys.json')
    if (existsSync(keysPath)) {
      const raw = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, unknown>
      const fromKeys = typeof raw['_db_dir'] === 'string' ? raw['_db_dir'].trim() : ''
      if (fromKeys) return fromKeys
    }
  } catch { /* ignore */ }
  const pinned = env['DSH_WECHAT_BASE_DIR']
  if (pinned !== undefined && pinned.trim().length > 0) return join(pinned.trim(), 'db_storage')
  return ''
}

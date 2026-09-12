/**
 * WeChat config (owned config.json under the DSH data root), read via the
 * gateway's decrypted-dir location; returns the configuration summary.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate the WeChat config.json for a data root: the DSH-owned root.
 * @param decryptedDir - decrypted data root (the parent is the owned root).
 * @returns the config file path, or null when it does not exist.
 */
function configPath(decryptedDir: string): string | null {
  const owned = join(decryptedDir, '..', 'config.json')
  return existsSync(owned) ? owned : null
}

/**
 * Read the WeChat configuration summary (without secrets).
 * @param decryptedDir - decrypted data root.
 * @returns the config summary.
 */
export function queryWechatConfig(decryptedDir: string): Record<string, unknown> {
  const path = configPath(decryptedDir)
  if (!path) return { db_dir: decryptedDir }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return {
      db_dir: raw.db_dir ?? '',
      wechat_process: raw.wechat_process ?? '',
      key_format: raw.key_format ?? '',
      api_enabled: raw.api_enabled ?? false,
      api_port: raw.api_port ?? 0,
    }
  } catch {
    return { db_dir: decryptedDir }
  }
}

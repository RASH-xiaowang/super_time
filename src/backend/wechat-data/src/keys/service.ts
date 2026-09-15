/**
 * Key-service orchestration, migrated from WeChatDataAnalysis
 * `key_service.py` (the parts that do not depend on the wx_key Python
 * package). Finds the running WeChat process, scans Weixin.dll for the
 * internal DB key, recovers the V4 database key from process memory, and
 * recovers the image key from process memory — persisting results into the
 * DSH-owned key store.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { extractXorKeysFromDll } from './dll-key-scan.ts'
import { recoverDbKeyV4 } from './db-key-v4.ts'
import { scanImageKeyOnce } from './image-key-memory-scan.ts'
import { resolveLocalImageKey, scanV2Templates, trustedXorForVerifiedAesKey } from './image-key-resolver.ts'
import { getAccountKeysFromStore, upsertAccountKeysInStore } from './key-store.ts'
import type { DbKeyResult, ImageKeyResult } from './types.ts'
import { detectWechatAccounts } from '../config/detect.ts'
import { resolveDecryptedDir } from '../dirs.ts'

/** WeChat main executable names. */
const WECHAT_EXECUTABLE_NAMES = ['weixin.exe', 'wechat.exe']

/** Default WeChat install paths to probe for Weixin.dll. */
function defaultWeixinDllCandidates(): string[] {
  const out = [
    'C:/Program Files/Tencent/Weixin/Weixin.dll',
    'C:/Program Files (x86)/Tencent/Weixin/Weixin.dll',
  ]
  const userProfile = process.env.USERPROFILE
  if (userProfile) out.push(join(userProfile, 'AppData', 'Roaming', 'Tencent', 'Weixin', 'Weixin.dll'))
  return out
}

/**
 * Find the running WeChat main-process pid via tasklist.
 * @returns the first matching pid, or null.
 */
export function findWechatPid(): number | null {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      // CSV: "Weixin.exe","1234",...
      const match = /^"([^"]+)"\s*,\s*"(\d+)"/.exec(line.trim())
      if (!match) continue
      const name = (match[1] ?? '').toLowerCase()
      if (WECHAT_EXECUTABLE_NAMES.includes(name)) return parseInt(match[2] ?? '', 10)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Scan Weixin.dll for the internal DB key used to unmask V4 candidates.
 * @param wechatInstallDir - optional explicit install dir (may be the version
 * folder or its parent; version subdirectories are probed too).
 * @returns the first 32-byte internal key, or null.
 */
export function scanDllInternalKey(wechatInstallDir?: string): Buffer | null {
  const candidates: string[] = []
  if (wechatInstallDir) {
    candidates.push(join(wechatInstallDir, 'Weixin.dll'))
    // Install layout `<dir>/<version>/Weixin.dll` (the registry InstallPath
    // has no version segment).
    try {
      for (const entry of readdirSync(wechatInstallDir, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name)) candidates.push(join(wechatInstallDir, entry.name, 'Weixin.dll'))
      }
    } catch { /* unreadable install dir, keep the base candidate */ }
  }
  const base = process.env.DSH_WECHAT_BASE_DIR
  if (base) candidates.push(join(base, 'Weixin.dll'))
  candidates.push(...defaultWeixinDllCandidates())
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const hits = extractXorKeysFromDll(p)
      const first = hits[0]
      if (first?.keyHex) return Buffer.from(first.keyHex, 'hex')
    } catch {
      // try the next candidate path
    }
  }
  return null
}

/** Pick a V4 probe DB from the decrypted root (first candidate found). */
function pickProbeDb(decrypted: string, explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  const names = ['msg0.db', 'msg.db', 'micromsg.db', 'favorite.db', 'mediamsg0.db', 'msg0.db']
  for (const name of names) {
    const p = join(decrypted, name)
    if (existsSync(p)) return p
  }
  const msgDir = join(decrypted, 'message')
  if (existsSync(msgDir)) {
    for (const f of readdirSync(msgDir)) {
      if (f.endsWith('.db') && !f.includes('-wal') && !f.includes('-shm')) return join(msgDir, f)
    }
  }
  return null
}

/**
 * Recover the V4 database key for the running WeChat process.
 * @param opts - optional db probe path and install dir.
 * @returns the recovered key result.
 */
export async function fetchDbKey(opts: { dbPath?: string; wechatInstallDir?: string } = {}): Promise<DbKeyResult> {
  const pid = findWechatPid()
  if (pid === null) return { ok: false, error: '未检测到运行中的微信进程（Weixin.exe/WeChat.exe）' }

  const probe = pickProbeDb(resolveDecryptedDir(), opts.dbPath)
  if (probe === null) return { ok: false, error: '找不到可用于校验的 V4 加密数据库' }

  const internal = scanDllInternalKey(opts.wechatInstallDir)
  const result = await recoverDbKeyV4(pid, probe, internal)
  if (result.ok && result.key) {
    upsertAccountKeysInStore('default', {
      db_key: result.key,
      db_key_source_db_storage_path: dirname(probe),
    })
  }
  return result
}

/**
 * Coerce the account dir to the wxid_* account root: a db_dir pointing at
 * `db_storage` is lifted to its parent, because the V2 template cache lives
 * under `<root>/msg/attach` (not under db_storage).
 * @param accountDir - as passed by callers (db_dir or account root).
 * @returns the account root, '' when nothing usable.
 */
export function normalizeAccountDir(accountDir: string): string {
  const dir = (accountDir || '').replace(/[\\/]+$/, '')
  if (!dir) return ''
  return (dir.split(/[\\/]/).pop() ?? '').toLowerCase() === 'db_storage' ? dirname(dir) : dir
}

/**
 * WeChat 4.x kvcomm cache dir. The image key is derived from the kvcomm code
 * (`md5(code + clean_wxid)[:16]`, XOR = `code & 0xFF`), and the codes are the
 * decimal prefixes of `*_input.statistic` file names under this dir.
 * @returns the kvcomm cache dir, '' when unavailable.
 */
export function kvcommCacheDir(): string {
  const appData = process.env.APPDATA
  return appData ? join(appData, 'Tencent', 'xwechat', 'net', 'kvcomm') : ''
}

/**
 * Recover the image key: kvcomm-cache derivation first (WeChat 4.x on-disk
 * cache, no injection), then the V2-verified process memory scan.
 * @param opts - account dir (wxid folder) and optional pid.
 * @returns the verified image key result.
 */
export async function fetchImageKey(opts: { accountDir?: string; pid?: number } = {}): Promise<ImageKeyResult> {
  const pid = opts.pid ?? findWechatPid()
  if (pid === null || pid <= 0) return { ok: false, error: '未检测到运行中的微信进程' }

  const accountDir = normalizeAccountDir(opts.accountDir ?? '')
  if (!accountDir || !existsSync(accountDir)) {
    return { ok: false, error: '未提供有效账号数据目录（wxid_* 文件夹）' }
  }

  // 4.x: 优先 kvcomm 缓存派生（无需注入/内存扫描，也无需 V2 模板）。
  const kvDir = kvcommCacheDir()
  if (existsSync(kvDir)) {
    const localWxids = detectWechatAccounts().map(a => a.wxid)
    const resolution = resolveLocalImageKey({ kvcommDir: kvDir, accountDir, account: basename(accountDir), localNativeWxids: localWxids })
    if (resolution !== null) {
      const result: ImageKeyResult = {
        ok: true,
        aesKey: resolution.aesKey,
        xorKey: resolution.xorKey,
        verified: true,
        wxid: resolution.wxid,
        code: resolution.code,
        templatePath: resolution.templatePath,
      }
      upsertAccountKeysInStore('default', {
        image_aes_key: resolution.aesKey,
        image_xor_key: String(resolution.xorKey),
        image_key_verified: true,
        image_key_source: 'kvcomm',
        image_key_derived_wxid: resolution.wxid,
        image_key_code: resolution.code,
      })
      return result
    }
  }

  // Fallback: V2-verified process memory scan (requires _t.dat templates).
  const templateScan = scanV2Templates(accountDir)
  if (templateScan.templates.length === 0) {
    return { ok: false, error: '未找到 V2 图片模板（_t.dat），无法验证图片密钥' }
  }
  const match = await scanImageKeyOnce(pid, templateScan)
  if (match === null) return { ok: false, error: '进程内存中未找到通过 V2 验证的图片 AES 密钥' }

  const xorKey = trustedXorForVerifiedAesKey(match.aesKey, templateScan) ?? 0
  const result: ImageKeyResult = {
    ok: true,
    aesKey: match.aesKey,
    xorKey,
    verified: true,
    templatePath: match.templatePath,
  }
  upsertAccountKeysInStore('default', {
    image_aes_key: match.aesKey,
    image_xor_key: String(xorKey),
    image_key_verified: true,
    image_key_source: 'memory_v2',
  })
  return result
}

/**
 * Get stored key info (db key presence + image key presence).
 * @returns a summary of the default slot's stored keys.
 */
export function getKeysInfoSummary(): { hasDbKey: boolean; hasImageKey: boolean; updatedAt?: string } {
  const stored = getAccountKeysFromStore('default')
  const result: { hasDbKey: boolean; hasImageKey: boolean; updatedAt?: string } = {
    hasDbKey: Boolean(stored.db_key),
    hasImageKey: Boolean(stored.image_aes_key && stored.image_key_verified),
  }
  if (stored.updated_at) result.updatedAt = stored.updated_at
  return result
}

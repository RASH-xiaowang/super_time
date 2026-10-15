
/**
 * 数据配置与密钥状态（含解密/数据库状态） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { fetchDbKey } from '../keys/service.ts'
import { generateKeysFile, getConfig, getKeysInfo, saveConfig, secretMigrationPending } from '../query/config.ts'
import { checkDecryptedIntegrity, queryDbHealth } from '../query/db-health.ts'
import { queryWechatConfig } from '../query/settings.ts'
import { getDbStatus } from '../query/status.ts'
import { migrateWhisperEngineDir, migrateWhisperModels, resolveWhisperModelsDir, whisperEnginePath } from '../query/whisper.ts'
import { AutoDbKeyResult, ConfigSnapshot, DbHealthSnapshot, DbIntegrityResult, DbStatusSnapshot, DecryptStatus, GenerateKeysResult, KeysInfoResult, OperationCategory, OperationStatus, SimpleResult, WechatConfigFull, WechatConfigPatch } from '../types.ts'
import { openNativePath } from '@deepseek-ai/dsh-native-command'
import { openDenialReason } from '../query/path-policy.ts'
import { join } from 'node:path'

export interface createConfigRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  decryptState: DecryptStatus
}

/** Coerce a config cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Remote-only service exposing WeChat data queries. */

export function createConfigRemotes(rc: createConfigRemotesInputs) {
  return {
    getWechatConfig(): ConfigSnapshot {
      return queryWechatConfig(rc.dirs().decrypted)
    },

    getWechatConfigFull(): WechatConfigFull {
      const cfg = getConfig(rc.dirs().decrypted)
      const resolved = (cfg['resolved'] as Record<string, string> | undefined) ?? {}
      return {
        db_dir: cellStr(cfg['db_dir'] ?? ''),
        wechat_process: cellStr(cfg['wechat_process'] ?? 'Weixin.exe'),
        key_format: cellStr(cfg['key_format'] ?? 'wx_key_v4.1'),
        db_enc_key: cellStr(cfg['db_enc_key'] ?? ''),
        image_aes_key: cellStr(cfg['image_aes_key'] ?? ''),
        image_xor_key: Number(cfg['image_xor_key'] ?? 136),
        // 默认关闭：入站监听面必须显式打开（与 config/wechat-config.ts 的 defaultConfig 同口径）
        api_enabled: Boolean(cfg['api_enabled'] ?? false),
        api_port: Number(cfg['api_port'] ?? 5032),
        api_token: cellStr(cfg['api_token'] ?? ''),
        whisper_device: cfg['whisper_device'] === 'gpu' ? 'gpu' : 'cpu',
        whisper_model: cellStr(cfg['whisper_model'] ?? 'medium'),
        whisper_threads: Number(cfg['whisper_threads'] ?? 0),
        whisper_models_dir: cellStr(cfg['whisper_models_dir'] ?? ''),
        whisper_bin: cellStr(cfg['whisper_bin'] ?? ''),
        // W2-12.3：告诉界面「密钥搬家」这件事还等着做没有（纯读，不动文件）。
        secret_migration: secretMigrationPending(rc.dirs().decrypted),
        resolved,
      }
    },

    saveWechatConfig(options: { patch: WechatConfigPatch }): SimpleResult {
      const before = getConfig(rc.dirs().decrypted)
      // Models/engine may live in the default dir even when none was persisted.
      const oldDirRaw = resolveWhisperModelsDir(before['whisper_models_dir'] as string | undefined, rc.dirs().decrypted)
      const oldBin = typeof before['whisper_bin'] === 'string' ? before['whisper_bin'] : ''
      // Resolved before the switch: engines found by search (e.g. Release/ layout)
      // also need to move to the new dir, even when whisper_bin was never persisted.
      const oldEngine = whisperEnginePath(oldBin, oldDirRaw)
      const res = saveConfig(rc.dirs().decrypted, options.patch as unknown as Record<string, unknown>)
      if (res.ok && typeof options.patch.whisper_models_dir === 'string') {
        const newDir = (options.patch.whisper_models_dir ?? '').trim()
        if (newDir && newDir.toLowerCase() !== oldDirRaw.toLowerCase()) {
          // Move previously downloaded models + engine install into the new dir.
          migrateWhisperModels(oldDirRaw, newDir)
          const after = getConfig(rc.dirs().decrypted)
          const bin = typeof after['whisper_bin'] === 'string' ? after['whisper_bin'] : ''
          const relocated = migrateWhisperEngineDir(bin || oldEngine, oldDirRaw, newDir)
          if (relocated && relocated !== (bin || oldEngine)) saveConfig(rc.dirs().decrypted, { whisper_bin: relocated })
        }
      }
      rc.op('settings', 'save_wechat_config', res.ok ? 'ok' : 'fail', '', res.error ?? '配置已保存')
      return res
    },

    async openConfig(signal: AbortSignal = new AbortController().signal): Promise<{ ok: boolean; path: string; error?: string }> {
      const dataRoot = join(rc.dirs().decrypted, '..')
      const p = join(dataRoot, 'config.json')
      // 这个路径是**算出来的**（数据根下的 config.json），不是渲染层给的字符串，
      // 所以政策检查在这里近乎恒过 —— 留着它是因为 `openNativePath` 的语义是「执行」，
      // 一旦哪天这里的 p 变成来自入参，守卫必须已经在这条路上。
      const denial = openDenialReason(p, dataRoot)
      if (denial !== null) return { ok: false, path: p, error: denial }
      try {
        await openNativePath(p, signal)
        return { ok: true, path: p }
      } catch {
        return { ok: false, path: p, error: '系统没能打开配置文件' }
      }
    },

    getWechatKeysInfo(): KeysInfoResult {
      return getKeysInfo(rc.dirs().decrypted)
    },

    generateKeysFile(options: { dbDir: string; keysFile: string; encKeyHex: string; keyFormat?: string }): GenerateKeysResult {
      const r = generateKeysFile(options.dbDir, options.keysFile, options.encKeyHex, options.keyFormat)
      rc.op('keys', 'generate_keys_file', r.ok ? 'ok' : 'fail', options.keysFile, r.error ?? `通过 ${r.verified}/${r.total}`)
      return r
    },

    async autoGetDbKey(options: { dbPath?: string; wechatInstallDir?: string }): Promise<AutoDbKeyResult> {
      const r = await fetchDbKey(options)
      rc.op('keys', 'auto_get_db_key', r.ok ? 'ok' : 'fail', options.dbPath ?? '', r.error ?? (r.source ?? ''))
      return r
    },

    getDecryptStatus(): DecryptStatus {
      return {
        op: rc.decryptState.op,
        active: rc.decryptState.active,
        done: rc.decryptState.done,
        total: rc.decryptState.total,
        failed: rc.decryptState.failed,
        skipped: rc.decryptState.skipped,
        message: rc.decryptState.message,
        // W3-2.5：失败明细随快照一起出去（「失败 N」只说有事发生，明细才说该修什么）。
        failures: rc.decryptState.failures,
      }
    },

    getDbStatus(): DbStatusSnapshot {
      return getDbStatus(rc.dirs().decrypted)
    },

    /**
     * 逐库完整性体检（`PRAGMA integrity_check`）—— **按需显式动作**，与
     * `getDbHealth` 的大小统计分开：后者被「原图链路自检」等面板启动时顺带读取，
     * 挂上全库扫描会让每次挂载多几秒阻塞。
     *
     * 「库文件已损坏」那条处方（wechat-host.js）指的就是这个结果：修不修、
     * 修哪些，看这里的 `corrupted`。
     * @returns DbIntegrityResult：checked/corrupted（可重解密修复）/ unreadable（占用等）。
     */
    async checkDbIntegrity(): Promise<DbIntegrityResult> {
      return checkDecryptedIntegrity(rc.dirs().decrypted)
    },

    getDbHealth(): DbHealthSnapshot {
      return queryDbHealth(rc.dirs().decrypted)
    },

  }
}

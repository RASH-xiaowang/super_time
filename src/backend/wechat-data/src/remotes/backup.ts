
/**
 * 备份与恢复（含加密备份） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { createBackup as createBackupEntry, createEncryptedBackup, deleteBackup as deleteBackupEntry, listBackups as listBackupEntries, previewBackup as previewBackupEntry, restoreEncryptedBackup } from '../query/backup.ts'
import { StreamControl } from '../query/zip.ts'
import { BackupMutationResult, BackupPreviewSnapshot, BackupRestoreResult, BackupSnapshot, OperationCategory, OperationStatus } from '../types.ts'

export interface createBackupRemotesInputs {
  normalizeJobId: (jobId?: unknown) => string
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  streamControl: (jobId?: string) => StreamControl
  finishStreamJob: (jobId: string, error?: string) => void
}

export function createBackupRemotes(rc: createBackupRemotesInputs) {
  const normalizeJobId = rc.normalizeJobId
  return {
    listBackups(): BackupSnapshot {
      return listBackupEntries(rc.dirs().decrypted)
    },

    previewBackup(options: { name: string }): BackupPreviewSnapshot {
      return previewBackupEntry(rc.dirs().decrypted, options.name)
    },

    createBackup(): BackupMutationResult {
      try {
        const e = createBackupEntry(rc.dirs().decrypted)
        rc.op('backup', 'create_backup', 'ok', e.name)
        return { ok: true, name: e.name }
      } catch (err) {
        rc.op('backup', 'create_backup', 'fail', '', (err as Error).message)
        return { ok: false, error: (err as Error).message }
      }
    },

    deleteBackup(options: { name: string }): BackupMutationResult {
      const r = deleteBackupEntry(rc.dirs().decrypted, options.name)
      rc.op('delete', 'delete_backup', r.ok ? 'ok' : 'fail', options.name, r.error ?? '')
      return r
    },

    restoreBackup(options: { name: string; password: string }): BackupRestoreResult {
      const r = restoreEncryptedBackup(rc.dirs().decrypted, options.name, options.password)
      rc.op('backup', 'restore_backup', r.ok ? 'ok' : 'fail', options.name, r.path ?? r.error ?? '')
      return r
    },

    async createEncryptedBackup(options: { password: string; jobId?: string }): Promise<BackupMutationResult> {
      const jobId = normalizeJobId(options?.jobId)
      try {
        // M3：加密备份同样支持进度/取消（同一套 jobId → 本地 onProgress + AbortController）。
        const entry = await createEncryptedBackup(rc.dirs().decrypted, options.password, rc.streamControl(jobId))
        rc.finishStreamJob(jobId)
        rc.op('backup', 'create_encrypted_backup', 'ok', entry.name)
        return { ok: true, name: entry.name }
      } catch (e) {
        rc.finishStreamJob(jobId, (e as Error).message)
        rc.op('backup', 'create_encrypted_backup', 'fail', '', (e as Error).message)
        // 注意：这里**不能**把失败吞掉 —— `createBackup` 现在对「部分子目录复制失败」直接抛错
        // （不再是「静默报成功」），所以本 catch 是那条错误的唯一出口，转成可读的 { ok:false }。
        return { ok: false, error: (e as Error).message }
      }
    },

  }
}

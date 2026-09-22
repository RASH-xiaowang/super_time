
/**
 * 操作日志与隐私审计（含隐私开关读数） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { clearOperationLog, listOperations } from '../query/operation-log.ts'
import { clearPrivacyAudit, getPrivacyStateSnapshot, listPrivacyAudit, writePrivacySettings } from '../query/privacy-audit.ts'
import { queryPrivacyScan } from '../query/privacy.ts'
import { OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PrivacyAuditClearResult, PrivacyAuditRow, PrivacySnapshot, PrivacyStateSnapshot } from '../types.ts'

export interface createOpsLogRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
}

export function createOpsLogRemotes(rc: createOpsLogRemotesInputs) {
  return {
    getOperationLog(options?: OperationLogQuery): OperationLogSnapshot {
      return listOperations(rc.dirs().decrypted, options)
    },

    clearOperationLog(): OperationLogClearResult {
      const r = clearOperationLog(rc.dirs().decrypted)
      rc.op('delete', 'clear_operation_log', r.ok ? 'ok' : 'fail', '', r.ok ? `已清除 ${r.removed} 条` : '清除失败')
      return r
    },

    getPrivacyAuditRows(): PrivacyAuditRow[] {
      return listPrivacyAudit(rc.dirs().decrypted)
    },

    clearPrivacyAudit(): PrivacyAuditClearResult {
      const r = clearPrivacyAudit(rc.dirs().decrypted)
      rc.op('delete', 'clear_privacy_audit', r.ok ? 'ok' : 'fail', '', r.ok ? `已清除 ${r.removed} 条` : '清除失败')
      return r
    },

    getPrivacyState(): PrivacyStateSnapshot {
      return getPrivacyStateSnapshot(rc.dirs().decrypted)
    },

    setPrivacyState(options: { redactSensitive?: boolean; blockOutbound?: boolean }): PrivacyStateSnapshot {
      try {
        writePrivacySettings(rc.dirs().decrypted, options)
        const snapshot = getPrivacyStateSnapshot(rc.dirs().decrypted)
        rc.op('settings', 'set_privacy_state', 'ok', '', `脱敏=${options.redactSensitive ?? '不变'}，出站拦截=${options.blockOutbound ?? '不变'}`)
        return snapshot
      } catch (e) {
        rc.op('settings', 'set_privacy_state', 'fail', '', (e as Error).message)
        throw e
      }
    },

    getPrivacyScan(): PrivacySnapshot {
      return queryPrivacyScan(rc.dirs().decrypted)
    },

  }
}

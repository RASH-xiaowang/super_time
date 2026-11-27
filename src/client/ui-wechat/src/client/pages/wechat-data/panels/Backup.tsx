/**
 * 备份管家面板 — React 版，忠实迁移 BackupManager：备份列表 + 创建/删除。
 * 走 Remote（listBackups / createBackup / deleteBackup），无 HTTP 依赖。
 */
import { useCallback, useEffect, useState } from 'react'
import { ListSkeleton } from './hooks.tsx'
import { apiCreateBackup, apiCreateEncryptedBackup, apiDeleteBackup, apiListBackups, apiPreviewBackup, apiRestoreBackup } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { BackupEntry, BackupPreviewItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Dialog, EmptyState, PanelHeader, Toolbar } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import css from './list-panel.module.css'
import { fmtBytes, fmtDateTimeSec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'
import { desktopOnlyGate } from '../ui/desktop-only.tsx'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useExportTask } from './export-task.ts'

const PLAIN_BACKUP_LABEL = '创建备份'
const ENCRYPTED_BACKUP_LABEL = '创建加密备份'

/**
 * Render the backup-manager panel.
 * @param props - `embedded`：作为「设置」弹窗里的一节渲染（整页交给弹窗右区滚动）。
 * @returns the backup element tree.
 */
export function BackupPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  // ⚠️ 降级判定必须在所有 hooks 之后（见函数末尾的 `blocked` 分支）。
  // 放在 hooks 之前会让 hook 数量随能力表变化而变，React 抛
  // "Rendered more hooks than during the previous render" ⇒ 整棵根树被卸载 ⇒ 黑屏。
  /** 应用内确认框（替代原生 window.confirm —— 系统白框不跟主题）。 */
  const confirm = useConfirm()
  /* 2026-10-03 推广批次 3：items 改用共用 useFreshData —— 打开即查最新（不再预填缓存），
     成功写回缓存；失败才回退缓存并由 hook 标注「以下为本地缓存（可能不是最新）」。
     `refresh` 仍是**可调用函数**（多处操作后重查），它就是 hook 的 reload。 */
  const fetchBackups = useCallback(() => apiListBackups(), [])
  const { data: backupData, loading: backupsLoading, error: backupsError, reload: refresh } =
    useFreshData<Awaited<ReturnType<typeof apiListBackups>>>('backups', fetchBackups)
  const items = backupData?.items ?? []
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [preview, setPreview] = useState<{ name: string; items: BackupPreviewItem[]; total: number } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const backupTask = useExportTask()
  const busyNow = busy || backupTask.running
  const plainBackupRunning = backupTask.running && backupTask.state.label === PLAIN_BACKUP_LABEL
  const encryptedBackupRunning = backupTask.running && backupTask.state.label === ENCRYPTED_BACKUP_LABEL

  const openPreview = async (name: string): Promise<void> => {
    setPreview({ name, items: [], total: 0 })
    setPreviewLoading(true)
    try {
      const env = await apiPreviewBackup({ name })
      setPreview({ name, items: env.items, total: env.total })
    } catch (e) {
      setError((e as Error).message)
      setPreview(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  // hook 负责取数与缓存；本面板的 loading/error 仍归自己（加密备份等流程也在写它们），这条只做对齐。
  useEffect(() => {
    if (!backupsLoading) setLoading(false)
    if (backupsError !== null) setError(backupsError)
  }, [backupsLoading, backupsError])

  /**
   * 失败之后**不能**再调 `refresh()`：它开头就 `setError(null)`，会把刚报出来的错误抹掉。
   * 2026-09-22 真机验收（`scripts/backup-progress-e2e.mjs`）发现：加密备份失败/被取消时
   * 界面上一个字都不显示（进度行消失 + 错误被清空），用户只能猜。
   * @param msg - 要显示的原因（成功时不传，改为刷新列表）。
   */
  const finishWith = async (msg: string | null): Promise<void> => {
    if (msg === null) { await refresh(); return }
    setError(msg)
  }

  const create = async (): Promise<void> => {
    if (backupTask.running) return
    setError(null)
    const outcome = await backupTask.run(async ({ jobId }) => {
      const r = await apiCreateBackup({ jobId })
      if (!r.ok) throw new Error(r.error ?? '创建备份失败')
      return r
    }, {
      idPrefix: 'backup-plain',
      label: PLAIN_BACKUP_LABEL,
      successMessage: () => '普通备份已创建',
    })
    if (outcome.ok) await refresh()
  }

  const remove = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `删除备份「${name}」？`,
      message: '备份文件会从磁盘删除，该操作不可恢复。',
      tone: 'danger',
      confirmText: '删除备份',
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await apiDeleteBackup({ name })
      await finishWith(r.ok ? null : (r.error ?? '删除失败'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const createEncrypted = async (): Promise<void> => {
    if (backupTask.running) return
    if (!password.trim()) { setError('请输入备份密码'); return }
    setError(null)
    const outcome = await backupTask.run(async ({ jobId }) => {
      const r = await apiCreateEncryptedBackup({ password: password.trim(), jobId })
      if (!r.ok) throw new Error(r.error ?? '加密备份失败')
      return r
    }, {
      idPrefix: 'backup-enc',
      label: ENCRYPTED_BACKUP_LABEL,
      successMessage: () => '加密备份已创建',
    })
    if (outcome.ok) {
      setPassword('')
      await refresh()
    }
  }

  const restore = async (name: string): Promise<void> => {
    if (!password.trim()) { setError('请输入备份密码'); return }
    // 恢复前确认：恢复会覆盖当前解密数据；建议先创建一份当前备份。
    const ok = await confirm({
      title: `用「${name}」恢复？`,
      message: '该操作会覆盖当前解密数据。建议先创建一份当前备份留底。',
      tone: 'danger',
      confirmText: '覆盖并恢复',
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const r = await apiRestoreBackup({ name, password: password.trim() })
      if (!r.ok) setError(r.error ?? '恢复失败')
      else setError(`已恢复到：${r.path ?? ''}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 浏览器态整节换成降级卡（hooks 之后判定，hook 数量恒定）。
  const blocked = desktopOnlyGate('backup')
  if (blocked !== null) return blocked

  return (
    <div className={embedded ? css.panelEmbedded : css.panel}>
      {/* 微信化：嵌进设置弹窗时不再画页头，只留一行节内工具行（输入 + 两个动作）。 */}
      {embedded ? (
        <Toolbar
          left={<span className={kitCss.textCaption}>本地快照 · 只写本机</span>}
          right={(
            <>
              <input type="password" className={css.backupInput} placeholder="备份密码（加密备份/恢复用）" value={password} onChange={(e) => { setPassword(e.target.value) }} aria-label="备份密码" />
              <button type="button" className={css.catBtn} data-active="true" onClick={() => { void create() }} disabled={busyNow}>
                {plainBackupRunning ? (backupTask.finishing ? '完成中…' : '备份中…') : busy ? '处理中…' : '创建备份'}
              </button>
              <button type="button" className={css.catBtn} onClick={() => { void createEncrypted() }} disabled={busyNow}>
                {encryptedBackupRunning ? (backupTask.finishing ? '完成中…' : '加密中…') : '加密备份'}
              </button>
            </>
          )}
        />
      ) : (
        <PanelHeader
          title="备份管家"
          actions={(
            <>
              <input type="password" className={css.backupInput} placeholder="备份密码（加密备份/恢复用）" value={password} onChange={(e) => { setPassword(e.target.value) }} aria-label="备份密码" />
              <button type="button" className={css.catBtn} data-active="true" onClick={() => { void create() }} disabled={busyNow}>
                {plainBackupRunning ? (backupTask.finishing ? '完成中…' : '备份中…') : busy ? '处理中…' : '创建备份'}
              </button>
              <button type="button" className={css.catBtn} onClick={() => { void createEncrypted() }} disabled={busyNow}>
                {encryptedBackupRunning ? (backupTask.finishing ? '完成中…' : '加密中…') : '加密备份'}
              </button>
            </>
          )}
        />
      )}
      <ExportProgressStatus state={backupTask.state} onCancel={() => { void backupTask.cancel() }} />
      {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
      <div className={css.scroll}>
        {loading && <ListSkeleton rows={4} />}
        {!loading && items.length === 0 && (
          <div className={css.empty}>
            <EmptyState
              icon="💾"
              title="暂无备份"
            />
          </div>
        )}
        {!loading && items.map(b => (
          <div key={b.name} className={`${css.fileCell} ${css.bkCell}`} title={b.path}>
            <span className={css.fileName}>{b.name}</span>
            <span className={css.fileMeta}>{fmtBytes(b.size)} · {b.summary || (b.kind === 'enc' ? '加密' : '目录')} · {fmtDateTimeSec(b.modified)}{b.ok !== undefined ? (b.ok ? ' · ✓ 完整' : ' · ⚠️ 校验异常') : ''}</span>
            <button type="button" className={css.catBtn} onClick={() => { void openPreview(b.name) }} disabled={previewLoading}>预览</button>
            {b.kind === 'enc' && <button type="button" className={css.catBtn} onClick={() => { void restore(b.name) }} disabled={busyNow || !b.ok}>恢复</button>}
            <button type="button" className={css.catBtn} onClick={() => { void remove(b.name) }} disabled={busyNow}>删除</button>
          </div>
        ))}
      </div>

      <Dialog open={preview !== null} onClose={() => { setPreview(null) }} title={preview ? `备份预览：${preview.name}` : '备份预览'}>
        {preview && (
          <>
            <div className={kitCss.textMeta}>共 {preview.total} 项（最多展示 500 项）</div>
            {previewLoading && <div className={css.bkPreviewNote}>加载中…</div>}
            {!previewLoading && preview.items.length === 0 && <div className={css.bkPreviewNote}>无可预览内容</div>}
            {!previewLoading && preview.items.map((it, i) => (
              <div key={i} className={css.bkPreviewRow}>
                <span className={css.bkPreviewName}>{it.isDir ? '📁 ' : ''}{it.name}</span>
                <span className={css.bkPreviewSize}>{it.isDir ? '目录' : fmtBytes(it.size)}</span>
              </div>
            ))}
          </>
        )}
      </Dialog>
    </div>
  )
}

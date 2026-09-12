/**
 * 备份管家面板 — React 版，忠实迁移 BackupManager：备份列表 + 创建/删除。
 * 走 Remote（listBackups / createBackup / deleteBackup），无 HTTP 依赖。
 */
import { useCallback, useEffect, useState } from 'react'
import { ListSkeleton } from './hooks.tsx'
import { apiCreateBackup, apiCreateEncryptedBackup, apiDeleteBackup, apiListBackups, apiPreviewBackup, apiRestoreBackup, readRenderCache, writeRenderCache } from '../api.ts'
import type { BackupEntry, BackupPreviewItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Dialog, PanelHeader } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import { fmtBytes, fmtDateTimeSec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

/**
 * Render the backup-manager panel.
 * @returns the backup element tree.
 */
export function BackupPanel(): React.JSX.Element {
  const [items, setItems] = useState<readonly BackupEntry[]>(() => readRenderCache<readonly BackupEntry[]>('backups') ?? [])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [preview, setPreview] = useState<{ name: string; items: BackupPreviewItem[]; total: number } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

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

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const env = await apiListBackups()
      setItems(env.items)
      writeRenderCache('backups', env.items)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await apiCreateBackup()
      if (!r.ok) setError(r.error ?? '创建备份失败')
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string): Promise<void> => {
    if (!window.confirm(`删除备份「${name}」？`)) return
    setBusy(true)
    try {
      const r = await apiDeleteBackup({ name })
      if (!r.ok) setError(r.error ?? '删除失败')
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const createEncrypted = async (): Promise<void> => {
    if (!password.trim()) { setError('请输入备份密码'); return }
    setBusy(true)
    setError(null)
    try {
      const r = await apiCreateEncryptedBackup({ password: password.trim() })
      if (!r.ok) setError(r.error ?? '加密备份失败')
      setPassword('')
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (name: string): Promise<void> => {
    if (!password.trim()) { setError('请输入备份密码'); return }
    // 恢复前确认：恢复会覆盖当前解密数据；建议先创建一份当前备份。
    if (!window.confirm(`确认用「${name}」恢复吗？该操作会覆盖当前解密数据（建议先创建一份当前备份留底）。`)) return
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

  return (
    <div className={css.panel}>
      <PanelHeader
        title="备份管家"
        desc="本地快照（目录拷贝 / AES-256 加密 WCB）"
        actions={(
          <>
            <input type="password" className={css.backupInput} placeholder="备份密码（加密备份/恢复用）" value={password} onChange={(e) => { setPassword(e.target.value) }} aria-label="备份密码" />
            <button type="button" className={css.catBtn} data-active="true" onClick={() => { void create() }} disabled={busy}>
              {busy ? '处理中…' : '创建备份'}
            </button>
            <button type="button" className={css.catBtn} onClick={() => { void createEncrypted() }} disabled={busy}>
              加密备份
            </button>
          </>
        )}
      />
      {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
      <div className={css.scroll}>
        {loading && <ListSkeleton rows={4} />}
        {!loading && items.length === 0 && (
          <div className={css.empty}>
            暂无备份 · 点上方「创建备份」生成第一个本地快照（目录拷贝），或「加密备份」生成 AES-256 加密包
          </div>
        )}
        {!loading && items.map(b => (
          <div key={b.name} className={css.fileCell} title={b.path}>
            <span className={css.fileName}>{b.name}</span>
            <span className={css.fileMeta}>{fmtBytes(b.size)} · {b.summary || (b.kind === 'enc' ? '加密' : '目录')} · {fmtDateTimeSec(b.modified)}{b.ok !== undefined ? (b.ok ? ' · ✓ 完整' : ' · ⚠️ 校验异常') : ''}</span>
            <button type="button" className={css.catBtn} onClick={() => { void openPreview(b.name) }} disabled={previewLoading}>预览</button>
            {b.kind === 'enc' && <button type="button" className={css.catBtn} onClick={() => { void restore(b.name) }} disabled={busy || !b.ok}>恢复</button>}
            <button type="button" className={css.catBtn} onClick={() => { void remove(b.name) }} disabled={busy}>删除</button>
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

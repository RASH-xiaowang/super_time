import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Button } from '../ui/kit.tsx'
import { kbUploadManager } from './use-kb-upload.ts'
import type { UploadBatch, UploadCandidate } from './kb-upload.ts'
import css from './kb-upload.module.css'

/** File metadata only; the backend still validates actual file type, size and content duplicates. */
export function droppedCandidates(data: DataTransfer, resolvePath: (file: File) => string): UploadCandidate[] {
  const items = Array.from(data.items ?? [])
  const files = items.length ? items.filter(item => item.kind === 'file').map(item => {
    try {
      const entry = item.webkitGetAsEntry?.()
      if (entry?.isDirectory) return { name: entry.name, error: '不支持文件夹，请选择其中的文件' }
      const file = item.getAsFile()
      if (!file) return { name: '未识别的文件', error: '无法读取拖入的文件，请重新选择' }
      return candidate(file)
    } catch { return { name: '未识别的文件', error: '读取拖拽项目失败，请重新选择文件' } }
  }) : Array.from(data.files ?? []).map(candidate)
  return files
  function candidate(file: File): UploadCandidate {
    try { return { name: file.name, size: file.size, path: resolvePath(file) } }
    catch { return { name: file.name, size: file.size, error: '读取文件路径失败，请点“添加文件”重试' } }
  }
}
const fileDrag = (data: DataTransfer) => Array.from(data.types ?? []).includes('Files')

export function KbUploadDropzone({ kbId, busy, children }: { kbId: number; busy: boolean; children: ReactNode }) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const pathForFile = window.electronAPI?.kbFiles?.getPathForFile
  useEffect(() => {
    const reset = () => { depth.current = 0; setDragging(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') reset() }
    document.addEventListener('dragend', reset)
    document.addEventListener('drop', reset)
    window.addEventListener('blur', reset)
    document.addEventListener('keydown', escape)
    reset()
    return () => {
      document.removeEventListener('dragend', reset)
      document.removeEventListener('drop', reset)
      window.removeEventListener('blur', reset)
      document.removeEventListener('keydown', escape)
    }
  }, [kbId])
  const enter = (event: DragEvent<HTMLDivElement>) => {
    if (!fileDrag(event.dataTransfer)) return
    event.preventDefault()
    depth.current++
    setDragging(true)
  }
  return <div className={css.zone} data-dragging={dragging || undefined} onDragEnter={enter}
    onDragOver={event => {
      // Never let a dropped file/URL navigate the application away.
      event.preventDefault()
      event.dataTransfer.dropEffect = fileDrag(event.dataTransfer) && !busy && pathForFile ? 'copy' : 'none'
    }}
    onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false) }}
    onDrop={event => {
      event.preventDefault()
      event.stopPropagation()
      depth.current = 0
      setDragging(false)
      if (busy || !fileDrag(event.dataTransfer)) return
      // No File.path fallback: Electron 32+ requires the narrow native bridge.
      const candidates = droppedCandidates(event.dataTransfer, file => pathForFile?.(file) ?? '')
      if (candidates.length) void kbUploadManager.start(kbId, candidates)
    }}>
    {children}
    {dragging && <div className={css.overlay} role="status">
      {busy ? '正在添加文件，请稍候' : pathForFile ? '松开以添加文件（支持多选，不支持文件夹）' : '拖拽需要桌面端支持，请使用“添加文件”选择'}
    </div>}
  </div>
}

export function KbUploadReceipt({ kbId, batch, busy, ownBusy }: { kbId: number; batch?: UploadBatch; busy: boolean; ownBusy: boolean }) {
  if (!batch) return busy ? <div className={css.receipt} role="status">另一知识库正在添加文件，请稍候</div> : null
  const added = batch.items.filter(item => item.status === 'added').length
  const failed = batch.items.filter(item => item.status === 'failed').length
  const settled = batch.items.filter(item => item.status !== 'processing' && item.status !== 'queued').length
  const retry = batch.items.filter(item => item.retryable && item.path)
  const statusText = { queued: '等待', processing: '登记中', added: '已加入', failed: '未加入', cancelled: '未开始' }
  return <section className={css.receipt} aria-label="文件添加进度">
    <div className={css.actions}>
      <span role="status" aria-live="polite">{batch.phase === 'selecting' ? '正在选择文件…' : '已处理 ' + settled + '/' + batch.items.length + ' · 已加入 ' + added + ' 个，' + failed + ' 个未加入'}</span>
      {ownBusy ? <Button size="sm" variant="outline" disabled={batch.stopping} onClick={() => kbUploadManager.cancel(kbId)}>{batch.stopping ? '正在停止后续文件…' : '停止后续文件'}</Button>
        : <><Button size="sm" variant="outline" disabled={busy || !retry.length} onClick={() => { void kbUploadManager.start(kbId, retry.map(({ name, path, size }) => ({ name, path, size }))) }}>重试未完成项</Button>
          <Button size="sm" variant="outline" onClick={() => kbUploadManager.dismiss(kbId)}>知道了</Button></>}
    </div>
    {batch.message && <p role="status">{batch.message}</p>}
    {batch.items.length > 0 && <ul className={css.items}>{batch.items.map((item, i) => <li key={i}>
      <span className={css.name} title={item.name}>{item.name}</span>
      <span>{statusText[item.status]}{item.detail ? ' · ' + item.detail : ''}</span>
    </li>)}</ul>}
  </section>
}

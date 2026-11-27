import { useEffect, useRef, useSyncExternalStore } from 'react'
import { apiAddKbFiles, apiOpenFileDialog } from '../api.ts'
import { KB_ACCEPTED_EXTS } from '../types.ts'
import { createKbUploadManager } from './kb-upload.ts'

export const kbUploadManager = createKbUploadManager(apiAddKbFiles)

export function useKbUpload(kbId: number, onRegistered: () => Promise<void>, active = true) {
  const snapshot = useSyncExternalStore(kbUploadManager.subscribe, kbUploadManager.getSnapshot)
  const batch = snapshot.batches.get(kbId)
  const refresh = useRef(onRegistered)
  refresh.current = onRegistered
  const refreshed = useRef('')
  useEffect(() => {
    if (!active) kbUploadManager.cancel(kbId)
    return () => { kbUploadManager.cancel(kbId) }
  }, [kbId, active])
  useEffect(() => {
    const key = kbId + ':' + batch?.revision
    if (!active || batch?.phase !== 'done' || !batch.items.some(item => item.status === 'added') || refreshed.current === key) return
    refreshed.current = key
    // The snapshot reader guards late responses on KB switch/unmount.
    void refresh.current()
  }, [kbId, batch, active])
  const pick = () => kbUploadManager.pick(kbId, () => apiOpenFileDialog({
    title: '选择要加入知识库的文件',
    filters: [{ name: '支持的文件', extensions: [...KB_ACCEPTED_EXTS] }],
  }))
  return { batch, busy: snapshot.activeKb !== null, ownBusy: snapshot.activeKb === kbId, pick }
}

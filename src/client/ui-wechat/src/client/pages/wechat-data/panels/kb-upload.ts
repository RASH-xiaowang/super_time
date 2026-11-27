/** Knowledge file registration queue. No bytes, models or send operations live here. */
import { KB_ACCEPTED_EXTS } from '../types.ts'
import type { KbFileAddResult } from '../types.ts'

// Mirrors kb-files-store.MAX_FILE_BYTES; covered by a contract test. Backend remains authoritative.
export const KB_UPLOAD_MAX_BYTES = 32 * 1024 * 1024
export interface UploadCandidate { name: string; path?: string; size?: number; error?: string }
export type UploadStatus = 'queued' | 'processing' | 'added' | 'failed' | 'cancelled'
export interface UploadItem extends UploadCandidate { status: UploadStatus; detail?: string; retryable?: boolean }
export interface UploadBatch { phase: 'selecting' | 'processing' | 'done'; stopping: boolean; items: readonly UploadItem[]; message?: string; revision: number }
export interface UploadSnapshot { activeKb: number | null; batches: ReadonlyMap<number, UploadBatch> }
type Register = (kbId: number, paths: string[]) => Promise<KbFileAddResult>
type Picker = () => Promise<{ canceled: boolean; files: string[]; error?: string }>

export function uploadBaseName(path: string): string { return path.split(/[\\/]/).pop() || path }
export function prepareUploads(candidates: readonly UploadCandidate[]): UploadItem[] {
  const seen = new Set<string>()
  return candidates.map(candidate => {
    const path = candidate.path?.trim()
    const key = path?.replace(/\\/g, '/').toLowerCase()
    let detail = candidate.error
    const dot = candidate.name.lastIndexOf('.')
    const ext = dot > 0 ? candidate.name.slice(dot + 1).toLowerCase() : ''
    if (!detail && !path) detail = '无法读取本机路径，请在桌面端点“添加文件”重新选择'
    if (!detail && !KB_ACCEPTED_EXTS.includes(ext)) detail = '不支持的文件类型：' + (ext ? '.' + ext : '无扩展名')
    if (!detail && candidate.size !== undefined && candidate.size > KB_UPLOAD_MAX_BYTES) detail = '文件超过 32 MiB 上限'
    if (!detail && key && seen.has(key)) detail = '本批次已选择这个路径'
    if (key) seen.add(key)
    return { ...candidate, path, status: detail ? 'failed' : 'queued', detail, retryable: false }
  })
}

/** Single shared lock includes the native picker. One RPC at a time; cancellation only stops queued work.
 * Receipts survive panel remounts (not app restarts). Backend SHA dedup remains the final safety net.
 */
export function createKbUploadManager(register: Register) {
  let snapshot: UploadSnapshot = { activeKb: null, batches: new Map() }
  const listeners = new Set<() => void>()
  let sequence = 0
  const emit = (kbId: number, batch: UploadBatch, activeKb = snapshot.activeKb) => {
    snapshot = { activeKb, batches: new Map(snapshot.batches).set(kbId, batch) }
    for (const listener of listeners) listener()
  }
  const current = (kbId: number) => snapshot.batches.get(kbId)!
  const cancel = (kbId: number) => {
    if (snapshot.activeKb !== kbId) return
    const batch = current(kbId)
    emit(kbId, { ...batch, stopping: true, message: '已停止后续文件；当前请求仍会完成，已登记文件不会撤回' })
  }
  const drain = async (kbId: number, candidates: readonly UploadCandidate[], token: number) => {
    if (sequence !== token) return
    let batch = current(kbId)
    const items = prepareUploads(candidates)
    emit(kbId, { ...batch, phase: 'processing', items: [...items] })
    for (let i = 0; i < items.length; i++) {
      batch = current(kbId)
      if (items[i]!.status !== 'queued') continue
      if (batch.stopping) {
        items[i] = { ...items[i]!, status: 'cancelled', detail: '未开始，可重试', retryable: true }
        emit(kbId, { ...batch, items: [...items] })
        continue
      }
      items[i] = { ...items[i]!, status: 'processing', detail: '正在登记；解析和索引状态见文档处理' }
      emit(kbId, { ...batch, items: [...items] })
      try {
        const result = await register(kbId, [items[i]!.path!])
        const res = result.results[0]
        items[i] = res?.ok
          ? { ...items[i]!, status: 'added', detail: items[i]!.size === 0 ? '已登记（空文件，无正文）' : '已登记；解析和索引另行处理' }
          : { ...items[i]!, status: 'failed', detail: res?.error || result.error || '未收到文件登记回执，请检查列表后重试', retryable: res?.code !== 'duplicate' && res?.code !== 'not-accepted' && res?.code !== 'too-large' }
      } catch (error) {
        items[i] = { ...items[i]!, status: 'failed', detail: '登记结果未确认，请先检查列表再重试：' + (error instanceof Error ? error.message : String(error)), retryable: true }
      }
      emit(kbId, { ...current(kbId), items: [...items] })
    }
    emit(kbId, { ...current(kbId), phase: 'done', revision: token }, null)
  }
  const begin = (kbId: number) => {
    if (snapshot.activeKb !== null) return null
    const token = ++sequence
    emit(kbId, { phase: 'selecting', stopping: false, items: [], revision: 0 }, kbId)
    return token
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    cancel,
    start: async (kbId: number, candidates: readonly UploadCandidate[]) => {
      const token = begin(kbId)
      if (token === null) return false
      await drain(kbId, candidates, token)
      return true
    },
    pick: async (kbId: number, picker: Picker) => {
      const token = begin(kbId)
      if (token === null) return false
      try {
        const picked = await picker()
        if (picked.error) throw new Error(picked.error)
        if (picked.canceled || current(kbId).stopping) {
          emit(kbId, { ...current(kbId), phase: 'done', revision: token }, null)
        } else {
          await drain(kbId, picked.files.map(path => ({ name: uploadBaseName(path), path })), token)
        }
      } catch (error) {
        emit(kbId, { ...current(kbId), phase: 'done', revision: token, message: error instanceof Error ? error.message : String(error) }, null)
      }
      return true
    },
    dismiss: (kbId: number) => {
      if (snapshot.activeKb === kbId) return
      const batches = new Map(snapshot.batches)
      batches.delete(kbId)
      snapshot = { ...snapshot, batches }
      for (const listener of listeners) listener()
    },
  }
}

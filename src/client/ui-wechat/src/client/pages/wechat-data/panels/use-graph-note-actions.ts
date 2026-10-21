/**
 * 知识笔记的打开 / 删除动作。
 *
 * 从 `GraphPanel` 抽出：它同时依赖知识库 id、当前选中、快照重载与确认框，
 * 放在面板里会让右键菜单的接线继续膨胀。这里只负责“动作”，不渲染 UI。
 */
import { useCallback, useEffect, useRef } from 'react'
import { apiDeleteNote, apiGetNotes } from '../api.ts'
import { useConfirm } from '../ui/confirm.tsx'

export interface GraphNoteEditorState {
  open: boolean
  id?: number
  title?: string
  body?: string
}

export interface UseGraphNoteActionsOptions {
  kbId: number
  selectedId: string | null
  onSelectedCleared: () => void
  onReload: () => Promise<void> | void
  onError: (message: string) => void
  onEditor: (state: GraphNoteEditorState) => void
}

/**
 * 生成笔记编辑/删除动作。
 * @param o - 知识库与面板状态回调。
 * @returns openEditor / remove 两个稳定动作。
 */
export function useGraphNoteActions(o: UseGraphNoteActionsOptions): {
  openEditor: (id: number) => Promise<void>
  remove: (id: number, title?: string) => Promise<void>
} {
  const confirm = useConfirm()
  // 回调经常是内联函数；用 ref 读取最新值，避免 openEditor/remove 每次渲染都换引用，
  // 也让依赖数组不会把整个 options 对象当成不稳定依赖。
  const optionsRef = useRef(o)
  optionsRef.current = o

  const openEditor = useCallback(async (id: number): Promise<void> => {
    const current = optionsRef.current
    try {
      const list = await apiGetNotes(current.kbId)
      const n = list.items.find(x => x.id === id)
      current.onEditor(n ? { open: true, id: n.id, title: n.title, body: n.body } : { open: true, id })
    } catch {
      current.onEditor({ open: true, id })
    }
  }, [])

  const remove = useCallback(async (id: number, title?: string): Promise<void> => {
    const current = optionsRef.current
    const ok = await confirm({
      title: '删除这篇笔记？',
      message: title ? `「${title}」及其正文会从当前知识库删除，相关引用会变成待补笔记。` : '笔记及其正文会从当前知识库删除，相关引用会变成待补笔记。',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const r = await apiDeleteNote(current.kbId, id)
      if (!r.ok) { current.onError(r.error ?? '删除笔记失败'); return }
      if (current.selectedId === 'note:' + id) current.onSelectedCleared()
      await current.onReload()
    } catch (e) {
      current.onError((e as Error).message)
    }
  }, [confirm])

  return { openEditor, remove }
}

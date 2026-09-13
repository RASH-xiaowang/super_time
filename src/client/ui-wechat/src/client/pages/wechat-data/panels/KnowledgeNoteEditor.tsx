/**
 * 知识笔记编辑器（新建 / 编辑）。
 *
 * 正文支持 `[[目标]]` / `[[目标|显示文本]]`：目标命中已有笔记标题即成边，命中不到
 * 就保留为「待补笔记」（图谱里画成虚线节点）。因此这里**不校验链接是否有效**、
 * 也不阻止保存 —— 「先把链接写下来、之后再补那篇笔记」正是这套知识库的用法。
 */
import { useEffect, useMemo, useState } from 'react'
import { apiSaveNote } from '../api.ts'
import css from './graph.module.css'

/** 抽出正文里的 `[[目标]]`（去重、保留原始写法），用于保存前的即时反馈。 */
function extractTargets(body: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([^[\]\n]+)\]\]/g
  let m: RegExpExecArray | null = re.exec(body)
  while (m !== null) {
    const inner = m[1] ?? ''
    const bar = inner.indexOf('|')
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
    const key = target.toLowerCase()
    if (target && !seen.has(key)) {
      seen.add(key)
      out.push(target)
    }
    m = re.exec(body)
  }
  return out
}

/**
 * Note editor modal.
 * @param props - `open` toggles visibility; `noteId` present ⇒ edit, absent ⇒ create.
 */
export function KnowledgeNoteEditor(props: {
  open: boolean
  noteId?: number
  initialTitle?: string
  initialBody?: string
  /** 「ask」标记由问答沉淀而来；后端在更新时会保留未提供的来源字段。 */
  sourceKind?: 'manual' | 'ask'
  sourceUsername?: string
  sourceQuestion?: string
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element | null {
  const {
    open, noteId, initialTitle = '', initialBody = '',
    sourceKind, sourceUsername, sourceQuestion, onClose, onSaved,
  } = props
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(initialBody)
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 组件常驻挂载、靠 open 控制显隐，因此每次打开都要按传入内容重置表单，
  // 否则会残留上一次编辑的标题/正文（看起来像「改了别的笔记」）。
  useEffect(() => {
    if (!open) return
    setTitle(initialTitle)
    setBody(initialBody)
    setTags('')
    setError(null)
  }, [open, initialTitle, initialBody, noteId])

  const links = useMemo(() => extractTargets(body), [body])

  if (!open) return null

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const r = await apiSaveNote({
        ...(noteId !== undefined ? { id: noteId } : {}),
        title: title.trim(),
        body,
        tags,
        ...(sourceKind !== undefined ? { sourceKind } : {}),
        ...(sourceUsername ? { sourceUsername } : {}),
        ...(sourceQuestion ? { sourceQuestion } : {}),
      })
      if (!r.ok) { setError(r.error ?? '保存失败'); return }
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={css.noteBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={noteId === undefined ? '新建笔记' : '编辑笔记'}
      onClick={onClose}
    >
      {/* 点内容区不关闭；只有点遮罩才算取消 */}
      <div className={css.noteCard} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.noteCardTitle}>{noteId === undefined ? '新建笔记' : '编辑笔记'}</div>
        <input
          className={css.noteInput}
          value={title}
          onChange={(e) => { setTitle(e.target.value) }}
          placeholder="标题（也是别的笔记 [[链接]] 的解析目标，需唯一）"
          autoFocus
        />
        <textarea
          className={css.noteTextarea}
          value={body}
          onChange={(e) => { setBody(e.target.value) }}
          placeholder="正文。用 [[目标]] 链接到别的笔记，例如：交付节奏见 [[项目组]]"
          rows={10}
        />
        <input
          className={css.noteInput}
          value={tags}
          onChange={(e) => { setTags(e.target.value) }}
          placeholder="标签，逗号分隔（可选）"
        />
        <div className={css.noteHint}>
          {links.length > 0
            ? <>将建立 {links.length} 条链接：{links.join('、')}（目标笔记不存在时会先记为「待补笔记」，之后再补）</>
            : '还没有 [[链接]]。链接是知识图谱里唯一的边来源。'}
        </div>
        {error && <div className={css.noteError} role="alert">⚠️ {error}</div>}
        <div className={css.noteActions}>
          <button type="button" className={css.miniBtn} onClick={onClose} disabled={saving}>取消</button>
          <button
            type="button"
            className={css.miniBtn}
            data-on
            onClick={() => { void save() }}
            disabled={saving || title.trim().length === 0}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

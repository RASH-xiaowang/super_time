/**
 * 知识笔记编辑器（新建 / 编辑）。
 *
 * 正文支持 `[[目标]]` / `[[目标|显示文本]]`：目标命中已有笔记标题即成边，命中不到
 * 就保留为「待补笔记」（图谱里画成虚线节点）。因此这里**不校验链接是否有效**、
 * 也不阻止保存 —— 「先把链接写下来、之后再补那篇笔记」正是这套知识库的用法。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiSaveNote, apiSuggestKbLinks } from '../api.ts'
import type { KbLinkSuggestResult } from '../types.ts'
import { Button, Dialog, Select } from '../ui/kit.tsx'
import { useKbScope } from './kb-scope.ts'
import css from './note-editor.module.css'

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
 * 编辑器里的「保存到」—— 只在 `allowKbPick` 时渲染。
 *
 * 单独一个组件、而不是在编辑器本体里无条件 `useKbScope()`：编辑器在三个面板里
 * **常驻挂载**（靠 `open` 控显隐），而库列表的订阅只有这一个入口真正需要；
 * 写在编辑器本体上就等于让图谱与笔记库那两个入口也白订一份。挂在这里，
 * Hook 只在它真的被渲染出来时才跑。
 * @param props.value - 当前选中的库 id。
 * @param props.onChange - 改选回调。
 * @returns 一行「保存到 [库选择器]」。
 */
function KbTargetPicker({ value, onChange }: { value: number; onChange: (id: number) => void }): React.JSX.Element {
  const { kbs } = useKbScope()
  if (kbs.length === 0) {
    // 列表还没到（或读失败）：**不留一个空选择器** —— 空下拉会被读成「没有别的库」，
    // 而这时用户其实只是还不知道有哪些库。
    return (
      <div className={css.kbRow}>
        <span className={css.kbLabel}>保存到</span>
        <span className={css.kbHint}>读取知识库列表…</span>
      </div>
    )
  }
  return (
    <div className={css.kbRow}>
      <span className={css.kbLabel}>保存到</span>
      <Select
        value={String(value)}
        onChange={(v) => { onChange(Number(v)) }}
        options={kbs.map(k => ({ value: String(k.id), label: `${k.name} · ${k.noteCount}` }))}
        ariaLabel="保存到哪个知识库"
      />
      <span className={css.kbHint}>决定它成为哪个库图谱里的节点</span>
    </div>
  )
}

/**
 * Note editor modal.
 * @param props - `open` toggles visibility; `noteId` present ⇒ edit, absent ⇒ create.
 */
export function KnowledgeNoteEditor(props: {
  /**
   * 目标知识库。**必填、无默认值。**
   *
   * 后端把 kbId 当定位参数（`saveNote(kbId, input)`），漏传在 typecheck 阶段就红；
   * 若给默认值，忘了传的新调用点会**静默写进默认库** —— 用户切库后会发现「刚写的东西
   * 不见了」（其实在另一个库里），这是最难自查的一类偏差。
   * 三个调用点（笔记库 / 知识图谱 / 问答沉淀）各传一次当前作用域。
   */
  kbId: number
  open: boolean
  noteId?: number
  initialTitle?: string
  initialBody?: string
  /**
   * 已有标签（编辑时回填）。
   *
   * 早先没有这个入参，表单每次打开都把标签清成 `''`，而保存时又会把 `tags`
   * 一并提交 —— 于是「改个错别字」会把这条笔记的标签**静默清空**（后端按
   * 「提供了就覆盖」处理）。标签是本库唯一的分类轴，被顺手抹掉是数据损失，
   * 所以这里必须能回填。
   */
  initialTags?: string
  /** 「ask」标记由问答沉淀而来；后端在更新时会保留未提供的来源字段。 */
  sourceKind?: 'manual' | 'ask'
  sourceUsername?: string
  sourceQuestion?: string
  /**
   * 允许在编辑器内改「存到哪个库」。
   *
   * 只有问答沉淀（`Ask.tsx`）会开：那是最容易「沉淀完才发现该归到另一个库」的入口。
   * 笔记库 / 知识图谱两个入口不开 —— 它们本来就站在某个库的分段条底下，
   * 再问一次「存到哪」等于把已知的事情重问一遍。
   */
  allowKbPick?: boolean
  onClose: () => void
  /** 保存成功后回调，带上后端返回的 id（新建时用它把详情切到这篇）。 */
  onSaved: (id?: number) => void
}): React.JSX.Element | null {
  const {
    kbId, open, noteId, initialTitle = '', initialBody = '', initialTags = '',
    sourceKind, sourceUsername, sourceQuestion, allowKbPick, onClose, onSaved,
  } = props
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(initialBody)
  const [tags, setTags] = useState(initialTags)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 模型给的链接建议（null = 还没要过）。**只在用户点「找建议」时才发请求。** */
  const [sug, setSug] = useState<KbLinkSuggestResult | null>(null)
  const [asking, setAsking] = useState(false)
  /** 插入要用到光标位置，所以正文得有个 ref（`setBody` 换不了光标）。 */
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  /** 实际写入的库：默认 = 打开时的当前作用域；只有 `allowKbPick` 下用户能改。 */
  const [targetKb, setTargetKb] = useState(kbId)

  // 组件常驻挂载、靠 open 控制显隐，因此每次打开都要按传入内容重置表单，
  // 否则会残留上一次编辑的标题/正文/标签（看起来像「改了别的笔记」）。
  useEffect(() => {
    if (!open) return
    setTitle(initialTitle)
    setBody(initialBody)
    setTags(initialTags)
    setError(null)
    // 上一次编辑的建议不能留到下一篇：那是**另一段正文**的语义近邻，
    // 留在屏幕上就会被当成「这篇也该连它」，而模型根本没看过这篇。
    setSug(null)
    // 每次打开都把目标库拉回当前作用域：上一次在别处改过（或中途切了库）残留的选择，
    // 会让这一条笔记在用户毫无察觉的情况下落到另一个库里。
    setTargetKb(kbId)
  }, [open, initialTitle, initialBody, initialTags, noteId, kbId])

  const links = useMemo(() => extractTargets(body), [body])
  /** 正文里已经连过的目标（小写）：建议芯片按它过滤，免得点了之后芯片还挂在原处。 */
  const linkedKeys = useMemo(() => new Set(links.map(t => t.trim().toLowerCase())), [links])

  /** 要一次建议：把「标题 + 正文」发过去，让后端在本库的标题与实体里找语义近邻。 */
  const ask = async (): Promise<void> => {
    setAsking(true)
    setError(null)
    try {
      setSug(await apiSuggestKbLinks(targetKb, title.trim() === '' ? body : `${title.trim()}\n${body}`, { excludeTitle: title }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  /**
   * 把 `[[目标]]` 插到光标处。
   *
   * 只有这一个写路径，而且它由**点击**触发：模型返回的候选从来不落库、也不自动进正文。
   * 拿 `selectionStart` 而不是追加到末尾，是因为用户通常停在句子中间 —— 追加到末尾
   * 等于把光标处的语义断点丢掉，还得自己搬一遍。
   * @param label - 候选名字。
   * @returns 无（改 body 与光标）。
   */
  const insertLink = (label: string): void => {
    const el = bodyRef.current
    const snippet = `[[${label}]]`
    const start = el?.selectionStart ?? body.length
    const end = el?.selectionEnd ?? start
    const next = body.slice(0, start) + snippet + body.slice(end)
    setBody(next)
    // 插完把光标放到插入内容之后并重新聚焦：用户接下来要接着写这句话，
    // 而不是看见焦点跳到弹层别处、再点一次正文找刚才的位置。
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + snippet.length, start + snippet.length)
    })
  }

  if (!open) return null

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const r = await apiSaveNote(targetKb, {
        ...(noteId !== undefined ? { id: noteId } : {}),
        title: title.trim(),
        body,
        tags,
        ...(sourceKind !== undefined ? { sourceKind } : {}),
        ...(sourceUsername ? { sourceUsername } : {}),
        ...(sourceQuestion ? { sourceQuestion } : {}),
      })
      if (!r.ok) { setError(r.error ?? '保存失败'); return }
      onSaved(r.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // 弹层骨架交给 kit 的 Dialog（Radix）：× / Esc / 焦点收口 / portal 到 body / 遮罩
  // 都是它自带的。改前这里是手写的 `role="dialog"` 覆盖层，只支持点遮罩关闭 ——
  // 键盘用户会被困住；而且它的 z-index 与库弹层同为 60，两层同时在场时谁在上面
  // 只由 DOM 顺序决定。
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={noteId === undefined ? '新建笔记' : '编辑笔记'}
      footer={(
        <>
          <Button variant="pill" onClick={onClose} disabled={saving}>取消</Button>
          <Button
            variant="primary"
            onClick={() => { void save() }}
            disabled={saving || title.trim().length === 0}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      )}
    >
      <input
        className={css.field}
        value={title}
        onChange={(e) => { setTitle(e.target.value) }}
        placeholder="标题（也是别的笔记 [[链接]] 的解析目标，需唯一）"
        aria-label="笔记标题"
        autoFocus
      />
      <textarea
        ref={bodyRef}
        className={css.body}
        value={body}
        onChange={(e) => { setBody(e.target.value) }}
        placeholder="正文。用 [[目标]] 链接到别的笔记，例如：交付节奏见 [[项目组]]"
        aria-label="笔记正文"
      />
      {/* ── 模型建议的链接（V6）─────────────────────────────────────────
          两个刻意的设计：
          ① 要**点一下**才出网 —— 随打字触发会把同一句话发几十遍，而那时用户还在写；
          ② 芯片**不自动写正文** —— 点它才插入。模型判错的代价因此是「没人点」，
             而不是「正文里多了一条用户没写过的链接，然后进了图谱」。 */}
      <div className={css.suggest}>
        <button
          type="button"
          className={css.suggestBtn}
          onClick={() => { void ask() }}
          disabled={asking || body.trim().length < 8}
          title={body.trim().length < 8 ? '正文太短，先写几句再要建议' : '把正文与本库标题/实体发给向量模型找语义近邻（会出网）'}
        >
          {asking ? '查找中…' : '🔗 找链接建议'}
        </button>
        {sug !== null && !sug.ok && <span className={css.suggestMeta}>{sug.error ?? '这次没拿到建议'}</span>}
        {sug !== null && sug.ok && sug.candidates.length === 0 && (
          <span className={css.suggestMeta}>{sug.note ?? '没有一个够近的候选'}</span>
        )}
        {sug !== null && sug.candidates.some(c => !linkedKeys.has(c.label.trim().toLowerCase())) && (
          <>
            <span className={css.suggestMeta}>点击插入（{sug.note ? `${sug.note} · ` : ''}来自 {sug.model} · 比对了 {sug.pool} 个候选）</span>
            {sug.candidates
              .filter(c => !linkedKeys.has(c.label.trim().toLowerCase()))
              .map(c => (
                <button
                  key={`${c.kind}:${c.label}`}
                  type="button"
                  className={css.chip}
                  onClick={() => { insertLink(c.label) }}
                  title={`插入 [[${c.label}]]（${c.kind === 'note' ? '已有笔记' : '模型抽出的实体'} · 相似度 ${c.score}）`}
                >
                  {c.label}
                </button>
              ))}
          </>
        )}
      </div>
      {/* 只有问答沉淀会渲染它：那里「存到哪个库」默认是当前作用域，但常常要改。 */}
      {allowKbPick && <KbTargetPicker value={targetKb} onChange={setTargetKb} />}
      <input
        className={css.field}
        value={tags}
        onChange={(e) => { setTags(e.target.value) }}
        placeholder="标签，逗号分隔（可选）"
        aria-label="标签，逗号分隔"
      />
      <div className={css.hint}>
        {links.length > 0
          ? <>将建立 {links.length} 条链接：{links.join('、')}（目标笔记不存在时会先记为「待补笔记」，之后再补）</>
          : '还没有 [[链接]]。链接是知识图谱里唯一的边来源。'}
      </div>
      {error && <div className={css.error} role="alert">⚠️ {error}</div>}
    </Dialog>
  )
}

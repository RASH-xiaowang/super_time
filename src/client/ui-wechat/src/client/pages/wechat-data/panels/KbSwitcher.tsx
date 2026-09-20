/**
 * 知识库切换器 —— 挂在合并外壳（`MergedSections`）分段条**右侧**的那个插槽里。
 *
 * 为什么库选择器在分段条右侧、而不是第三个分段：分段表达的是「同一份数据的两种看法」
 * （笔记库 / 知识图谱），而库表达的是「看哪一份数据」—— 是上一层的维度。两者并列会诱导出
 * 「在甲库里点知识图谱」这种语义矛盾。库的**管理**（新建 / 改名 / 删除 / 总览）做成弹层，
 * 不新增页面、不新增路由（侧栏入口数 17 与可路由页签数 36 因此都不变）。
 *
 * 本文件是**唯一**调用 `apiCreateKb / apiRenameKb / apiDeleteKb` 的地方
 * （源码级 gate 钉住）。失效与广播收在 `api.ts` 的包装里，调用方不可能忘。
 *
 * ⚠ 刻意**不**复用 `useConfirm()`：它只有「确认 / 取消」两个按钮，而删库必须让用户在
 * 「移到别的库」与「一并删除」之间**选一个**（后端 `KbDeleteAction` 也是必填、不猜）。
 * 用两次串联的 confirm 表达不了这个三分支（第二次 confirm 的「取消」语义会是「反悔」，
 * 而不是「这一次不删」）。
 */
import { useCallback, useMemo, useState } from 'react'
import { apiCreateKb, apiDeleteKb, apiRenameKb } from '../api.ts'
import type { KbMeta } from '../types.ts'
import { Button, Select } from '../ui/kit.tsx'
import { useTransientNotice } from './hooks.tsx'
import { canMoveInstead, deleteDialogLead, deleteReceipt, purgeButtonLabel } from './kb-delete-copy.ts'
import { DEFAULT_KB_ID, useKbScope } from './kb-scope.ts'
import css from './kb-switcher.module.css'

/**
 * 删掉 `goneId` 之后该停在哪个库。
 *
 * 优先回默认库（它是迁移兜底、不可删）；默认库也没了（理论上不会）就取剩下的第一个。
 * `rest` 为空时仍返回默认库 id：界面**永不停留在无库状态**，后端迁移也保证至少有一个库。
 * @param list - 删除前的库列表。
 * @param goneId - 被删掉的库 id。
 * @returns 应当切过去的库 id。
 */
function fallbackKbId(list: readonly KbMeta[], goneId: number): number {
  const rest = list.filter(k => k.id !== goneId)
  if (rest.length === 0) return DEFAULT_KB_ID
  return rest.some(k => k.id === DEFAULT_KB_ID) ? DEFAULT_KB_ID : (rest[0] as KbMeta).id
}

/** 新建 / 重命名弹层的表单状态。 */
interface FormState {
  mode: 'create' | 'rename'
  /** 重命名时的目标库 id；新建时为空。 */
  id?: number
  name: string
}

/**
 * 待删除的库（弹层要写全后果，所以条数也带上）。
 *
 * ⚠ **笔记数与文件数都要**：只带 `noteCount` 时，一个「0 条笔记 / 5 个文件」的库会走到
 * 「这个库是空的」那一支 —— 真机探针实测到过这一句，而用户点下去会丢掉 5 份登记。
 */
interface DeleteState {
  id: number
  name: string
  noteCount: number
  /** 库内登记文件条数（`KbMeta.fileCount`，由后端把两个库文件合流后给出）。 */
  fileCount: number
  /** 「移到…」分支里选中的目标库 id（0 = 还没选）。 */
  target: number
}

/**
 * 库切换器 + 库管理弹层。
 * @returns 选择器与「⋯」菜单。
 */
export function KbSwitcher(): React.JSX.Element {
  const { kbId, kbs, readError, loading, setKb, reloadKbs } = useKbScope()
  const [menuOpen, setMenuOpen] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [del, setDel] = useState<DeleteState | null>(null)
  const [manage, setManage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 删库是**破坏性且不可撤销**的，所以成功了也必须留一句话 —— 只说给弹层里的 err 槽
  // 是不够的（成功时弹层要关掉）。默认时长即可：这是一条「看见了就够」的确认。
  const { notice, flash } = useTransientNotice()

  const current = useMemo(() => kbs.find(k => k.id === kbId) ?? null, [kbs, kbId])
  const options = useMemo(
    () => kbs.map(k => ({ value: String(k.id), label: `${k.name} · ${k.noteCount}` })),
    [kbs],
  )
  /** 可移入的候选：除被删那个之外的全部库。 */
  const moveTargets = useMemo(
    () => (del ? kbs.filter(k => k.id !== del.id) : []),
    [kbs, del],
  )
  /** 弹层要说「库里有什么」（笔记 + 文件）。文案本体在 kb-delete-copy.ts，有单测。 */
  const delCounts = { noteCount: del?.noteCount ?? 0, fileCount: del?.fileCount ?? 0 }
  // 「移到别的库」不只看笔记：后端 `kbFilesOnKbDelete` 连**文件**一起迁移（设计稿 §7.1），
  // 所以一个装了几百份资料、笔记一条没写的库同样该有这条路 ——
  // 只按 noteCount 判，它就只剩「一并删除」一个出口。
  const canMove = canMoveInstead(delCounts)

  const closeAll = useCallback((): void => {
    setMenuOpen(false)
    setForm(null)
    setDel(null)
    setManage(false)
    setErr(null)
  }, [])

  const openCreate = useCallback((): void => {
    setMenuOpen(false)
    setErr(null)
    setForm({ mode: 'create', name: '' })
  }, [])

  const openRename = useCallback((k: KbMeta): void => {
    setMenuOpen(false)
    setErr(null)
    setForm({ mode: 'rename', id: k.id, name: k.name })
  }, [])

  const openDelete = useCallback((k: KbMeta): void => {
    setMenuOpen(false)
    setErr(null)
    setDel({ id: k.id, name: k.name, noteCount: k.noteCount, fileCount: k.fileCount, target: 0 })
  }, [])

  const openManage = useCallback((): void => {
    setMenuOpen(false)
    setErr(null)
    setManage(true)
  }, [])

  const submitForm = useCallback(async (): Promise<void> => {
    if (!form) return
    const name = form.name.trim()
    if (name === '') { setErr('库名不能为空'); return }
    setBusy(true)
    setErr(null)
    try {
      const r = form.mode === 'create'
        ? await apiCreateKb(name)
        : await apiRenameKb(form.id as number, name)
      if (!r.ok) { setErr(r.error ?? '操作失败'); return }
      // 新建后**不**自动切过去：用户常常是「先把库建好，稍后再往里写」，
      // 而库列表现已变成两项 —— 设计里的真机断言也要求此时仍停在原来的库。
      setForm(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [form])

  /**
   * 删库。两个分支都会让当前作用域可能失效，所以删完要**同步**把作用域挪走 ——
   * 等 `useKbScope` 拉到新列表再退回的话，中间那一次取数会带着已经不存在的 kbId，
   * 面板会先闪一下「知识库不存在」（那不是错误，只是顺序问题）。
   * @param action - 库内**笔记与文件**的处理方式（`purge` 两者一起删；`reassign` 两者一起移民）。
   */
  const runDelete = useCallback(async (action: 'purge' | 'reassign'): Promise<void> => {
    if (!del) return
    setBusy(true)
    setErr(null)
    try {
      const r = action === 'purge'
        ? await apiDeleteKb(del.id, { kind: 'purge' })
        : await apiDeleteKb(del.id, { kind: 'reassign', targetKbId: del.target })
      if (!r.ok) { setErr(r.error ?? '删除失败'); return }
      if (kbId === del.id) setKb(fallbackKbId(kbs, del.id))
      // 回执在关弹层**之前**写：`del` 马上就要被清空，而这条提示要活过弹层的退场。
      // `movedFiles / removedFiles` 为 `undefined`（文件侧没清点成）与 `0`（确实是 0 个）
      // 是两句不同的话 —— 后端从 T2 起就分开返回，`deleteReceipt` 负责分开说。
      flash(deleteReceipt({
        kbName: del.name,
        action,
        targetName: action === 'reassign' ? kbs.find(k => k.id === del.target)?.name : undefined,
        movedNotes: r.movedNotes,
        removedNotes: r.removedNotes,
        movedFiles: r.movedFiles,
        removedFiles: r.removedFiles,
      }))
      setDel(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [del, kbId, kbs, setKb])

  // ── 库列表读不到：给「重试」，**不给**「新建」─────────────────────
  // 空列表会被读成「一个库都没有」而诱导用户去新建 —— 那会用一个新的空库盖住
  // 真正的问题（库打不开）。这与 N1 是同一条纪律。
  if (readError) {
    return (
      <div className={css.wrap}>
        <span className={css.hint} role="alert" title={readError}>⚠️ 知识库列表读取失败</span>
        <Button variant="pill" onClick={reloadKbs}>重试</Button>
      </div>
    )
  }

  // 首次列表还没到：不留一个空选择器（会闪一下「请选择…」）。
  if (kbs.length === 0 && loading) {
    return <div className={css.wrap}><span className={css.hint}>读取知识库…</span></div>
  }

  return (
    <div className={css.wrap}>
      <span className={css.hint}>知识库</span>
      <div className={css.picker}>
        <Select
          value={String(kbId)}
          onChange={(v) => { setKb(Number(v)) }}
          options={options}
          ariaLabel="切换知识库"
          onOpen={reloadKbs}
        />
      </div>
      <button
        type="button"
        className={css.menuBtn}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="知识库管理"
        title="新建 / 重命名 / 删除 / 管理知识库"
        onClick={() => { setMenuOpen(v => !v); setErr(null) }}
      >
        ⋯
      </button>

      {menuOpen && (
        <>
          <div className={css.menuMask} role="presentation" onClick={() => { setMenuOpen(false) }} />
          <div className={css.menu} role="menu">
            <button type="button" className={css.menuItem} role="menuitem" onClick={openCreate}>新建知识库…</button>
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              disabled={current === null}
              onClick={() => { if (current) openRename(current) }}
            >
              重命名「{current?.name ?? '—'}」…
            </button>
            <button
              type="button"
              className={`${css.menuItem} ${css.menuItemDanger}`}
              role="menuitem"
              disabled={current === null || current.id === DEFAULT_KB_ID}
              title={current?.id === DEFAULT_KB_ID ? '默认知识库不可删除（它是老数据迁移的兜底），可以重命名' : undefined}
              onClick={() => { if (current) openDelete(current) }}
            >
              删除「{current?.name ?? '—'}」…
            </button>
            <div className={css.menuSep} />
            <button type="button" className={css.menuItem} role="menuitem" onClick={openManage}>管理全部知识库…</button>
          </div>
        </>
      )}

      {/* 新建 / 重命名 */}
      {form && (
        <div className={css.backdrop} role="presentation" onClick={() => { if (!busy) closeAll() }}>
          <div className={css.dialog} role="dialog" aria-modal="true" onClick={(e) => { e.stopPropagation() }}>
            <div className={css.dialogTitle}>{form.mode === 'create' ? '新建知识库' : '重命名知识库'}</div>
            <div className={css.dialogBody}>
              {form.mode === 'create'
                ? '新库是空的：它有自己的笔记、自己的 [[链接]] 解析域和自己的图谱，与现有库互不影响。'
                : '改名只影响显示。库内笔记、标签、[[链接]] 与图谱结构都不变 —— 也不影响其它库。'}
            </div>
            <input
              className={css.input}
              value={form.name}
              placeholder="库名（同一个库内笔记标题唯一，库名本身也需唯一）"
              aria-label="知识库名称"
              autoFocus
              onChange={(e) => { setForm({ ...form, name: e.target.value }) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); void submitForm() } }}
            />
            {err && <div className={css.err} role="alert">⚠️ {err}</div>}
            <div className={css.actions}>
              <Button variant="pill" onClick={() => { closeAll() }} disabled={busy}>取消</Button>
              <Button variant="pill" onClick={() => { void submitForm() }} disabled={busy || form.name.trim() === ''}>
                {busy ? '处理中…' : (form.mode === 'create' ? '新建' : '保存')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 删除：把后果写全，并让用户在两个动作之间**选一个** */}
      {del && (
        <div className={css.backdrop} role="presentation" onClick={() => { if (!busy) closeAll() }}>
          <div className={css.dialog} role="dialog" aria-modal="true" onClick={(e) => { e.stopPropagation() }}>
            <div className={css.dialogTitle}>删除知识库「{del.name}」？</div>
            <div className={css.dialogBody}>
              {deleteDialogLead(delCounts)}
              <br />
              无论哪种方式，指向这些笔记的 <code>[[链接]]</code> 都不会被改写；被删掉的笔记会变成其它库里的「待补笔记」。
              <br />
              你电脑上的原文件不会被删除或修改 —— 动的只是知识库里的登记、分块与向量索引。
            </div>
            {moveTargets.length > 0 && canMove && (
              <Select
                value={String(del.target)}
                onChange={(v) => { setDel({ ...del, target: Number(v) }) }}
                options={[
                  { value: '0', label: '移到…（请选择目标库）' },
                  ...moveTargets.map(k => ({ value: String(k.id), label: `${k.name} · ${k.noteCount}` })),
                ]}
                ariaLabel="把笔记移到哪个库"
              />
            )}
            {err && <div className={css.err} role="alert">⚠️ {err}</div>}
            <div className={css.actionsSplit}>
              <Button variant="pill" onClick={() => { closeAll() }} disabled={busy}>取消</Button>
              {canMove && moveTargets.length > 0 && (
                <Button
                  variant="pill"
                  disabled={busy || del.target === 0}
                  onClick={() => { void runDelete('reassign') }}
                >
                  移到该库并删除
                </Button>
              )}
              {/* 把条数写进按钮：用户是在**点之前**看这一眼（危险动作的后果要写在动作上）。 */}
              <Button variant="danger" disabled={busy} onClick={() => { void runDelete('purge') }}>
                {purgeButtonLabel(delCounts)}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 管理：一次看到全部库（含每库条数），并就地改名 / 删除 / 新建 */}
      {manage && (
        <div className={css.backdrop} role="presentation" onClick={() => { if (!busy) closeAll() }}>
          <div className={css.dialog} role="dialog" aria-modal="true" onClick={(e) => { e.stopPropagation() }}>
            <div className={css.dialogTitle}>管理知识库（{kbs.length}）</div>
            <div className={css.dialogBody}>
              每个库有独立的笔记、「[[链接]]」解析域与图谱。切换库在分段条右侧的选择器里。
            </div>
            <div className={css.list}>
              {kbs.map(k => (
                <div key={k.id} className={css.listRow}>
                  <span className={css.listName} title={k.name}>{k.name}</span>
                  {k.id === DEFAULT_KB_ID && <span className={css.listTag}>默认</span>}
                  {/* 只写「0 条」会让人以为这个库是空的 —— 库里可能有几百份文件。 */}
                  <span className={css.listMeta}>
                    {k.noteCount} 条{k.fileCount > 0 ? ` · ${k.fileCount} 个文件` : ''}
                  </span>
                  <Button variant="pill" onClick={() => { openRename(k) }}>重命名</Button>
                  <Button
                    variant="danger"
                    disabled={k.id === DEFAULT_KB_ID}
                    onClick={() => { openDelete(k) }}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
            {err && <div className={css.err} role="alert">⚠️ {err}</div>}
            <div className={css.actions}>
              <Button variant="pill" onClick={() => { closeAll() }}>关闭</Button>
              <Button variant="pill" onClick={openCreate}>＋ 新建知识库</Button>
            </div>
          </div>
        </div>
      )}

      {/* 删库回执。挂在最外层 wrap 上（**不放进任何弹层**）：成功分支的弹层此时已经关掉了，
          回执要活过它的退场。absolute 定位，不参与分段条的布局。 */}
      {notice && <div className={css.notice} role="status">{notice}</div>}
    </div>
  )
}

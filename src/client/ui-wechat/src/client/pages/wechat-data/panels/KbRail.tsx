/**
 * 知识库 rail —— 三栏布局的**第一栏**：列出全部库、切换当前库、就地管理单个库。
 *
 * 为什么从分段条右侧的「⋯」升级成一栏（2026-09-19 重设计）：
 *   库表达的是「看哪一份数据」，是**作用域**，比「笔记库 / 知识图谱 / 文件」这三种
 *   「怎么看」高一层。原先它被塞进分段条右端一个 26px 圆钮里，新建 / 改名 / 删除 /
 *   管理四层动作全压在二级菜单中，而「当前在哪个库」只剩选择器上一行小字 ——
 *   一层语义被藏成了三层交互。抬成一栏之后：当前库有选中态、每库的条数常驻可见、
 *   库与库之间可直接对比，管理动作就近挂在各自的行上。
 *
 * 与「侧栏导航」不是同一件事：侧栏选的是**页**（全局），这一栏选的是**库**（本页作用域），
 * 所以窄容器下这一栏会收回成分段条上的一个下拉（见 kb-shell.module.css 的容器查询），
 * 而不是和侧栏抢宽度。
 *
 * 本文件是**唯一**调用 `apiCreateKb / apiRenameKb / apiDeleteKb` 的地方（源码级 gate 钉住）。
 * 失效与广播收在 `api.ts` 的包装里，调用方不可能忘。
 *
 * ⚠ 刻意**不**复用 `useConfirm()`：它只有「确认 / 取消」两个按钮，而删库必须让用户在
 * 「移到别的库」与「一并删除」之间**选一个**（后端 `KbDeleteAction` 也是必填、不猜）。
 */
import { useCallback, useMemo, useState } from 'react'
import { apiCreateKb, apiDeleteKb, apiRenameKb } from '../api.ts'
import type { KbMeta } from '../types.ts'
import { Button, Dialog, Select } from '../ui/kit.tsx'
import { useTransientNotice } from './hooks.tsx'
import { canMoveInstead, deleteDialogLead, deleteReceipt, purgeButtonLabel } from './kb-delete-copy.ts'
import { DEFAULT_KB_ID, useKbScope } from './kb-scope.ts'
import { KbModelDialog } from './KbModelDialog.tsx'
import css from './kb-rail.module.css'

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
 * 库 rail：库列表 + 库级动作。
 * @returns 一栏知识库选择器。
 */
export function KbRail(): React.JSX.Element {
  const { kbId, kbs, readError, loading, setKb, reloadKbs } = useKbScope()
  /** 展开了行内菜单的那个库（同时只可能有一个；null = 都没展开）。 */
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [del, setDel] = useState<DeleteState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 「本库模型」弹层是否开着。 */
  const [modelOpen, setModelOpen] = useState(false)
  /** 当前选中的那个库（芯片要显示它的 modelOverrides / 名字）。找不到时是 undefined。 */
  const active = useMemo(() => kbs.find(k => k.id === kbId), [kbs, kbId])
  // 删库是**破坏性且不可撤销**的，所以成功了也必须留一句话 —— 只说给弹层里的 err 槽
  // 是不够的（成功时弹层要关掉）。默认时长即可：这是一条「看见了就够」的确认。
  const { notice, flash } = useTransientNotice()

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
    setMenuFor(null)
    setForm(null)
    setDel(null)
    setErr(null)
  }, [])

  const openCreate = useCallback((): void => {
    setMenuFor(null)
    setErr(null)
    setForm({ mode: 'create', name: '' })
  }, [])

  const openRename = useCallback((k: KbMeta): void => {
    setMenuFor(null)
    setErr(null)
    setForm({ mode: 'rename', id: k.id, name: k.name })
  }, [])

  const openDelete = useCallback((k: KbMeta): void => {
    setMenuFor(null)
    setErr(null)
    setDel({ id: k.id, name: k.name, noteCount: k.noteCount, fileCount: k.fileCount, target: 0 })
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
      // 而 rail 上此刻会多出第二项，选中态仍留在原来的库上 —— 这是对的。
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
      <aside className={css.rail}>
        <div className={css.railHd}>知识库</div>
        <div className={css.errBox} role="alert" title={readError}>
          <span>⚠️ 知识库列表读取失败</span>
          <Button variant="pill" onClick={reloadKbs}>重试</Button>
        </div>
      </aside>
    )
  }

  return (
    <aside className={css.rail} aria-label="知识库列表">
      <div className={css.railHd}>
        <span>知识库</span>
        {/* 首次列表还在路上时不给「新建」：那会建出第二个库盖住「还没读到」这件事。 */}
        {!(kbs.length === 0 && loading) && (
          <button
            type="button"
            className={css.addBtn}
            onClick={openCreate}
            aria-label="新建知识库"
            title="新建知识库"
          >
            ＋
          </button>
        )}
      </div>

      {kbs.length === 0 && loading
        ? <div className={css.hint}>读取知识库…</div>
        : (
          <nav className={css.kbList}>
            {kbs.map(k => (
              <div key={k.id} className={css.kbItem}>
                <button
                  type="button"
                  className={css.kbRow}
                  data-on={k.id === kbId ? '1' : undefined}
                  aria-current={k.id === kbId ? 'true' : undefined}
                  onClick={() => { setKb(k.id) }}
                >
                  <span className={css.kbName} title={k.name}>{k.name}</span>
                  {/* 只写「0 条」会让人以为这个库是空的 —— 库里可能有几百份文件。 */}
                  <span className={css.kbMeta}>
                    {k.noteCount} 条{k.fileCount > 0 ? ` · ${k.fileCount} 个文件` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className={css.rowBtn}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === k.id}
                  aria-label={`管理「${k.name}」`}
                  title="重命名 / 删除"
                  onClick={() => { setMenuFor(v => (v === k.id ? null : k.id)); setErr(null) }}
                >
                  ⋯
                </button>
                {menuFor === k.id && (
                  <div className={css.rowMenu} role="menu">
                    <button type="button" className={css.rowMenuItem} role="menuitem" onClick={() => { openRename(k) }}>
                      重命名…
                    </button>
                    <button
                      type="button"
                      className={`${css.rowMenuItem} ${css.rowMenuItemDanger}`}
                      role="menuitem"
                      disabled={k.id === DEFAULT_KB_ID}
                      title={k.id === DEFAULT_KB_ID ? '默认知识库不可删除（它是老数据迁移的兜底），可以重命名' : undefined}
                      onClick={() => { openDelete(k) }}
                    >
                      删除…
                    </button>
                  </div>
                )}
              </div>
            ))}
          </nav>
        )}

      {/* 模型芯片：当前库的模型来源。**不放进每行的 ⋯ 里** —— 那个菜单是破坏性操作的位置
          （重命名 / 删除），而模型配置是日常查看与调整；藏进 hover 才显形的菜单等于没有。
          它也不属于任何一段分段：三个视图共用同一个库作用域，所以它属于 rail。 */}
      <button
        type="button"
        className={css.modelChip}
        data-custom={(active?.modelOverrides ?? 0) > 0 ? '1' : undefined}
        onClick={() => { setModelOpen(true) }}
        title="本库用哪个语言 / 嵌入 / 重排序模型"
      >
        <span className={css.modelIcon} aria-hidden="true">🧠</span>
        <span className={css.modelText}>
          {(active?.modelOverrides ?? 0) > 0 ? `模型 · ${active?.modelOverrides} 项自定义` : '模型 · 继承全局'}
        </span>
      </button>

      {/* 删库回执。挂在 rail 底部而不是任何弹层里：成功分支的弹层此时已经关掉了，
          回执要活过它的退场。 */}
      {notice && <div className={css.notice} role="status">{notice}</div>}

      {modelOpen && active !== undefined && (
        <KbModelDialog kbId={active.id} kbName={active.name} onClose={() => { setModelOpen(false) }} />
      )}

      {/* 新建 / 重命名 */}
      <Dialog
        open={form !== null}
        onClose={() => { if (!busy) closeAll() }}
        title={form?.mode === 'create' ? '新建知识库' : '重命名知识库'}
        footer={(
          <>
            <Button variant="pill" onClick={() => { closeAll() }} disabled={busy}>取消</Button>
            <Button variant="primary" onClick={() => { void submitForm() }} disabled={busy || (form?.name.trim() ?? '') === ''}>
              {busy ? '处理中…' : (form?.mode === 'create' ? '新建' : '保存')}
            </Button>
          </>
        )}
      >
        <p className={css.dialogLead}>
          {form?.mode === 'create'
            ? '新库是空的：它有自己的笔记、自己的 [[链接]] 解析域和自己的图谱，与现有库互不影响。'
            : '改名只影响显示。库内笔记、标签、[[链接]] 与图谱结构都不变 —— 也不影响其它库。'}
        </p>
        <input
          className={css.input}
          value={form?.name ?? ''}
          placeholder="库名（同一个库内笔记标题唯一，库名本身也需唯一）"
          aria-label="知识库名称"
          onChange={(e) => { if (form) setForm({ ...form, name: e.target.value }) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); void submitForm() } }}
        />
        {err && <div className={css.errBox} role="alert">⚠️ {err}</div>}
      </Dialog>

      {/* 删除：把后果写全，并让用户在两个动作之间**选一个** */}
      <Dialog
        open={del !== null}
        onClose={() => { if (!busy) closeAll() }}
        title={del ? `删除知识库「${del.name}」？` : '删除知识库'}
        footer={(
          <>
            <Button variant="pill" onClick={() => { closeAll() }} disabled={busy}>取消</Button>
            {del !== null && canMove && moveTargets.length > 0 && (
              <Button variant="pill" disabled={busy || del.target === 0} onClick={() => { void runDelete('reassign') }}>
                移到该库并删除
              </Button>
            )}
            {/* 把条数写进按钮：用户是在**点之前**看这一眼（危险动作的后果要写在动作上）。 */}
            <Button variant="danger" disabled={busy} onClick={() => { void runDelete('purge') }}>
              {purgeButtonLabel(delCounts)}
            </Button>
          </>
        )}
      >
        <p className={css.dialogLead}>
          {deleteDialogLead(delCounts)}
          <br />
          无论哪种方式，指向这些笔记的 <code>[[链接]]</code> 都不会被改写；被删掉的笔记会变成其它库里的「待补笔记」。
          <br />
          你电脑上的原文件不会被删除或修改 —— 动的只是知识库里的登记、分块与向量索引。
        </p>
        {del !== null && moveTargets.length > 0 && canMove && (
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
        {err && <div className={css.errBox} role="alert">⚠️ {err}</div>}
      </Dialog>
    </aside>
  )
}

/**
 * 定时总结任务抽屉 —— 从 `SummaryWorkbench.tsx` 拆出（单函数 250 行棘轮）。
 *
 * 为什么是抽屉而不是主区的一块：定时任务是**配置**（建一次、之后自动跑），
 * 不是日常操作。放在主区会长期占掉一半屏幕，而用户 99% 的时间是在看总结。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  apiDeleteSummaryTask,
  apiGetContacts,
  apiGetSessions,
  apiRunSummaryTask,
  apiSaveSummaryTask,
  apiToggleSummaryTask,
  readRenderCache,
  writeRenderCache,
} from '../api.ts'
import type { SummaryTask, SummaryTaskInput } from '@deepseek-ai/dsh-wechat-data/types'
import { TimeField } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { fmtLocaleMs } from '../utils/format.ts'
import css from './summary-workbench.module.css'

/** 五种分析格式（与后端口径一致）。 */
export const FORMATS: ReadonlyArray<{ key: string; label: string; desc: string }> = [
  { key: 'brief', label: '简洁总结', desc: '3–5 句话概括重点内容' },
  { key: 'detailed', label: '详细总结', desc: '按主题分点，含关键事件与结论' },
  { key: 'bullets', label: '要点列表', desc: '用要点列表提炼核心信息' },
  { key: 'story', label: '叙事总结', desc: '以第三人称叙述来龙去脉' },
  { key: 'custom', label: '自定义格式', desc: '用自定义提示词（支持 {date} {group} {targets}）' },
]

/** 提示类型。 */
export type ToastKind = 'ok' | 'err' | 'info'

interface FormState {
  id?: number
  groupUsername: string
  groupName: string
  targetAll: boolean
  targetUsers: string[]
  format: string
  customPrompt: string
  scheduleTime: string
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  groupUsername: '', groupName: '', targetAll: true, targetUsers: [],
  format: 'brief', customPrompt: '', scheduleTime: '08:00', enabled: true,
}

/**
 * 渲染定时任务抽屉。
 * @param props - 任务列表、关闭回调、变更回调、提示函数。
 * @returns 抽屉元素。
 */
export function TaskDrawer({ tasks, onClose, onChanged, notify }: {
  tasks: readonly SummaryTask[]
  onClose: () => void
  onChanged: () => void
  notify: (kind: ToastKind, text: string) => void
}): React.JSX.Element {
  const confirm = useConfirm()
  const [form, setForm] = useState<FormState | null>(null)
  const [groups, setGroups] = useState<readonly { username: string; name: string }[]>([])
  const [members, setMembers] = useState<readonly { username: string; name: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  // Esc 关闭：表单开着先退表单，否则关抽屉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { if (form) setForm(null); else onClose() } }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [form, onClose])

  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      const cached = readRenderCache<readonly { username: string; name: string }[]>('summary-groups')
      if (cached) setGroups(cached)
      const env = await apiGetSessions({ limit: 500 })
      const gs = env.sessions
        .filter(s => s.type === 'group' || s.username.endsWith('@chatroom'))
        .map(s => ({ username: s.username, name: s.displayName || s.username }))
      setGroups(gs)
      writeRenderCache('summary-groups', gs)
    } catch { /* 保持旧列表 */ }
  }, [])

  const loadMembers = useCallback(async (groupUsername: string): Promise<void> => {
    setMembers([])
    if (!groupUsername) return
    try {
      const env = await apiGetContacts()
      // ⚠️ 2026-10-17 修（两个 bug 叠在一起）：
      //
      // ① **不能**用 `category === 'member'` 筛群成员。`category` 是「联系人类型」
      //    （friend / group / official / member…），而 `categoryOf()` 里
      //    `localType === 1` 一律判成 `friend` —— 加过好友的群成员全被归为 friend，
      //    筛 member 时一个都拿不到。实测本机 70 个群里有 7 个群的成员**全是好友**。
      //
      // ② **不能**用 `groupUsername` 筛。它只能存一个群，而一个人可以在多个群里 ——
      //    后写入的群会覆盖前面的。实测 `wxid_umyqa86if3lm22` 在 426 群，
      //    但 `groupUsername` 被 3061 群覆盖，于是选 426 群时一个成员都拿不到。
      //    正确判据是 `groupUsernames`（全部所属群）。
      setMembers(env.contacts
        .filter(c => c.groupUsernames?.includes(groupUsername) ?? c.groupUsername === groupUsername)
        .map(c => ({ username: c.username, name: c.displayName || c.username })))
    } catch { /* 保持空 */ }
  }, [])

  const openNew = (): void => { setForm({ ...EMPTY_FORM }); void loadGroups() }
  const openEdit = (t: SummaryTask): void => {
    setForm({
      id: t.id,
      groupUsername: t.groupUsername,
      groupName: t.groupName || t.groupUsername,
      targetAll: t.targetUsers.length === 0,
      targetUsers: t.targetUsers,
      format: t.format || 'brief',
      customPrompt: t.customPrompt || '',
      scheduleTime: t.scheduleTime || '08:00',
      enabled: t.enabled,
    })
    void loadGroups()
    void loadMembers(t.groupUsername)
  }

  const save = async (): Promise<void> => {
    if (!form || !form.groupUsername.trim()) return
    setBusy('save')
    try {
      const task: SummaryTaskInput = {
        groupUsername: form.groupUsername.trim(),
        groupName: form.groupName.trim() || form.groupUsername.trim(),
        targetUsers: form.targetAll ? [] : form.targetUsers,
        format: form.format,
        customPrompt: form.customPrompt.trim(),
        scheduleTime: form.scheduleTime,
        enabled: form.enabled,
      }
      if (form.id !== undefined) task.id = form.id
      const r = await apiSaveSummaryTask({ task })
      if (!r.ok) notify('err', r.error ?? '保存失败')
      else { setForm(null); notify('ok', form.id ? '任务已更新' : '任务已创建'); onChanged() }
    } catch (e) { notify('err', (e as Error).message || '保存失败') } finally { setBusy(null) }
  }

  const run = async (id: number): Promise<void> => {
    setBusy(`run:${String(id)}`)
    try {
      const r = await apiRunSummaryTask({ id })
      notify(r.ok ? 'ok' : 'err', r.ok ? (r.messageCount != null ? `运行成功，${String(r.messageCount)} 条消息` : '运行成功') : (r.error ?? '运行失败'))
      onChanged()
    } catch (e) { notify('err', (e as Error).message || '运行失败') } finally { setBusy(null) }
  }

  const toggle = async (t: SummaryTask): Promise<void> => {
    setBusy(`toggle:${String(t.id)}`)
    try {
      await apiToggleSummaryTask({ id: t.id, enabled: !t.enabled })
      notify('ok', t.enabled ? '已停用' : '已启用')
      onChanged()
    } catch (e) { notify('err', (e as Error).message || '操作失败') } finally { setBusy(null) }
  }

  const remove = async (t: SummaryTask): Promise<void> => {
    const ok = await confirm({ title: '删除该定时任务？', message: '删除后不再自动生成，不可撤销。', tone: 'danger' })
    if (!ok) return
    setBusy(`del:${String(t.id)}`)
    try {
      await apiDeleteSummaryTask({ id: t.id })
      notify('ok', '任务已删除')
      onChanged()
    } catch (e) { notify('err', (e as Error).message || '删除失败') } finally { setBusy(null) }
  }

  return (
    <div className={css.drawer} onClick={onClose} role="dialog" aria-modal="true" aria-label="定时总结任务">
      <div className={css.drawerPanel} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.drawerHead}>
          <span className={css.drawerTitle}>{form ? (form.id ? '编辑任务' : '新建任务') : '定时总结任务'}</span>
          <span className={css.toolbarSpacer} />
          {!form && <button type="button" className={css.ghostBtn} data-active="true" onClick={openNew}>＋ 新建</button>}
          <button type="button" className={css.ghostBtn} onClick={() => { if (form) setForm(null); else onClose() }} aria-label="关闭">✕</button>
        </div>

        <div className={css.drawerBody}>
          {!form && (
            <>
              {tasks.length === 0 && (
                <div className={css.empty}>
                  <div className={css.emptyHint}>还没有定时任务。建一个之后，到点会自动生成总结并存进历史。</div>
                </div>
              )}
              {tasks.map(t => (
                <div key={t.id} className={css.taskRow}>
                  <div className={css.taskInfo}>
                    <span className={css.taskName} title={t.groupName || t.groupUsername}>{t.groupName || t.groupUsername}</span>
                    <span className={css.taskMeta}>每天 {t.scheduleTime}</span>
                    <span className={css.taskMeta}>{FORMATS.find(f => f.key === t.format)?.label ?? t.format}</span>
                    <span className={css.badge} data-tone={t.enabled ? 'on' : 'off'}>{t.enabled ? '启用' : '停用'}</span>
                    {t.lastStatus === 'done' && <span className={css.badge} data-tone="ok">上次成功</span>}
                    {t.lastStatus === 'error' && <span className={css.badge} data-tone="fail">上次失败</span>}
                    {t.lastRunAt && <span className={css.taskMeta}>{fmtLocaleMs(t.lastRunAt)}</span>}
                  </div>
                  <div className={css.taskActions}>
                    <button type="button" className={css.iconBtn} title="立即运行" disabled={busy === `run:${String(t.id)}`} onClick={() => { void run(t.id) }}>▶</button>
                    <button type="button" className={css.iconBtn} title="编辑" onClick={() => { openEdit(t) }}>✎</button>
                    <button type="button" className={css.iconBtn} title={t.enabled ? '停用' : '启用'} disabled={busy === `toggle:${String(t.id)}`} onClick={() => { void toggle(t) }}>{t.enabled ? '⏸' : '⏵'}</button>
                    <button type="button" className={css.iconBtn} data-danger="true" title="删除" disabled={busy === `del:${String(t.id)}`} onClick={() => { void remove(t) }}>✕</button>
                  </div>
                </div>
              ))}
            </>
          )}

          {form && (
            <TaskForm
              form={form}
              setForm={setForm}
              groups={groups}
              members={members}
              busy={busy}
              onSave={() => { void save() }}
              onCancel={() => { setForm(null) }}
              onGroupChange={(v) => {
                setForm(f => (f ? { ...f, groupUsername: v, groupName: groups.find(g => g.username === v)?.name ?? v } : f))
                void loadMembers(v)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 任务表单（从抽屉里再拆一层，控制单函数行数）。
 * @param props - 表单状态与回调。
 * @returns 表单元素。
 */
function TaskForm({ form, setForm, groups, members, busy, onSave, onCancel, onGroupChange }: {
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState | null>>
  groups: readonly { username: string; name: string }[]
  members: readonly { username: string; name: string }[]
  busy: string | null
  onSave: () => void
  onCancel: () => void
  onGroupChange: (v: string) => void
}): React.JSX.Element {
  return (
    <>
      <div className={css.formField}>
        <span className={css.formLabel}>群聊</span>
        <select className={css.formSelect} value={form.groupUsername} onChange={(e) => { onGroupChange(e.target.value) }}>
          <option value="">选择群聊…</option>
          {groups.map(g => <option key={g.username} value={g.username}>{g.name}</option>)}
        </select>
      </div>

      <div className={css.formField}>
        <span className={css.formLabel}>关注成员</span>
        <label className={css.inlineCheck}>
          <input
            type="checkbox"
            checked={form.targetAll}
            onChange={(e) => { setForm(f => (f ? { ...f, targetAll: e.target.checked, targetUsers: e.target.checked ? [] : f.targetUsers } : f)) }}
          />
          全部成员
        </label>
        {!form.targetAll && form.groupUsername && (
          <div className={css.memberPick}>
            {members.length === 0 && (
              <span className={css.formLabel}>
                这个群没有读到成员数据 —— 可能是新群、成员还没同步，或重新选择群聊试试
              </span>
            )}
            {members.map(m => (
              <button
                key={m.username}
                type="button"
                className={css.memberChip}
                data-on={form.targetUsers.includes(m.username) || undefined}
                onClick={() => {
                  setForm(f => {
                    if (!f) return f
                    const has = f.targetUsers.includes(m.username)
                    return { ...f, targetUsers: has ? f.targetUsers.filter(u => u !== m.username) : [...f.targetUsers, m.username] }
                  })
                }}
              >{m.name}</button>
            ))}
          </div>
        )}
        {!form.targetAll && <span className={css.formLabel}>已关注 {form.targetUsers.length} 位</span>}
      </div>

      <div className={css.formField}>
        <span className={css.formLabel}>分析格式</span>
        <div className={css.formatGrid}>
          {FORMATS.map(f => (
            <label key={f.key} className={css.formatCard} data-on={form.format === f.key || undefined}>
              <input
                type="radio"
                name="sw-format"
                className={css.radioHidden}
                checked={form.format === f.key}
                onChange={() => { setForm(x => (x ? { ...x, format: f.key } : x)) }}
              />
              <span className={css.formatName}>{f.label}</span>
              <span className={css.formatDesc}>{f.desc}</span>
            </label>
          ))}
        </div>
      </div>

      {form.format === 'custom' && (
        <div className={css.formField}>
          <span className={css.formLabel}>自定义提示词</span>
          <textarea
            className={css.formTextarea}
            placeholder="支持占位符：{date} {group} {targets}"
            value={form.customPrompt}
            onChange={(e) => { setForm(f => (f ? { ...f, customPrompt: e.target.value } : f)) }}
          />
        </div>
      )}

      <div className={css.formField}>
        <span className={css.formLabel}>定时设置</span>
        <div className={css.formRow}>
          <TimeField value={form.scheduleTime} onChange={(v) => { setForm(f => (f ? { ...f, scheduleTime: v } : f)) }} ariaLabel="每日总结时刻" />
          <label className={css.inlineCheck}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => { setForm(f => (f ? { ...f, enabled: e.target.checked } : f)) }}
            />
            {form.enabled ? '已启用' : '已暂停'}
          </label>
        </div>
      </div>

      <div className={css.formRow}>
        <button type="button" className={css.primaryBtn} onClick={onSave} disabled={busy === 'save' || !form.groupUsername.trim()}>
          {busy === 'save' ? <><span className={css.spin} />保存中…</> : (form.id ? '保存修改' : '创建任务')}
        </button>
        <button type="button" className={css.ghostBtn} onClick={onCancel}>取消</button>
      </div>
    </>
  )
}

/**
 * 定时总结任务抽屉 —— 从 `SummaryWorkbench.tsx` 拆出（单函数 250 行棘轮）。
 *
 * 为什么是抽屉而不是主区的一块：定时任务是**配置**（建一次、之后自动跑），
 * 不是日常操作。放在主区会长期占掉一半屏幕，而用户 99% 的时间是在看总结。
 */
import { useCallback, useState } from 'react'
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
import { TimeField, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { fmtLocaleMs } from '../utils/format.ts'
import { withEnterprise } from './enterprise-identity.ts'
import css from './summary-workbench.module.css'
import { IdentityName } from './identity.tsx'

/** 五种分析格式（与后端口径一致）。 */
export const FORMATS: ReadonlyArray<{ key: string; label: string; desc: string }> = [
  { key: 'brief', label: '简洁总结', desc: '一段话概括重点，篇幅随素材量' },
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
  /**
   * 「要推送」这个开关**必须是独立状态**，不能由 `webhookUrl` 是否非空推导。
   *
   * 这里踩过一次：最初把勾选框的选中态绑在「地址是否非空」上，而 onChange 勾选时
   * 写回的仍是原来的空串 —— 于是勾选状态立刻被自己否掉，永远勾不上、输入框也永远不出现。
   * 开关与内容是两件事：勾上只是「我要填」，填没填满由保存时的校验负责。
   */
  webhookOn: boolean
  /**
   * 推送地址；`webhookOn` 为 false 时用户看到的是空输入框。
   *
   * 编辑已有任务时这里拿到的是后端**脱敏**后的地址（`http://host:port/webhook/***`）：
   * token 是凭据，不该出现在 DOM 与截图里。原样保存会被后端判成「不修改」，
   * 所以「打开看一眼再保存」不会把真实 token 覆盖成 `***`。
   */
  webhookUrl: string
  /** 推送对象（微信会话名）；空串 = 用群名。 */
  webhookTarget: string
}

const EMPTY_FORM: FormState = {
  groupUsername: '', groupName: '', targetAll: true, targetUsers: [],
  format: 'brief', customPrompt: '', scheduleTime: '08:00', enabled: true,
  webhookOn: false, webhookUrl: '', webhookTarget: '',
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
  const [groups, setGroups] = useState<readonly { username: string; name: string; enterpriseName?: string }[]>([])
  const [members, setMembers] = useState<readonly { username: string; name: string; enterpriseName?: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  // Esc 关闭：表单开着先退表单，否则关抽屉。
  useEscapeToClose(true, () => { if (form) setForm(null); else onClose() })
  useDialogFocus(true, '[data-st-dialog="summary-task"]')

  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      const cached = readRenderCache<readonly { username: string; name: string; enterpriseName?: string }[]>('summary-groups-v2')
      if (cached) setGroups(cached)
      const env = await apiGetSessions({ limit: 500 })
      const gs = env.sessions
        .filter(s => s.type === 'group' || s.username.endsWith('@chatroom'))
        .map(s => ({
          username: s.username,
          name: s.displayName || s.username,
          ...(s.enterpriseName ? { enterpriseName: s.enterpriseName } : {}),
        }))
      setGroups(gs)
      writeRenderCache('summary-groups-v2', gs)
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
        .map(c => ({
          username: c.username,
          name: c.displayName || c.username,
          ...(c.enterpriseName ? { enterpriseName: c.enterpriseName } : {}),
        })))
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
      // 有已保存的地址 = 这条任务本来就在推送，勾选框跟着它走。
      webhookOn: (t.webhookUrl || '').trim() !== '',
      webhookUrl: t.webhookUrl || '',
      webhookTarget: t.webhookTarget || '',
    })
    void loadGroups()
    void loadMembers(t.groupUsername)
  }

  const save = async (): Promise<void> => {
    if (!form || !form.groupUsername.trim()) return
    /**
     * 勾了推送却没填地址：在这里挡住。
     *
     * 不能放过去 —— 后端把空串当成「关掉推送」，于是用户勾了、点了创建、界面上也确实
     * 勾着，但任务实际不推送。那种「配置看起来存在却不生效」最难归因。
     */
    if (form.webhookOn && form.webhookUrl.trim() === '') {
      notify('err', '已勾选 Webhook 推送，请填写推送地址')
      return
    }
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
        // 关闭勾选 = 显式清空（后端把空串当 clear）；不传 undefined 是为了让「取消勾选」
        // 这个动作真的落库，而不是被 COALESCE 当成「这次不谈推送」保留旧地址。
        webhookUrl: form.webhookOn ? form.webhookUrl.trim() : '',
        webhookTarget: form.webhookOn ? form.webhookTarget.trim() : '',
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
      if (!r.ok) {
        notify('err', r.error ?? '运行失败')
      } else if (r.webhook !== undefined && !r.webhook.ok) {
        // 总结已经生成并落库了，只有推送失败 —— 别报成「运行失败」，那会让人以为白跑一轮。
        notify('err', `已生成，但推送失败：${r.webhook.error ?? '未知原因'}`)
      } else if (r.webhook !== undefined && r.webhook.ok && r.webhook.endpoint !== '') {
        notify('ok', `运行成功，已推送到 ${r.webhook.endpoint}${r.messageCount != null ? `（${String(r.messageCount)} 条消息）` : ''}`)
      } else {
        notify('ok', r.messageCount != null ? `运行成功，${String(r.messageCount)} 条消息` : '运行成功')
      }
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
    <div className={css.drawer} onClick={onClose} role="dialog" aria-modal="true" aria-label="定时总结任务" data-st-dialog="summary-task">
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
                    <IdentityName
                      className={css.taskIdentity}
                      textClassName={css.taskName}
                      name={t.groupName || t.groupUsername}
                      username={t.groupUsername}
                      size={24}
                      title={t.groupUsername}
                    />
                    <span className={css.taskMeta}>每天 {t.scheduleTime}</span>
                    <span className={css.taskMeta}>{FORMATS.find(f => f.key === t.format)?.label ?? t.format}</span>
                    <span className={css.badge} data-tone={t.enabled ? 'on' : 'off'}>{t.enabled ? '启用' : '停用'}</span>
                    {t.webhookUrl !== '' && (
                      <span className={css.badge} data-tone="on" title={`推送地址：${t.webhookUrl}`}>推送</span>
                    )}
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
 *
 * 导出是为了能被 SSR 冒烟直接渲染 —— 「Webhook 推送」那一段的可见性判据
 * （`webhookUrl` 非空才渲染输入框）单靠源码断言证明不了，必须真渲染一次。
 * @param props - 表单状态与回调。
 * @returns 表单元素。
 */
export function TaskForm({ form, setForm, groups, members, busy, onSave, onCancel, onGroupChange }: {
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState | null>>
  groups: readonly { username: string; name: string; enterpriseName?: string }[]
  members: readonly { username: string; name: string; enterpriseName?: string }[]
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
          {groups.map(g => <option key={g.username} value={g.username}>{withEnterprise(g.name, g.enterpriseName)}</option>)}
        </select>
        {form.groupUsername !== '' && (
          <IdentityName
            className={css.selectedGroupChip}
            name={form.groupName || form.groupUsername}
            username={form.groupUsername}
            size={22}
          >
            {withEnterprise(
              form.groupName || form.groupUsername,
              groups.find(g => g.username === form.groupUsername)?.enterpriseName,
            )}
          </IdentityName>
        )}
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
              >
                <IdentityName
                  name={m.name}
                  username={m.username}
                  size={18}
                >
                  {withEnterprise(m.name, m.enterpriseName)}
                </IdentityName>
              </button>
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

      {/*
        Webhook 推送（2026-11-18）。
        协议与消息列表用的是同一个发送接口：`POST /webhook/<token>` 带 `{target, message}`。
        开关（`webhookOn`）与内容（`webhookUrl`）分开存：勾上只表示「我要填」，
        没填地址在保存时校验，而不是让勾选框勾不住。
        取消勾选会把地址与对象一并清空 —— 这是显式关掉推送（后端把空串当成 clear）。
      */}
      <div className={css.formField}>
        <span className={css.formLabel}>Webhook 推送</span>
        <label className={css.inlineCheck}>
          <input
            type="checkbox"
            checked={form.webhookOn}
            aria-label="启用 Webhook 推送"
            onChange={(e) => {
              const on = e.target.checked
              setForm(f => (f
                ? { ...f, webhookOn: on, ...(on ? {} : { webhookUrl: '', webhookTarget: '' }) }
                : f))
            }}
          />
          生成后把总结推送到 Webhook
        </label>
        {form.webhookOn && (
          <>
            <input
              type="text"
              className={css.formInput}
              placeholder="http://192.168.1.2:55725/webhook/<token>"
              value={form.webhookUrl}
              spellCheck={false}
              aria-label="Webhook 推送地址"
              onChange={(e) => { setForm(f => (f ? { ...f, webhookUrl: e.target.value } : f)) }}
            />
            <input
              type="text"
              className={css.formInput}
              placeholder="推送对象，例如「文件传输助手」（留空则发到群名）"
              value={form.webhookTarget}
              aria-label="Webhook 推送对象"
              onChange={(e) => { setForm(f => (f ? { ...f, webhookTarget: e.target.value } : f)) }}
            />
            <span className={css.formLabel}>
              只填到 /webhook/&lt;token&gt;；地址里的 token 就是凭据，保存后界面只回显 /webhook/***
            </span>
          </>
        )}
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

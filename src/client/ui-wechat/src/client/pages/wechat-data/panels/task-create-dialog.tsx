/**
 * 「新建任务」弹窗（2026-10-19）—— 触发式任务的创建入口，替换旧的素材收集弹窗。
 *
 * 三处入口共用这一份：聊天会话头部「更多 → 新建任务」（`chats-head-actions.tsx`）、
 * 群聊「群信息」抽屉底部（`chats-group-info-view.tsx`）、单聊「聊天信息」抽屉底部
 * （`chats-contact-info-view.tsx`）。三处只传会话/群信息，弹窗自己拉群成员、自己提交。
 *
 * 为什么默认对象不用选：任务监听的就是**当前窗口这个会话**。单聊的触发对象是会话对象
 * 本身；群聊的触发对象是群内一个或多个成员（群消息里发信人是谁很关键），所以只有群聊多一步
 * 「选目标用户」——那一步用 `apiGetGroupInfo` 的成员表，可搜索、多选、未选不许提交。
 * 多选提交时每个成员各生成一条任务，目标与任务名分别落库，避免多人共用一条任务后串内容。
 *
 * 创建完的状态固定是「待完善」：任务信息面板（右侧「编辑」抽屉）里补触发方式配置
 * （Webhook 地址或八爪鱼 RPA）并标记已完善后才参与触发与回调投递。`apiSaveTaskInfo`
 * 成功后会广播 `TASK_CENTER_UPDATED_EVENT`（在 api 层），
 * 任务信息面板据此自动刷新，本弹窗不需要再手动通知。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { GroupMember, TaskInfoMutationResult } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetGroupInfo, apiSaveTaskInfo } from '../api.ts'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { LoadingState, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { IconCloseOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Avatar } from './chats-support.tsx'
import {
  GROUP_TARGET_REQUIRED, KEYWORD_MAX_COUNT, KEYWORD_MAX_LEN, PHOTO_LIMIT_MAX, PHOTO_LIMIT_MIN,
  TASK_NAME_MAX_LEN, TEXT_LIMIT_MAX, TEXT_LIMIT_MIN, addKeywordBatch, buildTaskInfoInputs, chatTypeLabel,
  clampPhotoLimit, clampTextLimit, defaultTaskName, initialTaskCreateForm, photoHint, pickMembers, removeKeyword,
  removeTaskTarget, textHint, toggleTaskTarget, validateTaskCreate,
  type TaskCreateForm, type TaskCreateSession, type TaskCreateTarget,
} from './task-create.ts'
import { withEnterprise } from './enterprise-identity.ts'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'
import cssrows from './chats-rows.module.css'
import kitCss from '../ui/kit.module.css'
import css from './task-create.module.css'

export interface TaskCreateDialogProps {
  /** 当前会话（单聊的触发对象就是它；群聊时弹窗还要选目标成员）。 */
  session: TaskCreateSession
  /** 关闭弹窗（取消 / 关闭按钮 / 遮罩 / Esc 共用）。 */
  onClose: () => void
  /** 每个任务创建成功后回调（成功面板已经就地显示，这里只给调用方做额外联动）。 */
  onCreated?: (result: TaskInfoMutationResult) => void
}

/**
 * 关键词 chips 区：没有关键词时给一句引导，有则逐条可删。
 * @param props.keywords - 已确认的关键词。
 * @param props.onRemove - 按下 × 时回调（参数是下标）。
 * @returns chips 或引导文案。
 */
function KeywordChips({ keywords, onRemove }: {
  keywords: readonly string[]
  onRemove: (index: number) => void
}): React.JSX.Element {
  if (keywords.length === 0) {
    return <p className={css.muted}>还没有关键词。填一个后按回车或逗号确认，任一命中即触发。</p>
  }
  return (
    <div className={css.chips} data-st-region="task-keywords">
      {keywords.map((keyword, index) => (
        <span key={keyword.toLowerCase()} className={css.chip}>
          <span className={css.chipText}>{keyword}</span>
          <button
            type="button"
            className={css.chipRemove}
            title={`删除关键词「${keyword}」`}
            aria-label={`删除关键词「${keyword}」`}
            onClick={() => { onRemove(index) }}
          >×</button>
        </span>
      ))}
    </div>
  )
}

/**
 * 照片数量输入（2026-10-19 起从「0/1/3/6/9 档位」改为**可直接输入**）。
 *
 * 档位只覆盖几个常见值，用户想要 2 张、5 张时没有入口；后端本来就只约束 0–9 的整数。
 * 这里用 `type="number"` + 输入即夹取（越界/小数/空值都会被收进 0..9），并保留
 * `photoHint()` 说明「触发时取最近 N 张」的语义。`0` 就是原来的「不带」。
 * @param props.value - 当前数量（0..9）。
 * @param props.onChange - 数量变化回调（已夹取）。
 * @returns 数字输入框 + 单位说明。
 */
function PhotoLimitInput({ value, onChange }: {
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className={css.photoInputRow}>
      <input
        type="number"
        inputMode="numeric"
        className={`${csscards.exportInput} ${css.photoInput}`}
        value={String(value)}
        min={PHOTO_LIMIT_MIN}
        max={PHOTO_LIMIT_MAX}
        step={1}
        aria-label="照片数量"
        onChange={(e) => { onChange(clampPhotoLimit(Number(e.target.value))) }}
      />
      <span className={kitCss.textMeta}>张（0 = 不带图片，最多 {PHOTO_LIMIT_MAX} 张）</span>
    </div>
  )
}

/**
 * 文本条数输入：与照片数量同一套「输入即夹取」。
 *
 * 口径是**触发人自己发的文本消息**（单聊 = 对方，群聊 = 被监听的那个成员）；
 * 触发那条消息本身始终在记录里，这里配的是额外带上的最近 N 条历史文本。
 * @param props.value - 当前条数（0..9）。
 * @param props.onChange - 条数变化回调（已夹取）。
 * @returns 数字输入框 + 单位说明。
 */
function TextLimitInput({ value, onChange }: {
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className={css.photoInputRow}>
      <input
        type="number"
        inputMode="numeric"
        className={`${csscards.exportInput} ${css.photoInput}`}
        value={String(value)}
        min={TEXT_LIMIT_MIN}
        max={TEXT_LIMIT_MAX}
        step={1}
        aria-label="文本条数"
        onChange={(e) => { onChange(clampTextLimit(Number(e.target.value))) }}
      />
      <span className={kitCss.textMeta}>条（0 = 不额外带文本，最多 {TEXT_LIMIT_MAX} 条）</span>
    </div>
  )
}

/** 群成员选择器的 props。 */
interface MemberPickerProps {
  members: readonly GroupMember[]
  loading: boolean
  error: string
  query: string
  selected: readonly TaskCreateTarget[]
  disabled: boolean
  onQueryChange: (query: string) => void
  onToggle: (member: GroupMember) => void
  onRetry: () => void
}

/**
 * 群聊的「目标用户」选择器：搜索框 + 多选成员列表。
 *
 * 三个状态都不能省：加载中（否则空列表像"群里没人"）、加载失败（带重试，不能吞错）、
 * 搜索无结果（给清空入口）。超过 50 行只画前 50 行并提示继续搜索 —— 千人群不该一次铺开。
 * 选中状态按 username 判断，不依赖当前搜索页，所以切换搜索词不会丢已选成员。
 * @param props - 成员表/加载态/错误/查询词/已选列表与回调。
 * @returns 选择器。
 */
function MemberPicker(props: MemberPickerProps): React.JSX.Element {
  const { members, loading, error, query, selected, disabled, onQueryChange, onToggle, onRetry } = props
  if (loading) return <LoadingState variant="compact" label="群成员加载中…" />
  if (error !== '') {
    return (
      <div className={css.memberError} role="alert">
        <span>群成员加载失败：{error}</span>
        <button type="button" className={css.retryBtn} onClick={onRetry}>重试</button>
      </div>
    )
  }
  const result = pickMembers(members, query)
  const selectedSet = new Set(selected.map((target) => target.username))
  return (
    <>
      <div className={cssrows.memberSearchBox}>
        <div className={cssrows.searchIcon}><IconSearchOutline16 size={13} /></div>
        <input
          type="text"
          placeholder="搜索昵称、微信号或企业名称"
          value={query}
          onChange={(e) => { onQueryChange(e.target.value) }}
        />
      </div>
      {result.items.length === 0 ? (
        <p className={css.muted}>
          {query.trim() === '' ? '这个群读不到成员列表' : `没有匹配「${query.trim()}」的成员`}
        </p>
      ) : (
        <div className={css.memberList} role="listbox" aria-label="选择触发对象" aria-multiselectable="true">
          {result.items.map((member) => {
            const checked = selectedSet.has(member.username)
            return (
              <button
                key={member.username}
                type="button"
                role="option"
                aria-selected={checked}
                className={css.memberRow}
                data-active={checked || undefined}
                disabled={disabled}
                onClick={() => { onToggle(member) }}
              >
                <span className={css.memberCheck} data-checked={checked || undefined} aria-hidden="true">
                  {checked ? '✓' : ''}
                </span>
                <Avatar name={member.name} username={member.username} size={26} />
                <span className={css.memberName}>{withEnterprise(member.name, member.enterpriseName)}</span>
                <span className={css.memberUser}>{member.username}</span>
              </button>
            )
          })}
        </div>
      )}
      {result.needQuery && <p className={css.hint}>群成员较多（共 {members.length} 位），输入昵称或微信号搜索</p>}
      {result.hidden > 0 && <p className={css.hint}>仅显示前 {result.items.length} 位匹配成员，继续搜索可缩小范围</p>}
    </>
  )
}

/**
 * 已选触发对象摘要。
 *
 * 搜索框只画当前匹配的成员；这里单独展示整批选择，用户切到别的搜索词后仍能看见
 * 自己已经选了谁，并能逐条撤销或一次清空。
 */
function SelectedTargets({ targets, disabled, onRemove, onClear }: {
  targets: readonly TaskCreateTarget[]
  disabled: boolean
  onRemove: (username: string) => void
  onClear: () => void
}): React.JSX.Element | null {
  if (targets.length === 0) return null
  return (
    <div className={css.targetSelection} data-st-region="task-create-targets">
      <div className={css.targetSummary}>
        <span>已选 {targets.length} 人 · 将分别创建 {targets.length} 个任务</span>
        <button type="button" className={css.targetClear} disabled={disabled} onClick={onClear}>清空</button>
      </div>
      <div className={css.targetChips}>
        {targets.map((target) => (
          <span key={target.username} className={css.targetChip}>
            <span className={css.targetChipName}>{withEnterprise(target.name || target.username, target.enterpriseName)}</span>
            <button
              type="button"
              className={css.targetChipRemove}
              title={`移除触发对象「${target.name || target.username}」`}
              aria-label={`移除触发对象「${target.name || target.username}」`}
              disabled={disabled}
              onClick={() => { onRemove(target.username) }}
            >×</button>
          </span>
        ))}
      </div>
    </div>
  )
}

/** 一个触发对象的创建结果（成功或失败都保留，便于部分失败时逐项交代）。 */
interface TaskCreateOutcome {
  targetUsername: string
  targetLabel: string
  taskName: string
  ok: boolean
  error?: string
}

/**
 * 创建完成后的就地结果面板（不再弹第二个框）。
 *
 * 批量创建允许部分成功：不能因为第 3 个人失败就把前 2 个已落库的任务藏起来。
 * 面板逐项展示成员、任务名与失败原因，用户能明确知道哪些已创建、哪些还需要重试。
 * @param props.outcomes - 每个触发对象的结果。
 * @param props.keywords - 本批共用关键词（让用户当场核对）。
 * @param props.onClose - 「知道啦」关闭。
 * @returns 成功/部分失败面板。
 */
function TaskCreatedPanel({ outcomes, keywords, onClose }: {
  outcomes: readonly TaskCreateOutcome[]
  keywords: readonly string[]
  onClose: () => void
}): React.JSX.Element {
  const okCount = outcomes.filter((item) => item.ok).length
  const failedCount = outcomes.length - okCount
  return (
    <div
      className={css.success}
      data-st-region="task-create-success"
      role={failedCount > 0 ? 'alert' : 'status'}
    >
      <div className={css.successTitle}>
        {failedCount > 0 ? `批量创建完成 · ${String(failedCount)} 个失败` : '已加入任务信息 · 待完善'}
      </div>
      <p className={css.successDesc}>
        已创建 {okCount} 个独立任务{failedCount > 0 ? `，${String(failedCount)} 个未创建` : ''}。
        完善触发方式后启用：到「任务信息」里分别点「编辑」，配置 Webhook 地址或八爪鱼 RPA 并标记已完善，
        命中各自目标的消息时才会投递。消息列表里已按同一会话和触发对象写好规则。
      </p>
      <div className={css.resultList}>
        {outcomes.map((item) => (
          <div key={item.targetUsername} className={css.resultRow} data-ok={item.ok || undefined}>
            <span className={css.resultBadge}>{item.ok ? '已创建' : '失败'}</span>
            <span className={css.resultMain}>
              <span className={css.resultTarget}>{item.targetLabel}</span>
              <span className={css.resultName}>{item.taskName}</span>
              {!item.ok && item.error !== undefined && <span className={css.resultError}>{item.error}</span>}
            </span>
          </div>
        ))}
      </div>
      <p className={css.successMeta}>共用触发关键词：{keywords.join('、')}</p>
      <div className={css.successActions}>
        <button type="button" className={csscards.exportBtnPrimary} onClick={onClose}>知道啦</button>
      </div>
    </div>
  )
}

/**
 * 群聊任务的「仅匹配@我的文本」勾选项。
 * @param checked - 是否启用该条件。
 * @param onChange - 勾选变化。
 * @returns 带说明的 checkbox 行。
 */
function MentionMeOnlyField({ checked, onChange }: {
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className={css.mentionRow}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { onChange(e.target.checked) }}
      />
      <span>
        <span className={css.mentionTitle}>仅匹配@我的文本</span>
        <span className={css.mentionHint}>只处理结构化 @ 了你本人的群消息；@所有人不算</span>
      </span>
    </label>
  )
}

/** 弹窗主体需要的表单、成员和提交状态。 */
interface TaskCreateFormPanelProps {
  session: TaskCreateSession
  isGroup: boolean
  form: TaskCreateForm
  members: readonly GroupMember[]
  membersLoading: boolean
  membersError: string
  memberQuery: string
  busy: boolean
  busyProgress: { done: number; total: number } | null
  error: string
  desktop: boolean
  keywordRef: React.MutableRefObject<HTMLInputElement | null>
  keywordCount: number
  targets: readonly TaskCreateTarget[]
  nameExample: string
  onKeywordDraftChange: (value: string) => void
  onKeywordKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onRemoveKeyword: (index: number) => void
  onMentionMeOnlyChange: (checked: boolean) => void
  onPhotoLimitChange: (value: number) => void
  onTextLimitChange: (value: number) => void
  onNameChange: (value: string) => void
  onMemberQueryChange: (value: string) => void
  onToggleMember: (member: GroupMember) => void
  onRemoveTarget: (username: string) => void
  onClearTargets: () => void
  onRetryMembers: () => void
  onClose: () => void
  onSubmit: () => void
}

/**
 * 新建任务弹窗的表单主体。
 * @param props - 会话、表单值、成员数据和交互回调。
 * @returns 可滚动表单与底部动作区。
 */
function TaskCreateFormPanel(props: TaskCreateFormPanelProps): React.JSX.Element {
  const { session, isGroup, form } = props
  return (
    <>
      <div className={cssshell.exportBody}>
        {/* ① 监听对象 */}
        <div className={cssshell.exportSection}>
          <div className={cssshell.exportSectionHead}>
            <span className={csscards.exportSectionTitle}>监听对象</span>
            <span className={csscards.exportCountBadge}>{chatTypeLabel(session.type)}</span>
          </div>
          <div className={css.chatRow}>
            <Avatar name={session.displayName} username={session.username} size={32} />
            <div className={css.chatMain}>
              <div className={css.chatName}>{withEnterprise(session.displayName || session.username, session.enterpriseName)}</div>
              <div className={css.chatMeta}>{session.username}</div>
            </div>
          </div>
          {isGroup ? (
            <>
              <p className={cssshell.exportHint}>
                可多选触发对象。每个成员会独立创建一个任务，关键词和照片配置共用，但目标消息、触发记录与启停状态互不混合。
              </p>
              <MemberPicker
                members={props.members}
                loading={props.membersLoading}
                error={props.membersError}
                query={props.memberQuery}
                selected={props.targets}
                disabled={props.busy}
                onQueryChange={props.onMemberQueryChange}
                onToggle={props.onToggleMember}
                onRetry={props.onRetryMembers}
              />
              <SelectedTargets
                targets={props.targets}
                disabled={props.busy}
                onRemove={props.onRemoveTarget}
                onClear={props.onClearTargets}
              />
              {props.targets.length === 0
                ? <p className={css.warn}>群聊需选择目标用户</p>
                : (
                  <p className={css.hint}>
                    已选 {props.targets.length} 人；提交后会按每个人分别生成任务。
                  </p>
                )}
            </>
          ) : (
            <p className={cssshell.exportHint}>单聊：触发对象就是当前会话对象本身。</p>
          )}
        </div>

        {/* ② 触发条件 */}
        <div className={cssshell.exportSection}>
          <div className={cssshell.exportSectionHead}>
            <span className={csscards.exportSectionTitle}>触发条件</span>
            <span className={cssshell.exportHint}>任一关键词命中即触发</span>
          </div>
          <div className={cssshell.exportField}>
            <span className={kitCss.textMeta}>触发关键词</span>
            <input
              ref={props.keywordRef}
              type="text"
              className={csscards.exportInput}
              placeholder="输入关键词后按回车或逗号添加"
              value={form.keywordDraft}
              maxLength={KEYWORD_MAX_LEN}
              onChange={(e) => { props.onKeywordDraftChange(e.target.value) }}
              onKeyDown={props.onKeywordKeyDown}
            />
            <KeywordChips keywords={form.keywords} onRemove={props.onRemoveKeyword} />
            <p className={cssshell.exportHint}>已添加 {props.keywordCount}/{KEYWORD_MAX_COUNT} 个；重复关键词（不区分大小写）自动忽略。</p>
          </div>
          {isGroup && (
            <MentionMeOnlyField checked={form.mentionMeOnly} onChange={props.onMentionMeOnlyChange} />
          )}
          <div className={cssshell.exportField}>
            <span className={kitCss.textMeta}>携带当前对象最近的照片数量</span>
            <PhotoLimitInput value={form.photoLimit} onChange={props.onPhotoLimitChange} />
            <p className={cssshell.exportHint}>{photoHint(form.photoLimit)}</p>
          </div>
          <div className={cssshell.exportField}>
            <span className={kitCss.textMeta}>携带触发人最近的文本条数</span>
            <TextLimitInput value={form.textLimit} onChange={props.onTextLimitChange} />
            <p className={cssshell.exportHint}>{textHint(form.textLimit)}</p>
          </div>
        </div>

        {/* ③ 任务名 */}
        <div className={cssshell.exportSection}>
          <div className={cssshell.exportSectionHead}>
            <span className={csscards.exportSectionTitle}>任务名</span>
            <span className={cssshell.exportHint}>
              {props.targets.length > 1 ? '可选；多选时自动追加成员名' : '可选，留空自动生成'}
            </span>
          </div>
          <div className={cssshell.exportField}>
            <input
              type="text"
              className={csscards.exportInput}
              placeholder={`留空自动生成：${props.nameExample}`}
              value={form.name}
              maxLength={TASK_NAME_MAX_LEN}
              onChange={(e) => { props.onNameChange(e.target.value) }}
            />
          </div>
        </div>

        {props.error !== '' && <p className={kitCss.error} role="alert">{props.error}</p>}
        {props.busyProgress !== null && (
          <p className={css.hint} role="status">
            正在创建 {props.busyProgress.done}/{props.busyProgress.total} 个任务…
          </p>
        )}
        {props.desktop && <p className={css.warn}>新建任务需要桌面端（要写本机数据库）。</p>}
      </div>
      <div className={cssshell.exportActions}>
        <button type="button" className={csscards.exportBtnGhost} disabled={props.busy} onClick={props.onClose}>取消</button>
        <button
          type="button"
          className={csscards.exportBtnPrimary}
          disabled={props.busy || props.desktop}
          onClick={props.onSubmit}
          {...desktopActionProps()}
        >{
          props.busy
            ? (props.busyProgress === null
              ? '创建中…'
              : `创建中 ${String(props.busyProgress.done)}/${String(props.busyProgress.total)}…`)
            : (props.targets.length > 1 ? `创建 ${String(props.targets.length)} 个任务` : '创建任务')
        }</button>
      </div>
    </>
  )
}

/**
 * 新建任务弹窗。
 * @param props - 当前会话、关闭回调与可选的成功回调。
 * @returns 弹窗元素（只在被挂载时存在）。
 */
export function TaskCreateDialog({ session, onClose, onCreated }: TaskCreateDialogProps): React.JSX.Element {
  const isGroup = session.type === 'group'
  const titleId = useId()
  const [form, setForm] = useState<TaskCreateForm>(initialTaskCreateForm)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [membersLoading, setMembersLoading] = useState(isGroup)
  const [membersError, setMembersError] = useState('')
  const [memberQuery, setMemberQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyProgress, setBusyProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ outcomes: TaskCreateOutcome[]; keywords: string[] } | null>(null)
  const keywordRef = useRef<HTMLInputElement | null>(null)
  const aliveRef = useRef(true)
  /** 手机/浏览器态没有本机数据库：创建动作沿用旧弹窗的 `desktopAction()` 降级。 */
  const desktop = desktopAction()

  const requestClose = useCallback((): void => {
    if (!busy) onClose()
  }, [busy, onClose])

  useEscapeToClose(!busy, requestClose)
  // 选择器写成**字面量**：`dialog-a11y.wiring.spec.ts` 按字面量扫「谁为这个 dialog 装了焦点陷阱」，
  // 传常量会让它查无此人（该守卫的口径见那份文件头；同目录的记录弹窗也是字面量写法）。
  useDialogFocus(true, '[data-st-dialog="task-create"]')
  // 打开时焦点直接落在关键词输入框（而不只是"进了弹窗"）：填关键词是这里的主动作。
  useEffect(() => { keywordRef.current?.focus() }, [])
  useEffect(() => () => { aliveRef.current = false }, [])

  const loadMembers = useCallback(async (): Promise<void> => {
    setMembersLoading(true)
    setMembersError('')
    try {
      const r = await apiGetGroupInfo(session.username)
      if (!aliveRef.current) return
      setMembers(r.group?.members ?? [])
    } catch (e) {
      if (!aliveRef.current) return
      setMembers([])
      setMembersError((e as Error).message)
    } finally {
      if (aliveRef.current) setMembersLoading(false)
    }
  }, [session.username])

  useEffect(() => { if (isGroup) void loadMembers() }, [isGroup, loadMembers])

  /**
   * 把输入框里的草稿并进 chips。
   *
   * Enter / 逗号触发；提交时也会先并一次 —— 用户填完最后一个词直接点「创建任务」
   * 是极常见的路径，不能因为"他没按回车"就把这个词丢掉。
   */
  const commitDraft = useCallback((raw: string): boolean => {
    const result = addKeywordBatch(form.keywords, raw)
    if (!result.ok) {
      setError(result.error ?? '关键词不合法')
      return false
    }
    setError('')
    if (raw !== '') setForm((prev) => ({ ...prev, keywords: result.keywords, keywordDraft: '' }))
    return true
  }, [form.keywords])

  const onKeywordKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // 中文输入法选词时的 Enter 不能当"确认关键词"，否则打字打到一半就多一个 chip。
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      commitDraft(form.keywordDraft)
    }
  }

  const toggleMember = (member: GroupMember): void => {
    setForm((prev) => ({
      ...prev,
      targets: toggleTaskTarget(prev.targets, {
        username: member.username,
        name: member.name,
        enterpriseName: member.enterpriseName,
      }),
    }))
    setError('')
  }

  const submit = useCallback(async (): Promise<void> => {
    if (desktop) {
      setError('新建任务需要桌面端（要写本机数据库）')
      return
    }
    const merged = addKeywordBatch(form.keywords, form.keywordDraft)
    if (!merged.ok) {
      setError(merged.error ?? '关键词不合法')
      return
    }
    const problem = validateTaskCreate({
      chatType: session.type,
      targetCount: session.type === 'group' ? form.targets.length : 1,
      keywords: merged.keywords,
      photoLimit: form.photoLimit,
      textLimit: form.textLimit,
    })
    if (problem !== null) {
      setError(problem)
      return
    }
    const inputs = buildTaskInfoInputs({
      chat: session,
      targets: form.targets,
      keywords: merged.keywords,
      photoLimit: form.photoLimit,
      textLimit: form.textLimit,
      mentionMeOnly: form.mentionMeOnly,
      name: form.name,
    })
    if (inputs.length === 0) {
      setError(GROUP_TARGET_REQUIRED)
      return
    }
    setBusy(true)
    setBusyProgress({ done: 0, total: inputs.length })
    setError('')
    try {
      const outcomes: TaskCreateOutcome[] = []
      for (const [index, input] of inputs.entries()) {
        if (!aliveRef.current) return
        const targetLabel = input.targetName || input.targetUsername || session.displayName
        let saved: TaskInfoMutationResult | null = null
        try {
          const result = await apiSaveTaskInfo(input)
          saved = result
          outcomes.push({
            targetUsername: input.targetUsername ?? `target-${String(index)}`,
            targetLabel,
            taskName: input.name ?? '',
            ok: result.ok,
            error: result.error,
          })
        } catch (e) {
          outcomes.push({
            targetUsername: input.targetUsername ?? `target-${String(index)}`,
            targetLabel,
            taskName: input.name ?? '',
            ok: false,
            error: (e as Error).message,
          })
        }
        if (saved?.ok === true) {
          // 回调属于宿主联动，不能让它的异常把已经成功的任务误报成失败。
          try {
            onCreated?.(saved)
          } catch (e) {
            console.warn('[task-create] onCreated 回调失败：' + (e as Error).message)
          }
        }
        if (aliveRef.current) setBusyProgress({ done: index + 1, total: inputs.length })
      }
      if (!aliveRef.current) return
      const okCount = outcomes.filter((item) => item.ok).length
      if (okCount === 0) {
        // 全部失败时留在表单上，按成员逐条回显原因，方便改配置后直接重试。
        setError(outcomes
          .map((item) => `${item.targetLabel}：${item.error ?? '创建任务失败'}`)
          .join('；'))
        return
      }
      setCreated({ outcomes, keywords: merged.keywords })
    } catch (e) {
      if (aliveRef.current) setError((e as Error).message)
    } finally {
      if (aliveRef.current) {
        setBusy(false)
        setBusyProgress(null)
      }
    }
  }, [desktop, form, session, onCreated])

  const keywordCount = form.keywords.length
  const firstTarget = form.targets[0]
  const nameExample = defaultTaskName({
    chatName: session.displayName,
    chatType: session.type,
    targetName: firstTarget?.name,
    keywords: form.keywords,
  })

  return (
    <div
      className={cssshell.calOverlay}
      data-edge="right"
      data-st-dialog="task-create"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose() }}
    >
      <div className={`${csscards.exportDialog} ${css.dialog}`}>
        <div className={cssshell.calHeader}>
          <span className={cssshell.calTitle} id={titleId}>新建任务</span>
          <button type="button" className={cssshell.calClose} title="关闭" aria-label="关闭" disabled={busy} onClick={requestClose}><IconCloseOutline16 size={15} /></button>
        </div>
        {created !== null ? (
          <TaskCreatedPanel outcomes={created.outcomes} keywords={created.keywords} onClose={onClose} />
        ) : (
          <TaskCreateFormPanel
            session={session}
            isGroup={isGroup}
            form={form}
            members={members}
            membersLoading={membersLoading}
            membersError={membersError}
            memberQuery={memberQuery}
            busy={busy}
            busyProgress={busyProgress}
            error={error}
            desktop={desktop}
            keywordRef={keywordRef}
            keywordCount={keywordCount}
            targets={form.targets}
            nameExample={nameExample}
            onKeywordDraftChange={(keywordDraft) => { setForm((prev) => ({ ...prev, keywordDraft })) }}
            onKeywordKeyDown={onKeywordKeyDown}
            onRemoveKeyword={(index) => { setForm((prev) => ({ ...prev, keywords: removeKeyword(prev.keywords, index) })) }}
            onMentionMeOnlyChange={(mentionMeOnly) => { setForm((prev) => ({ ...prev, mentionMeOnly })) }}
            onPhotoLimitChange={(photoLimit) => { setForm((prev) => ({ ...prev, photoLimit })) }}
            onTextLimitChange={(textLimit) => { setForm((prev) => ({ ...prev, textLimit })) }}
            onNameChange={(name) => { setForm((prev) => ({ ...prev, name })) }}
            onMemberQueryChange={setMemberQuery}
            onToggleMember={toggleMember}
            onRemoveTarget={(username) => {
              setForm((prev) => ({ ...prev, targets: removeTaskTarget(prev.targets, username) }))
              setError('')
            }}
            onClearTargets={() => {
              setForm((prev) => ({ ...prev, targets: [] }))
              setError('')
            }}
            onRetryMembers={() => { void loadMembers() }}
            onClose={requestClose}
            onSubmit={() => { void submit() }}
          />
        )}
      </div>
    </div>
  )
}

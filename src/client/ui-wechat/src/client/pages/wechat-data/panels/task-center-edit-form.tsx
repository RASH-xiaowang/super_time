/**
 * 「任务信息」右侧编辑抽屉里的**配置表单**（2026-10-21 从行内展开迁入抽屉）。
 *
 * 职责边界（与 `TaskCenter.tsx` 的分工）：
 *  · 本文件只管**草稿状态与校验**（任务名 / 关键词 / 触发方式 / 照片数量 / Webhook 或八爪鱼配置）；
 *  · 抽屉外壳（打开/关闭、标题）在 `TaskCenter.tsx` 的 `TaskCenterView` 根部；本文件是抽屉 body；
 *  · 写库动作（`apiSaveTaskInfo` / `apiSetTaskInfoStatus` / `apiDeleteTaskInfo`）由容器注入，
 *    容器负责广播后的两栏刷新与提示 —— 表单不自己取数，避免出现第二个真源；
 *  · 纯算术（草稿生成、校验、关键词增删、保存入参、触发方式文案）全在 `task-center.ts`。
 *
 * 四个容易踩的行为约定：
 *  ① **「标记已完善」= 先保存再改状态**：用户经常「改完配置直接点已完善」，
 *     若只改状态不保存，配置会停在旧值上（看着已完善、触发目标却是空的）。
 *     所以它走与「保存」同一份校验，再依次调 save / setStatus；
 *  ② **必填前置按触发方式分支**：webhook 缺地址 / bazhuayu 缺 FlowId / bazhuayu 既没存过 Key
 *     又没填新 Key ⇒ 本地拦截并把焦点指到对应输入框（后端的校验是最后一道闸）；
 *  ③ **API Key 不回显**：Remote 只回 `bazhuayuApiKeySet`，草稿里的 Key 输入框恒从空串开始；
 *     保存时只有输入非空才提交 `bazhuayuApiKey`（缺省 = 后端保留旧 Key，空串在契约里是「清空」，
 *     表单不提供清空入口，所以绝不能传空串）；
 *  ④ 保存成功后**不清空草稿**：容器刷新回来的任务快照会更新状态徽标，用户可能还要继续改；
 *     只有 API Key 输入框会在保存成功后清空（Key 已落库，placeholder 会变成「已保存」）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskInfo, TaskInfoInput, TaskInfoMutationResult, TaskInfoStatus, TaskTriggerMethod } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Button, Segmented } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { TaskDeleteButton } from './task-delete-button.tsx'
import {
  addKeywords,
  clampPhotoLimit,
  draftFromTask,
  PHOTO_LIMIT_MAX,
  PHOTO_LIMIT_MIN,
  readyRequirementHint,
  removeKeyword,
  taskSaveInput,
  taskStatusMeta,
  TASK_TRIGGER_METHOD_OPTIONS,
  validateTaskDraft,
  type TaskDraftErrors,
  type TaskEditDraft,
} from './task-center.ts'
import css from './task-center.module.css'
import kitCss from '../ui/kit.module.css'

/** 表单的注入依赖：写动作由容器提供（本文件不 import api-*）。 */
export interface TaskEditFormProps {
  /** 被编辑的任务（保存/改状态后由容器刷新快照，本组件保留草稿）。 */
  task: TaskInfo
  /** 保存任务（容器调用 `apiSaveTaskInfo`，入参已带 id）。 */
  onSave: (input: TaskInfoInput) => Promise<TaskInfoMutationResult>
  /** 切换「待完善 / 已完善」（容器调用 `apiSetTaskInfoStatus`）。 */
  onSetStatus: (status: TaskInfoStatus) => Promise<TaskInfoMutationResult>
  /** 删除任务（容器调用 `apiDeleteTaskInfo`，成功后清选中并关闭抽屉）。 */
  onDelete: () => Promise<TaskInfoMutationResult>
  /** 成功提示（容器的 `useTransientNotice.flash`）。 */
  onNotice: (text: string) => void
}

/** 照片数量字段的 props（独立成小组件，避免 TaskEditForm 越过函数行数棘轮）。 */
interface PhotoLimitFieldProps {
  value: number
  error?: string
  inputRef: React.MutableRefObject<HTMLInputElement | null>
  onChange: (value: number) => void
}

/**
 * 照片数量输入（0 = 不带图片，最多 9 张）。
 * @param props - 当前值 / 错误 / 输入框 ref / 变更回调。
 * @returns 数字输入框 + 单位说明。
 */
function PhotoLimitField({ value, error, inputRef, onChange }: PhotoLimitFieldProps): React.JSX.Element {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>照片数量（触发时随记录带上的图片张数）</span>
      <div className={css.photoRow}>
        <input
          ref={inputRef}
          className={`${css.input} ${css.photoInput}`}
          type="number"
          inputMode="numeric"
          min={PHOTO_LIMIT_MIN}
          max={PHOTO_LIMIT_MAX}
          step={1}
          value={String(value)}
          aria-label="照片数量"
          aria-invalid={error !== undefined}
          onChange={(e) => { onChange(clampPhotoLimit(Number(e.target.value))) }}
        />
        <span className={css.photoUnit}>张（0 = 不带图片，最多 {PHOTO_LIMIT_MAX} 张）</span>
      </div>
      {error !== undefined && <span className={css.errorText} role="alert">{error}</span>}
    </div>
  )
}

/** 关键词编辑区的 props。 */
interface KeywordFieldProps {
  keywords: readonly string[]
  input: string
  error?: string
  inputRef: React.MutableRefObject<HTMLInputElement | null>
  onInputChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onDrop: (keyword: string) => void
}

/**
 * 触发关键词区（chips + 追加输入框；回车/逗号添加、退格删最后一个）。
 * @param props - 已有关键词、输入框草稿与回调。
 * @returns 关键词编辑区。
 */
function KeywordField({ keywords, input, error, inputRef, onInputChange, onKeyDown, onDrop }: KeywordFieldProps): React.JSX.Element {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>触发关键词（回车 / 逗号添加，至少 1 个）</span>
      <div className={css.chipRow}>
        {keywords.map((keyword) => (
          <span key={keyword} className={css.chip}>
            {keyword}
            <button
              type="button"
              className={css.chipRemove}
              aria-label={`删除关键词 ${keyword}`}
              onClick={() => { onDrop(keyword) }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className={`${css.input} ${css.chipInput}`}
          type="text"
          value={input}
          placeholder={keywords.length === 0 ? '输入关键词…' : '继续添加…'}
          aria-label="添加触发关键词"
          aria-invalid={error !== undefined}
          onChange={(e) => { onInputChange(e.target.value) }}
          onKeyDown={onKeyDown}
        />
      </div>
      {error !== undefined && <span className={css.errorText} role="alert">{error}</span>}
    </div>
  )
}

/** Webhook 地址字段的 props。 */
interface WebhookFieldProps {
  value: string
  error?: string
  inputRef: React.MutableRefObject<HTMLInputElement | null>
  onChange: (value: string) => void
}

/**
 * Webhook 地址（触发方式 = Webhook 时显示）。
 * @param props - 当前值 / 错误 / 输入框 ref / 变更回调。
 * @returns 地址输入框。
 */
function WebhookField({ value, error, inputRef, onChange }: WebhookFieldProps): React.JSX.Element {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>Webhook 地址（http/https；标记已完善前必填）</span>
      <input
        ref={inputRef}
        className={css.input}
        type="url"
        value={value}
        placeholder="https://example.com/webhook"
        aria-label="Webhook 地址"
        aria-invalid={error !== undefined}
        onChange={(e) => { onChange(e.target.value) }}
      />
      {error !== undefined && <span className={css.errorText} role="alert">{error}</span>}
    </label>
  )
}

/** 八爪鱼配置字段的 props。 */
interface BazhuayuFieldsProps {
  flowId: string
  flowIdError?: string
  apiKeyInput: string
  apiKeyError?: string
  /** 该任务是否已保存过 API Key（决定 placeholder：已保存时不回显，只能留空保持不变）。 */
  apiKeySet: boolean
  flowIdRef: React.MutableRefObject<HTMLInputElement | null>
  apiKeyRef: React.MutableRefObject<HTMLInputElement | null>
  onFlowIdChange: (value: string) => void
  onApiKeyChange: (value: string) => void
}

/**
 * 八爪鱼 RPA 配置（触发方式 = 八爪鱼 RPA 时显示）：FlowId + API Key + 参数映射说明。
 *
 * API Key 用 `type="password"` 且**永不回显**：已配置时 placeholder 提示「已保存，留空保持不变」，
 * 用户不输入就不会覆盖后端已保存的 Key。
 * @param props - 两个输入的值 / 错误 / ref 与变更回调。
 * @returns FlowId、API Key 与一段说明。
 */
function BazhuayuFields({
  flowId,
  flowIdError,
  apiKeyInput,
  apiKeyError,
  apiKeySet,
  flowIdRef,
  apiKeyRef,
  onFlowIdChange,
  onApiKeyChange,
}: BazhuayuFieldsProps): React.JSX.Element {
  return (
    <div className={css.triggerConfig}>
      <label className={css.field}>
        <span className={css.fieldLabel}>FlowId</span>
        <input
          ref={flowIdRef}
          className={css.input}
          type="text"
          value={flowId}
          placeholder="例如 6ad859ccee2df270d53fc6e5"
          aria-label="八爪鱼 FlowId"
          aria-invalid={flowIdError !== undefined}
          onChange={(e) => { onFlowIdChange(e.target.value) }}
        />
        {flowIdError !== undefined && <span className={css.errorText} role="alert">{flowIdError}</span>}
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>API Key</span>
        <input
          ref={apiKeyRef}
          className={css.input}
          type="password"
          autoComplete="off"
          value={apiKeyInput}
          placeholder={apiKeySet ? '已保存，留空保持不变' : '填写八爪鱼 X-Api-Key'}
          aria-label="八爪鱼 API Key"
          aria-invalid={apiKeyError !== undefined}
          onChange={(e) => { onApiKeyChange(e.target.value) }}
        />
        {apiKeyError !== undefined && <span className={css.errorText} role="alert">{apiKeyError}</span>}
      </label>
      <p className={css.triggerDesc}>
        {'触发时调用 https://api-rpa.bazhuayu.com/api/bots/scheduling/start，把 room_name=会话名、content=触发文本、at_name=触发对象 传给该流程；图片不会发送。'}
      </p>
    </div>
  )
}

/** 触发方式分段控件的 props。 */
interface TriggerMethodPickerProps {
  method: TaskTriggerMethod
  onChange: (method: TaskTriggerMethod) => void
}

/**
 * 触发方式分区（Segmented：Webhook / 八爪鱼 RPA）+ 已完善前置提示。
 * @param props - 当前方式与切换回调。
 * @returns 分段控件与一行说明。
 */
function TriggerMethodPicker({ method, onChange }: TriggerMethodPickerProps): React.JSX.Element {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>触发方式</span>
      <Segmented
        ariaLabel="触发方式"
        options={TASK_TRIGGER_METHOD_OPTIONS}
        value={method}
        onChange={(value) => { onChange(value === 'bazhuayu' ? 'bazhuayu' : 'webhook') }}
      />
      <span className={css.triggerHint}>{readyRequirementHint(method)}</span>
    </div>
  )
}

/** 表单底部动作区（保存 / 标记状态 / 删除 / 状态说明）的 props。 */
interface FormActionsProps {
  taskName: string
  taskStatus: TaskInfoStatus
  busy: boolean
  photoLimit: number
  onSave: () => void
  onMarkReady: () => void
  onMarkIncomplete: () => void
  onDelete: () => Promise<TaskInfoMutationResult>
  onNotice: (text: string) => void
  onError: (message: string | null) => void
}

/**
 * 抽屉表单底部动作区：保存 / 标记已完善（或标记待完善）/ 删除 + 一行状态说明。
 *
 * 独立成组件有两个原因：① 主表单函数已逼近 250 行棘轮（CI 硬门禁）；
 * ② 三个写动作的禁用/降级形态是同一套，放一起不容易改一处漏一处。
 * @param props - 任务状态、在途标记与三个写动作。
 * @returns 动作区。
 */
function FormActions(props: FormActionsProps): React.JSX.Element {
  const status = taskStatusMeta(props.taskStatus)
  return (
    <div className={css.formActions}>
      {/* 保存/改状态/删除都会写本机库（后端把它们归为「仅桌面」）：手机端禁用，桌面端 spread 为空。 */}
      <Button size="sm" variant="primary" onClick={props.onSave} disabled={props.busy} {...desktopActionProps()}>
        {props.busy ? '处理中…' : '保存'}
      </Button>
      {props.taskStatus === 'ready' ? (
        <Button size="sm" variant="outline" onClick={props.onMarkIncomplete} disabled={props.busy} {...desktopActionProps()}>
          标记待完善
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={props.onMarkReady} disabled={props.busy} {...desktopActionProps()}>
          标记已完善
        </Button>
      )}
      <TaskDeleteButton
        taskName={props.taskName}
        onDelete={props.onDelete}
        onNotice={props.onNotice}
        onError={props.onError}
        showError={false}
        disabled={props.busy}
      />
      <span className={css.formHint}>
        当前状态：
        <Badge tone={status.tone} title={status.hint}>{status.label}</Badge>
        {' '}· 只有「已完善」的任务才参与触发与投递；
        {props.photoLimit === 0 ? '当前不带图片' : `当前带 ${String(props.photoLimit)} 张图片`}
      </span>
    </div>
  )
}

/**
 * 任务配置表单（抽屉 body）。
 * @param props - 任务 + 三个写动作 + 提示回调（见 {@link TaskEditFormProps}）。
 * @returns 表单元素。
 */
export function TaskEditForm({ task, onSave, onSetStatus, onDelete, onNotice }: TaskEditFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<TaskEditDraft>(() => draftFromTask(task))
  const [keywordInput, setKeywordInput] = useState('')
  const [errors, setErrors] = useState<TaskDraftErrors>({})
  const [apiError, setApiError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * 后台回源只会换掉 `task` 快照；用户正在编辑的草稿必须保留。
   * 仅在任务 id 切换时重建草稿，避免刷新把输入框内容“跳回旧值”。
   */
  const taskIdRef = useRef(task.id)
  const callbackRef = useRef<HTMLInputElement | null>(null)
  const keywordRef = useRef<HTMLInputElement | null>(null)
  const photoRef = useRef<HTMLInputElement | null>(null)
  const flowIdRef = useRef<HTMLInputElement | null>(null)
  const apiKeyRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (taskIdRef.current === task.id) return
    taskIdRef.current = task.id
    setDraft(draftFromTask(task))
    setKeywordInput('')
    setErrors({})
    setApiError(null)
  }, [task])

  /** 追加关键词（回车/逗号触发；去重由纯逻辑保证）。 */
  const commitKeyword = useCallback((): void => {
    const next = addKeywords(draft.keywords, keywordInput)
    setKeywordInput('')
    if (next.length === draft.keywords.length) return
    setDraft((d) => ({ ...d, keywords: next }))
    setErrors((e) => ({ ...e, keywords: undefined }))
  }, [draft.keywords, keywordInput])

  /** 删除一个关键词。 */
  const dropKeyword = useCallback((keyword: string): void => {
    setDraft((d) => ({ ...d, keywords: removeKeyword(d.keywords, keyword) }))
  }, [])

  /** 关键词输入框的键盘行为：回车/逗号提交；空值退格删最后一个。 */
  const onKeywordKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      commitKeyword()
      return
    }
    if (e.key === 'Backspace' && keywordInput === '' && draft.keywords.length > 0) {
      e.preventDefault()
      const last = draft.keywords[draft.keywords.length - 1]
      if (last !== undefined) dropKeyword(last)
    }
  }, [commitKeyword, dropKeyword, draft.keywords, keywordInput])

  /** 就地写回某一字段（并清掉该字段的旧错误；切换触发方式时另一方式的校验错误一起清掉）。 */
  const patch = useCallback(<K extends keyof TaskEditDraft>(key: K, value: TaskEditDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors((e) => {
      const next: TaskDraftErrors = { ...e }
      if (key === 'name') delete next.name
      else if (key === 'keywords') delete next.keywords
      else if (key === 'photoLimit') delete next.photoLimit
      else if (key === 'callbackUrl') delete next.callbackUrl
      else if (key === 'bazhuayuFlowId') delete next.bazhuayuFlowId
      else if (key === 'bazhuayuApiKeyInput') delete next.bazhuayuApiKey
      else if (key === 'triggerMethod') {
        delete next.callbackUrl
        delete next.bazhuayuFlowId
        delete next.bazhuayuApiKey
      }
      return next
    })
    setApiError(null)
  }, [])

  /**
   * 校验并提交。
   * @param thenReady - 提交成功后是否紧接着标记「已完善」。
   */
  const submit = useCallback(async (thenReady: boolean): Promise<void> => {
    const found = validateTaskDraft(draft)
    if (thenReady) {
      // 必填前置按触发方式分支（与后端「已完善」校验同口径；文案是用户能看到的最后一道本地提示）。
      if (draft.triggerMethod === 'webhook' && draft.callbackUrl.trim() === '') {
        found.callbackUrl = '标记「已完善」前必须填写 Webhook 地址（已完善的任务才会投递）'
      }
      if (draft.triggerMethod === 'bazhuayu') {
        if (draft.bazhuayuFlowId.trim() === '') found.bazhuayuFlowId = '标记「已完善」前必须填写八爪鱼 FlowId'
        if (!task.bazhuayuApiKeySet && draft.bazhuayuApiKeyInput.trim() === '') {
          found.bazhuayuApiKey = '标记「已完善」前必须填写八爪鱼 API Key'
        }
      }
    }
    if (Object.keys(found).length > 0) {
      setErrors(found)
      if (found.bazhuayuFlowId !== undefined) flowIdRef.current?.focus()
      else if (found.bazhuayuApiKey !== undefined) apiKeyRef.current?.focus()
      else if (found.callbackUrl !== undefined) callbackRef.current?.focus()
      else if (found.keywords !== undefined) keywordRef.current?.focus()
      else if (found.photoLimit !== undefined) photoRef.current?.focus()
      return
    }
    setBusy(true)
    setApiError(null)
    try {
      const saved = await onSave(taskSaveInput(task, draft))
      if (!saved.ok) {
        setApiError(saved.error ?? '保存失败')
        return
      }
      // Key 已随这次保存落库（Remote 不回读原文）：清空输入框，避免下次保存把同一把 Key 再覆盖一遍。
      // 容器刷新任务快照后 placeholder 会变成「已保存，留空保持不变」。
      if (draft.bazhuayuApiKeyInput.trim() !== '') setDraft((d) => ({ ...d, bazhuayuApiKeyInput: '' }))
      if (!thenReady) {
        onNotice('任务配置已保存')
        return
      }
      const ready = await onSetStatus('ready')
      if (!ready.ok) {
        setApiError(ready.error ?? '标记「已完善」失败')
        return
      }
      onNotice('任务已保存并标记为「已完善」，将参与触发与投递')
    } catch (e) {
      setApiError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [draft, onNotice, onSave, onSetStatus, task])

  /** 已完善 → 待完善（可逆）。 */
  const markIncomplete = useCallback(async (): Promise<void> => {
    setBusy(true)
    setApiError(null)
    try {
      const r = await onSetStatus('incomplete')
      if (!r.ok) setApiError(r.error ?? '标记「待完善」失败')
      else onNotice('已标记为「待完善」，不再参与触发与投递')
    } catch (e) {
      setApiError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [onNotice, onSetStatus])

  return (
    <form
      className={css.form}
      aria-label={`编辑任务：${task.name}`}
      onSubmit={(e) => { e.preventDefault(); void submit(false) }}
    >
      <label className={css.field}>
        <span className={css.fieldLabel}>任务名</span>
        <input
          className={css.input}
          type="text"
          value={draft.name}
          placeholder="给这个任务起个名字"
          aria-label="任务名"
          aria-invalid={errors.name !== undefined}
          onChange={(e) => { patch('name', e.target.value) }}
        />
        {errors.name !== undefined && <span className={css.errorText} role="alert">{errors.name}</span>}
      </label>

      <KeywordField
        keywords={draft.keywords}
        input={keywordInput}
        error={errors.keywords}
        inputRef={keywordRef}
        onInputChange={setKeywordInput}
        onKeyDown={onKeywordKeyDown}
        onDrop={dropKeyword}
      />

      <TriggerMethodPicker
        method={draft.triggerMethod}
        onChange={(method) => { patch('triggerMethod', method) }}
      />

      <PhotoLimitField
        value={draft.photoLimit}
        error={errors.photoLimit}
        inputRef={photoRef}
        onChange={(value) => { patch('photoLimit', value) }}
      />

      {draft.triggerMethod === 'webhook' ? (
        <WebhookField
          value={draft.callbackUrl}
          error={errors.callbackUrl}
          inputRef={callbackRef}
          onChange={(value) => { patch('callbackUrl', value) }}
        />
      ) : (
        <BazhuayuFields
          flowId={draft.bazhuayuFlowId}
          flowIdError={errors.bazhuayuFlowId}
          apiKeyInput={draft.bazhuayuApiKeyInput}
          apiKeyError={errors.bazhuayuApiKey}
          apiKeySet={task.bazhuayuApiKeySet}
          flowIdRef={flowIdRef}
          apiKeyRef={apiKeyRef}
          onFlowIdChange={(value) => { patch('bazhuayuFlowId', value) }}
          onApiKeyChange={(value) => { patch('bazhuayuApiKeyInput', value) }}
        />
      )}

      {task.chatType === 'group' && (
        <label className={css.mentionRow}>
          <input
            type="checkbox"
            checked={draft.mentionMeOnly}
            onChange={(e) => { patch('mentionMeOnly', e.target.checked) }}
          />
          <span>
            <span className={css.mentionTitle}>仅匹配@我的文本</span>
            <span className={css.mentionHint}>只处理结构化 @ 了你本人的群消息；@所有人不算</span>
          </span>
        </label>
      )}

      {apiError !== null && <div className={kitCss.error} role="alert">{apiError}</div>}

      <FormActions
        taskName={task.name}
        taskStatus={task.status}
        busy={busy}
        photoLimit={draft.photoLimit}
        onSave={() => { void submit(false) }}
        onMarkReady={() => { void submit(true) }}
        onMarkIncomplete={() => { void markIncomplete() }}
        onDelete={onDelete}
        onNotice={onNotice}
        onError={setApiError}
      />
    </form>
  )
}

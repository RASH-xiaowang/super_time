/**
 * 「任务信息」左栏行内展开的**配置表单**（2026-10-19）。
 *
 * 职责边界（与 `TaskCenter.tsx` 的分工）：
 *  · 本文件只管**草稿状态与校验**（任务名 / 关键词 / 照片数量 / Webhook 地址）；
 *  · 写库动作（`apiSaveTaskInfo` / `apiSetTaskInfoStatus` / `apiDeleteTaskInfo`）由容器注入，
 *    容器负责广播后的两栏刷新与提示 —— 表单不自己取数，避免出现第二个真源；
 *  · 纯算术（草稿生成、校验、关键词增删、保存入参）全在 `task-center.ts`，本文件只接线。
 *
 * 三个容易踩的行为约定：
 *  ① **「标记已完善」= 先保存再改状态**：用户经常「改完 Webhook 地址直接点已完善」，
 *     若只改状态不保存，配置会停在旧值上（看着已完善、回调却是空的）。
 *     所以它走与「保存」同一份校验，再依次调 save / setStatus；
 *  ② **回调为空时本地拦截**：后端的「已完善必须填回调」是最后一道闸，这里提前拦下并把焦点
 *     指到回调输入框 —— 否则用户只看到一句错误，不知道要改哪一格；
 *  ③ 保存成功后**不清空草稿**：容器刷新回来的任务快照会更新状态徽标，用户可能还要继续改。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskInfo, TaskInfoInput, TaskInfoMutationResult, TaskInfoStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Button } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { TaskDeleteButton } from './task-delete-button.tsx'
import {
  addKeywords,
  clampPhotoLimit,
  draftFromTask,
  PHOTO_LIMIT_MAX,
  PHOTO_LIMIT_MIN,
  removeKeyword,
  taskSaveInput,
  taskStatusMeta,
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
  /** 删除任务（容器调用 `apiDeleteTaskInfo`，成功后清选中并收起表单）。 */
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

/**
 * 行内任务配置表单。
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

  const status = taskStatusMeta(task.status)

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

  /** 就地写回某一字段（并清掉该字段的旧错误）。 */
  const patch = useCallback(<K extends keyof TaskEditDraft>(key: K, value: TaskEditDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors((e) => {
      const next: TaskDraftErrors = { ...e }
      if (key === 'name') delete next.name
      else if (key === 'keywords') delete next.keywords
      else if (key === 'photoLimit') delete next.photoLimit
      else if (key === 'callbackUrl') delete next.callbackUrl
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
    if (thenReady && draft.callbackUrl.trim() === '') {
      found.callbackUrl = '标记「已完善」前必须填写 Webhook 地址（已完善的任务才会投递）'
    }
    if (Object.keys(found).length > 0) {
      setErrors(found)
      if (found.callbackUrl !== undefined) callbackRef.current?.focus()
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
      if (!thenReady) {
        onNotice('任务配置已保存')
        return
      }
      const ready = await onSetStatus('ready')
      if (!ready.ok) {
        setApiError(ready.error ?? '标记「已完善」失败')
        return
      }
      onNotice('任务已保存并标记为「已完善」，将参与触发与 Webhook 投递')
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
      else onNotice('已标记为「待完善」，不再参与触发与 Webhook 投递')
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
      <div className={css.formRow}>
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

        <div className={css.field}>
          <span className={css.fieldLabel}>触发关键词（回车 / 逗号添加，至少 1 个）</span>
          <div className={css.chipRow}>
            {draft.keywords.map((keyword) => (
              <span key={keyword} className={css.chip}>
                {keyword}
                <button
                  type="button"
                  className={css.chipRemove}
                  aria-label={`删除关键词 ${keyword}`}
                  onClick={() => { dropKeyword(keyword) }}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={keywordRef}
              className={`${css.input} ${css.chipInput}`}
              type="text"
              value={keywordInput}
              placeholder={draft.keywords.length === 0 ? '输入关键词…' : '继续添加…'}
              aria-label="添加触发关键词"
              aria-invalid={errors.keywords !== undefined}
              onChange={(e) => { setKeywordInput(e.target.value) }}
              onKeyDown={onKeywordKeyDown}
            />
          </div>
          {errors.keywords !== undefined && <span className={css.errorText} role="alert">{errors.keywords}</span>}
        </div>
      </div>

      <div className={css.formRow}>
        <PhotoLimitField
          value={draft.photoLimit}
          error={errors.photoLimit}
          inputRef={photoRef}
          onChange={(value) => { patch('photoLimit', value) }}
        />

        <label className={css.field}>
          <span className={css.fieldLabel}>Webhook 地址（http/https；标记已完善前必填）</span>
          <input
            ref={callbackRef}
            className={css.input}
            type="url"
            value={draft.callbackUrl}
            placeholder="https://example.com/webhook"
            aria-label="Webhook 地址"
            aria-invalid={errors.callbackUrl !== undefined}
            onChange={(e) => { patch('callbackUrl', e.target.value) }}
          />
          {errors.callbackUrl !== undefined && <span className={css.errorText} role="alert">{errors.callbackUrl}</span>}
        </label>
      </div>

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

      <div className={css.formActions}>
        {/* 保存/改状态/删除都会写本机库（后端把它们归为「仅桌面」）：手机端禁用，桌面端 spread 为空。 */}
        <Button size="sm" variant="primary" onClick={() => { void submit(false) }} disabled={busy} {...desktopActionProps()}>
          {busy ? '处理中…' : '保存'}
        </Button>
        {task.status === 'ready' ? (
          <Button size="sm" variant="outline" onClick={() => { void markIncomplete() }} disabled={busy} {...desktopActionProps()}>
            标记待完善
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => { void submit(true) }} disabled={busy} {...desktopActionProps()}>
            标记已完善
          </Button>
        )}
        <TaskDeleteButton
          taskName={task.name}
          onDelete={onDelete}
          onNotice={onNotice}
          onError={setApiError}
          showError={false}
          disabled={busy}
        />
        <span className={css.formHint}>
          当前状态：
          <Badge tone={status.tone} title={status.hint}>{status.label}</Badge>
          {' '}· 只有「已完善」的任务才参与触发与 Webhook 投递；
          {draft.photoLimit === 0 ? '当前不带图片' : `当前带 ${String(draft.photoLimit)} 张图片`}
        </span>
      </div>
    </form>
  )
}

/**
 * 任务删除入口（任务行与编辑表单共用，2026-10-20）。
 *
 * 两处入口必须给出同一套语义：危险色、二次确认、保留历史记录、桌面端降级。
 * 把这段动作放在一个组件里，避免将来只改了行内按钮、表单按钮却还弹旧文案。
 *
 * 这个组件同时会被放进编辑表单的 `<form>` 里。按钮必须显式写 `type="button"`：
 * 共享 `Button` 的默认类型应由原子组件保证，但删除入口是破坏性动作，不能把
 * “点删除会不会先提交表单”留给默认值 —— 一处表单语义变化就可能表现为
 * 「按钮点下去没反应」。
 *
 * @module task-delete-button
 */
import { useCallback, useState } from 'react'
import type { TaskInfoMutationResult } from '@deepseek-ai/dsh-wechat-data/types'
import { Button } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import css from './task-center.module.css'

/** 任务删除按钮的注入依赖。 */
export interface TaskDeleteButtonProps {
  /** 删除确认文案与可访问名里使用的任务名。 */
  taskName: string
  /** 容器写入口。 */
  onDelete: () => Promise<TaskInfoMutationResult>
  /** 成功提示（容器的 transient notice）。 */
  onNotice: (text: string) => void
  /** 失败回传；表单可据此在顶部显示同一条错误。 */
  onError?: (message: string) => void
  /** 是否在按钮旁直接显示错误。行内入口用 true，表单用 false 避免与顶部错误重复。 */
  showError?: boolean
  /** 表单保存/改状态期间禁用，避免同一任务并发写。 */
  disabled?: boolean
  /** 按钮可见文案。 */
  label?: string
}

/**
 * 删除任务配置（触发记录保留）。
 * @param props - 任务名、写入口、提示与展示选项（见 {@link TaskDeleteButtonProps}）。
 * @returns 危险按钮及可选错误提示。
 */
export function TaskDeleteButton({
  taskName,
  onDelete,
  onNotice,
  onError,
  showError = true,
  disabled = false,
  label = '删除',
}: TaskDeleteButtonProps): React.JSX.Element {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: `删除任务「${taskName}」？`,
      message: '任务配置会被删除，之后不再触发；已产生的触发记录会保留（它们是历史事实，仍可在右栏回看）。',
      tone: 'danger',
      confirmText: '删除任务',
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const result = await onDelete()
      if (!result.ok) {
        const message = result.error ?? '删除失败'
        setError(message)
        onError?.(message)
        return
      }
      onNotice('任务已删除')
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      onError?.(message)
    } finally {
      setBusy(false)
    }
  }, [confirm, onDelete, onError, onNotice, taskName])

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="danger"
        aria-label={`删除任务「${taskName}」`}
        disabled={disabled || busy}
        onClick={() => { void remove() }}
        {...desktopActionProps()}
      >
        {busy ? '删除中…' : label}
      </Button>
      {showError && error !== null && (
        <span className={css.deleteError} role="alert">删除失败：{error}</span>
      )}
    </>
  )
}

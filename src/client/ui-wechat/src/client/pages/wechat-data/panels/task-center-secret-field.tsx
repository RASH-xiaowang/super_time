/**
 * 动态厂商表单里的 **凭据（secret）字段控件 + 「眼睛」回显**。
 *
 * 从 `task-center-edit-form.tsx` 拆出（主表单接近 M21 1000 行上限），也让「查看/隐藏」
 * 的异步状态与输入框渲染集中在一处：
 *  · 眼睛只在**已保存**凭据上出现（`canRevealSecret`，新建任务/非法 id 不显示）；
 *  · 点击「查看」→ `apiRevealTaskTriggerSecret` 回读本机凭据，原文写进输入框、type 切 text；
 *  · 再点「隐藏」→ 清空输入框、type 回 password（清空后保存 = 保留旧值，语义不变）；
 *  · 明文状态由调用方在切换厂商/保存成功/任务切换时 `reset()` 并清输入框；
 *  · 失败走面板通知条（`查看失败：<error>`），**不写 console/log**。
 *
 * 可访问名：`查看 <ariaLabel ?? label>` / `隐藏 <...>`（E2E/SSR 依赖）。
 */
import { useCallback, useRef, useState } from 'react'
import type { RpaField } from '@deepseek-ai/dsh-wechat-data/types'
import { apiRevealTaskTriggerSecret } from '../api-task-center.ts'
import { desktopAction } from '../ui/desktop-only.tsx'
import {
  canRevealSecret,
  secretFieldLabel,
  secretFieldPlaceholder,
  secretFieldType,
  secretRevealButtonLabel,
} from './task-center-secret.ts'
import css from './task-center.module.css'
import triggerCss from './task-center-trigger.module.css'

/** 「眼睛」状态与动作（edit-form 持有，切厂商/保存时调用 reset）。 */
export interface SecretRevealState {
  /** 当前回显明文的字段 key（null = 全部隐藏）。 */
  revealedKey: string | null
  /** 正在调用 Remote 的字段 key（null = 空闲）。 */
  busyKey: string | null
  /** 点「查看/隐藏」；`apply` 负责把值写回（或清空）对应输入框。 */
  toggle: (field: RpaField, apply: (value: string) => void) => void
  /** 清掉回显/在途状态（不负责清输入框，调用方一并清）。 */
  reset: () => void
}

/**
 * 凭据回显状态机（不含渲染）。
 * @param options.taskId - 被编辑任务 id（<=0 视为新建/非法，不会发请求）。
 * @param options.onError - 失败提示（面板通知条）。
 * @returns 回显状态与 toggle/reset。
 */
export function useSecretReveal(options: { taskId: number; onError: (text: string) => void }): SecretRevealState {
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const busyRef = useRef(false)
  const { taskId, onError } = options

  const reset = useCallback((): void => {
    busyRef.current = false
    setRevealedKey(null)
    setBusyKey(null)
  }, [])

  const toggle = useCallback((field: RpaField, apply: (value: string) => void): void => {
    // 仅桌面端：浏览器/手机态隐藏入口并拒绝调用（后端远程通道也会拒绝）。
    if (desktopAction()) return
    if (busyRef.current) return
    // 已回显 → 隐藏：清空输入框并让 type 回到 password。
    if (revealedKey === field.key) {
      apply('')
      setRevealedKey(null)
      return
    }
    if (!Number.isInteger(taskId) || taskId <= 0) return
    busyRef.current = true
    setBusyKey(field.key)
    void (async (): Promise<void> => {
      try {
        const result = await apiRevealTaskTriggerSecret(taskId)
        if (!result.ok) {
          onError(`查看失败：${result.error ?? '未知错误'}`)
          return
        }
        const secret = result.secrets?.[field.key]
        if (secret === undefined) {
          onError(`查看失败：后端未返回「${secretFieldLabel(field)}」的已保存值`)
          return
        }
        apply(secret)
        setRevealedKey(field.key)
      } catch (e) {
        onError(`查看失败：${(e as Error).message}`)
      } finally {
        busyRef.current = false
        setBusyKey(null)
      }
    })()
  }, [onError, revealedKey, taskId])

  return { revealedKey, busyKey, toggle, reset }
}

/** `SecretField` 的 props。 */
export interface SecretFieldProps {
  field: RpaField
  /** 输入框当前值（回显时是后端原文；隐藏时为空/用户新输入）。 */
  value: string
  /** 是否已有保存值（决定 placeholder 与眼睛是否出现）。 */
  configured: boolean
  /** 是否渲染眼睛（`canRevealSecret(field, configured, taskId)`）。 */
  showReveal: boolean
  /** 当前字段是否已回显明文。 */
  revealed: boolean
  /** 该字段的 Remote 在途。 */
  busy: boolean
  error?: string
  registerRef: (el: HTMLInputElement | null) => void
  onChange: (value: string) => void
  onToggle: () => void
}

/**
 * 凭据字段：password/text 输入框 + 已保存时右侧「查看/隐藏」眼睛按钮。
 * @param props - 字段描述符、当前值、回显状态与回调。
 * @returns 字段控件。
 */
export function SecretField(props: SecretFieldProps): React.JSX.Element {
  const { field, error } = props
  const label = secretFieldLabel(field)
  return (
    <label className={`${css.field} ${triggerCss.vendorField}`}>
      <span className={css.fieldLabel}>{field.label}</span>
      <div className={triggerCss.secretRow}>
        <input
          ref={props.registerRef}
          className={css.input}
          type={secretFieldType(props.revealed)}
          autoComplete="off"
          value={props.value}
          placeholder={secretFieldPlaceholder(field, props.configured, props.revealed)}
          aria-label={label}
          aria-invalid={error !== undefined}
          onChange={(e) => { props.onChange(e.target.value) }}
        />
        {props.showReveal && !desktopAction() && (
          <button
            type="button"
            className={triggerCss.secretEye}
            aria-label={secretRevealButtonLabel(field, props.revealed)}
            title={secretRevealButtonLabel(field, props.revealed)}
            disabled={props.busy}
            onClick={props.onToggle}
          >
            {props.busy ? '读取中…' : props.revealed ? '隐藏' : '查看'}
          </button>
        )}
      </div>
      {field.help !== undefined && <span className={triggerCss.fieldHelp}>{field.help}</span>}
      {error !== undefined && <span className={css.errorText} role="alert">{error}</span>}
    </label>
  )
}

/** 内部再导出一下，方便 edit-form 只 import 一个入口。 */
export { canRevealSecret }

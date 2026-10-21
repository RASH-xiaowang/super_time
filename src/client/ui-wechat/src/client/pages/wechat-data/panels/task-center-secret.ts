/**
 * 凭据字段「眼睛」的**纯判定**（不 import react；编辑表单与单测共用）。
 *
 * 安全语义（与后端 `revealTaskTriggerSecret` 的安全边界一致）：
 *  · 只有**已保存**凭据（`triggerSecretSet[key] === true`）才显示眼睛 —— 新输入尚未落库的
 *    内容本来就在输入框里，没有「回读」的必要；
 *  · 只有本机桌面任务（有效 id）才可查看；新建中的任务/非法 id 一律隐藏；
 *  · 明文只在「查看」期间存在于输入框：隐藏/切换厂商/保存成功都要清空（调用方负责）。
 *
 * @module task-center-secret
 */
import type { RpaField } from '@deepseek-ai/dsh-wechat-data/types'

/** 字段可访问名（`ariaLabel ?? label`；与 `task-center.ts#fieldAriaLabel` 同口径）。 */
export function secretFieldLabel(field: RpaField): string {
  return field.ariaLabel ?? field.label
}

/**
 * 是否可显示「眼睛」：字段是凭据、已有保存值、且有有效任务 id（编辑的既有任务）。
 * @param field - 描述符字段。
 * @param hasSavedSecret - `task.triggerSecretSet[field.key] === true`。
 * @param taskId - 任务 id（0/NaN 视为新建或非法）。
 * @returns 是否渲染眼睛按钮。
 */
export function canRevealSecret(field: RpaField, hasSavedSecret: boolean, taskId: number): boolean {
  return field.secret === true && hasSavedSecret && Number.isInteger(taskId) && taskId > 0
}

/**
 * 眼睛按钮的可访问名（E2E/SSR 依赖）：`查看 <aria>` / `隐藏 <aria>`。
 * @param field - 描述符字段。
 * @param revealed - 当前是否已回显明文。
 * @returns aria-label 文案。
 */
export function secretRevealButtonLabel(field: RpaField, revealed: boolean): string {
  return `${revealed ? '隐藏' : '查看'} ${secretFieldLabel(field)}`
}

/**
 * 输入框 type：回显期间用 text（可见），其余恒为 password。
 * @param revealed - 是否已回显明文。
 * @returns `text` 或 `password`。
 */
export function secretFieldType(revealed: boolean): 'text' | 'password' {
  return revealed ? 'text' : 'password'
}

/**
 * 输入框 placeholder：回显期间为空；已配置（未回显）提示「已保存，留空保持不变」；未配置提示填写。
 * @param field - 描述符字段。
 * @param configured - 是否已有保存值。
 * @param revealed - 是否已回显明文。
 * @returns placeholder 文案。
 */
export function secretFieldPlaceholder(field: RpaField, configured: boolean, revealed: boolean): string {
  if (revealed) return ''
  if (configured) return '已保存，留空保持不变'
  return `填写${field.example ?? field.label}`
}

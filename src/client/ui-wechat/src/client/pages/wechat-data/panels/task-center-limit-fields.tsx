/**
 * 任务编辑表单里的两个**数量字段**：照片张数与文本条数。
 *
 * 为什么从 `task-center-edit-form.tsx` 搬出来（2026-11-24）：那个文件已经贴着 M21 的
 * 1000 行上限，而这两个字段是同一个形状（输入即夹取 + 一行单位说明 + 行内错误），
 * 单独成文件既给主表单腾了行数，也让「0 = 不带」这条口径只写在两个常量旁边。
 *
 * 口径差异只有一处，且是**有意**的：
 *   · 照片张数 = 触发对象最近 N 张图片（谁发的都算，跟着"这个对象"走）；
 *   · 文本条数 = 触发人最近 N 条文本（只算触发人自己发的，见后端 `isTargetMessage`）。
 *
 * @module panels/task-center-limit-fields
 */
import { PHOTO_LIMIT_MAX, PHOTO_LIMIT_MIN, clampPhotoLimit } from './task-center.ts'
import { TEXT_LIMIT_MAX, TEXT_LIMIT_MIN, clampTextLimit } from './task-center-limits.ts'
import css from './task-center.module.css'

/** 两个数量字段共用的 props 形状。 */
interface LimitFieldProps {
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
export function PhotoLimitField({ value, error, inputRef, onChange }: LimitFieldProps): React.JSX.Element {
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
 * 文本条数输入（0 = 不额外带文本，最多 9 条）。
 *
 * 只算**触发人自己发的**文本消息；触发那条消息本身始终在记录里，这里配的是额外历史。
 * @param props - 当前值 / 错误 / 输入框 ref / 变更回调。
 * @returns 数字输入框 + 单位说明。
 */
export function TextLimitField({ value, error, inputRef, onChange }: LimitFieldProps): React.JSX.Element {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>文本条数（触发时随记录带上的触发人文本）</span>
      <div className={css.photoRow}>
        <input
          ref={inputRef}
          className={`${css.input} ${css.photoInput}`}
          type="number"
          inputMode="numeric"
          min={TEXT_LIMIT_MIN}
          max={TEXT_LIMIT_MAX}
          step={1}
          value={String(value)}
          aria-label="文本条数"
          aria-invalid={error !== undefined}
          onChange={(e) => { onChange(clampTextLimit(Number(e.target.value))) }}
        />
        <span className={css.photoUnit}>条（0 = 不额外带文本，最多 {TEXT_LIMIT_MAX} 条）</span>
      </div>
      {error !== undefined && <span className={css.errorText} role="alert">{error}</span>}
    </div>
  )
}

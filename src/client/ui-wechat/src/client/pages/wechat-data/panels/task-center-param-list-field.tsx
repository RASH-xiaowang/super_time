/**
 * 动态厂商表单里的 **`paramList` 字段控件**（「附加参数」：参数名 → 值来源的列表）。
 *
 * 从 `task-center-edit-form.tsx` 单独拆出：主表单已接近 M21 的 1000 行上限，而这个控件
 * 自带行内布局/条件输入/增删逻辑，是天然的独立簇。它只负责渲染与编辑，规则全在
 * `task-center-param-list.ts`（默认值/归一化/校验/值来源中文名）。
 *
 * 可访问名固定公式（E2E/SSR 依赖，字段 label 来自描述符，不写死厂商文案）：
 *  · 行输入：`<label> 参数名 N` / `<label> 值来源 N` / `<label> 固定值 N` / `<label> 模板 N`
 *  · 按钮：`添加<label>`（八爪鱼 = 「添加附加参数」）、`删除<label> N`
 *
 * 行内错误来自父级的 `errors[`${field.key}:${index}`]`（纯逻辑按行产出，一行一条）；
 * 列表级错误（超 maxItems / 值不是数组）挂在 `errors[field.key]`。
 */
import type { RpaField, RpaParamEntry, RpaParamSource } from '@deepseek-ai/dsh-wechat-data/types'
import {
  appendParamEntry,
  maxParamItems,
  paramSourceOptions,
  removeParamEntry,
  TEMPLATE_PLACEHOLDER,
  updateParamEntry,
} from './task-center-param-list.ts'
import css from './task-center.module.css'
import triggerCss from './task-center-trigger.module.css'

/** `paramList` 控件的 props。 */
export interface ParamListFieldProps {
  /** 字段描述符（label/help/paramSources/maxItems 全来自这里）。 */
  field: RpaField
  /** 当前条目（来自 `paramEntriesOf` 的浅拷贝）。 */
  value: readonly RpaParamEntry[]
  /** 整个表单的字段错误表（key = `field.key` 或 `field.key:index`）。 */
  errors: Record<string, string>
  /** 整列表替换（父级写回 triggerConfig）。 */
  onChange: (next: RpaParamEntry[]) => void
  /** 首行参数名输入框 ref（保存校验失败时聚焦第一行）。 */
  registerFirstRow: (el: HTMLInputElement | null) => void
}

/** 单行的 props。 */
interface ParamRowProps {
  field: RpaField
  entry: RpaParamEntry
  index: number
  /** 该行第一条错误（无 = 合法）。 */
  error?: string
  onPatch: (patch: Partial<RpaParamEntry>) => void
  onRemove: () => void
  registerName: ((el: HTMLInputElement | null) => void) | undefined
}

/**
 * 附加参数的一行：参数名 / 值来源 / 按来源显示的固定值或模板 / 删除。
 * @param props - 行数据与回调。
 * @returns 行元素。
 */
function ParamRow(props: ParamRowProps): React.JSX.Element {
  const { field, entry, index } = props
  const n = index + 1
  const label = field.label
  return (
    <div className={triggerCss.paramRow}>
      <div className={triggerCss.paramRowHead}>
        <span className={triggerCss.paramRowIndex}>{`第 ${String(n)} 项`}</span>
        <button
          type="button"
          className={triggerCss.paramRowRemove}
          aria-label={`删除${label} ${String(n)}`}
          onClick={props.onRemove}
        >
          删除
        </button>
      </div>
      <div className={triggerCss.paramGrid}>
        <label className={triggerCss.paramField}>
          <span className={triggerCss.paramFieldLabel}>参数名</span>
          <input
            ref={props.registerName}
            className={css.input}
            type="text"
            value={entry.name}
            placeholder="例如 order_no"
            aria-label={`${label} 参数名 ${String(n)}`}
            aria-invalid={props.error !== undefined}
            onChange={(e) => { props.onPatch({ name: e.target.value }) }}
          />
        </label>
        <label className={triggerCss.paramField}>
          <span className={triggerCss.paramFieldLabel}>值来源</span>
          <select
            className={`${css.input} ${triggerCss.selectInput}`}
            value={entry.source}
            aria-label={`${label} 值来源 ${String(n)}`}
            onChange={(e) => { props.onPatch({ source: e.target.value as RpaParamSource }) }}
          >
            {paramSourceOptions(field).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      {entry.source === 'fixed' && (
        <label className={triggerCss.paramField}>
          <span className={triggerCss.paramFieldLabel}>固定值</span>
          <input
            className={css.input}
            type="text"
            value={entry.fixedValue ?? ''}
            placeholder="每次都发送这个值"
            aria-label={`${label} 固定值 ${String(n)}`}
            aria-invalid={props.error !== undefined}
            onChange={(e) => { props.onPatch({ fixedValue: e.target.value }) }}
          />
        </label>
      )}
      {entry.source === 'template' && (
        <label className={triggerCss.paramField}>
          <span className={triggerCss.paramFieldLabel}>自定义模板</span>
          <input
            className={css.input}
            type="text"
            value={entry.template ?? ''}
            placeholder={TEMPLATE_PLACEHOLDER}
            aria-label={`${label} 模板 ${String(n)}`}
            aria-invalid={props.error !== undefined}
            onChange={(e) => { props.onPatch({ template: e.target.value }) }}
          />
          <span className={triggerCss.fieldHelp}>
            可用 {'${record.chatName}'}、{'${record.keyword}'}、{'${task.name}'} 等记录/任务字段
          </span>
        </label>
      )}
      {props.error !== undefined && <span className={css.errorText} role="alert">{props.error}</span>}
    </div>
  )
}

/**
 * 「附加参数」字段控件：行列表 + 添加按钮（达到 maxItems 时禁用并说明上限）。
 * @param props - 见 {@link ParamListFieldProps}。
 * @returns 字段控件。
 */
export function ParamListField(props: ParamListFieldProps): React.JSX.Element {
  const { field, value, errors } = props
  const max = maxParamItems(field)
  const listError = errors[field.key]
  const atLimit = value.length >= max
  return (
    <div className={`${css.field} ${triggerCss.vendorField}`}>
      <span className={css.fieldLabel}>{field.label}</span>
      {field.help !== undefined && <span className={triggerCss.fieldHelp}>{field.help}</span>}
      {listError !== undefined && <span className={css.errorText} role="alert">{listError}</span>}
      {value.length === 0 && <span className={triggerCss.paramEmpty}>还没有附加参数（保存时不追加任何参数）</span>}
      {value.map((entry, index) => (
        <ParamRow
          key={index}
          field={field}
          entry={entry}
          index={index}
          error={errors[`${field.key}:${String(index)}`]}
          onPatch={(patch) => { props.onChange(updateParamEntry(value, index, patch)) }}
          onRemove={() => { props.onChange(removeParamEntry(value, index)) }}
          registerName={index === 0 ? props.registerFirstRow : undefined}
        />
      ))}
      <div className={triggerCss.paramListFoot}>
        <button
          type="button"
          className={triggerCss.paramAdd}
          disabled={atLimit}
          onClick={() => { props.onChange(appendParamEntry(value, field)) }}
        >
          {`添加${field.label}`}
        </button>
        <span className={triggerCss.fieldHelp}>
          {`最多 ${String(max)} 条${atLimit ? '（已达上限）' : ''}`}
        </span>
      </div>
    </div>
  )
}

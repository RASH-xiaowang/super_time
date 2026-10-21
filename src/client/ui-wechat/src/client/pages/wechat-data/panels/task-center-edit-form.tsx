/**
 * 「任务信息」右侧编辑抽屉里的**配置表单**（2026-10-21：catalog 驱动 + 动态厂商字段）。
 *
 * 职责边界（与 `TaskCenter.tsx` 的分工）：
 *  · 本文件只管**草稿状态与校验**（任务名 / 关键词 / 照片数量 / 触发方式 / 厂商字段）；
 *  · 触发方式由后端 `listRpaVendors` 的**描述符目录**决定：选择器渲染 `catalog.items`，
 *    字段区按 `descriptor.fields`（+ `auth.modes[].fields`）自动生成 —— 本文件不认识任何
 *    具体厂商，新增厂商只改后端注册表；
 *  · 写库动作（`apiSaveTaskInfo` / `apiSetTaskInfoStatus` / `apiDeleteTaskInfo`）由容器注入，
 *    容器负责广播后的两栏刷新与提示 —— 表单不自己取数，避免出现第二个真源；
 *  · 纯算术（草稿生成、字段分组、默认值、校验、摘要、保存入参）全在 `task-center.ts`；
 *  · 多厂商字段/说明区的样式在 `task-center-trigger.module.css`（主样式文件已到 M21 上限）。
 *
 * 五个容易踩的行为约定：
 *  ① **字段分组固定**：凭据字段 →「账号与鉴权」（密码框，已配置时 placeholder「已保存，
 *     留空保持不变」）；普通配置 →「流程与参数」；`advanced` →「高级」折叠；
 *  ② **凭据永不回显**：Remote 只回 `triggerSecretSet`（是否已配置）；保存时只带本次输入
 *     非空的键（缺省 = 保留旧值，空串 = 清空），表单不提供「清空凭据」入口；
 *  ③ **切换厂商不清空已填**：切换时把当前厂商的 config/secretInputs 留在内存，
 *     切回来能接着改（也满足 E2E「切回八爪鱼仍可读旧配置并保存」）；
 *  ④ **保存/标记已完善都按描述符校验**：`required` 只拦「标记已完善」（待完善任务允许
 *     先不填）；未知厂商（已下线）与目录读取失败都禁止保存并给出可读原因；
 *  ⑤ 保存成功后不清空草稿（容器刷新快照后状态徽标会变），只清空凭据输入框。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  RpaConfigValue,
  RpaField,
  RpaTriggerConfig,
  RpaTriggerSecretInput,
  RpaVendorDescriptor,
  TaskInfo,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoStatus,
} from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Button } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { TaskDeleteButton } from './task-delete-button.tsx'
import {
  addKeywords,
  clampPhotoLimit,
  configMapValue,
  configTextValue,
  defaultVendorConfig,
  draftFromTask,
  fieldAriaLabel,
  findVendorDescriptor,
  groupVendorFields,
  hasDraftErrors,
  PHOTO_LIMIT_MAX,
  PHOTO_LIMIT_MIN,
  readyMissingFields,
  readyRequirementHint,
  removeKeyword,
  taskSaveInput,
  taskStatusMeta,
  validateTaskDraft,
  vendorFields,
  vendorMapTargets,
  withVendorDefaults,
  type TaskDraftErrors,
  type TaskEditDraft,
} from './task-center.ts'
import css from './task-center.module.css'
import triggerCss from './task-center-trigger.module.css'
import { paramEntriesOf } from './task-center-param-list.ts'
import { ParamListField } from './task-center-param-list-field.tsx'
import kitCss from '../ui/kit.module.css'

/** 表单的注入依赖：写动作由容器提供（本文件不 import api-*）。 */
export interface TaskEditFormProps {
  /** 被编辑的任务（保存/改状态后由容器刷新快照，本组件保留草稿）。 */
  task: TaskInfo
  /** 触发方式目录（`listRpaVendors` 的 items；空 = 未加载/读取失败）。 */
  vendorCatalog: readonly RpaVendorDescriptor[]
  /** 目录读取失败原因（null = 正常；失败时禁止保存并显示错误条）。 */
  vendorCatalogError: string | null
  /** 目录是否仍在加载（加载中时选择器提示「正在读取」并暂时禁止保存）。 */
  vendorCatalogLoading: boolean
  /** 保存任务（容器调用 `apiSaveTaskInfo`，入参已带 id）。 */
  onSave: (input: TaskInfoInput) => Promise<TaskInfoMutationResult>
  /** 切换「待完善 / 已完善」（容器调用 `apiSetTaskInfoStatus`）。 */
  onSetStatus: (status: TaskInfoStatus) => Promise<TaskInfoMutationResult>
  /** 删除任务（容器调用 `apiDeleteTaskInfo`，成功后清选中并关闭抽屉）。 */
  onDelete: () => Promise<TaskInfoMutationResult>
  /** 成功提示（容器的 `useTransientNotice.flash`）。 */
  onNotice: (text: string) => void
}

/** 照片数量字段的 props（独立成小组件，避免主表单越过函数行数棘轮）。 */
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

/** 动态厂商字段的公共上下文（避免每个控件都传一长串 props）。 */
interface VendorFormContext {
  descriptor: RpaVendorDescriptor
  /** 已按描述符补过默认值的配置（展示值以它为准）。 */
  config: RpaTriggerConfig
  secretInputs: RpaTriggerSecretInput
  /** 凭据是否已保存（只回布尔，永不回原文）。 */
  secretSet: Record<string, boolean>
  /** 字段 key → 行内错误。 */
  errors: Record<string, string>
  onConfigChange: (key: string, value: RpaConfigValue) => void
  onSecretChange: (key: string, value: string) => void
  registerRef: (key: string, el: HTMLElement | null) => void
}

/**
 * `map` 字段：按 `mapping.targets` 渲染 3 个参数名输入（会话名 / 触发文本 / 触发对象）。
 *
 * 值存的是**厂商参数名**（默认取 targets[].defaultKey，用户可改成自己流程的入参名），
 * 不是触发内容本身 —— 触发内容在投递时由后端映射进来。
 * @param props.field - map 字段描述符。
 * @param props.ctx - 动态字段上下文。
 * @returns 三行参数名输入。
 */
function MapFieldControl({ field, ctx }: { field: RpaField; ctx: VendorFormContext }): React.JSX.Element {
  const aria = fieldAriaLabel(field)
  const map = configMapValue(ctx.config, field.key)
  return (
    <div className={`${css.field} ${triggerCss.vendorField}`}>
      <span className={css.fieldLabel}>{field.label}</span>
      <div className={triggerCss.mapGrid}>
        {vendorMapTargets(ctx.descriptor).map((target, index) => (
          <label key={target.semantic} className={triggerCss.mapRow}>
            <span className={triggerCss.mapLabel}>{target.label}</span>
            <input
              className={`${css.input} ${triggerCss.mapInput}`}
              type="text"
              value={map[target.semantic] ?? target.defaultKey}
              placeholder={target.defaultKey}
              aria-label={`${aria} · ${target.label}`}
              ref={index === 0 ? (el) => { ctx.registerRef(field.key, el) } : undefined}
              onChange={(e) => {
                ctx.onConfigChange(field.key, { ...map, [target.semantic]: e.target.value })
              }}
            />
          </label>
        ))}
      </div>
      {field.help !== undefined && <span className={triggerCss.fieldHelp}>{field.help}</span>}
      {ctx.errors[field.key] !== undefined && <span className={css.errorText} role="alert">{ctx.errors[field.key]}</span>}
    </div>
  )
}

/**
 * 单个动态厂商字段的控件（text / password / number / boolean / select / map）。
 *
 * 可访问名统一 `fieldAriaLabel(field)`（= `ariaLabel ?? label`）——E2E/SSR 依赖它；
 * `example` 渲染为 placeholder；`help` 渲染为一行小字。
 * @param props.field - 字段描述符。
 * @param props.ctx - 动态字段上下文。
 * @returns 一个字段控件。
 */
function VendorFieldControl({ field, ctx }: { field: RpaField; ctx: VendorFormContext }): React.JSX.Element {
  const aria = fieldAriaLabel(field)
  const error = ctx.errors[field.key]
  const register = (el: HTMLElement | null): void => { ctx.registerRef(field.key, el) }
  const help = field.help !== undefined ? <span className={triggerCss.fieldHelp}>{field.help}</span> : null
  const errorNode = error === undefined ? null : <span className={css.errorText} role="alert">{error}</span>
  if (field.type === 'map') return <MapFieldControl field={field} ctx={ctx} />
  if (field.type === 'paramList') {
    return (
      <ParamListField
        field={field}
        value={paramEntriesOf(ctx.config, field.key)}
        errors={ctx.errors}
        onChange={(next) => { ctx.onConfigChange(field.key, next) }}
        registerFirstRow={(el) => { ctx.registerRef(field.key, el) }}
      />
    )
  }
  if (field.type === 'boolean') {
    return (
      <label className={triggerCss.checkRow}>
        <input
          type="checkbox"
          ref={register}
          checked={ctx.config[field.key] === true}
          aria-label={aria}
          onChange={(e) => { ctx.onConfigChange(field.key, e.target.checked) }}
        />
        <span>
          <span className={triggerCss.checkTitle}>{field.label}</span>
          {field.help !== undefined && <span className={triggerCss.fieldHelp}>{field.help}</span>}
        </span>
      </label>
    )
  }
  if (field.type === 'select') {
    return (
      <label className={`${css.field} ${triggerCss.vendorField}`}>
        <span className={css.fieldLabel}>{field.label}</span>
        <select
          ref={(el) => { ctx.registerRef(field.key, el) }}
          className={`${css.input} ${triggerCss.selectInput}`}
          value={configTextValue(ctx.config, field.key)}
          aria-label={aria}
          aria-invalid={error !== undefined}
          onChange={(e) => { ctx.onConfigChange(field.key, e.target.value) }}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {help}
        {errorNode}
      </label>
    )
  }
  if (field.type === 'number') {
    return (
      <label className={`${css.field} ${triggerCss.vendorField}`}>
        <span className={css.fieldLabel}>{field.label}</span>
        <input
          className={css.input}
          type="number"
          ref={register}
          value={configTextValue(ctx.config, field.key)}
          placeholder={field.example ?? ''}
          aria-label={aria}
          aria-invalid={error !== undefined}
          onChange={(e) => { ctx.onConfigChange(field.key, e.target.value) }}
        />
        {help}
        {errorNode}
      </label>
    )
  }
  if (field.secret === true) {
    const placeholder = ctx.secretSet[field.key] === true ? '已保存，留空保持不变' : `填写${field.example ?? field.label}`
    return (
      <label className={`${css.field} ${triggerCss.vendorField}`}>
        <span className={css.fieldLabel}>{field.label}</span>
        <input
          ref={register}
          className={css.input}
          type="password"
          autoComplete="off"
          value={ctx.secretInputs[field.key] ?? ''}
          placeholder={placeholder}
          aria-label={aria}
          aria-invalid={error !== undefined}
          onChange={(e) => { ctx.onSecretChange(field.key, e.target.value) }}
        />
        {help}
        {errorNode}
      </label>
    )
  }
  return (
    <label className={`${css.field} ${triggerCss.vendorField}`}>
      <span className={css.fieldLabel}>{field.label}</span>
      <input
        ref={register}
        className={css.input}
        type="text"
        value={configTextValue(ctx.config, field.key)}
        placeholder={field.example ?? ''}
        aria-label={aria}
        aria-invalid={error !== undefined}
        onChange={(e) => { ctx.onConfigChange(field.key, e.target.value) }}
      />
      {help}
      {errorNode}
    </label>
  )
}

/**
 * 动态字段分区：账号与鉴权 / 流程与参数 / 高级（折叠）。
 * @param props.ctx - 动态字段上下文（描述符 + 草稿 + 回调）。
 * @returns 三组字段控件。
 */
function VendorFieldSections({ ctx }: { ctx: VendorFormContext }): React.JSX.Element {
  const groups = groupVendorFields(vendorFields(ctx.descriptor))
  return (
    <>
      {groups.auth.length > 0 && (
        <section className={triggerCss.vendorSection} aria-label="账号与鉴权">
          <span className={triggerCss.sectionTitle}>账号与鉴权</span>
          {groups.auth.map((field) => <VendorFieldControl key={field.key} field={field} ctx={ctx} />)}
        </section>
      )}
      {groups.config.length > 0 && (
        <section className={triggerCss.vendorSection} aria-label="流程与参数">
          <span className={triggerCss.sectionTitle}>流程与参数</span>
          {groups.config.map((field) => <VendorFieldControl key={field.key} field={field} ctx={ctx} />)}
        </section>
      )}
      {groups.advanced.length > 0 && (
        <details className={triggerCss.advancedBlock}>
          <summary className={triggerCss.advancedSummary}>高级</summary>
          <div className={triggerCss.advancedBody}>
            {groups.advanced.map((field) => <VendorFieldControl key={field.key} field={field} ctx={ctx} />)}
          </div>
        </details>
      )}
    </>
  )
}

/**
 * 厂商说明区：名称 / 状态徽标 / 一句话说明 / 文档链接 / 参数核对时间 / 风险（前 2 条）。
 *
 * 状态徽标对 `experimental` 显式标「⚠ 实验性」——契约要求官方未公开的参数不得假装稳定。
 * 任务保存时的描述符版本与当前目录不一致时提示复核（厂商参数可能已变）。
 * @param props.descriptor - 当前厂商描述符。
 * @param props.savedVersion - 任务保存时的 `triggerVendorVersion`。
 * @returns 说明区。
 */
function VendorInfoPanel({ descriptor, savedVersion }: {
  descriptor: RpaVendorDescriptor
  savedVersion: string
}): React.JSX.Element {
  const risks = descriptor.risks.slice(0, 2)
  return (
    <section className={triggerCss.vendorInfo} aria-label="厂商说明">
      <div className={triggerCss.vendorInfoHead}>
        <span className={triggerCss.vendorInfoName}>{descriptor.name}</span>
        {descriptor.status === 'experimental'
          ? <span className={triggerCss.vendorStatusWarn}>⚠ 实验性</span>
          : <span className={triggerCss.vendorStatusOk}>稳定</span>}
        <span className={triggerCss.vendorInfoMeta}>参数核对 {descriptor.docs.lastVerifiedAt}</span>
      </div>
      <p className={triggerCss.vendorSummary}>{descriptor.summary}</p>
      <p className={triggerCss.vendorDocs}>
        官方文档：
        <a href={descriptor.docs.triggerApi} target="_blank" rel="noreferrer">触发接口</a>
        {' '}·{' '}
        <a href={descriptor.docs.home} target="_blank" rel="noreferrer">{descriptor.vendor}</a>
      </p>
      {risks.length > 0 && (
        <ul className={triggerCss.vendorRisks}>
          {risks.map((risk) => <li key={risk}>{risk}</li>)}
        </ul>
      )}
      {savedVersion !== '' && savedVersion !== descriptor.version && (
        <p className={triggerCss.vendorVersionWarn}>
          厂商参数已更新（任务保存于 {savedVersion}，当前 {descriptor.version}），请复核后保存
        </p>
      )}
      {descriptor.notes !== undefined && descriptor.notes.length > 0 && (
        <p className={triggerCss.vendorNotes}>{descriptor.notes[0]}</p>
      )}
    </section>
  )
}

/** 触发方式选择器的 props。 */
interface VendorSelectorProps {
  catalog: readonly RpaVendorDescriptor[]
  catalogError: string | null
  loading: boolean
  method: string
  descriptor: RpaVendorDescriptor | null
  selectRef: React.MutableRefObject<HTMLSelectElement | null>
  onChange: (method: string) => void
}

/**
 * 触发方式选择器（`<select>`，选项 = catalog.items 的 `descriptor.name`）。
 *
 * 目录读取失败 / 任务当前厂商不在目录里时都给出可读错误；未知厂商的选项排在同级
 * （用户仍可切到可用方式后保存）。文案是 SSR/E2E 依赖的字面量。
 * @param props - 目录、当前方式与回调。
 * @returns 选择器与提示。
 */
function VendorSelector(props: VendorSelectorProps): React.JSX.Element {
  const { descriptor, catalogError, loading, method } = props
  const unknown = descriptor === null
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>触发方式</span>
      <select
        ref={props.selectRef}
        className={`${css.input} ${triggerCss.selectInput}`}
        aria-label="触发方式"
        value={method}
        onChange={(e) => { props.onChange(e.target.value) }}
      >
        {props.catalog.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
        {unknown && catalogError === null && !loading && (
          <option value={method}>触发方式不可用（厂商已下线）</option>
        )}
        {unknown && catalogError !== null && <option value={method}>触发方式目录不可用</option>}
        {unknown && loading && <option value={method}>加载触发方式目录…</option>}
      </select>
      {catalogError !== null
        ? <span className={css.errorText} role="alert">读取触发方式目录失败：{catalogError}</span>
        : loading
          ? <span className={triggerCss.fieldHelp}>正在读取触发方式目录…</span>
          : descriptor === null
            ? <span className={css.errorText} role="alert">触发方式不可用（厂商已下线），请重新选择触发方式</span>
            : <span className={css.triggerHint}>{readyRequirementHint(descriptor)}</span>}
    </div>
  )
}

/** 表单底部动作区（保存 / 标记状态 / 删除 / 状态说明）的 props。 */
interface FormActionsProps {
  taskName: string
  taskStatus: TaskInfoStatus
  busy: boolean
  photoLimit: number
  /** 触发方式不可用（目录失败/未知厂商）时禁用「保存 / 标记」；删除仍可用。 */
  disabled: boolean
  onSave: () => void
  onMarkReady: () => void
  onMarkIncomplete: () => void
  onDelete: () => Promise<TaskInfoMutationResult>
  onNotice: (text: string) => void
  onError: (message: string | null) => void
}

/**
 * 抽屉表单底部动作区：保存 / 标记已完善（或标记待完善）/ 删除 + 一行状态说明。
 * @param props - 任务状态、在途标记与三个写动作。
 * @returns 动作区。
 */
function FormActions(props: FormActionsProps): React.JSX.Element {
  const status = taskStatusMeta(props.taskStatus)
  const blocked = props.busy || props.disabled
  return (
    <div className={css.formActions}>
      {/* 保存/改状态/删除都会写本机库（后端把它们归为「仅桌面」）：手机端禁用，桌面端 spread 为空。 */}
      <Button size="sm" variant="primary" onClick={props.onSave} disabled={blocked} {...desktopActionProps()}>
        {props.busy ? '处理中…' : '保存'}
      </Button>
      {props.taskStatus === 'ready' ? (
        <Button size="sm" variant="outline" onClick={props.onMarkIncomplete} disabled={blocked} {...desktopActionProps()}>
          标记待完善
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={props.onMarkReady} disabled={blocked} {...desktopActionProps()}>
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

/** 抽屉表单 body 需要的字段区（描述符 + 上下文 + 版本提示）。 */
function VendorFormBody({ descriptor, ctx, savedVersion }: {
  descriptor: RpaVendorDescriptor
  ctx: VendorFormContext
  savedVersion: string
}): React.JSX.Element {
  return (
    <>
      <VendorFieldSections ctx={ctx} />
      <VendorInfoPanel descriptor={descriptor} savedVersion={savedVersion} />
    </>
  )
}

/** 草稿状态 + 基础字段回调（从主表单拆出，控制单函数行数）。 */
function useTaskDraftState(task: TaskInfo, vendorCatalog: readonly RpaVendorDescriptor[]): {
  draft: TaskEditDraft
  setDraft: React.Dispatch<React.SetStateAction<TaskEditDraft>>
  keywordInput: string
  setKeywordInput: React.Dispatch<React.SetStateAction<string>>
  errors: TaskDraftErrors
  setErrors: React.Dispatch<React.SetStateAction<TaskDraftErrors>>
  apiError: string | null
  setApiError: React.Dispatch<React.SetStateAction<string | null>>
  busy: boolean
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  keywordRef: React.MutableRefObject<HTMLInputElement | null>
  photoRef: React.MutableRefObject<HTMLInputElement | null>
  selectRef: React.MutableRefObject<HTMLSelectElement | null>
  fieldRefsRef: React.MutableRefObject<Record<string, HTMLElement | null>>
  commitKeyword: () => void
  dropKeyword: (keyword: string) => void
  onKeywordKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  patchBase: <K extends 'name' | 'keywords' | 'photoLimit' | 'mentionMeOnly'>(key: K, value: TaskEditDraft[K]) => void
  patchConfig: (key: string, value: RpaConfigValue) => void
  patchSecret: (key: string, value: string) => void
  changeTriggerMethod: (method: string) => void
  registerFieldRef: (key: string, el: HTMLElement | null) => void
} {
  const [draft, setDraft] = useState<TaskEditDraft>(() => draftFromTask(task, findVendorDescriptor(vendorCatalog, task.triggerMethod)))
  const [keywordInput, setKeywordInput] = useState('')
  const [errors, setErrors] = useState<TaskDraftErrors>({})
  const [apiError, setApiError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const taskIdRef = useRef(task.id)
  const keywordRef = useRef<HTMLInputElement | null>(null)
  const photoRef = useRef<HTMLInputElement | null>(null)
  const selectRef = useRef<HTMLSelectElement | null>(null)
  /** 厂商字段 key → 输入框（校验失败时把焦点移过去；map 字段取第一行）。 */
  const fieldRefsRef = useRef<Record<string, HTMLElement | null>>({})
  /** 切换厂商时暂存各厂商的草稿（config/secretInputs），切回来不丢已填。 */
  const vendorDraftsRef = useRef<Record<string, { config: RpaTriggerConfig; secretInputs: RpaTriggerSecretInput }>>({})
  /** 目录加载完成后给当前厂商补一次默认值（首屏目录可能晚于表单到达）。 */
  const seededRef = useRef('')
  const descriptor = findVendorDescriptor(vendorCatalog, draft.triggerMethod)

  useEffect(() => {
    if (taskIdRef.current === task.id) return
    taskIdRef.current = task.id
    setDraft(draftFromTask(task, findVendorDescriptor(vendorCatalog, task.triggerMethod)))
    setKeywordInput('')
    setErrors({})
    setApiError(null)
    vendorDraftsRef.current = {}
    seededRef.current = ''
  }, [task, vendorCatalog])

  useEffect(() => {
    if (descriptor === null) return
    const stamp = `${String(task.id)}:${descriptor.id}:${descriptor.version}`
    if (seededRef.current === stamp) return
    seededRef.current = stamp
    setDraft((current) => ({ ...current, config: withVendorDefaults(descriptor, current.config) }))
  }, [descriptor, task.id])

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

  /** 就地写回一个基础字段（任务名/关键词/照片/@过滤），并清掉该字段错误。 */
  const patchBase = useCallback(<K extends 'name' | 'keywords' | 'photoLimit' | 'mentionMeOnly'>(
    key: K,
    value: TaskEditDraft[K],
  ): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined }))
    setApiError(null)
  }, [])

  /** 写回一个厂商配置字段（值类型由控件决定；保存时再按描述符归一）。 */
  const patchConfig = useCallback((key: string, value: RpaConfigValue): void => {
    setDraft((d) => ({ ...d, config: { ...d.config, [key]: value } }))
    setErrors((e) => {
      // paramList 的行内错误键是 `${key}:${index}`：改任意一行都要把该字段的错误一起清掉。
      const prefix = `${key}:`
      if (e.fields === undefined || !Object.keys(e.fields).some((k) => k === key || k.startsWith(prefix))) return e
      const fields = { ...e.fields }
      for (const k of Object.keys(fields)) {
        if (k === key || k.startsWith(prefix)) delete fields[k]
      }
      return { ...e, fields }
    })
    setApiError(null)
  }, [])

  /** 写回一个凭据字段（只改输入框内容，不回显已保存的凭据）。 */
  const patchSecret = useCallback((key: string, value: string): void => {
    setDraft((d) => ({ ...d, secretInputs: { ...d.secretInputs, [key]: value } }))
    setErrors((e) => {
      if (e.fields?.[key] === undefined) return e
      const fields = { ...e.fields }
      delete fields[key]
      return { ...e, fields }
    })
    setApiError(null)
  }, [])

  /** 切换触发方式：当前厂商草稿留在内存，目标厂商用缓存/默认值。 */
  const changeTriggerMethod = useCallback((nextMethod: string): void => {
    setDraft((current) => {
      if (current.triggerMethod === nextMethod) return current
      vendorDraftsRef.current[current.triggerMethod] = { config: current.config, secretInputs: current.secretInputs }
      const nextDescriptor = findVendorDescriptor(vendorCatalog, nextMethod)
      const cached = vendorDraftsRef.current[nextMethod]
      const nextConfig = cached !== undefined
        ? cached.config
        : nextDescriptor !== null
          ? defaultVendorConfig(nextDescriptor)
          : {}
      const nextSecrets = cached !== undefined ? cached.secretInputs : {}
      return { ...current, triggerMethod: nextMethod, config: nextConfig, secretInputs: nextSecrets }
    })
    setErrors((e) => {
      const next: TaskDraftErrors = { ...e }
      delete next.triggerMethod
      delete next.fields
      return next
    })
    setApiError(null)
  }, [vendorCatalog])

  const registerFieldRef = useCallback((key: string, el: HTMLElement | null): void => {
    fieldRefsRef.current[key] = el
  }, [])

  return {
    draft,
    setDraft,
    keywordInput,
    setKeywordInput,
    errors,
    setErrors,
    apiError,
    setApiError,
    busy,
    setBusy,
    keywordRef,
    photoRef,
    selectRef,
    fieldRefsRef,
    commitKeyword,
    dropKeyword,
    onKeywordKeyDown,
    patchBase,
    patchConfig,
    patchSecret,
    changeTriggerMethod,
    registerFieldRef,
  }
}

/** 提交/改状态动作（从主表单拆出，控制单函数行数）。 */
function useTaskFormActions(options: {
  task: TaskInfo
  vendorCatalog: readonly RpaVendorDescriptor[]
  draft: TaskEditDraft
  setDraft: React.Dispatch<React.SetStateAction<TaskEditDraft>>
  setErrors: React.Dispatch<React.SetStateAction<TaskDraftErrors>>
  setApiError: React.Dispatch<React.SetStateAction<string | null>>
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  selectRef: React.MutableRefObject<HTMLSelectElement | null>
  keywordRef: React.MutableRefObject<HTMLInputElement | null>
  photoRef: React.MutableRefObject<HTMLInputElement | null>
  fieldRefsRef: React.MutableRefObject<Record<string, HTMLElement | null>>
  onSave: (input: TaskInfoInput) => Promise<TaskInfoMutationResult>
  onSetStatus: (status: TaskInfoStatus) => Promise<TaskInfoMutationResult>
  onNotice: (text: string) => void
}): { submit: (thenReady: boolean) => Promise<void>; markIncomplete: () => Promise<void> } {
  const { task, vendorCatalog, draft, setDraft, setErrors, setApiError, setBusy, onSave, onSetStatus, onNotice } = options
  const descriptor = findVendorDescriptor(vendorCatalog, draft.triggerMethod)

  /** 校验失败时把焦点移到第一个出错控件（厂商字段优先，按描述符顺序）。 */
  const focusFirstError = useCallback((found: TaskDraftErrors): void => {
    if (descriptor !== null) {
      for (const field of vendorFields(descriptor)) {
        // paramList 的行内错误挂在 `${key}:${index}` 上（聚焦第一行参数名）。
        const hasRowError = Object.keys(found.fields ?? {}).some((key) => key.startsWith(`${field.key}:`))
        if (found.fields?.[field.key] === undefined && !hasRowError) continue
        options.fieldRefsRef.current[field.key]?.focus()
        return
      }
    }
    if (found.triggerMethod !== undefined) options.selectRef.current?.focus()
    else if (found.keywords !== undefined) options.keywordRef.current?.focus()
    else if (found.photoLimit !== undefined) options.photoRef.current?.focus()
  }, [descriptor, options.fieldRefsRef, options.keywordRef, options.photoRef, options.selectRef])

  /**
   * 校验并提交。
   * @param thenReady - 提交成功后是否紧接着标记「已完善」。
   */
  const submit = useCallback(async (thenReady: boolean): Promise<void> => {
    const currentDescriptor = findVendorDescriptor(vendorCatalog, draft.triggerMethod)
    const found = validateTaskDraft(draft, currentDescriptor)
    if (thenReady && currentDescriptor !== null) {
      const missing = readyMissingFields(task, draft, currentDescriptor)
      if (missing.length > 0) {
        const fields = { ...(found.fields ?? {}) }
        for (const field of missing) fields[field.key] = `请填写 ${field.label}`
        found.fields = fields
      }
    }
    if (hasDraftErrors(found)) {
      setErrors(found)
      focusFirstError(found)
      return
    }
    setBusy(true)
    setApiError(null)
    try {
      const saved = await onSave(taskSaveInput(task, draft, currentDescriptor))
      if (!saved.ok) {
        setApiError(saved.error ?? '保存失败')
        return
      }
      // 凭据已随这次保存落库（Remote 不回读原文）：清空输入框，避免下次保存把同一把凭据再覆盖一遍。
      if (Object.keys(draft.secretInputs).length > 0) setDraft((d) => ({ ...d, secretInputs: {} }))
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
  }, [draft, focusFirstError, onNotice, onSave, onSetStatus, setApiError, setBusy, setDraft, setErrors, task, vendorCatalog])

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
  }, [onNotice, onSetStatus, setApiError, setBusy])

  return { submit, markIncomplete }
}

/**
 * 任务配置表单（抽屉 body）。
 * @param props - 任务 + 触发方式目录 + 三个写动作 + 提示回调（见 {@link TaskEditFormProps}）。
 * @returns 表单元素。
 */
export function TaskEditForm(props: TaskEditFormProps): React.JSX.Element {
  const { task, vendorCatalog, vendorCatalogError, vendorCatalogLoading, onSave, onSetStatus, onDelete, onNotice } = props
  const state = useTaskDraftState(task, vendorCatalog)
  const { draft, errors } = state
  const { submit, markIncomplete } = useTaskFormActions({
    task,
    vendorCatalog,
    draft,
    setDraft: state.setDraft,
    setErrors: state.setErrors,
    setApiError: state.setApiError,
    setBusy: state.setBusy,
    selectRef: state.selectRef,
    keywordRef: state.keywordRef,
    photoRef: state.photoRef,
    fieldRefsRef: state.fieldRefsRef,
    onSave,
    onSetStatus,
    onNotice,
  })
  const descriptor = findVendorDescriptor(vendorCatalog, draft.triggerMethod)
  const config = descriptor === null ? draft.config : withVendorDefaults(descriptor, draft.config)
  const ctx: VendorFormContext | null = descriptor === null
    ? null
    : {
        descriptor,
        config,
        secretInputs: draft.secretInputs,
        secretSet: task.triggerSecretSet ?? {},
        errors: errors.fields ?? {},
        onConfigChange: state.patchConfig,
        onSecretChange: state.patchSecret,
        registerRef: state.registerFieldRef,
      }
  const canSubmit = descriptor !== null && !vendorCatalogLoading

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
          onChange={(e) => { state.patchBase('name', e.target.value) }}
        />
        {errors.name !== undefined && <span className={css.errorText} role="alert">{errors.name}</span>}
      </label>

      <KeywordField
        keywords={draft.keywords}
        input={state.keywordInput}
        error={errors.keywords}
        inputRef={state.keywordRef}
        onInputChange={state.setKeywordInput}
        onKeyDown={state.onKeywordKeyDown}
        onDrop={state.dropKeyword}
      />

      <VendorSelector
        catalog={vendorCatalog}
        catalogError={vendorCatalogError}
        loading={vendorCatalogLoading}
        method={draft.triggerMethod}
        descriptor={descriptor}
        selectRef={state.selectRef}
        onChange={state.changeTriggerMethod}
      />

      <PhotoLimitField
        value={draft.photoLimit}
        error={errors.photoLimit}
        inputRef={state.photoRef}
        onChange={(value) => { state.patchBase('photoLimit', value) }}
      />

      {ctx !== null && (
        <VendorFormBody descriptor={ctx.descriptor} ctx={ctx} savedVersion={task.triggerVendorVersion ?? ''} />
      )}

      {task.chatType === 'group' && (
        <label className={css.mentionRow}>
          <input
            type="checkbox"
            checked={draft.mentionMeOnly}
            onChange={(e) => { state.patchBase('mentionMeOnly', e.target.checked) }}
          />
          <span>
            <span className={css.mentionTitle}>仅匹配@我的文本</span>
            <span className={css.mentionHint}>只处理结构化 @ 了你本人的群消息；@所有人不算</span>
          </span>
        </label>
      )}

      {state.apiError !== null && <div className={kitCss.error} role="alert">{state.apiError}</div>}

      <FormActions
        taskName={task.name}
        taskStatus={task.status}
        busy={state.busy}
        photoLimit={draft.photoLimit}
        disabled={!canSubmit}
        onSave={() => { void submit(false) }}
        onMarkReady={() => { void submit(true) }}
        onMarkIncomplete={() => { void markIncomplete() }}
        onDelete={onDelete}
        onNotice={onNotice}
        onError={state.setApiError}
      />
    </form>
  )
}

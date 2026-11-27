/**
 * 自定义工具的编辑抽屉（2026-11-24）。
 *
 * ## 为什么表单只有两种「执行方式」
 *
 * 工具的执行体必须是代码（查库、解码、权限闸门）。前端能安全生成的只有两种模板：
 *   · **预设封装**（`alias`）—— 选一个内置工具，把若干参数固定住。它让模型拿到一个
 *     窄而正确的工具（例：「最近三个月的转账」= `search_records` 固定 `from`/`to`），
 *     而不是自己猜参数。
 *   · **固定回答**（`answer`）—— 一段本地文本（团队约定、术语表）。零 I/O、零副作用。
 *
 * 两者都不新增出网点。这条边界不是偷懒：允许界面新建「任意 HTTP 工具」，就等于允许
 * 把聊天内容发到用户随手填的地址上，而本应用的所有出网都有独立的主机白名单与隐私闸门。
 *
 * ## 为什么固定参数用「勾选 + 填值」而不是让用户写 JSON
 *
 * 模型调工具失败的多数原因就是参数形状不对；让用户手写 JSON 等于把这个坑搬到配置界面。
 * 这里按目标工具的 schema 逐行给出输入框，类型与必填都由 schema 决定。
 *
 * @module panels/local-tool-editor
 */
import { useEffect, useMemo, useState } from 'react'
import { Drawer } from '../ui/kit.tsx'
import { apiSaveLocalTool } from '../api.ts'
import type { LocalToolInput, LocalToolItem, LocalToolParam } from '@deepseek-ai/dsh-wechat-data/types'
import { suggestToolName, toolNameHint } from './local-tool-name.ts'
import kitCss from '../ui/kit.module.css'
import css from './local-tools.module.css'

/** 可被封装的内置工具（由面板从清单里挑出来传进来）。 */
export interface AliasTarget {
  name: string
  label: string
  params: readonly LocalToolParam[]
}

type Kind = 'alias' | 'answer'

/** 表单态（全部字符串，提交时再归一）。 */
interface FormState {
  name: string
  title: string
  description: string
  kind: Kind
  target: string
  answer: string
  /** 参数名 → 固定值（空串表示不固定）。 */
  fixed: Record<string, string>
}

const EMPTY: FormState = { name: '', title: '', description: '', kind: 'alias', target: '', answer: '', fixed: {} }

/** 由已有卡片还原表单（编辑用）。 */
function formOf(item: LocalToolItem): FormState {
  const kind: Kind = item.kind === 'answer' ? 'answer' : 'alias'
  const fixed: Record<string, string> = {}
  for (const [key, value] of Object.entries(item.fixed ?? {})) fixed[key] = String(value)
  return {
    name: item.callName ?? '',
    title: item.name,
    description: item.description,
    kind,
    target: item.target ?? '',
    answer: item.answer ?? '',
    fixed,
  }
}

/**
 * 固定值输入框的占位文案：按 schema 的类型说明该填什么形状。
 *
 * 这一步不是美化：布尔参数要填 `true/false`（工具里是 `=== true` 严格比较），
 * 数组参数要逗号分隔（工具里是 `Array.isArray`）—— 填错形状会被**静默忽略**，
 * 界面上完全不报错。
 * @param param - 目标工具里该参数的摘要。
 * @returns 占位文案。
 */
function fixedPlaceholder(param: LocalToolParam): string {
  if (param.type === 'boolean') return 'true 或 false'
  if (param.type === 'number' || param.type === 'integer') return '数字'
  if (param.type === 'array') return '多个值用逗号分隔'
  if (param.note !== undefined && param.note !== '') return param.note
  return '固定值'
}

/**
 * 「预设封装」那一段：选目标工具 + 逐参数勾选固定值。
 *
 * 单独成组件而不是内联在抽屉里：`LocalToolEditor` 本身已经在 250 行棘轮边缘，
 * 而这一段是纯展示 + 三个回调，搬出来不改变行为、只让主函数回到预算内。
 * @param props - 当前目标、候选列表、已固定的参数值与三个回调。
 * @returns 目标选择器 + 固定参数列表。
 */
function AliasSection({ targetName, options, target, fixed, onChangeTarget, onToggleParam, onSetFixed }: {
  targetName: string
  options: readonly AliasTarget[]
  target: AliasTarget | null
  fixed: Record<string, string>
  onChangeTarget: (value: string) => void
  onToggleParam: (name: string, on: boolean) => void
  onSetFixed: (name: string, value: string) => void
}): React.JSX.Element {
  return (
    <>
      <label className={css.field}>
        <span className={css.fieldLabel}>被封装的内置工具</span>
        <select
          className={css.input}
          value={targetName}
          aria-label="被封装的工具"
          onChange={(e) => { onChangeTarget(e.target.value) }}
        >
          <option value="">（选择工具）</option>
          {options.map((row) => (
            <option key={row.name} value={row.name}>{row.label}（{row.name}）</option>
          ))}
        </select>
      </label>

      {/* 选中的目标后来被停用/删除时，select 里仍要能看到它，否则一保存就报「目标不存在」。 */}
      {targetName !== '' && target === null && (
        <p className={css.note}>
          这个预设封装的目标工具已经不存在或被停用了；可以改选另一个工具，或先去把它启用。
        </p>
      )}

      {target !== null && (
        <div className={css.field}>
          <span className={css.fieldLabel}>固定参数（勾选后填值；至少固定一个）</span>
          <div className={css.fixedRows}>
            {target.params.map((param) => {
              const value = fixed[param.name] ?? ''
              /*
               * 「勾上」的判据是**键存在于 fixed 里**，不是「值非空」。
               * 用值反推会自我打脸：勾选时先把值置成空串（等用户填），于是 `value !== ''`
               * 立刻变回 false ⇒ 复选框永远弹回未勾选、填不了值（2026-11-24 实测）。
               */
              const on = Object.prototype.hasOwnProperty.call(fixed, param.name)
              return (
                <div key={param.name} className={css.fixedRow} data-on={on || undefined}>
                  <label className={css.fixedCheck}>
                    <input
                      type="checkbox"
                      checked={on}
                      aria-label={`固定 ${param.name}`}
                      onChange={(e) => { onToggleParam(param.name, e.target.checked) }}
                    />
                    <code>{param.name}</code>
                    <span className={kitCss.textCaption}>{param.required ? '必填' : '可选'}</span>
                  </label>
                  {on && (
                    <>
                      <input
                        className={css.input}
                        value={value}
                        placeholder={fixedPlaceholder(param)}
                        aria-label={`${param.name} 的固定值`}
                        onChange={(e) => { onSetFixed(param.name, e.target.value) }}
                      />
                      {/* 勾上但没填值：后端会把空串当成「没固定」，这里提前说清，别等保存才报错 */}
                      {value.trim() === '' && <span className={css.fieldHint} data-warn>填上值才会生效</span>}
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <span className={css.fieldHint}>
            固定住的参数不会出现在模型的参数里；其余参数照常由模型填写。若模型已无可填参数，这个工具就退化成固定调用，保存时会被拒绝。
          </span>
        </div>
      )}
    </>
  )
}

/**
 * 自定义工具编辑抽屉。
 * @param props.open - 是否打开。
 * @param props.item - 正在编辑的卡片（`null` = 新建）。
 * @param props.targets - 可被封装的检索工具。
 * @param props.onClose - 关闭。
 * @param props.onSaved - 保存成功（回带新卡片）。
 * @returns 抽屉。
 */
export function LocalToolEditor({ open, item, targets, taken = new Set(), onClose, onSaved }: {
  open: boolean
  item: LocalToolItem | null
  targets: readonly AliasTarget[]
  /** 已被占用的调用名（内置工具 + 现有自定义工具），用于自动生成与重复提示。 */
  taken?: ReadonlySet<string>
  onClose: () => void
  onSaved: (item: LocalToolItem) => void
}): React.JSX.Element {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 调用名是否由用户手改过：没改过时跟着标题自动生成（中文标题也能得到合法名）。 */
  const [nameTouched, setNameTouched] = useState(false)

  // 每次打开都重置：上一次的残值（尤其错误与固定参数）不该带进下一次。
  useEffect(() => {
    if (!open) return
    setForm(item === null ? EMPTY : formOf(item))
    setBusy(false)
    setError('')
    setNameTouched(item !== null)
  }, [open, item])

  const target = useMemo(() => targets.find((row) => row.name === form.target) ?? null, [targets, form.target])
  /**
   * 下拉里要显示的候选：当前目标**即使已被停用/删除**也要留着，否则编辑一个旧预设时
   * 下拉会显示空白，一保存就变成「目标不存在」。
   */
  const targetOptions = useMemo<readonly AliasTarget[]>(() => {
    if (form.target === '' || targets.some((row) => row.name === form.target)) return targets
    return [{ name: form.target, label: form.target, params: [] }, ...targets]
  }, [targets, form.target])
  const editing = item !== null

  /** 标题变化时，在用户没手改过调用名的情况下自动生成一个合法名。 */
  const changeTitle = (title: string): void => {
    setForm((prev) => ({
      ...prev,
      title,
      ...(nameTouched ? {} : { name: title.trim() === '' ? '' : suggestToolName(title, taken) }),
    }))
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setError('')
    const hint = toolNameHint(form.name)
    if (hint !== '') {
      setError(`${hint}。${hint.includes('自动生成') ? '' : '可点「自动生成」按钮。'}`)
      return
    }
    if (!editing && taken.has(form.name.trim())) {
      setError(`已经有一个叫「${form.name.trim()}」的工具了；改个名字，或直接编辑它`)
      return
    }
    if (form.kind === 'alias') {
      const pinned = Object.keys(form.fixed).filter((key) => (form.fixed[key] ?? '').trim() !== '')
      if (pinned.length === 0) {
        setError('至少给一个参数填上固定值（否则直接给内置工具起个别名没有意义）')
        return
      }
    }
    setBusy(true)
    try {
      const fixed: Record<string, string> = {}
      for (const [key, value] of Object.entries(form.fixed)) {
        if (value.trim() !== '') fixed[key] = value.trim()
      }
      const input: LocalToolInput = {
        // 新建时**也必须带 name**：它是模型调用时用的键，后端没有别的地方能推断出来。
        name: form.name.trim(),
        ...(editing ? {} : { isNew: true }),
        title: form.title,
        description: form.description,
        kind: form.kind,
        ...(form.kind === 'alias'
          ? { target: form.target, fixed }
          : { answer: form.answer }),
      }
      const result = await apiSaveLocalTool(input)
      if (!result.ok || result.item === undefined) {
        setError(result.error ?? '保存失败')
        return
      }
      onSaved(result.item)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={editing ? '编辑工具' : '新建工具'} width={520}>
      <div className={css.form}>
        <label className={css.field}>
          <span className={css.fieldLabel}>显示名称</span>
          <input
            className={css.input}
            value={form.title}
            placeholder="例如 最近三个月转账"
            aria-label="工具显示名称"
            onChange={(e) => { changeTitle(e.target.value) }}
          />
        </label>

        <div className={css.field}>
          <span className={css.fieldLabel}>调用名（模型按它调用，保存后不可改）</span>
          <div className={css.nameRow}>
            <input
              className={css.input}
              value={form.name}
              disabled={editing}
              placeholder="例如 recent_transfers"
              aria-label="工具调用名"
              onChange={(e) => { setNameTouched(true); setForm((prev) => ({ ...prev, name: e.target.value })) }}
            />
            {!editing && (
              <button
                type="button"
                className={css.btn}
                onClick={() => {
                  setNameTouched(false)
                  setForm((prev) => ({ ...prev, name: suggestToolName(prev.title, taken) }))
                }}
              >自动生成</button>
            )}
          </div>
          <span className={css.fieldHint} data-warn={toolNameHint(form.name) !== '' || undefined}>
            {toolNameHint(form.name) !== ''
              ? toolNameHint(form.name)
              : '小写字母开头，3–49 位小写字母/数字/下划线；不能与内置工具重名。'}
          </span>
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>说明（模型靠它决定什么时候用）</span>
          <textarea
            className={css.textarea}
            value={form.description}
            rows={3}
            placeholder="例如：需要查最近三个月的转账明细时用这个工具，时间范围已经固定，不要再传 from/to。"
            aria-label="工具说明"
            onChange={(e) => { setForm((prev) => ({ ...prev, description: e.target.value })) }}
          />
        </label>

        <div className={css.field}>
          <span className={css.fieldLabel}>执行方式</span>
          <div className={css.kindRow}>
            <button
              type="button"
              className={css.kindBtn}
              data-active={form.kind === 'alias' || undefined}
              onClick={() => { setForm((prev) => ({ ...prev, kind: 'alias' })) }}
            >
              预设封装
              <small>把内置工具固定若干参数</small>
            </button>
            <button
              type="button"
              className={css.kindBtn}
              data-active={form.kind === 'answer' || undefined}
              onClick={() => { setForm((prev) => ({ ...prev, kind: 'answer' })) }}
            >
              固定回答
              <small>一段本地文本，不查数据</small>
            </button>
          </div>
        </div>

        {form.kind === 'alias' ? (
          <AliasSection
            targetName={form.target}
            options={targetOptions}
            target={target}
            fixed={form.fixed}
            onChangeTarget={(value) => { setForm((prev) => ({ ...prev, target: value, fixed: {} })) }}
            onToggleParam={(name, on) => {
              setForm((prev) => {
                const next = { ...prev.fixed }
                if (on) next[name] = ''
                else delete next[name]
                return { ...prev, fixed: next }
              })
            }}
            onSetFixed={(name, value) => {
              setForm((prev) => ({ ...prev, fixed: { ...prev.fixed, [name]: value } }))
            }}
          />
        ) : (
          <label className={css.field}>
            <span className={css.fieldLabel}>固定回答（最多 2000 字）</span>
            <textarea
              className={css.textarea}
              value={form.answer}
              rows={5}
              placeholder="例如：本团队把「回款」定义为：客户确认已付款、但我们还没收到银行到账。"
              aria-label="固定回答"
              onChange={(e) => { setForm((prev) => ({ ...prev, answer: e.target.value })) }}
            />
          </label>
        )}

        {error !== '' && <div className={kitCss.error} role="alert">{error}</div>}

        <div className={css.formActions}>
          <button type="button" className={css.btn} onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className={css.btn} data-primary="true" onClick={() => { void submit() }} disabled={busy}>
            {busy ? '保存中…' : editing ? '保存修改' : '创建工具'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}

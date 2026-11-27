import { useEffect, useRef, useState } from 'react'
import {
  apiGetChatAiReplyDefaultWebhook,
  apiSaveChatAiReplyDefaultWebhook,
  type ChatAiReplyDefaultWebhookSaveResult,
  type ChatAiReplyDefaultWebhookState,
} from '../api-chat-ai-reply.ts'
import { runtimeCapabilities } from '../api-core.ts'
import { apiAppsSaveAiReplyWebhook, apiAppsWebhookTargets } from '../api-apps.ts'
import type { AppsWebhookTarget } from '../../../electron-api.ts'
import { Button, Drawer, ErrorState } from '../ui/kit.tsx'
import { useKbScope } from './kb-scope.ts'
import { PersonaPresetPicker } from './chat-ai-reply-persona-presets.tsx'
import css from './chat-ai-reply-settings.module.css'

export interface ChatAiReplyPersonaDraft {  name: string
  prompt: string
  splitReply: boolean
  /** 是否让知识库参与本会话的自动回复。 */
  kbEnabled: boolean
  /** 参与回复的知识库 id；`kbEnabled` 为 true 时必须大于 0。 */
  kbId: number
  /** 上下文时间窗（小时）；0 = 不限。 */
  contextWindowHours: number
  safetyHandoff: string
  safetyBlocked: string
}

const SAFETY_HANDOFF_DEFAULT = '抱歉我不太清楚，建议为您转接人工'

/**
 * 上下文时间窗的可选项：小时数 → 界面文案。
 *
 * 刻意给固定的几档而不是自由输入：这个值影响模型看到多少历史，
 * 手填「37 小时」既难解释也没有实际收益。
 */
export const CONTEXT_WINDOW_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 0, label: '不限（最近 60 条）' },
  { hours: 1, label: '最近 1 小时' },
  { hours: 3, label: '最近 3 小时' },
  { hours: 6, label: '最近 6 小时' },
  { hours: 12, label: '最近 12 小时' },
  { hours: 24, label: '最近 1 天' },
  { hours: 72, label: '最近 3 天' },
  { hours: 168, label: '最近 7 天' },
]

export interface ChatAiReplyWebhookScope {
  chatUsername: string
  chatName?: string
}

export type ChatAiReplyWebhookSaveResult = ChatAiReplyDefaultWebhookSaveResult

interface ChatAiReplyWebhookConfigInput {
  open: boolean
  chatUsername: string
  chatName: string
  initialWebhook?: ChatAiReplyDefaultWebhookState
  onLoadWebhook?: (options: ChatAiReplyWebhookScope) => Promise<ChatAiReplyDefaultWebhookState>
  onSaveWebhook?: (
    options: ChatAiReplyWebhookScope & { webhookUrl: string },
  ) => Promise<ChatAiReplyWebhookSaveResult>
  saving: boolean
}

/**
 * 默认 Webhook 的读取、校验与保存状态。
 *
 * 对话框只负责人格表单与展示；把这套异步竞态（切换会话、重复点击、脱敏回显）
 * 收在独立 hook 里，避免每次改人格都要重新审一遍 Webhook 状态机。
 */
interface WebhookPersistInput {
  /** 选中的托管实例；空串 = 用输入框里的手填地址。 */
  instanceId: string
  scope: ChatAiReplyWebhookScope
  text: string
  onSaveWebhook?: ChatAiReplyWebhookConfigInput['onSaveWebhook']
}

type WebhookPersistResult =
  | { ok: true, endpoint: string, configured: boolean, updatedAt?: number }
  | { ok: false, error: string, endpoint?: string, configured?: boolean, updatedAt?: number }

/**
 * 真正把地址写下去的两条路：托管实例（主进程解析）与手填（常规校验）。
 *
 * 拆成模块级函数有两个原因：`useChatAiReplyWebhookConfig` 已逼近单函数行数闸门；
 * 而且这段是**纯决策 + 一次调用**，与 React 状态无关，单独放更好读。
 */
async function persistWebhook(input: WebhookPersistInput): Promise<WebhookPersistResult> {
  const scope = input.scope
  if (input.instanceId !== '') {
    if (typeof window === 'undefined' || !window.electronAPI?.apps?.saveAiReplyWebhook) {
      return { ok: false, error: '当前环境不支持选择托管应用，请到电脑端操作' }
    }
    const result = await apiAppsSaveAiReplyWebhook({
      instanceId: input.instanceId,
      chatUsername: input.scope.chatUsername,
      ...(input.scope.chatName === undefined ? {} : { chatName: input.scope.chatName }),
    })
    if (!result.ok) return { ok: false, error: result.error ?? '保存默认 Webhook 失败' }
    const endpoint = maskWebhookEndpoint(
      typeof result.maskedUrl === 'string' ? result.maskedUrl : input.text,
    )
    return { ok: true, endpoint, configured: true }
  }
  const value = input.text.trim()
  if (value === '' || value.includes('***')) {
    return { ok: false, error: '请输入新的完整 Webhook 地址；留空或保留脱敏值不会覆盖已保存的 token' }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: '请输入完整的 Feather Webhook 地址' }
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || !/^\/webhook\/[^/]+\/?$/i.test(parsed.pathname)
  ) {
    return { ok: false, error: 'Webhook 必须是 Feather 的 /webhook/<token> 地址' }
  }
  const saver = input.onSaveWebhook !== undefined
    ? (webhookUrl: string) => input.onSaveWebhook!({ ...scope, webhookUrl })
    : runtimeCapabilities().isDesktop === true
      ? (webhookUrl: string) => apiSaveChatAiReplyDefaultWebhook({ ...scope, webhookUrl })
      : undefined
  if (saver === undefined) {
    return { ok: false, error: '当前环境不支持配置默认 Webhook，请到电脑端操作' }
  }
  const result = await saver(value)
  const endpoint = maskWebhookEndpoint(result.endpoint ?? value)
  const configured = result.configured !== false
  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? '默认 Webhook 保存失败',
      endpoint,
      configured,
      ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
    }
  }
  return {
    ok: true,
    endpoint,
    configured,
    ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
  }
}

function useChatAiReplyWebhookConfig(input: ChatAiReplyWebhookConfigInput): {
  webhook: ChatAiReplyDefaultWebhookState
  text: string
  dirty: boolean
  loading: boolean
  saving: boolean
  error: string | null
  canConfigure: boolean
  /** 「托管应用环境」候选实例；地址已脱敏，真实地址只在主进程里。 */
  targets: AppsWebhookTarget[]
  instanceId: string
  save: () => Promise<void>
  changeText: (value: string) => void
  focusText: (value: string) => void
  blurText: () => void
  pickInstance: (instanceId: string) => void
} {
  const [webhook, setWebhook] = useState<ChatAiReplyDefaultWebhookState>({
    configured: input.initialWebhook?.configured === true,
    endpoint: maskWebhookEndpoint(input.initialWebhook?.endpoint ?? ''),
  })
  const [text, setText] = useState(maskWebhookEndpoint(input.initialWebhook?.endpoint ?? ''))
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [targets, setTargets] = useState<AppsWebhookTarget[]>([])
  const [instanceId, setInstanceId] = useState('')
  const savingRef = useRef(false)
  const canConfigure = input.chatUsername.trim() !== ''
    && (input.onLoadWebhook !== undefined
      || input.onSaveWebhook !== undefined
      || runtimeCapabilities().isDesktop === true)

  // 托管实例清单只在弹窗打开时拉一次：关闭态不该为了一个下拉去打 IPC。
  useEffect(() => {
    if (!input.open) return
    let alive = true
    void apiAppsWebhookTargets().then((result) => {
      if (alive) setTargets(Array.isArray(result.targets) ? result.targets : [])
    })
    return () => { alive = false }
  }, [input.open])

  useEffect(() => {
    if (!input.open) return
    setError(null)
    setDirty(false)
    const supplied = input.initialWebhook
    if (supplied !== undefined) {
      const endpoint = maskWebhookEndpoint(supplied.endpoint)
      setWebhook({
        configured: supplied.configured || endpoint !== '',
        endpoint,
        ...(supplied.updatedAt === undefined ? {} : { updatedAt: supplied.updatedAt }),
      })
      setText(endpoint)
      setLoading(false)
      return
    }

    const scope: ChatAiReplyWebhookScope = {
      chatUsername: input.chatUsername.trim(),
      ...(input.chatName.trim() === '' ? {} : { chatName: input.chatName.trim() }),
    }
    if (scope.chatUsername === '') {
      setWebhook({ configured: false, endpoint: '' })
      setText('')
      setLoading(false)
      setError('缺少当前会话标识，暂时无法读取默认 Webhook')
      return
    }
    const loader = input.onLoadWebhook !== undefined
      ? () => input.onLoadWebhook!(scope)
      : runtimeCapabilities().isDesktop === true
        ? () => apiGetChatAiReplyDefaultWebhook(scope)
        : undefined
    if (loader === undefined) {
      setWebhook({ configured: false, endpoint: '' })
      setText('')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    void loader()
      .then((next) => {
        if (cancelled) return
        const endpoint = maskWebhookEndpoint(next.endpoint)
        setWebhook({
          configured: next.configured || endpoint !== '',
          endpoint,
          ...(next.updatedAt === undefined ? {} : { updatedAt: next.updatedAt }),
        })
        setText(endpoint)
        if (next.error !== undefined && next.error !== '') setError(next.error)
      })
      .catch((nextError: unknown) => {
        if (cancelled) return
        setError(nextError instanceof Error ? nextError.message : String(nextError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [
    input.open,
    input.chatUsername,
    input.chatName,
    input.initialWebhook,
    input.onLoadWebhook,
  ])

  const changeText = (value: string): void => {
    setDirty(true)
    setText(value)
    setError(null)
  }

  const focusText = (value: string): void => {
    // 脱敏值只是“已有配置”的提示；聚焦后清空，避免用户误以为可以再次提交 ***。
    if (!dirty && value.includes('***')) setText('')
  }

  const blurText = (): void => {
    if (!dirty) setText(webhook.endpoint)
  }

  /** 选择托管实例：地址框只显示脱敏值，保存时由主进程换成真实地址。 */
  const pickInstance = (nextId: string): void => {
    setInstanceId(nextId)
    setError(null)
    if (nextId === '') {
      setDirty(false)
      setText(webhook.endpoint)
      return
    }
    const hit = targets.find((item) => item.id === nextId)
    setDirty(false)
    setText(hit?.maskedUrl ?? '')
  }

  const save = async (): Promise<void> => {
    if (input.saving || savingRef.current || loading) return
    const scope: ChatAiReplyWebhookScope = {
      chatUsername: input.chatUsername.trim(),
      ...(input.chatName.trim() === '' ? {} : { chatName: input.chatName.trim() }),
    }
    if (scope.chatUsername === '') {
      setError('缺少当前会话标识，暂时无法保存默认 Webhook')
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const result = await persistWebhook({
        instanceId,
        scope,
        text,
        ...(input.onSaveWebhook === undefined ? {} : { onSaveWebhook: input.onSaveWebhook }),
      })
      if (!result.ok) {
        // 「已保存但绑定失败」这类半成功要先把地址反映到界面上，再报错。
        if (result.configured && result.endpoint !== undefined) {
          setWebhook({
            configured: true,
            endpoint: result.endpoint,
            ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
          })
          setText(result.endpoint)
          setDirty(false)
        }
        setError(result.error)
        return
      }
      setWebhook({
        configured: result.configured,
        endpoint: result.endpoint,
        ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
      })
      setText(result.endpoint)
      setDirty(false)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return {
    webhook,
    text,
    dirty,
    loading,
    saving,
    error,
    canConfigure,
    targets,
    instanceId,
    save,
    changeText,
    focusText,
    blurText,
    pickInstance,
  }
}

/**
 * 「知识库参与回复」勾选项与库选择器。
 *
 * 刻意拆成子组件：`useKbScope()` 会在挂载时读库列表，而设置弹窗在会话里是常驻
 * 挂载（只是 `open=false`）。放到子组件里并只在 `open` 时渲染，关闭状态不会多打
 * 一次 `getKbs`；勾选后若还没选库，自动落到当前知识库作用域的库。
 */
function KnowledgeBaseSection(props: {
  enabled: boolean
  kbId: number
  disabled: boolean
  onChange: (enabled: boolean, kbId: number) => void
}): React.JSX.Element {
  const { enabled, kbId, disabled, onChange } = props
  const scope = useKbScope()
  const options = scope.kbs

  useEffect(() => {
    if (!enabled || kbId > 0) return
    const first = options[0]
    if (first === undefined) return
    const fallback = options.some((kb) => kb.id === scope.kbId) ? scope.kbId : first.id
    onChange(true, fallback)
  }, [enabled, kbId, onChange, options, scope.kbId])

  return (
    <section className={css.kbSection} aria-label="知识库参与回复">
      <label className={css.kbHead}>
        <input
          className={css.kbCheck}
          type="checkbox"
          aria-label="知识库参与回复"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => { onChange(event.target.checked, kbId) }}
        />
        <span className={css.kbTitle}>知识库参与回复</span>
      </label>
      <label className={css.field}>
        <span>参与回复的知识库</span>
        <select
          className={css.select}
          aria-label="选择知识库"
          value={String(kbId)}
          disabled={disabled || !enabled}
          onChange={(event) => { onChange(enabled, Number(event.target.value)) }}
        >
          <option value="0">
            {enabled ? '请选择知识库' : '未启用'}
          </option>
          {options.map((kb) => (
            <option key={kb.id} value={String(kb.id)}>{kb.name}</option>
          ))}
          {kbId > 0 && !options.some((kb) => kb.id === kbId) && (
            <option value={String(kbId)}>知识库 #{kbId}</option>
          )}
        </select>
      </label>
      {scope.readError !== null && (
        <p className={css.hint}>知识库列表读取失败：{scope.readError}</p>
      )}
      {scope.readError === null && !scope.loading && options.length === 0 && (
        <p className={css.hint}>还没有知识库；请先到「知识库」版块新建并导入资料。</p>
      )}
    </section>
  )
}

export function ChatAiReplySettingsDialog(props: {
  open: boolean
  /** 会话稳定键；默认 Webhook 必须按当前账号下的会话读取/保存。 */
  chatUsername: string
  chatName: string
  initialName: string
  initialPrompt: string
  initialSplitReply: boolean
  initialKbEnabled: boolean
  initialKbId: number
  /** 上下文时间窗（小时）；0 = 不限。 */
  initialContextWindowHours: number
  initialHandoff: string
  initialBlocked: string
  /** 已脱敏的默认 Webhook；由外层状态传入时可避免额外一次读取。 */
  initialWebhook?: ChatAiReplyDefaultWebhookState
  /** 测试或设置宿主注入；缺省时桌面端直接读取本机 Remote。 */
  onLoadWebhook?: (options: ChatAiReplyWebhookScope) => Promise<ChatAiReplyDefaultWebhookState>
  onSaveWebhook?: (
    options: ChatAiReplyWebhookScope & { webhookUrl: string },
  ) => Promise<ChatAiReplyWebhookSaveResult>
  saving: boolean
  error?: string
  onClose: () => void
  onSave: (draft: ChatAiReplyPersonaDraft) => Promise<boolean>
}): React.JSX.Element {
  const [name, setName] = useState(props.initialName)
  const [prompt, setPrompt] = useState(props.initialPrompt)
  const [splitReply, setSplitReply] = useState(props.initialSplitReply)
  const [kbEnabled, setKbEnabled] = useState(props.initialKbEnabled)
  const [kbId, setKbId] = useState(props.initialKbId)
  const [contextWindowHours, setContextWindowHours] = useState(props.initialContextWindowHours)
  const [handoff, setHandoff] = useState(props.initialHandoff || SAFETY_HANDOFF_DEFAULT)
  const [blocked, setBlocked] = useState(props.initialBlocked)
  const [localError, setLocalError] = useState<string | null>(null)
  const webhookConfig = useChatAiReplyWebhookConfig(props)
  const busy = props.saving || webhookConfig.saving

  useEffect(() => {
    if (!props.open) return
    setName(props.initialName)
    setPrompt(props.initialPrompt)
    setSplitReply(props.initialSplitReply)
    setKbEnabled(props.initialKbEnabled)
    setKbId(props.initialKbId)
    setContextWindowHours(props.initialContextWindowHours)
    setHandoff(props.initialHandoff || SAFETY_HANDOFF_DEFAULT)
    setBlocked(props.initialBlocked)
    setLocalError(null)
  }, [
    props.open,
    props.initialName,
    props.initialPrompt,
    props.initialSplitReply,
    props.initialKbEnabled,
    props.initialKbId,
    props.initialContextWindowHours,
    props.initialHandoff,
    props.initialBlocked,
  ])

  const closeIfIdle = (): void => {
    if (!busy) props.onClose()
  }

  const changeKb = (nextEnabled: boolean, nextKbId: number): void => {
    setKbEnabled(nextEnabled)
    setKbId(Number.isSafeInteger(nextKbId) && nextKbId > 0 ? nextKbId : 0)
    setLocalError(null)
  }

  const submit = async (): Promise<void> => {
    if (kbEnabled && kbId <= 0) {
      setLocalError('请选择参与回复的知识库，或取消勾选「知识库参与回复」')
      return
    }
    const saved = await props.onSave({
      name,
      prompt,
      splitReply,
      kbEnabled,
      kbId: kbEnabled ? kbId : 0,
      contextWindowHours,
      safetyHandoff: handoff.trim() || SAFETY_HANDOFF_DEFAULT,
      safetyBlocked: blocked.trim(),
    })
    // onSave 返回时 hook 的 saving 状态可能还没完成下一帧渲染；保存成功的关闭
    // 不再二次读取 props.saving，否则会偶发“保存成功但弹窗不关”。
    if (saved) props.onClose()
  }

  return (
    <Drawer
      open={props.open}
      onClose={closeIfIdle}
      title={`AI 回复设置 · ${props.chatName || '当前会话'}`}
      width={480}
      footer={(
        <div className={css.actions}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setName('')
              setPrompt('')
            }}
          >
            恢复内置人格
          </Button>
          <span className={css.footerSpacer} />
          <Button size="sm" variant="outline" disabled={busy} onClick={closeIfIdle}>
            取消
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void submit() }}>
            {props.saving ? '保存中…' : '保存设置'}
          </Button>
        </div>
      )}
    >
      <div className={css.form}>
        <PersonaPresetPicker
          disabled={busy}
          draft={{ name, prompt }}
          onPick={(preset) => {
            setName(preset.name)
            setPrompt(preset.prompt)
            setLocalError(null)
          }}
        />
        <label className={css.field}>
          <span>人格名称</span>
          <input
            className={css.input}
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(event) => { setName(event.target.value) }}
            placeholder="留空使用内置人格"
          />
        </label>
        <label className={css.field}>
          <span>人格与回复风格</span>
          <textarea
            className={css.textarea}
            maxLength={4000}
            rows={8}
            value={prompt}
            disabled={busy}
            onChange={(event) => { setPrompt(event.target.value) }}
            placeholder="角色、语气和措辞"
          />
          <span className={css.counter}>{prompt.length} / 4000</span>
        </label>
        <label className={css.toggleRow}>
          <span className={css.toggleCopy}>
            <span className={css.toggleLabel}>长回复自动分段</span>
          </span>
          <input
            className={css.toggleInput}
            type="checkbox"
            role="switch"
            checked={splitReply}
            disabled={busy}
            onChange={(event) => { setSplitReply(event.target.checked) }}
          />
          <span className={css.toggleSwitch} aria-hidden="true" />
        </label>
        <label className={css.field}>
          <span>上下文时间窗</span>
          <select
            className={css.select}
            aria-label="上下文时间窗"
            value={String(contextWindowHours)}
            disabled={busy}
            onChange={(event) => {
              setContextWindowHours(Number(event.target.value))
              setLocalError(null)
            }}
          >
            {CONTEXT_WINDOW_OPTIONS.map((option) => (
              <option key={option.hours} value={String(option.hours)}>{option.label}</option>
            ))}
          </select>
        </label>
        <KnowledgeBaseSection
          enabled={kbEnabled}
          kbId={kbId}
          disabled={busy}
          onChange={changeKb}
        />
        <section className={css.webhookSection} aria-label="安全红线">
          <span className={css.sectionTitle}>安全红线</span>
          <div className={css.safetyLines}>
            <span>合规</span>
            <span>防注入</span>
            <span>不私自承诺</span>
            <span>不泄密</span>
            <span>不贬低同行</span>
          </div>
          <label className={css.field}>
            <span>查无资料时</span>
            <input
              className={css.input}
              maxLength={80}
              value={handoff}
              disabled={busy}
              aria-label="查无资料时的回复"
              onChange={(event) => { setHandoff(event.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span>禁说词</span>
            <input
              className={css.input}
              maxLength={400}
              value={blocked}
              disabled={busy}
              placeholder="竞品、内部词，逗号分隔"
              aria-label="禁说词"
              onChange={(event) => { setBlocked(event.target.value) }}
            />
          </label>
        </section>
        {localError !== null && <ErrorState message={localError} />}
        <WebhookSettingsSection config={webhookConfig} saving={props.saving} />
        {props.error && <ErrorState message={props.error} />}
      </div>
    </Drawer>
  )
}

/**
 * 「当前会话默认 Webhook」区块。
 *
 * 从设置弹窗本体拆出（单函数行数闸门）：它只是一段表单渲染 + 一处脱敏提示，
 * 状态全在 `useChatAiReplyWebhookConfig` 里，拆出来不改变任何行为。
 */
function WebhookSettingsSection(props: {
  config: ReturnType<typeof useChatAiReplyWebhookConfig>
  saving: boolean
}): React.JSX.Element {
  const { config, saving } = props
  const busy = config.loading || config.saving || saving
  return (
    <section className={css.webhookSection} aria-label="当前会话默认 Webhook 配置">
      <div className={css.sectionTitleRow}>
        <span className={css.sectionTitle}>当前会话默认 Webhook</span>
        <span
          className={css.webhookStatus}
          data-configured={config.webhook.configured ? 'true' : undefined}
          title={config.webhook.updatedAt === undefined
            ? undefined
            : '最近更新：' + new Date(config.webhook.updatedAt).toLocaleString('zh-CN', { hour12: false })}
        >
          {config.loading
            ? '读取中…'
            : config.webhook.configured
              ? '已配置'
              : '待配置'}
        </span>
      </div>
      <div className={css.webhookRow}>
        <input
          className={css.input}
          value={config.text}
          disabled={!config.canConfigure || busy}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="http://192.168.1.4:17890/webhook/<token>"
          onChange={(event) => { config.changeText(event.target.value) }}
          onFocus={(event) => { config.focusText(event.currentTarget.value) }}
          onBlur={config.blurText}
          aria-label="默认 Webhook 地址"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!config.canConfigure || busy}
          onClick={() => { void config.save() }}
        >
          {config.saving ? '保存中…' : '保存 Webhook'}
        </Button>
      </div>
      {!config.canConfigure && (
        <p className={css.hint}>默认 Webhook 只允许在电脑端配置。</p>
      )}
      <label className={css.field}>
        <span>托管应用环境（可选）</span>
        <select
          className={css.input}
          value={config.instanceId}
          disabled={!config.canConfigure || busy}
          onChange={(event) => { config.pickInstance(event.target.value) }}
        >
          <option value="">不使用 —— 手填上面的地址</option>
          {config.targets.map((target) => (
            <option key={target.id} value={target.id} disabled={!target.usable}>
              席位 {String(target.seat)} · {target.name} — {target.maskedUrl || '未启动'}
              {!target.enabled ? '（已停用）' : target.ready ? '' : '（未就绪）'}
            </option>
          ))}
        </select>
      </label>
      {config.error !== null && <ErrorState message={config.error} />}
    </section>
  )
}

/**
 * 只用于展示的回显脱敏。即使旧后端误把完整地址返回给渲染层，也不会在输入框里
 * 直接展示 token；真正的 token 仍只保存在本机后端。
 */
export function maskWebhookEndpoint(endpoint: string): string {
  const value = endpoint.trim()
  if (value === '') return ''
  return value
    .replace(/(\/webhook\/)([^/?#]+)/i, '$1***')
    .replace(/(\/api\/message-webhook\/)([^/?#]+)/i, '$1***')
    .replace(/([?&](?:token|key|secret)=)[^&]+/gi, '$1***')
}

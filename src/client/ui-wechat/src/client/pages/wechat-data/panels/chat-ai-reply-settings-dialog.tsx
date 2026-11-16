import { useEffect, useRef, useState } from 'react'
import {
  apiGetChatAiReplyDefaultWebhook,
  apiSaveChatAiReplyDefaultWebhook,
  type ChatAiReplyDefaultWebhookSaveResult,
  type ChatAiReplyDefaultWebhookState,
} from '../api-chat-ai-reply.ts'
import { runtimeCapabilities } from '../api-core.ts'
import { Button, Dialog, ErrorState } from '../ui/kit.tsx'
import { useKbScope } from './kb-scope.ts'
import css from './chat-ai-reply-settings.module.css'

export interface ChatAiReplyPersonaDraft {
  name: string
  prompt: string
  splitReply: boolean
  /** 是否让知识库参与本会话的自动回复。 */
  kbEnabled: boolean
  /** 参与回复的知识库 id；`kbEnabled` 为 true 时必须大于 0。 */
  kbId: number
}

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
function useChatAiReplyWebhookConfig(input: ChatAiReplyWebhookConfigInput): {
  webhook: ChatAiReplyDefaultWebhookState
  text: string
  dirty: boolean
  loading: boolean
  saving: boolean
  error: string | null
  canConfigure: boolean
  save: () => Promise<void>
  changeText: (value: string) => void
  focusText: (value: string) => void
  blurText: () => void
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
  const savingRef = useRef(false)
  const canConfigure = input.chatUsername.trim() !== ''
    && (input.onLoadWebhook !== undefined
      || input.onSaveWebhook !== undefined
      || runtimeCapabilities().isDesktop === true)

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

  const save = async (): Promise<void> => {
    if (input.saving || savingRef.current || loading) return
    const value = text.trim()
    if (value === '' || value.includes('***')) {
      setError('请输入新的完整 Webhook 地址；留空或保留脱敏值不会覆盖已保存的 token')
      return
    }
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      setError('请输入完整的 Feather Webhook 地址')
      return
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username !== ''
      || parsed.password !== ''
      || !/^\/webhook\/[^/]+\/?$/i.test(parsed.pathname)
    ) {
      setError('Webhook 必须是 Feather 的 /webhook/<token> 地址')
      return
    }
    const scope: ChatAiReplyWebhookScope = {
      chatUsername: input.chatUsername.trim(),
      ...(input.chatName.trim() === '' ? {} : { chatName: input.chatName.trim() }),
    }
    if (scope.chatUsername === '') {
      setError('缺少当前会话标识，暂时无法保存默认 Webhook')
      return
    }
    const saver = input.onSaveWebhook !== undefined
      ? (webhookUrl: string) => input.onSaveWebhook!({ ...scope, webhookUrl })
      : runtimeCapabilities().isDesktop === true
        ? (webhookUrl: string) => apiSaveChatAiReplyDefaultWebhook({ ...scope, webhookUrl })
        : undefined
    if (saver === undefined) {
      setError('当前环境不支持配置默认 Webhook，请到电脑端操作')
      return
    }

    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const result = await saver(value)
      if (!result.ok) {
        if (result.configured) {
          const endpoint = maskWebhookEndpoint(result.endpoint ?? value)
          setWebhook({
            configured: true,
            endpoint,
            ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
          })
          setText(endpoint)
          setDirty(false)
        }
        setError(result.error ?? '默认 Webhook 保存失败')
        return
      }
      const endpoint = maskWebhookEndpoint(result.endpoint ?? value)
      setWebhook({
        configured: result.configured !== false,
        endpoint,
        ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
      })
      setText(endpoint)
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
    save,
    changeText,
    focusText,
    blurText,
  }
}

/**
 * 「知识库参与回复」勾选项与库选择器。
 *
 * 刻意拆成子组件：`useKbScope()` 会在挂载时读库列表，而设置弹窗在单聊里是常驻
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
      <p className={css.hint}>
        勾选后，每轮自动回复会先用当前会话最近的对话检索所选知识库，命中片段作为
        事实依据交给模型；材料只作参考，不能覆盖安全规则。没有命中时按普通对话回复，不会编造。
      </p>
      <label className={css.field}>
        <span>参与回复的知识库</span>
        <select
          className={css.select}
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
  /** 已脱敏的默认大肥鱼 Webhook；由外层状态传入时可避免额外一次读取。 */
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
    setLocalError(null)
  }, [
    props.open,
    props.initialName,
    props.initialPrompt,
    props.initialSplitReply,
    props.initialKbEnabled,
    props.initialKbId,
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
    const saved = await props.onSave({ name, prompt, splitReply, kbEnabled, kbId: kbEnabled ? kbId : 0 })
    // onSave 返回时 hook 的 saving 状态可能还没完成下一帧渲染；保存成功的关闭
    // 不再二次读取 props.saving，否则会偶发“保存成功但弹窗不关”。
    if (saved) props.onClose()
  }

  return (
    <Dialog
      open={props.open}
      onClose={closeIfIdle}
      title="AI 回复设置"
      className={css.settingsDialog}
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
        <p className={css.hint}>
          为「{props.chatName || '当前会话'}」设置回复人格与知识库参与。人格只影响角色、
          语气和措辞；知识库材料只作事实依据。两者都不会绕过聊天正文防注入、隐私脱敏和
          回复格式等安全规则。
        </p>
        <label className={css.field}>
          <span>人格名称</span>
          <input
            className={css.input}
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(event) => { setName(event.target.value) }}
            placeholder="例如：温柔客服、专业顾问、熟人聊天"
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
            placeholder={'例如：\n· 用自然、简短的口语回复\n· 称呼对方为“你”\n· 先回应情绪，再给出下一步\n· 不确定的信息先询问，不要编造'}
          />
          <span className={css.counter}>{prompt.length} / 4000</span>
        </label>
        <label className={css.toggleRow}>
          <span className={css.toggleCopy}>
            <span className={css.toggleLabel}>长回复自动分段</span>
            <span className={css.toggleHint}>
              模型只调用一次；生成后按空行和句意拆成每段 25 个字以内，段尾只保留问号或感叹号，再通过消息列表按顺序发送。
            </span>
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
        <KnowledgeBaseSection
          enabled={kbEnabled}
          kbId={kbId}
          disabled={busy}
          onChange={changeKb}
        />
        {localError !== null && <ErrorState message={localError} />}
        <p className={css.hint}>
          两项都留空表示使用内置默认人格，名称仅用于界面标识。修改人格或知识库设置会取消
          该会话尚未完成的旧回复，只影响之后新触发的消息；建议保存后用“立即检查 AI 回复”验证一次。
        </p>
        <section className={css.webhookSection} aria-label="当前会话默认大肥鱼 Webhook 配置">
          <div className={css.sectionTitleRow}>
            <span className={css.sectionTitle}>当前会话默认大肥鱼 Webhook</span>
            <span
              className={css.webhookStatus}
              data-configured={webhookConfig.webhook.configured ? 'true' : undefined}
              title={webhookConfig.webhook.updatedAt === undefined
                ? undefined
                : '最近更新：' + new Date(webhookConfig.webhook.updatedAt).toLocaleString('zh-CN', { hour12: false })}
            >
              {webhookConfig.loading
                ? '读取中…'
                : webhookConfig.webhook.configured
                  ? '已配置'
                  : '待配置'}
            </span>
          </div>
          <p className={css.hint}>
            为当前会话保存独立地址。开启 AI 回复后，回复正文会先写入消息列表；
            没有会话级规则时使用这个默认地址投递。
            已保存的 token 只显示脱敏值，输入新地址即可替换；留空或保留脱敏值不会覆盖原 token。
          </p>
          <div className={css.webhookRow}>
            <input
              className={css.input}
              value={webhookConfig.text}
              disabled={!webhookConfig.canConfigure || webhookConfig.loading || webhookConfig.saving || props.saving}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="http://192.168.1.4:17890/webhook/<token>"
              onChange={(event) => { webhookConfig.changeText(event.target.value) }}
              onFocus={(event) => { webhookConfig.focusText(event.currentTarget.value) }}
              onBlur={webhookConfig.blurText}
              aria-label="默认大肥鱼 Webhook 地址"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!webhookConfig.canConfigure || webhookConfig.loading || webhookConfig.saving || props.saving}
              onClick={() => { void webhookConfig.save() }}
            >
              {webhookConfig.saving ? '保存中…' : '保存 Webhook'}
            </Button>
          </div>
          {!webhookConfig.canConfigure && (
            <p className={css.hint}>默认 Webhook 只允许在电脑端配置。</p>
          )}
          {webhookConfig.error !== null && <ErrorState message={webhookConfig.error} />}
        </section>
        {props.error && <ErrorState message={props.error} />}
      </div>
    </Dialog>
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

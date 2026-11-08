/**
 * AI 大模型设置。
 *
 * 页面结构刻意分成五层：
 *   1. 当前连接：只描述已经保存并生效的配置；
 *   2. 已保存配置：点击即切换；
 *   3. 对话模型编辑区：始终展开，连接凭据与模型选择分区；
 *   4. 高级能力：嵌入 / 精排默认折叠；
 *   5. 粘性保存栏：草稿状态与保存动作始终可见。
 *
 * 全应用共用 `wechat/llm.json` 这一份配置。这里不是“多套运行时并存”，
 * 配置卡切换仍是整套字段一次替换；`draftNew` 只是把当前表单另存为一条新配置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiActivateLlmProfile,
  apiDeleteLlmProfile,
  apiGetLlmProfiles,
  apiSaveLlmConfig,
  apiSaveLlmProfile,
  type WechatLlmConfig,
  type WechatLlmProfile,
} from '../api.ts'
import { AiModelAdvanced } from './ai-model-advanced.tsx'
import { AiModelEditor } from './ai-model-editor.tsx'
import { AiModelOverview } from './ai-model-overview.tsx'
import { ProfilesQuickSwitch } from './ai-model-profiles.tsx'
import { AiModelSaveBar } from './ai-model-save-bar.tsx'
import { useAiModelModels, type AiModelMessage } from './use-ai-model-models.ts'
import {
  LLM_TEMPLATES,
  configSignature,
  sameHost,
  templateKeyOf,
} from './ai-model-templates.ts'
import { useConfirm } from '../ui/confirm.tsx'
import css from './ai-model.module.css'

export function AiModelConfig(): React.JSX.Element {
  const [llmConfig, setLlmConfig] = useState<WechatLlmConfig | null>(null)
  const [savedConfig, setSavedConfig] = useState<WechatLlmConfig | null>(null)
  const [llmSaving, setLlmSaving] = useState(false)
  const [llmMsg, setLlmMsg] = useState<AiModelMessage>(null)
  const [llmKeyVisible, setLlmKeyVisible] = useState(false)
  const [profiles, setProfiles] = useState<WechatLlmProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [draftNew, setDraftNew] = useState(false)
  const confirm = useConfirm()
  const keepMsgRef = useRef(false)
  const {
    models: llmModels,
    loading: llmModelsLoading,
    source: llmModelsSource,
    fetchModels: fetchLlmModels,
  } = useAiModelModels(llmConfig, setLlmMsg, keepMsgRef)

  const dirty = useMemo(
    () => Boolean(llmConfig && (draftNew || configSignature(llmConfig) !== configSignature(savedConfig))),
    [llmConfig, savedConfig, draftNew],
  )
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId)

  const applySnapshot = useCallback((snap: {
    config: WechatLlmConfig
    profiles: WechatLlmProfile[]
    activeProfileId: string
  }): void => {
    setLlmConfig(snap.config)
    setSavedConfig(snap.config)
    setProfiles(snap.profiles)
    setActiveProfileId(snap.activeProfileId)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const snap = await apiGetLlmProfiles()
        applySnapshot(snap)
      } catch (error) {
        setLlmMsg({ kind: 'err', text: (error as Error).message })
      }
    })()
  }, [applySnapshot])

  const patchCfg = useCallback((patch: Partial<WechatLlmConfig>): void => {
    setLlmConfig((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const confirmDiscard = useCallback(async (action: string): Promise<boolean> => {
    if (!dirty) return true
    return confirm({
      title: '放弃未保存的修改？',
      message: `${action}前，编辑器里尚未保存的修改会被放弃。已保存的配置不会受影响。`,
      tone: 'danger',
      confirmText: '继续',
    })
  }, [confirm, dirty])

  const switchTo = useCallback(async (p: WechatLlmProfile): Promise<void> => {
    if (profileBusy || p.id === activeProfileId) return
    if (!(await confirmDiscard('切换配置'))) return
    setProfileBusy(true)
    keepMsgRef.current = true
    try {
      const snap = await apiActivateLlmProfile(p.id)
      applySnapshot(snap)
      setDraftNew(false)
      setLlmMsg({ kind: 'ok', text: `已切换到「${p.label}」（${p.provider} / ${p.model}），下一次提问立即生效` })
    } catch (error) {
      keepMsgRef.current = false
      setLlmMsg({ kind: 'err', text: `切换失败：${(error as Error).message}` })
    } finally {
      setProfileBusy(false)
    }
  }, [activeProfileId, applySnapshot, confirmDiscard, profileBusy])

  const startNewProfile = useCallback((): void => {
    if (!llmConfig || draftNew) return
    // 清空 Key 会触发模型上下文 effect；先保留本次“已进入新建模式”提示。
    const clearsModelContext = llmConfig.apiKey !== ''
    if (clearsModelContext) keepMsgRef.current = true
    setLlmConfig({ ...llmConfig, apiKey: '' })
    setDraftNew(true)
    setLlmMsg({ kind: 'ok', text: '已进入新建模式：填写该厂商的 API Key 后保存为新配置，不会覆盖现有配置。' })
  }, [draftNew, llmConfig])

  const cancelNewProfile = useCallback((): void => {
    if (profileBusy) return
    setDraftNew(false)
    if (savedConfig) setLlmConfig(savedConfig)
    setLlmMsg(null)
  }, [profileBusy, savedConfig])

  const removeProfile = useCallback(async (p: WechatLlmProfile): Promise<void> => {
    if (profileBusy) return
    const active = p.id === activeProfileId
    const ok = await confirm({
      title: `删除配置「${p.label}」？`,
      message: active
        ? `这是当前使用中的配置。删除后会自动切换到最近用过的一条；保存在它里面的 API Key 也会一起删掉。${dirty ? '编辑器中的未保存修改同样会丢弃。' : ''}`
        : '保存在这条配置里的 API Key 会一起删掉；其它配置不受影响。',
      tone: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    setProfileBusy(true)
    keepMsgRef.current = true
    try {
      const snap = await apiDeleteLlmProfile(p.id)
      applySnapshot(snap)
      setDraftNew(false)
      setLlmMsg({ kind: 'ok', text: `已删除「${p.label}」` })
    } catch (error) {
      keepMsgRef.current = false
      setLlmMsg({ kind: 'err', text: `删除失败：${(error as Error).message}` })
    } finally {
      setProfileBusy(false)
    }
  }, [activeProfileId, applySnapshot, confirm, dirty, profileBusy])

  const applyLlmTemplate = useCallback(async (key: string): Promise<void> => {
    if (!llmConfig) return
    const template = LLM_TEMPLATES.find((item) => item.key === key)
    if (!template) return
    const changedVendor = !sameHost(llmConfig.apiUrl, template.apiUrl)
    const next = {
      ...llmConfig,
      provider: template.provider,
      model: template.model,
      apiUrl: template.apiUrl,
      ...(changedVendor ? { apiKey: '' } : {}),
    }
    if (configSignature(next) === configSignature(llmConfig)) return
    if (!(await confirmDiscard('套用厂商模板'))) return
    keepMsgRef.current = true
    setLlmConfig(next)
    setLlmMsg({
      kind: 'ok',
      text: changedVendor
        ? `已套用「${template.label}」模板；换厂商需重新填写该家的 API Key（已清空），确认后点「${draftNew ? '保存为新配置' : '保存模型配置'}」。`
        : `已套用「${template.label}」模板（同厂商，API Key 保留），确认后点「${draftNew ? '保存为新配置' : '保存模型配置'}」。`,
    })
  }, [confirmDiscard, draftNew, llmConfig])

  const saveLlm = useCallback(async (): Promise<void> => {
    if (!llmConfig || llmSaving) return
    if (!llmConfig.apiUrl.trim() || !llmConfig.model.trim()) {
      setLlmMsg({ kind: 'err', text: '保存前请填写 API 地址与模型名。' })
      return
    }
    setLlmSaving(true)
    setLlmMsg(null)
    try {
      if (draftNew) {
        keepMsgRef.current = true
        const snap = await apiSaveLlmProfile({ config: llmConfig })
        applySnapshot(snap)
        setDraftNew(false)
        setLlmMsg({ kind: 'ok', text: `已保存为新配置并切换为使用中：${snap.config.provider} / ${snap.config.model}` })
        return
      }

      const saved = await apiSaveLlmConfig(llmConfig)
      setLlmConfig(saved)
      setSavedConfig(saved)
      try {
        const snap = await apiGetLlmProfiles()
        setProfiles(snap.profiles)
        setActiveProfileId(snap.activeProfileId)
      } catch {
        // 配置集刷新失败不影响已经成功的保存本身。
      }
      const unknownModel = Boolean(
        saved.model && llmModels.length > 0 && !llmModels.includes(saved.model),
      )
      if (unknownModel) {
        setLlmMsg({
          kind: 'err',
          text: `已保存 ${saved.provider} / ${saved.model}，但它不在已获取的模型列表中；若这是自建或中转部署可忽略。`,
        })
      } else {
        setLlmMsg({ kind: 'ok', text: `已保存模型配置：${saved.provider} / ${saved.model}` })
      }
    } catch (error) {
      setLlmMsg({ kind: 'err', text: (error as Error).message })
    } finally {
      setLlmSaving(false)
    }
  }, [applySnapshot, draftNew, llmConfig, llmModels, llmSaving])

  const discardDraft = useCallback((): void => {
    if (draftNew) {
      cancelNewProfile()
      return
    }
    if (savedConfig) setLlmConfig(savedConfig)
    setLlmMsg(null)
  }, [cancelNewProfile, draftNew, savedConfig])

  if (!llmConfig) {
    return (
      <section className={css.console} aria-label="AI 大模型">
        <div className={css.consoleLoading} role="status">正在读取模型配置…</div>
        {llmMsg?.kind === 'err' && <div className={css.consoleError} role="alert">{llmMsg.text}</div>}
      </section>
    )
  }

  return (
    <AiModelConfigView
      savedConfig={savedConfig}
      activeProfile={activeProfile}
      llmConfig={llmConfig}
      draftNew={draftNew}
      dirty={dirty}
      profiles={profiles}
      activeProfileId={activeProfileId}
      profileBusy={profileBusy}
      llmModels={llmModels}
      llmModelsLoading={llmModelsLoading}
      llmModelsSource={llmModelsSource}
      llmKeyVisible={llmKeyVisible}
      llmSaving={llmSaving}
      llmMsg={llmMsg}
      onSwitch={switchTo}
      onRemove={removeProfile}
      onStartNew={startNewProfile}
      onCancelNew={cancelNewProfile}
      onSave={saveLlm}
      onDiscard={discardDraft}
      onPatch={patchCfg}
      onApplyTemplate={applyLlmTemplate}
      onFetchModels={fetchLlmModels}
      onToggleKeyVisible={() => { setLlmKeyVisible((visible) => !visible) }}
    />
  )
}

interface AiModelConfigViewProps {
  savedConfig: WechatLlmConfig | null
  activeProfile: WechatLlmProfile | undefined
  llmConfig: WechatLlmConfig
  draftNew: boolean
  dirty: boolean
  profiles: WechatLlmProfile[]
  activeProfileId: string
  profileBusy: boolean
  llmModels: string[]
  llmModelsLoading: boolean
  llmModelsSource: 'live' | 'catalog' | null
  llmKeyVisible: boolean
  llmSaving: boolean
  llmMsg: AiModelMessage
  onSwitch: (profile: WechatLlmProfile) => Promise<void>
  onRemove: (profile: WechatLlmProfile) => Promise<void>
  onStartNew: () => void
  onCancelNew: () => void
  onSave: () => Promise<void>
  onDiscard: () => void
  onPatch: (patch: Partial<WechatLlmConfig>) => void
  onApplyTemplate: (key: string) => Promise<void>
  onFetchModels: () => Promise<void>
  onToggleKeyVisible: () => void
}

function AiModelConfigView(props: AiModelConfigViewProps): React.JSX.Element {
  const { llmConfig, dirty, draftNew } = props
  return (
    <section className={css.console} aria-label="AI 大模型">
      <AiModelOverview
        savedConfig={props.savedConfig}
        activeProfile={props.activeProfile}
        draftConfig={llmConfig}
        draftNew={draftNew}
        dirty={dirty}
      />

      <div className={css.configWorkspace}>
        <ProfilesQuickSwitch
          profiles={props.profiles}
          activeProfileId={props.activeProfileId}
          profileBusy={props.profileBusy}
          draftNew={draftNew}
          cfg={llmConfig}
          onSwitch={(profile) => { void props.onSwitch(profile) }}
          onRemove={(profile) => { void props.onRemove(profile) }}
          onStartNew={props.onStartNew}
          onCancelNew={props.onCancelNew}
        />

        <AiModelEditor
          cfg={llmConfig}
          template={templateKeyOf(llmConfig)}
          models={props.llmModels}
          modelsLoading={props.llmModelsLoading}
          modelsSource={props.llmModelsSource}
          keyVisible={props.llmKeyVisible}
          draftNew={draftNew}
          dirty={dirty}
          saveBar={(
            <AiModelSaveBar
              dirty={dirty}
              draftNew={draftNew}
              saving={props.llmSaving}
              message={props.llmMsg}
              onSave={() => { void props.onSave() }}
              onDiscard={props.onDiscard}
            />
          )}
          onPatch={props.onPatch}
          onTemplateChange={(key) => { void props.onApplyTemplate(key) }}
          onFetchModels={() => { void props.onFetchModels() }}
          onToggleKeyVisible={props.onToggleKeyVisible}
        />
      </div>

      <AiModelAdvanced cfg={llmConfig} onPatch={props.onPatch} />
    </section>
  )
}

/** 供模板清单相关测试引用。 */
export const __templates = LLM_TEMPLATES

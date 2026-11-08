import type { ReactNode } from 'react'
import type { WechatLlmConfig } from '../api.ts'
import { Select } from '../ui/kit.tsx'
import { CUSTOM_TEMPLATE_KEY, LLM_TEMPLATES } from './ai-model-templates.ts'
import css from './ai-model.module.css'
import setCss from './settings.module.css'

export interface AiModelEditorProps {
  cfg: WechatLlmConfig
  template: string
  models: string[]
  modelsLoading: boolean
  modelsSource: 'live' | 'catalog' | null
  keyVisible: boolean
  draftNew: boolean
  dirty: boolean
  /** 脏状态、反馈与保存动作组成的紧凑操作条。 */
  saveBar: ReactNode
  onPatch: (patch: Partial<WechatLlmConfig>) => void
  onTemplateChange: (key: string) => void
  onFetchModels: () => void
  onToggleKeyVisible: () => void
}

/** 对话模型主编辑器：连接凭据与模型选择分成两段，模板只负责起步。 */
export function AiModelEditor({
  cfg,
  template,
  models,
  modelsLoading,
  modelsSource,
  keyVisible,
  draftNew,
  dirty,
  saveBar,
  onPatch,
  onTemplateChange,
  onFetchModels,
  onToggleKeyVisible,
}: AiModelEditorProps): React.JSX.Element {
  const modelOptions = [
    ...(cfg.model && !models.includes(cfg.model)
      ? [{ value: cfg.model, label: `${cfg.model}（当前草稿）` }]
      : []),
    ...models.map((id) => ({ value: id, label: id })),
  ]

  return (
    <section className={css.editorCard} id="chat" data-model-panel="chat" data-llm-editor="">
      <header className={css.editorHead}>
        <div className={css.editorHeadText}>
          <span className={css.sectionKicker}>对话模型</span>
          <h2 className={css.editorTitle}>{draftNew ? '新建一套连接配置' : '编辑当前连接配置'}</h2>
          <p className={css.editorDesc}>微信问答、AI 问答、总结与推荐回复都使用这一套模型。</p>
        </div>
        <span className={css.editState} data-dirty={dirty || undefined}>
          {draftNew ? '保存后新增' : dirty ? '有未保存修改' : '与已保存一致'}
        </span>
      </header>

      {saveBar}

      <div className={css.templateBox}>
        <div className={css.templateText}>
          <span className={css.templateTitle}>从厂商模板开始</span>
          <span className={css.templateHint}>只预填供应商、模型与地址；换厂商会清空上一家的 Key。</span>
        </div>
        <div className={css.templateSelect}>
          <Select
            value={template}
            onChange={onTemplateChange}
            options={[
              ...(template === CUSTOM_TEMPLATE_KEY
                ? [{ value: CUSTOM_TEMPLATE_KEY, label: '当前配置（自定义）' }]
                : []),
              ...LLM_TEMPLATES.map((item) => ({ value: item.key, label: item.label })),
            ]}
            placeholder="选择厂商模板…"
            ariaLabel="厂商配置模板"
          />
        </div>
      </div>

      <div className={css.formSection}>
        <div className={css.formSectionHead}>
          <span className={css.formStep} aria-hidden="true">01</span>
          <div>
            <h3 className={css.formTitle}>连接与凭据</h3>
            <p className={css.formHint}>OpenAI 兼容接口。地址与 Key 只保存在本机配置中。</p>
          </div>
        </div>
        <div className={css.formGrid}>
          <label className={css.modelField}>
            <span className={setCss.rowName}>模型供应商</span>
            <input
              className={css.modelInput}
              value={cfg.provider}
              onChange={(event) => { onPatch({ provider: event.target.value }) }}
              placeholder="openai-compat / deepseek / moonshot..."
            />
          </label>
          <label className={css.modelField}>
            <span className={setCss.rowName}>API 地址（base_url）</span>
            <input
              className={css.modelInput}
              value={cfg.apiUrl}
              onChange={(event) => { onPatch({ apiUrl: event.target.value }) }}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
          </label>
          <label className={`${css.modelField} ${css.fieldWide}`}>
            <span className={setCss.rowName}>API Key</span>
            <div className={css.keyWrap}>
              <input
                className={`${css.modelInput} ${css.modelInputKey}`}
                type={keyVisible ? 'text' : 'password'}
                value={cfg.apiKey}
                onChange={(event) => { onPatch({ apiKey: event.target.value }) }}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className={css.keyEye}
                data-on={keyVisible || undefined}
                onClick={onToggleKeyVisible}
                title={keyVisible ? '隐藏 API Key' : '显示 API Key'}
                aria-label={keyVisible ? '隐藏 API Key' : '显示 API Key'}
                aria-pressed={keyVisible}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {keyVisible ? (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="m1 1 22 22" />
                      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                    </>
                  ) : (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
              </button>
            </div>
            <span className={css.fieldHint}>换厂商时会清空旧 Key，避免把 A 家凭据发到 B 家地址。</span>
          </label>
        </div>
      </div>

      <div className={css.formSection}>
        <div className={css.formSectionHead}>
          <span className={css.formStep} aria-hidden="true">02</span>
          <div>
            <h3 className={css.formTitle}>模型选择</h3>
            <p className={css.formHint}>可直接输入模型名，也可从厂商接口拉取列表后选择。</p>
          </div>
        </div>
        <div className={css.modelPicker}>
          <label className={`${css.modelField} ${css.modelPickerField}`}>
            <span className={setCss.rowName}>模型</span>
            {models.length > 0 ? (
              <Select
                value={cfg.model}
                onChange={(model) => { onPatch({ model }) }}
                options={modelOptions}
                placeholder="选择模型…"
                ariaLabel="模型选择"
              />
            ) : (
              <input
                className={css.modelInput}
                value={cfg.model}
                onChange={(event) => { onPatch({ model: event.target.value }) }}
                placeholder="如 deepseek-chat / gpt-4o-mini"
                spellCheck={false}
              />
            )}
          </label>
          <button
            type="button"
            className={css.modelGhost}
            onClick={onFetchModels}
            disabled={modelsLoading || !cfg.apiUrl}
            title="通过 base_url 拉取模型列表；未填 API Key 时展示内置参考清单"
          >
            {modelsLoading ? '拉取中…' : models.length > 0 ? '重新获取模型' : '获取可用模型'}
          </button>
        </div>
        <div className={css.modelPickerMeta} aria-live="polite">
          {models.length === 0 && '尚未拉取模型列表；手输的模型名同样会保存。'}
          {models.length > 0 && modelsSource === 'catalog' && `已加载 ${models.length} 个内置参考模型；填入 Key 后可拉取实时列表。`}
          {models.length > 0 && modelsSource !== 'catalog' && `已加载 ${models.length} 个模型。`}
        </div>
      </div>
    </section>
  )
}

/**
 * AI 大模型配置（「数据配置」页面里的一张卡片）。
 *
 * **全应用唯一的模型配置入口**：微信问答、会话内 AI 对话、每日/周期总结、
 * 稠密向量检索全都读 `wechat/llm.json` 这一份。此前同一份配置散落在四个面板
 * （问答页签的侧栏、会话 AI 的下拉、检索设置、总结页签）各配一遍、彼此不一致，
 * 这里收敛成一处：其余界面不再暴露模型选项，改模型只来这里。
 */
import { useCallback, useEffect, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { apiFetchLlmModels, apiGetLlmConfig, apiSaveLlmConfig, type WechatLlmConfig } from '../api.ts'
import { Select } from '../ui/kit.tsx'
import css from './ai-model.module.css'
import setCss from './settings.module.css'

/** 已获取的官方模型列表按 base_url 缓存在 localStorage：
 *  换厂商地址各自独立；同一地址成功后无需重复拉取（下次打开直接恢复）。
 *  缓存同时记下 API Key 指纹 —— 换 Key 等于换账号权限，旧列表不再可信。 */
const MODELS_CACHE_KEY = 'st-llm-models-v1'
/** API Key 指纹：只留长度与后 4 位，不落任何明文。 */
function keyTag(apiKey: string): string {
  const k = String(apiKey || '')
  return k ? `${k.length}:${k.slice(-4)}` : 'anon'
}
function readModelsCache(apiUrl: string, apiKey: string): string[] {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY)
    if (!raw) return []
    const map = JSON.parse(raw) as Record<string, unknown>
    const hit = map?.[apiUrl]
    // 兼容旧格式（纯数组）：没有指纹时只认匿名 Key 的会话
    if (Array.isArray(hit)) return keyTag(apiKey) === 'anon' ? hit.filter((m): m is string => typeof m === 'string') : []
    const entry = hit as { models?: unknown; tag?: unknown } | undefined
    if (!entry || entry.tag !== keyTag(apiKey)) return []
    return Array.isArray(entry.models) ? entry.models.filter((m): m is string => typeof m === 'string') : []
  } catch {
    return []
  }
}
function writeModelsCache(apiUrl: string, apiKey: string, models: string[]): void {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    map[apiUrl] = { models, tag: keyTag(apiKey) }
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(map))
  } catch {
    /* 缓存写入失败不阻塞主流程 */
  }
}

/** 厂商配置模板：连接只依赖 base_url（OpenAI 兼容，接口路径固定 /chat/completions、
 *  超时走默认值，二者不再暴露在界面），模板仅预填「供应商/模型/地址」三项；
 *  API Key 与超时保留用户当前值，绝不被模板覆盖。 */
const LLM_TEMPLATES = [
  { key: 'deepseek', label: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash', apiUrl: 'https://api.deepseek.com/v1' },
  {
    key: 'mimo',
    label: 'MiMo（小米 Token Plan）',
    provider: 'mimo',
    // 与 src/backend/llm-model-catalog.js 的同名条目保持一致：模型 id 只列已确认的
    // （mimo-v2.5）；其余预览型号的 API id 未确认，填 Key 后点「获取官方模型」按实时列表取。
    model: 'mimo-v2.5',
    apiUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  },
  { key: 'dashscope', label: '通义千问（阿里百炼）', provider: 'dashscope', model: 'qwen-plus', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'moonshot', label: 'Moonshot Kimi', provider: 'moonshot', model: 'moonshot-v1-8k', apiUrl: 'https://api.moonshot.cn/v1' },
  { key: 'siliconflow', label: '硅基流动 SiliconFlow', provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct', apiUrl: 'https://api.siliconflow.cn/v1' },
  { key: 'hunyuan', label: '腾讯混元', provider: 'hunyuan', model: 'hunyuan-lite', apiUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { key: 'qianfan', label: '百度千帆（文心）', provider: 'qianfan', model: 'ernie-4.0-turbo-8k', apiUrl: 'https://qianfan.baidubce.com/v2' },
  { key: 'openai', label: 'OpenAI 官方', provider: 'openai-compat', model: 'gpt-4o-mini', apiUrl: 'https://api.openai.com/v1' },
] as const

/** 下拉里代表「当前配置不属于任何内置模板」的那一项。只用于把选中态显示出来，不参与保存。 */
const CUSTOM_TEMPLATE_KEY = '__current__'

/**
 * Render the AI model configuration card.
 * @returns the card element tree.
 */
export function AiModelConfig(): React.JSX.Element {
  const [llmConfig, setLlmConfig] = useState<WechatLlmConfig | null>(null)
  const [llmSaving, setLlmSaving] = useState(false)
  const [llmMsg, setLlmMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 已套用的厂商模板（仅作下拉选中态展示，不参与保存）。 */
  const [llmTemplate, setLlmTemplate] = useState('')
  /** 徽标必须反映**已保存**的状态：草稿（手输或套用模板）未点保存就标「已配置」是误导。 */
  const [llmSavedModel, setLlmSavedModel] = useState('')
  /** 「获取官方模型」：拉取状态 + 模型列表（成功后按 base_url 持久化）。 */
  const [llmModels, setLlmModels] = useState<string[]>([])
  const [llmModelsLoading, setLlmModelsLoading] = useState(false)
  /** 列表来源：live=实时接口，catalog=未填 Key 时的内置参考清单（null=缓存恢复/未拉取）。 */
  const [llmModelsSource, setLlmModelsSource] = useState<'live' | 'catalog' | null>(null)
  /** API Key 明文可见开关（小眼睛）。 */
  const [llmKeyVisible, setLlmKeyVisible] = useState(false)

  /** 当前模型对应的 API 主机名（标题栏提示用）。 */
  const apiHost = (() => {
    try { return new URL(llmConfig?.apiUrl ?? '').host } catch { return '' }
  })()

  useEffect(() => {
    void apiGetLlmConfig()
      .then((cfg) => { setLlmConfig(cfg); setLlmSavedModel(cfg.model || '') })
      .catch((e) => { setLlmMsg({ kind: 'err', text: (e as Error).message }) })
  }, [])

  /**
   * 「配置模板」下拉的选中态要反映**已保存的配置**，而不是只反映「这次点过哪个模板」。
   *
   * 原先 `llmTemplate` 初值恒为 ''、只在点击时被赋值，于是配置明明是
   * deepseek-flash @ api.deepseek.com（与内置 deepseek 模板三项全同），下拉仍停在
   * 「选择厂商模板…」—— 看起来像从没配过，与卡片徽标的「已配置」自相矛盾。
   * 现在按 供应商 + 模型 + 地址 三项回填；三项都不匹配任何模板时补一项「当前配置（自定义）」，
   * 让这个下拉永远能回答「现在用的是哪一套」。
   */
  useEffect(() => {
    if (!llmConfig) return
    const hit = LLM_TEMPLATES.find(t => (
      t.provider === llmConfig.provider && t.model === llmConfig.model && t.apiUrl === llmConfig.apiUrl
    ))
    setLlmTemplate(hit ? hit.key : ((llmConfig.provider || llmConfig.apiUrl) ? CUSTOM_TEMPLATE_KEY : ''))
  }, [llmConfig])

  /** base_url 或 API Key 变化时回到该组合下缓存的模型列表（指纹不符即为空 → 回退手输）；
   *  同时清掉旧提示——换地址/换凭据等于换上下文，上一个成功/错误提示都不再适用。 */
  useEffect(() => {
    if (!llmConfig) return
    setLlmModels(readModelsCache(llmConfig.apiUrl, llmConfig.apiKey))
    setLlmModelsSource(null)
    setLlmMsg(null)
  }, [llmConfig?.apiUrl, llmConfig?.apiKey])

  /** 通过 base_url 拉取官方模型列表（主进程请求，绕开 CORS）。
   *  未填 API Key 时会命中的两条兜底路径（内置参考清单），由后端返回 source='catalog'。 */
  const fetchLlmModels = useCallback(async (): Promise<void> => {
    if (!llmConfig || llmModelsLoading) return
    setLlmModelsLoading(true)
    setLlmMsg(null)
    try {
      const r = await apiFetchLlmModels({ apiUrl: llmConfig.apiUrl, apiKey: llmConfig.apiKey })
      if (r.models.length === 0) {
        setLlmMsg({ kind: 'err', text: '已连接，但该接口未返回任何模型（可返回手输模式）' })
        setLlmModels([])
        setLlmModelsSource(null)
      } else {
        setLlmModels(r.models)
        setLlmModelsSource(r.source)
        writeModelsCache(llmConfig.apiUrl, llmConfig.apiKey, r.models)
        if (r.source === 'catalog') {
          setLlmMsg({ kind: 'ok', text: `✓ 已获取 ${r.models.length} 个模型 · ${r.note || '已改用内置清单'}；填入 API Key 后可拉取实时列表` })
        } else {
          setLlmMsg({ kind: 'ok', text: `✓ 已获取 ${r.models.length} 个官方模型，可在下方「模型」下拉中选择` })
        }
      }
    } catch (e) {
      setLlmMsg({ kind: 'err', text: '✗ 模型列表获取失败：' + (e as Error).message })
      setLlmModels(readModelsCache(llmConfig.apiUrl, llmConfig.apiKey))
      setLlmModelsSource(null)
    } finally {
      setLlmModelsLoading(false)
    }
  }, [llmConfig, llmModelsLoading])

  /** 套用厂商模板：只接管供应商/模型/地址，API Key 与超时保留用户当前值。 */
  const applyLlmTemplate = useCallback((key: string): void => {
    setLlmTemplate(key)
    const t = LLM_TEMPLATES.find(item => item.key === key)
    if (!t || !llmConfig) return
    setLlmConfig({ ...llmConfig, provider: t.provider, model: t.model, apiUrl: t.apiUrl })
    setLlmMsg({ kind: 'ok', text: `已套用「${t.label}」模板，填入 API Key 后点「保存模型配置」` })
  }, [llmConfig])

  /** 保存模型配置。保存前做一次「模型名是否在已获取的官方列表里」的软校验：
   *  不在列表里不阻断（可能是自建/中转部署），但要明确提示 —— 否则用户会带着
   *  一个厂商不认的模型名去提问，直到第一次问答才收到 HTTP 400。 */
  const saveLlm = useCallback(async (): Promise<void> => {
    if (!llmConfig || llmSaving) return
    setLlmSaving(true)
    setLlmMsg(null)
    try {
      const saved = await apiSaveLlmConfig(llmConfig)
      setLlmConfig(saved)
      setLlmSavedModel(saved.model || '')
      const unknownModel = Boolean(
        saved.model && llmModels.length > 0 && !llmModels.includes(saved.model),
      )
      if (!saved.model) {
        setLlmMsg({ kind: 'err', text: '✗ 已保存，但模型名为空 —— 问答会直接失败，请在「模型」里选一个' })
      } else if (unknownModel) {
        setLlmMsg({
          kind: 'err',
          text: `⚠ 已保存：${saved.provider} / ${saved.model}，但该名字不在已获取的 ${llmModels.length} 个官方模型里`
            + `（${llmModels.slice(0, 3).join(' / ')}${llmModels.length > 3 ? ' …' : ''}）—— 首次提问可能报「模型不存在」，请确认是否自建/中转部署`,
        })
      } else {
        setLlmMsg({ kind: 'ok', text: `✓ 已保存模型配置：${saved.provider} / ${saved.model}` })
      }
    } catch (e) {
      setLlmMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setLlmSaving(false)
    }
  }, [llmConfig, llmSaving, llmModels])

  return (
    <section className={setCss.card} aria-label="AI 大模型">
      <div className={setCss.cardHd}>
        <span className={setCss.cardIconChip} aria-hidden="true">🤖</span>
        <div className={setCss.cardTitleBox}>
          <span className={setCss.cardTitle}>AI 大模型</span>
        </div>
        <span className={setCss.cardBadge}>
          <StateDot state={llmSavedModel ? 'done' : 'warning'} />
          {llmSavedModel ? `已配置 · ${llmSavedModel}` : '未配置'}
        </span>
      </div>
      <div className={setCss.cardBody}>
        <div className={setCss.row}>
          <span className={setCss.rowNote}>
            全应用共用一份配置：微信问答、会话内 AI 对话、每日/周期总结、稠密向量检索都读这里。
          </span>
        </div>

        {!llmConfig ? (
          <div className={setCss.row}><span className={setCss.rowMeta}>读取配置中…</span></div>
        ) : (
          <>
            <div className={css.modelGrid}>
              <div className={css.modelField}>
                <span className={setCss.rowName}>配置模板（套用后仍需填 API Key）</span>
                <Select
                  value={llmTemplate}
                  onChange={applyLlmTemplate}
                  options={[
                    // 当前配置不是任何内置模板时，也要在下拉里说清楚用的是什么 —— 否则显示成空，
                    // 看起来像没配过（与「已配置」徽标矛盾）。
                    ...(llmTemplate === CUSTOM_TEMPLATE_KEY
                      ? [{ value: CUSTOM_TEMPLATE_KEY, label: '当前配置（自定义）' }]
                      : []),
                    ...LLM_TEMPLATES.map(t => ({ value: t.key, label: t.label })),
                  ]}
                  placeholder="选择厂商模板…"
                  ariaLabel="厂商配置模板"
                />
              </div>
              <label className={css.modelField}>
                <span className={setCss.rowName}>模型供应商</span>
                <input className={css.modelInput} value={llmConfig.provider} onChange={(e) => { setLlmConfig({ ...llmConfig, provider: e.target.value }) }} placeholder="openai-compat / deepseek / moonshot..." />
              </label>
              {llmModels.length > 0 ? (
                <div className={css.modelField}>
                  <span className={setCss.rowName}>
                    {llmModelsSource === 'catalog' ? '模型（内置参考清单，填 Key 可拉取实时列表）' : '模型（来自官方接口）'}
                  </span>
                  <Select
                    value={llmConfig.model}
                    onChange={(v) => { setLlmConfig({ ...llmConfig, model: v }) }}
                    options={[
                      // 已保存的模型可能不在最新列表里，补一项避免下拉显示空白
                      ...(llmConfig.model && !llmModels.includes(llmConfig.model)
                        ? [{ value: llmConfig.model, label: `${llmConfig.model}（当前）` }]
                        : []),
                      ...llmModels.map(id => ({ value: id, label: id })),
                    ]}
                    placeholder="选择模型…"
                    ariaLabel="模型选择"
                  />
                </div>
              ) : (
                <label className={css.modelField}>
                  <span className={setCss.rowName}>模型（可手输，或点「获取官方模型」）</span>
                  <input className={css.modelInput} value={llmConfig.model} onChange={(e) => { setLlmConfig({ ...llmConfig, model: e.target.value }) }} placeholder="如 deepseek-chat / gpt-4o-mini" />
                </label>
              )}
              <div className={css.modelField}>
                <span className={setCss.rowName}>API Key</span>
                <div className={css.keyWrap}>
                  <input
                    className={`${css.modelInput} ${css.modelInputKey}`}
                    type={llmKeyVisible ? 'text' : 'password'}
                    value={llmConfig.apiKey}
                    onChange={(e) => { setLlmConfig({ ...llmConfig, apiKey: e.target.value }) }}
                    placeholder="sk-..."
                  />
                  {/* 小眼睛：切换明文/密文显示。data-on 时图标换成「划掉的眼」。 */}
                  <button
                    type="button"
                    className={css.keyEye}
                    data-on={llmKeyVisible || undefined}
                    onClick={() => { setLlmKeyVisible(v => !v) }}
                    title={llmKeyVisible ? '隐藏 API Key' : '显示 API Key'}
                    aria-label={llmKeyVisible ? '隐藏 API Key' : '显示 API Key'}
                    aria-pressed={llmKeyVisible}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {llmKeyVisible ? (
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
              </div>
              <label className={css.modelField}>
                <span className={setCss.rowName}>API 地址（base_url，OpenAI 兼容）</span>
                <input className={css.modelInput} value={llmConfig.apiUrl} onChange={(e) => { setLlmConfig({ ...llmConfig, apiUrl: e.target.value }) }} placeholder="https://api.openai.com/v1" />
              </label>
              {/* 向量模型：稠密检索用（可选）。留空则复用上面的对话模型，
                  与对话模型共用同一个 base_url / API Key。 */}
              <label className={css.modelField}>
                <span className={setCss.rowName}>向量模型（可选，稠密检索用）</span>
                <input
                  className={css.modelInput}
                  value={llmConfig.embeddingModel ?? ''}
                  onChange={(e) => { setLlmConfig({ ...llmConfig, embeddingModel: e.target.value }) }}
                  placeholder="如 text-embedding-3-small / bge-m3；留空复用对话模型"
                />
              </label>
            </div>
            {/* 操作区：获取（次要/描边）在左，保存（主要/高亮）在右，等宽两列；
                状态消息整行独立展示（此前 inline 跟在按钮后面，长文案挤压排版）。 */}
            <div className={css.modelActions}>
              <button type="button" className={css.modelGhost} onClick={() => { void fetchLlmModels() }} disabled={llmModelsLoading || !llmConfig.apiUrl} title="通过 base_url 拉取模型列表；未填 API Key 时展示内置参考清单">
                {llmModelsLoading ? '拉取中…' : '获取官方模型'}
              </button>
              <button type="button" className={css.modelPrimary} onClick={() => { void saveLlm() }} disabled={llmSaving}>
                {llmSaving ? '保存中…' : '保存模型配置'}
              </button>
            </div>
            {llmMsg && (
              <div className={`${css.modelMsg} ${llmMsg.kind === 'ok' ? css.msgOk : css.msgErr}`} role="status">{llmMsg.text}</div>
            )}
            <div className={setCss.row}>
              <span className={setCss.rowNote}>
                当前模型：{llmSavedModel || '未配置'}{apiHost ? ` · ${apiHost}` : ''}
                {llmSavedModel ? '' : '（未配置时问答与总结会直接报错）'}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/** 供测试引用：模板清单。 */
export const __templates = LLM_TEMPLATES

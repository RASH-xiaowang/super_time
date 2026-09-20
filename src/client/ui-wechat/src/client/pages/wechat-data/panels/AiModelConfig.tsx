/**
 * AI 大模型配置（「数据配置」页面里的一张卡片）。
 *
 * **全应用唯一的模型配置入口**：微信问答、会话内 AI 对话、每日/周期总结、
 * 稠密向量检索全都读 `wechat/llm.json` 这一份。此前同一份配置散落在四个面板
 * （问答页签的侧栏、会话 AI 的下拉、检索设置、总结页签）各配一遍、彼此不一致，
 * 这里收敛成一处：其余界面不再暴露模型选项，改模型只来这里。
 *
 * ── 三种「列表」别再混为一谈（本卡片最容易看错的地方）────────
 *   ① **已配置模型**（本轮新增）：`profiles` —— 成套存下来的若干份配置，含各自的 API Key。
 *      顶部切换条点击即切换、立即生效。这是「切回之前配好的那家厂商」的唯一入口。
 *   ② **配置模板**：内置的 8 个厂商**空壳**（只有供应商/模型/地址，没有 Key），
 *      用来快速起一份新配置。
 *   ③ **模型**下拉：该 base_url 下**厂商官方提供**的模型名（可能上百个），只改草稿字段。
 *      它既不是「你配过的」，也不是「能直接用的」。
 *
 * ── 为什么不是「点一下下拉就切好了」────────────────────────
 * 因为切换的单位是**一份成套配置**（供应商+模型+地址+Key+向量模型），不是单个模型名。
 * 旧实现只有一份扁平配置、保存即整文件覆盖，切走就再也回不去；套模板又只改三项、
 * Key 保留旧值 → 拼出「A 家地址 + B 家 Key」，下一次提问必然 401。所以这里把
 * 「切换」做成 chips、把「Key 跟随厂商变化」做成明确规则（见 `applyLlmTemplate`）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  apiActivateLlmProfile,
  apiDeleteLlmProfile,
  apiFetchLlmModels,
  apiGetLlmProfiles,
  apiSaveLlmConfig,
  apiSaveLlmProfile,
  type WechatLlmConfig,
  type WechatLlmProfile,
} from '../api.ts'
import { Select } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
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
 *  超时走默认值，二者不再暴露在界面），模板仅预填「供应商/模型/地址」三项。 */
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

/** 两个地址是否同一家（host 相同）。用于判断「换厂商就该清空 Key」。 */
function sameHost(a: string, b: string): boolean {
  try {
    const ha = new URL(a).host
    const hb = new URL(b).host
    return Boolean(ha) && ha === hb
  } catch {
    return false
  }
}

/**
 * 从一条已保存配置里取出可编辑的扁平配置（丢掉 id/label/usedAt）。
 *
 * 三个角色的字段必须**逐个列全**：这里漏一个，编辑一条已存配置就会把它静默丢掉
 * （表单提交的是这个对象，没列出的字段回到后端就成了默认空值）。
 */
function configOf(p: WechatLlmProfile): WechatLlmConfig {
  const picked: WechatLlmConfig = {
    provider: p.provider,
    model: p.model,
    apiKey: p.apiKey,
    apiUrl: p.apiUrl,
    apiPath: p.apiPath,
    timeoutMs: p.timeoutMs,
  }
  for (const k of ['embeddingModel', 'embedPath', 'embeddingApiUrl', 'embeddingApiKey',
    'rerankModel', 'rerankPath', 'rerankApiUrl', 'rerankApiKey'] as const) {
    if (p[k] !== undefined) picked[k] = p[k]
  }
  // 超时是数值，与上面八个字符串键不同型 —— 分开写，而不是把整个循环 cast 成 any。
  if (p.rerankTimeoutMs !== undefined) picked.rerankTimeoutMs = p.rerankTimeoutMs
  return picked
}

/** 一个「标题 + 文本框」字段。三个角色的卡片共用，避免把同一段 JSX 抄三遍。 */
function RoleInput({ label, value, placeholder, onInput }: {
  label: string
  value: string
  placeholder?: string
  onInput: (v: string) => void
}): React.JSX.Element {
  return (
    <label className={css.modelField}>
      <span className={setCss.rowName}>{label}</span>
      <input className={css.modelInput} value={value} placeholder={placeholder} onChange={e => { onInput(e.target.value) }} />
    </label>
  )
}

/** 「上次使用」的相对时间：比一串时间戳更易读，也避免让人以为那是配置时间。 */
function usedText(ts: number): string {
  if (!ts) return '从未使用'
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return '今天用过'
  if (days === 1) return '昨天用过'
  return `${days} 天前用过`
}

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
  /** 已保存的模型配置集 + 使用中那条的 id。 */
  const [profiles, setProfiles] = useState<WechatLlmProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState('')
  /** 配置集操作（切换/新增/删除）进行中：这些动作都会写盘，必须单飞。 */
  const [profileBusy, setProfileBusy] = useState(false)
  /**
   * 「新增配置」草稿态。
   *
   * 为什么要有这个态：**新增**与**修改使用中的那条**是两种语义，落到后端是两条不同的路径
   * （`upsertLlmProfile` vs `saveLlmConfig`）。不区分的话，用户想「再加一家」时会不可逆地
   * 覆盖掉当前这家的配置与 Key。
   */
  const [draftNew, setDraftNew] = useState(false)
  const confirm = useConfirm()
  /** 切换配置时保留刚写下的成功提示（见下方回填模型列表的那个 effect）。 */
  const keepMsgRef = useRef(false)

  /** 当前模型对应的 API 主机名（标题栏提示用）。 */
  const apiHost = (() => {
    try { return new URL(llmConfig?.apiUrl ?? '').host } catch { return '' }
  })()

  /**
   * 首次挂载读一次快照（当前配置 + 配置集，一次读取保证两者一致。
   * 与 profiles 快照里的 `config` 合成一个来源，避免「徽标用 A、切换条用 B」）。
   */
  useEffect(() => {
    void (async () => {
      try {
        const snap = await apiGetLlmProfiles()
        setLlmConfig(snap.config)
        setLlmSavedModel(snap.config.model || '')
        setProfiles(snap.profiles)
        setActiveProfileId(snap.activeProfileId)
      } catch (e) {
        setLlmMsg({ kind: 'err', text: (e as Error).message })
      }
    })()
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
   *  同时清掉旧提示——换地址/换凭据等于换上下文，上一个成功/错误提示都不再适用。
   *  例外：切换配置时会同时改地址与 Key，那条「已切换到 X」的提示必须留着
   *  （`keepMsgRef` 由 `switchTo` 置位，一次性）。 */
  useEffect(() => {
    if (!llmConfig) return
    setLlmModels(readModelsCache(llmConfig.apiUrl, llmConfig.apiKey))
    setLlmModelsSource(null)
    if (keepMsgRef.current) keepMsgRef.current = false
    else setLlmMsg(null)
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

  /**
   * 套用厂商模板：只接管供应商/模型/地址。
   *
   * **换厂商时清空 API Key**（同厂商换模型时保留）：Key 是某一家厂商的凭据，
   * 带着 A 家的 Key 去连 B 家的地址，下一次提问必然 401，而用户从界面上看不出问题在哪。
   * 这是「套模板保留旧 Key」那套做法的直接修正 —— 它当初是为了少打字，代价却是静默的失败。
   */
  const applyLlmTemplate = useCallback((key: string): void => {
    setLlmTemplate(key)
    const t = LLM_TEMPLATES.find(item => item.key === key)
    if (!t || !llmConfig) return
    const changedVendor = !sameHost(llmConfig.apiUrl, t.apiUrl)
    setLlmConfig({
      ...llmConfig,
      provider: t.provider,
      model: t.model,
      apiUrl: t.apiUrl,
      ...(changedVendor ? { apiKey: '' } : {}),
    })
    setLlmMsg({
      kind: 'ok',
      text: changedVendor
        ? `已套用「${t.label}」模板；换厂商需重新填写该家的 API Key（已清空），填好后点「${draftNew ? '保存为新配置' : '保存模型配置'}」`
        : `已套用「${t.label}」模板（同厂商，API Key 保留），点「${draftNew ? '保存为新配置' : '保存模型配置'}」生效`,
    })
  }, [llmConfig, draftNew])

  /** 用一份快照刷新界面（切换/新增/删除后的统一收尾）。 */
  const applySnapshot = useCallback((snap: { config: WechatLlmConfig; profiles: WechatLlmProfile[]; activeProfileId: string }): void => {
    setLlmConfig(snap.config)
    setLlmSavedModel(snap.config.model || '')
    setProfiles(snap.profiles)
    setActiveProfileId(snap.activeProfileId)
  }, [])

  /**
   * 切换到另一条已保存的配置。
   *
   * 一次 IPC、一个原子写：后端把该条的成套字段摊平到顶层（成套切换），
   * 因为 wechat-host 每次请求都重读 llm.json，**下一次提问立即生效，不需要重启应用**。
   * @param p - 目标配置。
   */
  const switchTo = useCallback(async (p: WechatLlmProfile): Promise<void> => {
    if (profileBusy || p.id === activeProfileId) return
    setProfileBusy(true)
    keepMsgRef.current = true
    try {
      const snap = await apiActivateLlmProfile(p.id)
      applySnapshot(snap)
      setDraftNew(false)
      setLlmMsg({ kind: 'ok', text: `✓ 已切换到「${p.label}」（${p.provider} / ${p.model}），下一次提问立即生效` })
    } catch (e) {
      keepMsgRef.current = false
      setLlmMsg({ kind: 'err', text: '✗ 切换失败：' + (e as Error).message })
    } finally {
      setProfileBusy(false)
    }
  }, [profileBusy, activeProfileId, applySnapshot])

  /** 进入「新增配置」：以当前配置的非密钥部分为起点，清空 Key。 */
  const startNewProfile = useCallback((): void => {
    if (!llmConfig) return
    setLlmConfig({ ...llmConfig, apiKey: '' })
    setDraftNew(true)
    setLlmMsg({ kind: 'ok', text: '已进入新增模式：填好该厂商的 API Key 后点「保存为新配置」（不会覆盖现有配置）' })
  }, [llmConfig])

  /** 放弃新增，回到使用中的那条配置。 */
  const cancelNewProfile = useCallback((): void => {
    setDraftNew(false)
    const active = profiles.find(p => p.id === activeProfileId)
    if (active) setLlmConfig(configOf(active))
    setLlmMsg(null)
  }, [profiles, activeProfileId])

  /** 删除一条配置（只剩一条时后端拒绝；删掉使用中的那条会自动切到最近用过的一条）。 */
  const removeProfile = useCallback(async (p: WechatLlmProfile): Promise<void> => {
    if (profileBusy) return
    const active = p.id === activeProfileId
    const ok = await confirm({
      title: `删除配置「${p.label}」？`,
      message: active
        ? '这是当前使用中的配置。删除后会自动切换到最近用过的那一条，保存在它里面的 API Key 也会一起删掉。'
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
      setLlmMsg({ kind: 'ok', text: `✓ 已删除「${p.label}」` })
    } catch (e) {
      keepMsgRef.current = false
      setLlmMsg({ kind: 'err', text: '✗ 删除失败：' + (e as Error).message })
    } finally {
      setProfileBusy(false)
    }
  }, [profileBusy, activeProfileId, applySnapshot, confirm])

  /** 保存模型配置。
   *
   *  两条路径（这是本卡片的关键分叉）：
   *   · 新增态 → `apiSaveLlmProfile`：存成**一条新配置**并设为使用中，不动其它配置；
   *   · 编辑态 → `apiSaveLlmConfig`：更新**使用中的那一份**（后端会同步更新对应配置）。
   *
   *  保存前做一次「模型名是否在已获取的官方列表里」的软校验：不在列表里不阻断
   *  （可能是自建/中转部署），但要明确提示 —— 否则用户会带着一个厂商不认的模型名去提问，
   *  直到第一次问答才收到 HTTP 400。
   */
  const saveLlm = useCallback(async (): Promise<void> => {
    if (!llmConfig || llmSaving) return
    setLlmSaving(true)
    setLlmMsg(null)
    try {
      if (draftNew) {
        const snap = await apiSaveLlmProfile({ config: llmConfig })
        applySnapshot(snap)
        setDraftNew(false)
        setLlmMsg({ kind: 'ok', text: `✓ 已保存为新配置并切换为使用中：${snap.config.provider} / ${snap.config.model}` })
        return
      }
      const saved = await apiSaveLlmConfig(llmConfig)
      setLlmConfig(saved)
      setLlmSavedModel(saved.model || '')
      // 后端会把改动同步进「使用中的那条」配置，重新拉一次让切换条与之一致。
      try {
        const snap = await apiGetLlmProfiles()
        setProfiles(snap.profiles)
        setActiveProfileId(snap.activeProfileId)
      } catch { /* 配置集刷新失败不影响保存结果本身 */ }
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
  }, [llmConfig, llmSaving, llmModels, draftNew, applySnapshot])

  const saveLabel = draftNew ? '保存为新配置' : '保存模型配置'

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
            {/* ① 已配置模型：点击即切换。
                只显示名称与模型名，**绝不显示 API Key**（切换条是要被随手看的东西）。 */}
            <div className={css.profileBlock} data-llm-profiles="">
              <div className={css.profileHead}>
                <span className={css.profileTitle}>已配置模型</span>
                <span className={css.profileHint}>
                  {profiles.length > 1 ? '点击即切换，下一次提问立即生效' : '再配一家就会有第二颗芯片，可随时切回来'}
                </span>
                <span className={css.profileSpacer} />
                {draftNew ? (
                  <button type="button" className={css.profileAdd} data-cancel-new-profile="" disabled={profileBusy} onClick={cancelNewProfile}>
                    取消新增
                  </button>
                ) : (
                  <button type="button" className={css.profileAdd} data-add-llm-profile="" disabled={profileBusy || !llmConfig} onClick={startNewProfile}
                    title="以当前配置为起点新建一份配置；不会覆盖现有配置">
                    ＋ 新增配置
                  </button>
                )}
              </div>
              <div className={css.profileList}>
                {profiles.map((p) => {
                  const active = p.id === activeProfileId
                  return (
                    <div key={p.id} className={css.profileChip} data-active={active || undefined}>
                      <button
                        type="button"
                        className={css.profilePick}
                        data-activate-llm-profile={p.id}
                        onClick={() => { void switchTo(p) }}
                        disabled={profileBusy || active}
                        aria-current={active || undefined}
                        title={active
                          ? `当前使用中：${p.provider} / ${p.model}`
                          : `切换到「${p.label}」（${p.provider} / ${p.model}）`}
                      >
                        <span className={css.profileDot} aria-hidden="true" />
                        <span className={css.profileLabel}>{p.label}</span>
                        <span className={css.profileModel}>{p.model || '（缺模型名）'}</span>
                        <span className={css.profileState}>{active ? '使用中' : usedText(p.usedAt)}</span>
                      </button>
                      {profiles.length > 1 && (
                        <button
                          type="button"
                          className={css.profileDel}
                          data-delete-llm-profile={p.id}
                          disabled={profileBusy}
                          onClick={() => { void removeProfile(p) }}
                          title={`删除配置「${p.label}」（会一起删掉存在里面的 API Key）`}
                          aria-label={`删除配置 ${p.label}`}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )
                })}
                {profiles.length === 0 && (
                  <span className={css.profileEmpty}>还没有保存过配置：填好下方表单并保存，就会出现第一颗芯片</span>
                )}
              </div>
            </div>

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
              {/* ── 嵌入模型 ─────────────────────────────────────────────
                  地址与 Key 留空 ⇒ 复用上面语言模型那一对（同厂商是常态）；
                  自建向量服务与云端对话服务并存时才需要分开填。 */}
            </div>
            <div className={css.roleHead}>
              <span className={css.roleTitle}>嵌入模型</span>
              <span className={css.roleNote}>知识库与问答的语义索引用它。换了这个模型，各库的向量需要重建（会再次出网）。</span>
            </div>
            <div className={css.modelGrid}>
              <RoleInput
                label="向量模型（留空复用上面的对话模型）"
                value={llmConfig.embeddingModel ?? ''}
                placeholder="如 text-embedding-3-small / bge-m3"
                onInput={v => { setLlmConfig({ ...llmConfig, embeddingModel: v }) }}
              />
              <RoleInput
                label="向量端点（留空复用 API 地址）"
                value={llmConfig.embeddingApiUrl ?? ''}
                placeholder="https://embeddings.internal/v1"
                onInput={v => { setLlmConfig({ ...llmConfig, embeddingApiUrl: v }) }}
              />
              <RoleInput
                label="向量 API Key（留空复用上面的 Key）"
                value={llmConfig.embeddingApiKey ?? ''}
                placeholder="sk-..."
                onInput={v => { setLlmConfig({ ...llmConfig, embeddingApiKey: v }) }}
              />
            </div>

            {/* ── 重排序模型 ─────────────────────────────────────────────
                  **没有独立开关**：填了模型名就启用（决策 D3）。
                  剩下的关闸是全局「禁止 AI 出网」与逐文件的「参与语义检索」。 */}
            <div className={css.roleHead}>
              <span className={css.roleTitle}>重排序模型</span>
              <span className={css.roleNote}>把召回的候选按与问题的相关性精排。留空则沿用本地的加权排序，行为与现在完全一致。</span>
            </div>
            <div className={css.modelGrid}>
              <RoleInput
                label="重排序模型（填了就启用）"
                value={llmConfig.rerankModel ?? ''}
                placeholder="如 bge-reranker-v2 / cohere-rerank-3"
                onInput={v => { setLlmConfig({ ...llmConfig, rerankModel: v }) }}
              />
              <RoleInput
                label="重排序端点（留空复用 API 地址）"
                value={llmConfig.rerankApiUrl ?? ''}
                placeholder="https://rerank.internal/v1"
                onInput={v => { setLlmConfig({ ...llmConfig, rerankApiUrl: v }) }}
              />
              <RoleInput
                label="重排序 API Key（留空复用上面的 Key）"
                value={llmConfig.rerankApiKey ?? ''}
                placeholder="sk-..."
                onInput={v => { setLlmConfig({ ...llmConfig, rerankApiKey: v }) }}
              />
              <label className={css.modelField}>
                <span className={setCss.rowName}>重排序超时（毫秒）</span>
                <input
                  className={css.modelInput}
                  type="number"
                  min={1000}
                  step={1000}
                  value={llmConfig.rerankTimeoutMs ?? 20000}
                  onChange={(e) => { setLlmConfig({ ...llmConfig, rerankTimeoutMs: Number(e.target.value) || 20000 }) }}
                />
              </label>
            </div>
            {/* 操作区：获取（次要/描边）在左，保存（主要/高亮）在右，等宽两列；
                状态消息整行独立展示（此前 inline 跟在按钮后面，长文案挤压排版）。 */}
            <div className={css.modelActions}>
              <button type="button" className={css.modelGhost} onClick={() => { void fetchLlmModels() }} disabled={llmModelsLoading || !llmConfig.apiUrl} title="通过 base_url 拉取模型列表；未填 API Key 时展示内置参考清单">
                {llmModelsLoading ? '拉取中…' : '获取官方模型'}
              </button>
              <button type="button" className={css.modelPrimary} data-save-llm="" onClick={() => { void saveLlm() }} disabled={llmSaving}>
                {llmSaving ? '保存中…' : saveLabel}
              </button>
            </div>
            {llmMsg && (
              <div className={`${css.modelMsg} ${llmMsg.kind === 'ok' ? css.msgOk : css.msgErr}`} role="status">{llmMsg.text}</div>
            )}
            <div className={setCss.row}>
              <span className={setCss.rowNote}>
                当前模型：{llmSavedModel || '未配置'}{apiHost ? ` · ${apiHost}` : ''}
                {draftNew ? '（正在新增，尚未保存）' : ''}
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

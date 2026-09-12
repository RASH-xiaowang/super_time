/**
 * 微信问答面板 — 基于本机聊天记录检索 + DSH LLM 生成回答，引用可点击跳转。
 * 检索在本机完成；AI 生成会调用当前配置的模型（出网提示见界面）。
 *
 * ── 界面结构（本轮整体重排）──────────────────────────────
 *  askLayout（横向两栏，永远是「并排」而不是「覆盖」）
 *   ├─ askPage
 *   │  ① 面板头（固定）   标题 / 说明 / 清空对话
 *   │  ② 检索上下文条（固定） 语料状态 · 会话范围 · 时间范围 · 回答模型
 *   │  ③ 对话区（滚动）   多轮问答；空态为一张引导卡，内容贴底生长
 *   │  ④ 提问区（固定）   输入框 + 发送（同一个面）+ 次要动作行
 *   │  ⑤ 隐私说明（固定） 12px 次级小字
 *   └─ modelPanel
 *      模型配置（仅在打开时渲染，占据自己的车道）
 *
 * 与上一版的关键差别：
 *  ① 把「会话/时间/模型」三个限定条件从输入框内部提到输入框**上方**的上下文条 ——
 *     输入框只负责输入与发送（三层挤 158px → 两层），限定条件常驻可见、随时可改。
 *  ② 模型配置从 `position: fixed` 的覆盖式抽屉改成**面板内的实体侧栏**：
 *     任何窗口宽度下都不遮挡顶部栏、输入框、发送键或任何对话内容
 *     （旧实现 <1100px 时用覆盖式，实测把发送键整块盖住、点击被抽屉体截获）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiAskWechat, apiFetchLlmModels, apiGetLlmConfig, apiGetSessions, apiOptimizeAskQuestion, apiSaveLlmConfig, type WechatLlmConfig } from '../api.ts'
import type { AskOptimizeResult, AskResult, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, PanelHeader, Select } from '../ui/kit.tsx'
import css from './ask.module.css'
import kitCss from '../ui/kit.module.css'

/** 空态示例问题：点一下即填入输入框并聚焦。 */
const EXAMPLES = [
  '上周三我和李四聊了什么？',
  '谁答应过我下周交报告？',
  '最近一次转账给我的是谁？',
]

/** 空态能力行：三条一句话说明「这个面板能做什么 / 边界在哪」，
 *  让首次进入的空白区承载信息而不是纯留白。 */
const CAPABILITIES = ['本机检索，不出网', '引用可跳转原文', '支持多轮追问']

/** 时间 chip 上的短日期显示：2026-09-11 → 09/11。 */
function fmtShortDate(d: string): string {
  return d.length >= 10 ? d.slice(5).replace('-', '/') : d
}

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
  { key: 'dashscope', label: '通义千问（阿里百炼）', provider: 'dashscope', model: 'qwen-plus', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'moonshot', label: 'Moonshot Kimi', provider: 'moonshot', model: 'moonshot-v1-8k', apiUrl: 'https://api.moonshot.cn/v1' },
  { key: 'siliconflow', label: '硅基流动 SiliconFlow', provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct', apiUrl: 'https://api.siliconflow.cn/v1' },
  { key: 'hunyuan', label: '腾讯混元', provider: 'hunyuan', model: 'hunyuan-lite', apiUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { key: 'qianfan', label: '百度千帆（文心）', provider: 'qianfan', model: 'ernie-4.0-turbo-8k', apiUrl: 'https://qianfan.baidubce.com/v2' },
  { key: 'openai', label: 'OpenAI 官方', provider: 'openai-compat', model: 'gpt-4o-mini', apiUrl: 'https://api.openai.com/v1' },
] as const

/** 上下文条上的统一领标图标：三种限定条件用同一套 13px 线性图标，
 *  不再各用一个约定（会话曾是 ○ 伪元素、时间是时钟、模型是字母圆牌）。 */
function ScopeIcon({ kind }: { kind: 'corpus' | 'time' | 'model' }): React.JSX.Element {
  const common = {
    className: css.ctxIcon, viewBox: '0 0 24 24', width: 13, height: 13,
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  }
  if (kind === 'corpus') {
    return (
      <svg {...common}>
        <path d="M12 3 2 8l10 5 10-5-10-5Z" />
        <path d="m2 16 10 5 10-5" />
        <path d="m2 12 10 5 10-5" />
      </svg>
    )
  }
  if (kind === 'time') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
    </svg>
  )
}

/** 检索规划元信息行：默认收起只显示意图 + 已识别的限定条件，点击展开检索词。 */
function PlanLine({ plan }: { plan?: AskResult['plan'] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!plan || (!plan.intent && plan.subQueries.length === 0)) return null
  const hasQueries = plan.subQueries.length > 0
  // 规划器识别出的时间/人物线索直接平铺 —— 这是「系统有没有听懂我要问什么」的唯一证据，
  // 收在展开区里等于没有（用户只会在答案不对时才想起来看它）。
  const when = plan.from || plan.to
    ? `${plan.from ? fmtShortDate(plan.from) : '…'}${plan.to && plan.to !== plan.from ? '→' + fmtShortDate(plan.to) : ''}`
    : ''
  return (
    <button
      type="button"
      className={css.planLine}
      data-open={open || undefined}
      onClick={() => { setOpen(v => !v) }}
      disabled={!hasQueries}
      aria-expanded={hasQueries ? open : undefined}
      title={hasQueries ? (open ? '收起检索词' : '展开检索词') : undefined}
    >
      <svg className={css.planChevron} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      <span className={css.planIntent}>意图：{plan.intent || '—'}</span>
      {when && <span className={css.planChip}>时间 {when}</span>}
      {plan.person && <span className={css.planChip}>对象 {plan.person}</span>}
      {open && hasQueries && <span className={css.planQueries}>检索词：{plan.subQueries.join(' / ')}</span>}
    </button>
  )
}

/** 引用来源：2 列网格 + 默认折叠前 4 条（20 条平铺会吞没整屏）。
 *  回答正文里真正引用过的来源会高亮标记 —— 否则「来源 20 条」里哪些被用到了
 *  只能靠用户在答案里逐个对 [n]，等于没标。 */
function CiteList({ items, cited, onOpen }: {
  items: NonNullable<AskResult['citations']>
  cited?: number[]
  onOpen?: (username: string, localId?: number) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const CAP = 4
  const shown = expanded ? items : items.slice(0, CAP)
  const citedSet = new Set(cited ?? [])
  return (
    <div className={css.citeBlock}>
      <div className={css.citeHead}>
        <span className={css.citeHeadTitle}>
          来源 · {items.length} 条{citedSet.size > 0 ? `（回答引用了 ${citedSet.size} 条，已高亮）` : ''}（点击跳转原文）
        </span>
        {items.length > CAP && (
          <button type="button" className={css.citeMore} onClick={() => { setExpanded(v => !v) }}>
            {expanded ? '收起' : `展开全部 ${items.length} 条`}
          </button>
        )}
      </div>
      <div className={css.citeGrid}>
        {shown.map((c, ci) => (
          <button
            key={`${c.username}:${c.local_id}:${ci}`}
            type="button"
            className={css.citeBtn}
            data-cited={citedSet.has(ci + 1) || undefined}
            onClick={() => { onOpen?.(c.username, c.local_id) }}
            title={`${c.sender ? `${c.name} · ${c.sender}` : c.name} · ${c.time} · ${c.snippet}`}
          >
            <span className={css.citeIdx}>[{ci + 1}]</span>
            <span className={css.citeName}>{c.sender ? `${c.name} · ${c.sender}` : c.name}</span>
            <span className={css.citeTime}>{c.time}</span>
            <span className={css.citeSnippet}>{c.snippet}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Render the WeChat Q&A panel.
 * @param props - optional chat navigation callback.
 * @returns the ask panel element tree.
 */
export function AskPanel({ onOpenChat }: { onOpenChat?: (username: string, localId?: number) => void } = {}): React.JSX.Element {
  const [sessions, setSessions] = useState<readonly WechatSession[]>([])
  /** 会话列表是否已拉取过：用于区分「还没查」与「确实没有可检索会话」。 */
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [scopeUsername, setScopeUsername] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [question, setQuestion] = useState('')
  /** 多轮对话：所有轮次的问答列表（user/assistant 交替），替代原来的单条 result。 */
  const [turns, setTurns] = useState<Array<{
    role: 'user' | 'assistant'
    text: string
    citations?: AskResult['citations']
    plan?: AskResult['plan']
    /** 回答正文里真正引用到的来源序号（1 基）。 */
    citedIndexes?: number[]
  }>>([])
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [llmConfig, setLlmConfig] = useState<WechatLlmConfig | null>(null)
  const [llmSaving, setLlmSaving] = useState(false)
  const [llmMsg, setLlmMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 已套用的厂商模板（仅作下拉选中态展示，不参与保存）。 */
  const [llmTemplate, setLlmTemplate] = useState('')
  /** 右上角「已配置/未配置」徽标必须反映**已保存**的状态：
   *  草稿（手输或套用模板）未点保存就标「已配置」是误导。 */
  const [llmSavedModel, setLlmSavedModel] = useState('')
  /** 「获取官方模型」：拉取状态 + 模型列表（成功后按 base_url 持久化）。 */
  const [llmModels, setLlmModels] = useState<string[]>([])
  const [llmModelsLoading, setLlmModelsLoading] = useState(false)
  /** 列表来源：live=实时接口，catalog=未填 Key 时的内置参考清单（null=缓存恢复/未拉取）。 */
  const [llmModelsSource, setLlmModelsSource] = useState<'live' | 'catalog' | null>(null)
  /** API Key 明文可见开关（小眼睛）。 */
  const [llmKeyVisible, setLlmKeyVisible] = useState(false)
  /** 模型配置侧栏：默认隐藏；点击上下文条的模型 chip 展开，占据面板右侧独立车道（非覆盖）。
   *  ≤900px 放不下两栏时改为「整栏对换」——配置占满面板宽度、对话暂时让位，
   *  由面板内的「返回对话」显式切回，同样不会盖住任何东西。 */
  const [modelOpen, setModelOpen] = useState(false)
  /** 侧栏与触发 chip 的引用（用于「点击外部收起」判定）。 */
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  /** 提问优化：加载态 + 结果（优化后的问题与建议）+ 错误。 */
  const [optLoading, setOptLoading] = useState(false)
  const [optResult, setOptResult] = useState<AskOptimizeResult | null>(null)
  const [optError, setOptError] = useState<string | null>(null)
  /** 流式回答：生成中的**全文**（后端按 80ms 节流推送，渲染端整体替换）。 */
  const [streamText, setStreamText] = useState('')
  /** 当前这一轮的流式标识：只有 id 匹配的增量才采纳（避免上一轮的迟到事件串进新一轮）。 */
  const streamIdRef = useRef('')
  /** 时间范围面板展开态（上下文条「时间」chip 切换；默认收起）。 */
  const [timeOpen, setTimeOpen] = useState(false)
  /** 输入框随内容自动增高（超上限后内部滚动）。 */
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [question])

  /** 正文滚动容器 + 「贴近底部」跟踪：仅当用户停在底部附近时才自动滚到最新消息。 */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = (): void => { atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [])
  /** 新内容到达：提问中必滚（用户想看结果）；回答到达时若在底部附近才滚（尊重向上翻阅）。 */
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (asking || atBottomRef.current) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }
  }, [turns, asking])

  /** 模型配置侧栏开着时：Esc / 点击外部收起。
   *  「外部」= 侧栏与触发 chip 之外；Radix 下拉（模板/模型选择）挂在 body 的 portal 里，不算外部。
   *  点「可交互元素」豁免：点输入框/按钮应直接操作，不因 mousedown 引起的回流让本次 click 丢失。
   *  点空白背景 = 明确的收起意图 → 收起。 */
  useEffect(() => {
    if (!modelOpen) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setModelOpen(false) }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (!t) return
      if (drawerRef.current?.contains(t) || chipRef.current?.contains(t)) return
      if (t instanceof Element && t.closest('[role="listbox"],[role="option"],[data-radix-popper-content-wrapper]')) return
      if (t instanceof Element && t.closest('button, input, textarea, select, a, [role="button"], [contenteditable]')) return
      setModelOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [modelOpen])

  /** 当前模型 chip 上显示的 API 主机名。 */
  const apiHost = (() => {
    try { return new URL(llmConfig?.apiUrl ?? '').host } catch { return '' }
  })()

  /** 提问优化：调后端 LLM 改写问题 + 给改进建议（结果内联展示，不弹窗）。 */
  const optimizeQuestion = useCallback(async (): Promise<void> => {
    const q = question.trim()
    if (!q || optLoading) return
    setOptLoading(true)
    setOptError(null)
    setOptResult(null)
    try {
      const history = turns.map(t => ({ role: t.role, content: t.text }))
      const r = await apiOptimizeAskQuestion({
        question: q,
        ...(scopeUsername ? { username: scopeUsername } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(history.length > 0 ? { history } : {}),
      })
      setOptResult(r)
    } catch (e) {
      setOptError('优化失败：' + (e as Error).message)
    } finally {
      setOptLoading(false)
    }
  }, [question, optLoading, turns, scopeUsername, from, to])

  useEffect(() => {
    void apiGetLlmConfig()
      .then((cfg) => { setLlmConfig(cfg); setLlmSavedModel(cfg.model || '') })
      .catch((e) => { setLlmMsg({ kind: 'err', text: (e as Error).message }) })
  }, [])

  /** 流式回答增量：后端把「已生成的全文」按 80ms 节流推过来，这里整体替换。
   *  只采纳当前 streamId 的事件；事件在拿到最终结果后失效。 */
  useEffect(() => {
    const onDelta = (e: Event): void => {
      const d = (e as CustomEvent).detail as { id?: string; text?: string } | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.text === 'string') setStreamText(d.text)
    }
    window.addEventListener('dsh-wechat-ask-delta', onDelta)
    return () => { window.removeEventListener('dsh-wechat-ask-delta', onDelta) }
  }, [])

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

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const env = await apiGetSessions({ limit: 500 })
      setSessions(env.sessions)
    } catch {
      /* 会话列表加载失败不阻塞提问 */
    } finally {
      setSessionsLoaded(true)
    }
  }, [])

  /** 进入面板即拉一次会话列表（api 侧带 30s 快照缓存，重复进入不会重复查询）：
   *  上下文条的「N 个会话可检索」与空态说明都基于它 —— 只有真拉过才不会
   *  在数据已导入时错报「0 个会话可检索」。 */
  useEffect(() => { void loadSessions() }, [loadSessions])

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

  const ask = useCallback(async (): Promise<void> => {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setError(null)
    setStreamText('')
    // 每轮一个流式标识：后端只推这个 id 的增量，上一轮的迟到事件不会被采纳。
    const streamId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    streamIdRef.current = streamId
    // 多轮：把此前轮次作为 history 带上（后端截取最近 8 轮）。
    const history = turns.map(t => ({ role: t.role, content: t.text }))
    setTurns(prev => [...prev, { role: 'user', text: q }])
    setQuestion('')
    try {
      const r = await apiAskWechat({
        question: q,
        streamId,
        ...(scopeUsername ? { username: scopeUsername } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(history.length > 0 ? { history } : {}),
      })
      setTurns(prev => [...prev, {
        role: 'assistant',
        text: r.answer,
        citations: r.citations,
        plan: r.plan,
        citedIndexes: r.citedIndexes,
      }])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      // 先作废流式标识再清缓冲：迟到的增量不会再写进 state
      streamIdRef.current = ''
      setStreamText('')
      setAsking(false)
    }
  }, [question, asking, scopeUsername, from, to, turns])

  /** 清空对话与草稿（原「清空」按钮移至面板头）。 */
  const clearConversation = useCallback((): void => {
    setQuestion('')
    setTurns([])
    setError(null)
    setOptResult(null)
    setOptError(null)
  }, [])

  const userTurnCount = turns.filter(t => t.role === 'user').length
  const hasScope = Boolean(scopeUsername || from || to)
  const noCorpus = sessionsLoaded && sessions.length === 0

  return (
    <div className={kitCss.panelShell}>
      {/* 两栏布局：对话栏 + （按需）模型配置栏。两栏都是常规流内元素 ——
          没有 fixed / z-index / 遮罩，因此不存在「谁盖住谁」的可能。 */}
      <div className={css.askLayout} data-model-open={modelOpen || undefined}>
      <div className={css.askPage}>
      <PanelHeader
        title="微信问答"
        desc="本机检索 · AI 综合回答 · 点击引用跳转原文"
        actions={(
          <>
            <Badge tone={noCorpus ? 'amber' : 'cyan'}>
              {!sessionsLoaded ? '会话载入中…' : noCorpus ? '无可检索会话' : `${sessions.length} 个会话可检索`}
            </Badge>
            {userTurnCount > 0 && (
              <button type="button" className={css.headerClear} onClick={clearConversation} title="清空全部对话轮次">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                清空对话
              </button>
            )}
          </>
        )}
      />

      {/* ② 检索上下文条：左侧「检索什么语料」（会话 + 时间），右侧「谁来回答」（模型）。
          三个限定条件同形态（统一 32/40px pill、统一线性图标、统一描边），
          离开输入框后不再与发送动作争夺视觉重心。 */}
      <div className={css.contextBar}>
        <span className={css.ctxLabel}>范围</span>
        <div className={css.scopeHost} data-set={scopeUsername ? '' : undefined}>
          <ScopeIcon kind="corpus" />
          <Select
            value={scopeUsername}
            onChange={(v) => { setScopeUsername(v) }}
            options={[{ value: '', label: '全部会话' }, ...sessions.map(s => ({ value: s.username, label: s.displayName || s.username }))]}
            onOpen={() => { void loadSessions() }}
            placeholder="全部会话"
            ariaLabel="会话范围"
          />
        </div>
        <button
          type="button"
          className={css.ctxChip}
          data-open={timeOpen || undefined}
          data-set={from || to ? '' : undefined}
          onClick={() => { setTimeOpen(v => !v) }}
          aria-expanded={timeOpen}
          title="限定检索的时间范围"
        >
          <ScopeIcon kind="time" />
          {from || to ? `${from ? fmtShortDate(from) : '…'} → ${to ? fmtShortDate(to) : '…'}` : '全部时间'}
          <span className={css.ctxCaret} aria-hidden="true">▾</span>
        </button>
        {(from || to) && (
          <button
            type="button"
            className={css.ctxClear}
            onClick={() => { setFrom(''); setTo(''); setTimeOpen(false) }}
            title="清除时间范围"
            aria-label="清除时间范围"
          >
            清除
          </button>
        )}
        <span className={css.ctxSpacer} />
        {hasScope && <span className={css.ctxHint} title="当前回答只基于以上范围内的聊天片段">已限定范围</span>}
        <button
          type="button"
          ref={chipRef}
          className={css.ctxChip}
          data-open={modelOpen || undefined}
          data-unset={llmSavedModel ? undefined : ''}
          onClick={() => { setModelOpen(v => !v) }}
          aria-expanded={modelOpen}
          title={llmSavedModel ? `当前模型：${llmSavedModel}${apiHost ? ` · ${apiHost}` : ''}（点击查看/切换）` : '尚未配置模型（点击展开填写）'}
        >
          <ScopeIcon kind="model" />
          <span className={css.ctxChipName}>{llmSavedModel || '未配置模型'}</span>
          <span className={css.ctxCaret} aria-hidden="true">▾</span>
        </button>
      </div>
      {timeOpen && (
        <div className={css.scopePanel}>
          <span className={css.timePanelLabel}>时间范围</span>
          <label className={css.timeField} htmlFor="ask-from">
            <span className={css.dateLabel}>从</span>
            <input id="ask-from" className={css.input} type="date" value={from} onChange={(e) => { setFrom(e.target.value) }} />
          </label>
          <span className={css.dateSep} aria-hidden="true">→</span>
          <label className={css.timeField} htmlFor="ask-to">
            <span className={css.dateLabel}>到</span>
            <input id="ask-to" className={css.input} type="date" value={to} onChange={(e) => { setTo(e.target.value) }} />
          </label>
          {(from || to) && (
            <button type="button" className={css.timeClear} onClick={() => { setFrom(''); setTo('') }}>清除</button>
          )}
        </div>
      )}

      {/* ③ 对话区：唯一滚动容器。内容一律贴底生长（聊天契约）：
          内容不足时由 .askStack 的 margin-top:auto 把整块推到输入框上方，
          超出时 auto 归零、从顶部开始正常滚动。 */}
      <div className={`${kitCss.panelBody} ${css.askBody}`} ref={bodyRef}>
        <div className={css.askMain}>
        <div className={css.askStack}>
          {/* 空态：一张引导卡（图标 + 标题 + 说明 + 示例），示例就在输入框上方，
              点一下即填入并聚焦输入框 —— 不再把引导拆到正文中央、示例另置一处。 */}
          {userTurnCount === 0 && !asking && (
            <div className={css.emptyIntro}>
              <div className={css.emptyIcon} aria-hidden="true">✦</div>
              <div className={css.emptyTitle}>向你的聊天记录提问</div>
              <div className={css.emptySub} data-warn={noCorpus || undefined}>
                {noCorpus
                  ? '尚未检测到可检索的会话：请先在「数据配置」中设置数据目录并导入解密库'
                  : `${sessions.length} 个会话可检索 · 回答会附上可点击跳转的本机来源`}
              </div>
              <div className={css.emptyCaps}>
                {CAPABILITIES.map(cap => (
                  <span key={cap} className={css.emptyCap}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="m8.5 12.5 2.4 2.4L15.5 9.5" />
                    </svg>
                    {cap}
                  </span>
                ))}
              </div>
              <div className={css.emptyExHead}>试试这样问</div>
              <div className={css.emptyExGrid}>
                {EXAMPLES.map(ex => (
                  <button
                    key={ex}
                    type="button"
                    className={css.emptyExCard}
                    onClick={() => { setQuestion(ex); setError(null); taRef.current?.focus() }}
                  >
                    <span className={css.emptyExIcon} aria-hidden="true">↗</span>
                    <span className={css.emptyExText}>{ex}</span>
                  </button>
                ))}
              </div>
              <div className={css.emptyHint}>点一张卡片直接填入，或在下方的输入框里自己写</div>
            </div>
          )}
          {/* 消息流：无卡片框 —— 对话即主体内容（用户气泡右对齐 / AI 回答左对齐 + 来源） */}
          {turns.length > 0 && (
            <div className={css.thread}>
              {turns.map((t, i) => (
                t.role === 'user' ? (
                  <div key={i} className={css.chatUser}>
                    <div className={css.chatUserBubble}>{t.text}</div>
                  </div>
                ) : (
                  <div key={i} className={css.chatAi}>
                    <PlanLine plan={t.plan} />
                    <div className={css.chatAnswer}>{t.text}</div>
                    {(t.citations?.length ?? 0) > 0 && (
                      <CiteList items={t.citations!} cited={t.citedIndexes} onOpen={onOpenChat} />
                    )}
                  </div>
                )
              ))}
              {asking && (
                streamText
                  // 流式：已经有增量了就直接展示正在生成的正文（尾部光标表示「还在写」），
                  // 不再显示「正在分析…」——那句话在这时已经过时了。
                  ? (
                    <div className={css.chatAi}>
                      <div className={css.chatAnswer} data-streaming>
                        {streamText}
                        <span className={css.streamCaret} aria-hidden="true" />
                      </div>
                    </div>
                  )
                  : (
                    <div className={css.chatPending}>
                      <span className={css.chatDots} />
                      正在分析问题意图 → 检索本机记录 → 综合生成回答…
                    </div>
                  )
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {/* ④ 提问区：错误 → 优化建议 → 输入面。三者都属于「本次输入」的上下文，
          紧贴输入框上方，不进入滚动区。 */}
      {error && <div className={`${kitCss.error} ${css.askError}`} role="alert">{error}</div>}
      {optResult && (
        <div className={css.optStrip} role="status">
          <div className={css.optTitle}>优化后的问题</div>
          <div className={css.optText}>{optResult.optimized}</div>
          {optResult.suggestions.length > 0 && (
            <>
              <div className={css.optTitle}>改进建议</div>
              <ul className={css.optList}>
                {optResult.suggestions.map((s, i) => (<li key={i}>{s}</li>))}
              </ul>
            </>
          )}
          <div className={css.optActions}>
            <button type="button" className={css.optApply} onClick={() => { setQuestion(optResult.optimized); setOptResult(null) }}>采用优化</button>
            <button type="button" className={css.optDismiss} onClick={() => { setOptResult(null) }}>忽略</button>
          </div>
        </div>
      )}
      {optError && <div className={css.optError} role="alert">{optError}</div>}

      <div className={css.composer}>
        <div className={css.inputRow}>
          <textarea
            ref={taRef}
            className={css.composerInput}
            value={question}
            onChange={(e) => { setQuestion(e.target.value) }}
            onKeyDown={(e) => {
              // Enter 发送、Shift+Enter 换行；输入法组字期间不拦截（中文候选确认用）。
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void ask()
              }
            }}
            placeholder="今天想从聊天记录里查点什么？"
            rows={1}
            aria-label="微信问答问题"
          />
          <button
            type="button"
            className={css.send}
            data-busy={asking || undefined}
            disabled={!question.trim() || asking}
            onClick={() => { void ask() }}
            aria-label="提问"
            title="提问（Enter 发送，Shift+Enter 换行）"
          >
            {asking ? (
              <span className={css.sendSpinner} aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            )}
          </button>
        </div>
        <div className={css.composerFooter}>
          <button
            type="button"
            className={css.optBtn}
            onClick={() => { void optimizeQuestion() }}
            disabled={optLoading || !question.trim() || asking}
            title="让 AI 改写问题、给出改进建议（结果内联展示，可一键采用）"
          >
            {optLoading ? '优化中…' : (<><span aria-hidden="true">✨</span>优化提问</>)}
          </button>
          <span className={css.actionHint}>Enter 发送 · Shift+Enter 换行</span>
        </div>
      </div>

      {/* ⑤ 隐私说明：输入框下方次级小字（常驻底部，不随对话滚动） */}
      <div className={css.privacyNote}>🔒 检索在本机完成；AI 生成会把检索片段发送到所选模型（可在「隐私与信任」中关闭出网）</div>
      </div>

      {/* 模型配置栏：面板内的实体侧栏（默认隐藏）。仅在打开时渲染 ——
          它占据 askLayout 的第二个 flex 车道，对话栏随之收窄，两者永远并排可见、都可交互。
          ≥901px：并排（对话栏至少留 ~400px）；≤900px 放不下两栏时整栏对换，
          配置栏占满面板宽度并由「返回对话」显式切回。两种情况都不会盖住任何内容。 */}
      {modelOpen && (
      <section
        className={css.modelPanel}
        ref={drawerRef}
        role="region"
        aria-label="模型配置（AI 问答）"
      >
        <div className={kitCss.drawerHd}>
          <span className={kitCss.drawerTitle}>模型配置（AI 问答）</span>
          <div className={css.drawerHdRight}>
            <Badge tone={llmSavedModel ? 'green' : 'warning'}>{llmSavedModel ? '已配置' : '未配置'}</Badge>
            <button type="button" className={css.panelBack} onClick={() => { setModelOpen(false) }}>返回对话</button>
            <button type="button" className={kitCss.drawerClose} onClick={() => { setModelOpen(false) }} aria-label="关闭模型配置">×</button>
          </div>
        </div>
        <div className={kitCss.drawerBd}>
        {llmConfig && (
          <>
            <div className={css.modelGrid}>
              <div className={css.modelField}>
                <span className={kitCss.textCaption}>配置模板（套用后仍需填 API Key）</span>
                <Select
                  value={llmTemplate}
                  onChange={applyLlmTemplate}
                  options={LLM_TEMPLATES.map(t => ({ value: t.key, label: t.label }))}
                  placeholder="选择厂商模板…"
                  ariaLabel="厂商配置模板"
                />
              </div>
              <label className={css.modelField}>
                <span className={kitCss.textCaption}>模型供应商</span>
                <input className={css.modelInput} value={llmConfig.provider} onChange={(e) => { setLlmConfig({ ...llmConfig, provider: e.target.value }) }} placeholder="openai-compat / deepseek / moonshot..." />
              </label>
              {llmModels.length > 0 ? (
                <div className={css.modelField}>
                  <span className={kitCss.textCaption}>
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
                  <span className={kitCss.textCaption}>模型（可手输，或点「获取官方模型」）</span>
                  <input className={css.modelInput} value={llmConfig.model} onChange={(e) => { setLlmConfig({ ...llmConfig, model: e.target.value }) }} placeholder="如 deepseek-chat / gpt-4o-mini" />
                </label>
              )}
              <div className={css.modelField}>
                <span className={kitCss.textCaption}>API Key</span>
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
                <span className={kitCss.textCaption}>API 地址（base_url，OpenAI 兼容）</span>
                <input className={css.modelInput} value={llmConfig.apiUrl} onChange={(e) => { setLlmConfig({ ...llmConfig, apiUrl: e.target.value }) }} placeholder="https://api.openai.com/v1" />
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
          </>
        )}
        </div>
      </section>
      )}
      </div>
    </div>
  )
}

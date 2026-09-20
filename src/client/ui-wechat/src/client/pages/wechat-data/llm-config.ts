/**
 * AI 大模型配置的前端访问层（「数据配置 → AI 大模型」卡片专用）。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────
 * ① 这几条都走**主进程 IPC**（`window.electronAPI.wechat.*`），不是 `ctx.remote.wechatData.*`：
 *    配置要在后端起来之前就存在（后端启动后每次请求都要读它连模型），所以它住不进 Remote。
 * ② `api.ts` 有硬行数预算（`api-module-split.spec.ts` 要求 < 2010 行，防缓存层被搬回去）。
 *    领域独立的一小块搬到这里、由 api.ts 转发 —— 与 M21 拆 `cache.ts` / `media-cache.ts` 同一口径。
 *
 * ── 两类东西，别再混为一谈 ────────────────────────────────────
 *   · **配置（config）**：当前生效的那一份扁平配置，写 llm.json 顶层，所有面板都读它；
 *   · **已保存的配置集（profiles）**：成套存下来的若干份配置（含各自的 API Key），
 *     用来「一键切回之前配好的那家厂商」。
 * 界面上那个「模型」下拉列的是**厂商官方提供的模型名**，两者都不是 —— 历史包袱见
 * `AiModelConfig.tsx` 的说明。
 */

/** 微信问答模型配置（OpenAI 兼容）。 */
export interface WechatLlmConfig {
  provider: string
  model: string
  apiKey: string
  apiUrl: string
  apiPath: string
  timeoutMs: number
  /** RAG 稠密检索用的向量模型；留空则回退到 chat model。 */
  embeddingModel?: string
  /** 向量化接口路径（默认 /embeddings）。 */
  embedPath?: string
  /** 嵌入端点的独立地址/Key：留空 ⇒ 复用上面的 apiUrl/apiKey。 */
  embeddingApiUrl?: string
  embeddingApiKey?: string
  /** 重排序模型：填了就启用，留空 ⇒ 精排退回本地的线性加权。 */
  rerankModel?: string
  /** 精排接口路径（默认 /rerank）。 */
  rerankPath?: string
  rerankApiUrl?: string
  rerankApiKey?: string
  /** 精排超时（毫秒）。它跑在每次提问的热路径上，所以默认值比 chat 短得多。 */
  rerankTimeoutMs?: number
}

/**
 * 一条**已保存的**模型配置。
 *
 * 字段成套存在一起（供应商 / 模型 / 地址 / Key / 向量模型），切换时整体替换 ——
 * 只换其中几项会拼出「A 家地址 + B 家 Key」，下一次提问必然 401。
 */
export interface WechatLlmProfile extends WechatLlmConfig {
  id: string
  /** 显示名（默认由 `供应商 · 模型` 派生；用户改过就保留用户的）。 */
  label: string
  /** 最近一次被使用/切换的时间（毫秒）；0 = 从未。 */
  usedAt: number
}

/** 「当前生效配置 + 已保存的配置集」快照。 */
export interface LlmProfilesSnapshot {
  config: WechatLlmConfig
  profiles: WechatLlmProfile[]
  activeProfileId: string
}

/** 「获取官方模型」结果：models 来自实时接口（live）或未填 Key 时的内置参考清单（catalog）。 */
export interface LlmModelsResult {
  models: string[]
  source: 'live' | 'catalog'
  vendor?: string
  note?: string
}

/** 读取当前生效的模型配置（走主进程 IPC）。 */
export async function apiGetLlmConfig(): Promise<WechatLlmConfig> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.getLlmConfig) return { provider: 'openai-compat', model: '', apiKey: '', apiUrl: 'https://api.openai.com/v1', apiPath: '/chat/completions', embedPath: '/embeddings', embeddingApiUrl: '', embeddingApiKey: '', rerankModel: '', rerankPath: '/rerank', rerankApiUrl: '', rerankApiKey: '', rerankTimeoutMs: 20000, timeoutMs: 120000 }
  const res = await api.getLlmConfig()
  if (!res?.ok) throw new Error(res?.error?.message || '读取模型配置失败')
  return res.value
}

/** 保存当前生效的模型配置（表单提交；后端会同步更新「使用中的那条」配置）。 */
export async function apiSaveLlmConfig(config: WechatLlmConfig): Promise<WechatLlmConfig> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.saveLlmConfig) throw new Error('模型配置接口不可用')
  const res = await api.saveLlmConfig(config)
  if (!res?.ok) throw new Error(res?.error?.message || '保存模型配置失败')
  return res.value
}

/**
 * 读取已保存的模型配置集。
 *
 * 老版本只存一份扁平配置、没有 `profiles` 字段 —— 后端会按现有配置懒迁移出一条，
 * 所以这里**永远至少返回一条**（只要那份配置有模型名或 Key）。
 */
export async function apiGetLlmProfiles(): Promise<LlmProfilesSnapshot> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.getLlmProfiles) throw new Error('模型配置集接口不可用')
  const res = await api.getLlmProfiles()
  if (!res?.ok) throw new Error(res?.error?.message || '读取已保存的模型配置失败')
  return res.value
}

/**
 * 切换到某条已保存的配置（成套替换，立即生效，无需重启 —— 后端每次请求都重读 llm.json）。
 * @param id - 目标配置 id。
 * @returns 切换后的完整快照。
 */
export async function apiActivateLlmProfile(id: string): Promise<LlmProfilesSnapshot> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.activateLlmProfile) throw new Error('模型配置集接口不可用')
  const res = await api.activateLlmProfile(id)
  if (!res?.ok) throw new Error(res?.error?.message || '切换模型配置失败')
  return res.value
}

/**
 * 新增或更新一条模型配置（「保存为新配置」/ 改名后保存）。
 * @param options - `id` 缺省为新增；`config` 缺省取当前生效配置；`activate` 默认 true。
 * @returns 操作后的完整快照。
 */
export async function apiSaveLlmProfile(options: {
  id?: string
  label?: string
  config?: WechatLlmConfig
  activate?: boolean
}): Promise<LlmProfilesSnapshot> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.saveLlmProfile) throw new Error('模型配置集接口不可用')
  const res = await api.saveLlmProfile(options)
  if (!res?.ok) throw new Error(res?.error?.message || '保存模型配置失败')
  return res.value
}

/** 删除一条已保存的配置（只剩一条时后端会拒绝；删到使用中的那条会自动切到最近使用的一条）。 */
export async function apiDeleteLlmProfile(id: string): Promise<LlmProfilesSnapshot> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.deleteLlmProfile) throw new Error('模型配置集接口不可用')
  const res = await api.deleteLlmProfile(id)
  if (!res?.ok) throw new Error(res?.error?.message || '删除模型配置失败')
  return res.value
}

/**
 * 通过 base_url 拉取官方模型列表（OpenAI 兼容 GET {base_url}/models）。
 * 实际请求在主进程发出（渲染页 file:// 跨域 fetch 会被 CORS 拦截）；
 * 未填 API Key 时后端会按厂商回退内置参考清单（source='catalog'）。
 * @param options - 地址与凭据（用当前表单的草稿值，不必先保存）。
 * @returns 模型名列表 + 来源标记。
 */
export async function apiFetchLlmModels(options: { apiUrl: string; apiKey: string }): Promise<LlmModelsResult> {
  const api = (window as any)?.electronAPI?.wechat
  if (!api?.listLlmModels) throw new Error('模型列表接口不可用')
  const res = await api.listLlmModels({ baseUrl: options.apiUrl, apiKey: options.apiKey })
  if (!res?.ok) throw new Error(res?.error?.message || '获取模型列表失败')
  return {
    models: Array.isArray(res.value?.models) ? res.value.models : [],
    source: res.value?.source === 'catalog' ? 'catalog' : 'live',
    vendor: typeof res.value?.vendor === 'string' ? res.value.vendor : undefined,
    note: typeof res.value?.note === 'string' ? res.value.note : undefined,
  }
}

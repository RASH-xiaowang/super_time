/**
 * 模型服务的「连接测试」与「余额查询」（主进程侧，2026-09-30）。
 *
 * ## 为什么放在主进程
 *
 * 与 `wechat:llm-models` 同一条接缝：渲染页是 `file://`，跨域 fetch 会被 CORS 拦，
 * 而主进程的 Node fetch 不受限。两个动作都**只带用户自己填的 API Key、只去用户自己配的
 * 地址**，不发送任何聊天内容。
 *
 * ## 出网口径（别把这条漏出文档）
 *
 * 这两条是**新的出网点**：连接测试是显式点击（manual），余额查询还会被主界面左下角
 * **按 5 分钟定时**触发（无人值守）。`docs/PRIVACY.md` 与同意屏的「AI 问答与总结」那一条
 * 已把「连接测试 / 余额查询」一并写进去 —— 改这里请同步那两处。
 *
 * ## 纯函数与网络分开
 *
 * 地址推导（{@link balanceUrlsFor}）与响应解析（{@link parseBalance}）都是纯函数，
 * 可以脱离网络单测；`queryLlmBalance` / `testLlmConnection` 只负责取数与错误翻译。
 *
 * @module llm-balance
 */

/** 单次请求超时（与 `wechat:llm-models` 保持一致）。 */
const TIMEOUT_MS = 20_000

/**
 * 把 undici 的底层错误码翻译成用户能照做的中文提示。
 * （原先内联在 `ipc-wechat.js` 的模型列表 handler 里，2026-09-30 提到本模块共用，
 * 否则三个频道会各抄一份、只修其中一处。）
 * @param e 抛出的错误。
 * @param host 目标主机（写进提示里）。
 * @returns 中文提示。
 */
function humanizeNetworkError(e, host) {
  const code = (e && e.cause && e.cause.code) || (e && e.code) || ''
  if (e && e.name === 'AbortError') return `请求超时（${Math.round(TIMEOUT_MS / 1000)} 秒）：${host} 无响应，请检查网络或地址`
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return `连接 ${host} 超时：网络不通或地址有误（国内网络通常无法直连 api.openai.com，可换 DeepSeek / 通义千问等国内厂商）`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `域名解析失败（${host}）：请检查 API 地址拼写`
  if (code === 'ECONNREFUSED') return `连接被拒绝（${host}）：端口未开放或已被防火墙拦截`
  if (code === 'ECONNRESET') return `连接被重置（${host}）：可能被网络中间设备中断，请重试或换厂商`
  if (/CERT|SELF_SIGNED|TLS|SSL/i.test(String(code))) return `TLS 证书校验失败（${host}）：${code}`
  return `${(e && e.message) || String(e)}（${host}）`
}

/** 取主机名（写提示用）；地址不合法时退回原文。 */
function hostOf(baseUrl) {
  try { return new URL(baseUrl).host } catch { return String(baseUrl || '') }
}

/**
 * 归一化 base_url：去掉结尾斜杠，并校验协议。
 * @param baseUrl 用户填的 API 地址。
 * @returns 归一化后的地址。
 */
function normalizeBase(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('API 地址需以 http:// 或 https:// 开头')
  return base
}

/**
 * 余额查询的候选地址。
 *
 * 各家路径不一样，且**没有统一标准**（这也是为什么 OpenAI 这类厂商根本没有余额接口）：
 *   · DeepSeek：`GET https://api.deepseek.com/user/balance` —— 注意**不带 `/v1`**，
 *     用户填的 base_url 是 `https://api.deepseek.com/v1`，所以要取 origin 再拼；
 *   · SiliconFlow 等：`GET {base}/user/info`（`{base}` 已含 `/v1`）；
 *   · 其余厂商按「先 /user/info 再 /user/balance」依次试。
 * @param baseUrl 用户填的 API 地址。
 * @returns 依次尝试的地址列表。
 */
function balanceUrlsFor(baseUrl) {
  const base = normalizeBase(baseUrl)
  const u = new URL(base)
  if (/deepseek/i.test(u.host)) return [u.origin + '/user/balance']
  return [base + '/user/info', base + '/user/balance']
}

/** 尽力把任意值转成有限数字（厂商有的返回字符串金额，有的是数字）。 */
function toNumber(x) {
  const n = typeof x === 'string' ? Number(x.trim()) : x
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * 从响应里**尽力**认出余额字段。
 *
 * 为什么按字段名表试探而不是按厂商分支解析：文档里的字段名会变（SiliconFlow 的响应体在
 * 官方文档里还是 JS 渲染的，抓不到权威 schema），而余额只是给人看的展示值 ——
 * **认不出来就如实说认不出来**，不要猜一个数字。所以要按优先级试完再返回 null，
 * 由调用方把原始片段回显给用户。
 * @param payload 已解析的 JSON。
 * @returns `{currency,total,granted,toppedUp,isAvailable}`，认不出返回 null。
 */
function parseBalance(payload) {
  if (!payload || typeof payload !== 'object') return null
  const root = payload.data && typeof payload.data === 'object' ? payload.data : payload
  // ① DeepSeek：{ is_available, balance_infos: [{ currency, total_balance, ... }] }
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos
    : Array.isArray(root.balance_infos) ? root.balance_infos
    : null
  if (infos && infos.length > 0 && infos[0] && typeof infos[0] === 'object') {
    const info = infos[0]
    const total = toNumber(info.total_balance)
    if (total !== null) {
      return {
        currency: String(info.currency || '').toUpperCase() || 'CNY',
        total,
        granted: toNumber(info.granted_balance),
        toppedUp: toNumber(info.topped_up_balance),
        isAvailable: payload.is_available === true ? true : payload.is_available === false ? false : null,
      }
    }
  }
  // ② 通用：totalBalance / total_balance / balance（SiliconFlow 等挂在 data 下）
  const keys = ['totalBalance', 'total_balance', 'totalAmount', 'balance', 'remainBalance', 'chargeBalance']
  for (const key of keys) {
    const total = toNumber(root[key])
    if (total !== null) {
      return {
        currency: String(root.currency || root.unit || '').toUpperCase() || 'CNY',
        total,
        granted: toNumber(root.grantedBalance) ?? toNumber(root.giftBalance),
        toppedUp: toNumber(root.chargeBalance) ?? toNumber(root.toppedUpBalance),
        isAvailable: null,
      }
    }
  }
  return null
}

/** 带超时与统一错误翻译的 GET。 */
async function getJson(url, apiKey, host) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
      signal: ctrl.signal,
    })
  } catch (e) {
    throw new Error(humanizeNetworkError(e, host))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 连接测试：按**端点类型**各测各的（2026-09-30 扩展）。
 *
 * 为什么不能只测 `/models`：主模型、向量模型、重排序模型在配置里是**三套地址/Key/路径**
 * （`apiUrl` / `embeddingApiUrl` / `rerankApiUrl`，各自可留空回落到上一套），
 * 实测就有「主模型 DeepSeek、向量与精排指向 SiliconFlow」这种组合 ——
 * 只测主模型等于没测向量与精排。
 *
 * 三种 kind 的代价如实写在这里：
 *   · `chat`   = `GET {base}/models` —— **不产生费用**，只回答地址/Key/兼容性通不通；
 *   · `embed`  = `POST {base}{embedPath}`，body `{ model, input: '连接测试' }` —— 约 3 个 token；
 *   · `rerank` = `POST {base}{rerankPath}`，body `{ model, query, documents: ['连接测试'] }` —— 约 6 个 token。
 * 后两条发的是**固定的测试串**，不是用户内容（这一点写进了 docs/PRIVACY.md 的 A2 节）。
 *
 * @param opts.baseUrl 该端点的地址（已由调用方回落到 `apiUrl`）。
 * @param opts.apiKey 该端点的 Key（已由调用方回落到 `apiKey`）。
 * @param opts.kind `chat` | `embed` | `rerank`。
 * @param opts.path 向量 / 精排的路径（缺省 `/embeddings` / `/rerank`）。
 * @param opts.model 该端点要用的模型名（向量与精排必填）。
 * @returns `{ms, detail, url, models?}`：耗时、一句话结论、实际请求地址；chat 另带可见模型数。
 */
async function testLlmEndpoint(opts) {
  const kind = opts && opts.kind ? String(opts.kind) : 'chat'
  const apiKey = String((opts && opts.apiKey) || '')
  const base = normalizeBase(opts && opts.baseUrl)
  const host = hostOf(base)
  const model = String((opts && opts.model) || '').trim()

  if (kind === 'embed' || kind === 'rerank') {
    const field = kind === 'embed' ? '向量模型' : '重排序模型'
    if (!model) {
      throw new Error(`未填写${field}：${kind === 'embed' ? '向量检索会退化为纯本地稀疏通道' : '精排整段会跳过'}，没有可测的端点`)
    }
    const path = String((opts && opts.path) || '').trim() || (kind === 'embed' ? '/embeddings' : '/rerank')
    const url = base + (path.startsWith('/') ? path : '/' + path)
    const body = kind === 'embed'
      ? { model, input: '连接测试' }
      : { model, query: '连接测试', documents: ['连接测试'] }
    const t0 = Date.now()
    const res = await postJson(url, apiKey, host, body)
    const ms = Date.now() - t0
    if (!res.ok) throw new Error(httpError(res, url, apiKey ? 'API Key' : 'API Key 为空'))
    const data = await res.json().catch(() => null)
    const detail = kind === 'embed' ? embedDetail(data) : rerankDetail(data)
    if (!detail) throw new Error(`${url} 返回里没有可识别的结果（向量应有 data[].embedding，精排应有 results[].relevance_score）`)
    return { ms, detail, url }
  }

  // chat：沿用 /models（最便宜、无副作用，且能同时证明"是 OpenAI 兼容接口"）
  const url = base + '/models'
  const t0 = Date.now()
  const res = await getJson(url, apiKey, host)
  const ms = Date.now() - t0
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200)
    if (res.status === 401 || res.status === 403) {
      throw new Error(`接口返回 ${res.status}：${apiKey ? 'API Key 无效或无权限，请检查后重试' : 'API Key 为空，请先填写你的 API Key'}${body ? '：' + body : ''}`)
    }
    const hint = res.status === 404 ? '（该地址可能缺少 /v1 后缀，或厂商不提供 /models 接口）' : ''
    throw new Error(`接口返回 ${res.status} ${res.statusText || ''}${body ? '：' + body : ''} ${hint}`.trim())
  }
  const data = await res.json().catch(() => null)
  const raw = Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : []
  const models = [...new Set(raw.map((m) => (typeof m === 'string' ? m : m && m.id)).filter((id) => typeof id === 'string' && id))]
  return { ms, detail: `该接口可见 ${models.length} 个模型`, url, models: models.length }
}

/** 向量响应的维度（`data[0].embedding`，也认 `embeddings[0]`）。 */
function embedDetail(data) {
  const first = Array.isArray(data && data.data) && data.data.length ? data.data[0] : null
  const vec = first && Array.isArray(first.embedding) ? first.embedding
    : Array.isArray(data && data.embeddings) && data.embeddings.length ? data.embeddings[0]
      : null
  return Array.isArray(vec) ? `向量维度 ${vec.length}` : ''
}

/** 精排的首条相关度（`results[0].relevance_score`，兼容 `relevanceScore` / `score`）。 */
function rerankDetail(data) {
  const rows = Array.isArray(data && data.results) ? data.results
    : Array.isArray(data && data.data) ? data.data
      : null
  if (!rows || rows.length === 0) return ''
  const first = rows[0] || {}
  const score = toNumber(first.relevance_score) ?? toNumber(first.relevanceScore) ?? toNumber(first.score)
  return score === null ? `返回 ${rows.length} 条结果` : `相关度 ${score.toFixed(4)}`
}

/** 非 2xx 的统一错误文案（401/403 点明 Key、404 点明路径）。 */
function httpError(res, url, keyLabel) {
  const status = res.status
  if (status === 401 || status === 403) return `接口返回 ${status}：${keyLabel} 无效或无权限（${url}）`
  if (status === 404) return `接口返回 404：路径不对或该厂商没有这个接口（${url}）—— 检查「接口路径」那一栏`
  return `接口返回 ${status} ${res.statusText || ''}（${url}）`.trim()
}

/**
 * 带超时与统一错误翻译的 POST（JSON body）。
 * @param url 目标地址。
 * @param apiKey 凭据。
 * @param host 主机名（写进错误提示）。
 * @param body 请求体（会被 JSON 序列化）。
 * @returns fetch 响应。
 */
async function postJson(url, apiKey, host, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    throw new Error(humanizeNetworkError(e, host))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 连接测试（只测主模型 / `/models`）—— 老签名的薄包装，保留给既有调用方与用例。
 * @param baseUrl 用户填的 API 地址。
 * @param apiKey 用户填的 Key。
 * @returns 同 {@link testLlmEndpoint}。
 */
async function testLlmConnection(baseUrl, apiKey) {
  return testLlmEndpoint({ baseUrl, apiKey, kind: 'chat' })
}

/**
 * 余额查询：按 {@link balanceUrlsFor} 的候选依次试。
 * @param baseUrl 用户填的 API 地址。
 * @param apiKey 用户填的 Key（**必需**：余额接口一律要凭据）。
 * @returns `{currency,total,granted,toppedUp,isAvailable,url,fetchedAt}`。
 */
async function queryLlmBalance(baseUrl, apiKey) {
  if (!String(apiKey || '')) throw new Error('余额查询需要 API Key：请先在「AI 大模型」里填写并保存')
  const urls = balanceUrlsFor(baseUrl)
  const host = hostOf(baseUrl)
  const problems = []
  for (const url of urls) {
    const res = await getJson(url, apiKey, host)
    if (res.status === 401 || res.status === 403) {
      throw new Error(`接口返回 ${res.status}：API Key 无效或无权限（${url}）`)
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 160)
      problems.push(`${url} → ${res.status} ${res.statusText || ''}${body ? '：' + body : ''}`.trim())
      continue
    }
    const data = await res.json().catch(() => null)
    const parsed = parseBalance(data)
    if (parsed) return { ...parsed, url, fetchedAt: Date.now() }
    problems.push(`${url} → 返回里没有可识别的余额字段`)
  }
  throw new Error(`余额查询失败：${problems.join('；')}。部分厂商（如 OpenAI）不提供余额接口 —— 这只影响这个数字，不影响问答与总结。`)
}

module.exports = {
  TIMEOUT_MS,
  humanizeNetworkError,
  normalizeBase,
  balanceUrlsFor,
  parseBalance,
  testLlmEndpoint,
  testLlmConnection,
  queryLlmBalance,
}

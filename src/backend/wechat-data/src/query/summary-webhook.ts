/**
 * 定时总结的 **Webhook 推送**（2026-11-18）。
 *
 * 为什么要有这一格：总结生成完只落进本机历史表，用户得自己回到应用里看。
 * 而「到点把这段总结发到微信」才是大多数人真正想要的形态，所以任务可以额外配一个
 * 推送目的地 —— 协议与消息列表、AI 回复用的 /webhook/<token> 发送接口完全一致：
 *
 * ```http
 * POST /webhook/<token>
 * Content-Type: application/json
 *
 * {"target":"文件传输助手","message":"这里是定时总结的内容"}
 * ```
 *
 * 三条有意为之的取舍：
 *   · **只收 `/webhook/<token>`**：附件上传端点 `/webhook/<token>/resources` 拿来发正文
 *     一定失败，与其等到发送时才报错，不如在保存任务时就说清楚（判据与消息列表同一份，
 *     见 `net/webhook-endpoint.ts`）。
 *   · **推不出去不影响总结本身**：总结已经生成并落库了，推送失败只把原因带回去让界面显示
 *     「已生成，但推送失败」，不把整轮标成失败、更不重跑 LLM（重跑要再花钱）。
 *   · **错误文本一律脱敏**：下游可能把完整地址回显在错误里，而地址里的 token 就是凭据。
 *
 * @module query/summary-webhook
 */
import { isTokenizedWebhookEndpoint, redactWebhookEndpoint, redactWebhookSecrets } from '../net/webhook-endpoint.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import { sendRequest } from './rpa/dispatch.ts'

/** 推送地址长度上限（够长，但别让一条脏数据把任务表撑爆）。 */
export const SUMMARY_WEBHOOK_URL_MAX = 2000

/** 推送对象（微信里的会话名）长度上限，与消息列表的 `target` 同口径。 */
export const SUMMARY_WEBHOOK_TARGET_MAX = 200

/**
 * 总结正文**不限长**（2026-11-18）。
 *
 * 此前这里有一个 2 万字的截断，理由写的是「防模型抽风把请求体撑爆」。但它的实际后果是
 * **静默吃掉一段内容** —— 而总结本来就要「该说的都说完」，截断往往正好砍在结论上。
 * 现在整段照发；真发不出去（对端拒收超长请求体）会以非 2xx 回来并如实报错，
 * 那是可见的失败，不是悄悄少一段。
 */

/** 推送依赖（测试注入 fetch）。 */
export interface SummaryWebhookDeps {
  fetchImpl?: RetryFetch
}

/** 一次推送的结果。`skipped` 表示任务没配地址、本来就不该发。 */
export interface SummaryWebhookPushResult {
  ok: boolean
  /** 脱敏后的地址（`/webhook/***`），可以直接给界面看。 */
  endpoint: string
  /** 任务没配地址时为 true（此时 ok 也为 true：什么都不做就是成功）。 */
  skipped?: boolean
  status?: number
  error?: string
}

/** 规范化结果。 */
export interface SummaryWebhookUrlCheck {
  ok: boolean
  /** `kind:'set'` 时的规范化地址；其它情况为空串。 */
  url: string
  /**
   * 保存时怎么处理这一列：
   *   · `set` —— 写入 `url`
   *   · `clear` —— 显式关掉推送（写空串）
   *   · `keep` —— 不动已保存的值（SQL 里落 NULL）
   */
  kind: 'set' | 'clear' | 'keep'
  error?: string
}

/**
 * 校验并规范化用户填写的推送地址。
 *
 * 三条输入形态各有含义，别合并：
 *   · 空串 → `clear`（用户清空输入框 = 关掉推送）；
 *   · 脱敏占位 `http://host:port/webhook/***` → `keep`。界面上「已配置」只回显脱敏地址
 *     （token 就是凭据，不该出现在 DOM/截图里），用户没改它就直接保存时必须**保持原值**，
 *     否则 `***` 会被当成真 token 存进去，把原地址覆盖掉 —— 之后推送静默失效。
 *   · 正常地址 → `set`（http/https、无内嵌凭据、路径必须是 `/webhook/<token>`）。
 * @param raw - 界面上填的原始文本。
 * @returns ok + 处理方式；不合法时 `error` 说明原因。
 */
export function normalizeSummaryWebhookUrl(raw: unknown): SummaryWebhookUrlCheck {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: true, url: '', kind: 'clear' }
  if (text.length > SUMMARY_WEBHOOK_URL_MAX) {
    return { ok: false, url: '', kind: 'keep', error: `推送地址过长（上限 ${String(SUMMARY_WEBHOOK_URL_MAX)} 字符）` }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, url: '', kind: 'keep', error: '推送地址无法解析，请填写完整地址（含 http:// 或 https://）' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, url: '', kind: 'keep', error: '推送地址只支持 http/https' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, url: '', kind: 'keep', error: '推送地址不允许内嵌用户名或密码' }
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, url: '', kind: 'keep', error: '推送地址不能带查询串或片段' }
  }
  if (!isTokenizedWebhookEndpoint(url.toString())) {
    return {
      ok: false,
      url: '',
      kind: 'keep',
      error: '推送地址必须是发送端点 /webhook/<token>（附件上传端点 /resources 不能用来发正文）',
    }
  }
  // 脱敏占位：界面回显的就是这种形式，原样保存等于没有任何改动。
  const token = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
  if (token === '***') return { ok: true, url: '', kind: 'keep' }
  return { ok: true, url: url.toString(), kind: 'set' }
}

/** 把不可信的响应体收成可落库的短文本。 */
function responseSnippet(bodyText: string, webhookUrl: string): string {
  const text = bodyText.trim()
  return text === '' ? '' : redactWebhookSecrets(text, webhookUrl)
}

/**
 * 把一段总结推送到已保存的 Webhook。
 *
 * 不抛错：所有失败都折进返回值 —— 调用方是「总结已经生成」的那条路径，
 * 不能让一次推送异常把成功结果吞掉。
 * @param input - 推送地址 / 目标会话名 / 正文。
 * @param deps - 可选注入 fetch（测试）。
 * @returns 推送结果（含脱敏地址与失败原因）。
 */
export async function pushSummaryToWebhook(
  input: { webhookUrl: string; target: string; message: string },
  deps: SummaryWebhookDeps = {},
): Promise<SummaryWebhookPushResult> {
  const checked = normalizeSummaryWebhookUrl(input.webhookUrl)
  if (!checked.ok) {
    return { ok: false, endpoint: redactWebhookEndpoint(input.webhookUrl), error: checked.error ?? '推送地址无效' }
  }
  // `keep` / `clear` 在推送语境下都等于「没有可发的地址」—— 任务本来就该跳过。
  if (checked.kind !== 'set') return { ok: true, endpoint: '', skipped: true }

  const endpoint = redactWebhookEndpoint(checked.url)
  const target = (typeof input.target === 'string' ? input.target : '').trim().slice(0, SUMMARY_WEBHOOK_TARGET_MAX)
  if (target === '') return { ok: false, endpoint, error: '没有填写推送对象（例如「文件传输助手」）' }

  const rawMessage = typeof input.message === 'string' ? input.message : ''
  const message = rawMessage.trim()
  if (message === '') return { ok: false, endpoint, error: '总结内容为空，未推送' }

  try {
    const response = await sendRequest({
      method: 'POST',
      url: checked.url,
      headers: { accept: 'application/json' },
      // 只发这两个字段：下游协议就是 `{target, message}`（见 docs/FEATHER-INTEGRATION.md）。
      body: JSON.stringify({ target, message }),
      contentType: 'application/json',
    }, deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }, {
      // 「发一条微信消息」不是幂等操作：重试可能让同一个总结发两遍。
      // 所以只重试**确定没送出去**的网络失败，不对 5xx/429 重发。
      maxAttempts: 2,
      retryOn: ['network'],
    })

    const result: SummaryWebhookPushResult = { ok: false, endpoint, status: response.status }

    const snippet = responseSnippet(response.bodyText, checked.url)
    if (response.status >= 200 && response.status < 300) {
      // 2xx 但正文明确 `ok:false` 仍算失败：下游在排队失败时会这么回。
      let rejected = ''
      try {
        const parsed = JSON.parse(response.bodyText) as unknown
        if (typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === false) {
          rejected = snippet === '' ? '下游返回 ok=false' : snippet
        }
      } catch {
        // 非 JSON 的 2xx 就当成功（有些接收端只回 200/空体）。
      }
      if (rejected !== '') return { ...result, error: rejected }
      return { ...result, ok: true }
    }
    return {
      ...result,
      error: 'HTTP ' + String(response.status) + (snippet === '' ? '' : '：' + snippet),
    }
  } catch (e) {
    const errMessage = (e as { message?: unknown } | null | undefined)?.message
    const text = typeof errMessage === 'string' && errMessage !== '' ? errMessage : String(e)
    return { ok: false, endpoint, error: redactWebhookSecrets(text, checked.url) }
  }
}

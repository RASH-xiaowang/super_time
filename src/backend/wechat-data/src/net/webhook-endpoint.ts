/**
 * Webhook 端点的**共用**判定与脱敏。
 *
 * 为什么要单独一格：Feather 的 `/webhook/<token>` 地址被三处用到 ——
 * 消息列表投递、消息列表健康探测、以及 2026-11-18 新增的定时总结推送。
 * 「这个地址算不算合法的发送端点」「日志里怎么把 token 抹掉」必须是**同一把尺子**：
 * 三处各写一遍正则，改一处忘一处就会出现「这里能存、那里拒绝」或者「某条路径把 token
 * 原样写进日志」。这些函数是纯函数、无 I/O。
 *
 * @module net/webhook-endpoint
 */

/** 下游错误可能回显完整地址；只保留 origin + 骨架。 */
const URL_TOKEN_RE = /\b(https?:\/\/[^\s"'<>]+)/gi

/** Webhook 响应体截断上限（够排障，不把整个 HTML 错误页存进库）。 */
export const WEBHOOK_TEXT_MAX = 500

/**
 * 去掉 URL 里内嵌的凭据、token 与查询串。
 * @param text - 任意可能含 URL 的文本。
 * @returns 每个 URL 都被脱敏后的文本。
 */
function redactUrls(text: string): string {
  return text.replace(URL_TOKEN_RE, (raw) => {
    try {
      const url = new URL(raw)
      if (url.username !== '' || url.password !== '') {
        url.username = ''
        url.password = ''
      }
      url.pathname = url.pathname
        .replace(/(\/webhook\/)[^/]+/i, '$1***')
        .replace(/(\/api\/message-webhook\/)[^/]+/i, '$1***')
      url.search = ''
      return url.toString()
    } catch {
      return '[已隐藏地址]'
    }
  })
}

/** 截断到上限（不改变空串语义）。 */
export function trimText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 把一段下游错误文本里可能出现的 webhook 凭据抹掉。
 * @param text - 下游返回的错误或响应体。
 * @param webhookUrl - 本次请求用的地址（用于精确抹掉路径 token 与 query 值）。
 * @returns 可安全落库/展示的文本。
 */
export function redactWebhookSecrets(text: string, webhookUrl: string): string {
  let out = redactUrls(text)
  try {
    const url = new URL(webhookUrl)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    const pathToken = pathSegments.at(-1) ?? ''
    const tokenizedPath = /\/webhook\/[^/]+/i.test(url.pathname)
      || /\/api\/message-webhook\/[^/]+/i.test(url.pathname)
    const queryValues = [...url.searchParams.values()]
    for (const secret of [tokenizedPath ? pathToken : '', ...queryValues]) {
      if (secret.length >= 4) out = out.split(secret).join('***')
    }
  } catch {
    // 地址已过 http(s) 校验；这里失败只是少一层额外遮蔽，不影响主流程。
  }
  return trimText(out, WEBHOOK_TEXT_MAX)
}

/**
 * 只回显 origin + 路径骨架（token 变 `***`），给界面与日志用。
 * @param webhookUrl - 已保存或待保存的地址。
 * @returns 脱敏地址；解析失败返回空串。
 */
export function redactWebhookEndpoint(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname
      .replace(/(\/webhook\/)[^/]+/i, '$1***')
      .replace(/(\/api\/message-webhook\/)[^/]+/i, '$1***')
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

/**
 * 是不是 Feather 的**发送**端点 `/webhook/<token>`。
 *
 * 刻意排除 `/webhook/<token>/resources`：那是附件上传子路径，拿来发正文会失败，
 * 而失败发生在真正发送时 —— 不如在保存时就说清楚。
 * @param url - 待判定的地址。
 * @returns 形状是否吻合。
 */
export function isTokenizedWebhookEndpoint(url: string): boolean {
  try {
    return /^\/webhook\/[^/]+\/?$/i.test(new URL(url).pathname)
  } catch {
    return /\/webhook\/[^/]+\/?$/i.test(url)
  }
}

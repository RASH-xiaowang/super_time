/**
 * 隐私闸（#20 第一个协作者）：脱敏与审计两件事的唯一出处。
 *
 * **2026-09-30：出网拦截已被彻底移除。** `blockOutbound`（「禁止 AI 出网」）开关、
 * `privacyBlockedAt` / `outboundBlockedAt` 两个判断与所有「被拦截」文案一并删除 ——
 * 应用不再有任何阻止出网的机制，{@link privacyGateAt} 只做两件事：
 *
 * 1. 用户开了「敏感字段打码」时，把即将发出去的文本换成脱敏副本；
 * 2. 把这次放行的调用记进本机审计表（功能名、字符数、会话与消息数）。
 *
 * 为什么还是单独一个模块：这两件事是**出站调用的必经接缝**（`gateway.ts` 的
 * `privacyGate`），收在一处才能保证「以后新增的 AI 功能也走同一套脱敏与审计」。
 * 它不再做权限判断，所以读不到设置时按默认值（不脱敏）继续 —— 没有任何失败方向会拦下请求。
 */
import { readPrivacySettings, recordPrivacyAudit, redactSensitiveText } from './query/privacy-audit.ts'

/**
 * 隐私闸门的函数形态：remotes 的 ctx 与 LLM 工厂共用同一份签名。
 * @param feature - 审计功能名。
 * @param stats - 本次出站的数据量。
 * @param texts - 即将发出去的文本。
 * @returns 可直接发出去的文本（开启脱敏时是副本）。
 */
export type PrivacyGateFn = (
  feature: string,
  stats: { sessions: number; messages: number },
  texts: string[],
) => string[]

/**
 * 隐私闸门：**所有**出站 LLM 调用都必须先过这里。
 *
 * @param decryptedDir - 已解密数据根。
 * @param feature - 审计里的功能名（ask_wechat / daily_summary / summary_task / period_summary…）。
 * @param stats - 本次出站涉及的数据量（会话数、消息数），写进审计。
 * @param texts - 即将发出去的文本；开启脱敏时返回脱敏后的副本。
 * @returns 可以直接发出去的文本（不脱敏时就是入参本身的内容）。
 */
export function privacyGateAt(
  decryptedDir: string,
  feature: string,
  stats: { sessions: number; messages: number },
  texts: string[],
): string[] {
  let redactSensitive = false
  try {
    redactSensitive = readPrivacySettings(decryptedDir).redactSensitive
  } catch {
    // 读不到设置时按默认值（false）继续：这里已不是权限判断，不该因为库读不动就改变出网行为。
  }
  const out = redactSensitive ? texts.map(redactSensitiveText) : texts
  const chars = out.reduce((a, t) => a + t.length, 0)
  // 审计是 best-effort：recordPrivacyAudit 内部已是 try/catch，失败不影响功能本身
  recordPrivacyAudit(decryptedDir, feature, chars, stats.sessions, stats.messages)
  return out
}

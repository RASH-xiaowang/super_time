/**
 * 隐私闸（#20 第一个协作者）：出站判断、脱敏与审计三件事的唯一出处。
 *
 * 为什么从 `GatewayCore` 里搬出来（审计 §P2-2 给的方向是「LLM 工厂 / 隐私闸 / 调度各成协作者」）：
 * 这三件是**安全判断**，而 `GatewayCore` 是个 986 行的装配类 —— 判断住在装配类里，
 * 就只能靠 `this._dirs` 起一个真网关才能测，实测本仓对它的覆盖全是"起整个网关"级别的
 * （`outbound-gates.spec.ts`）。搬成三个以目录为参数的纯薄函数之后，判据可以直接喂
 * 「开关开着 / 开关关着 / 库读不动 / 竞态里第二次读失败」这四种状态，逐一断言。
 *
 * `GatewayCore` 保留同样签名的 `protected` 包装，子类（`gateway-read.ts` 等十几个远程组）
 * 一行都不用改 —— 这是"组合而非继承"那一步里风险最低的一半。
 *
 * 三条失败方向全部**偏保守**（判断不了就拦、就脱敏、就不下发 URL）：
 * 权限判断出错的方向只能是"少发数据"，不能是"多发数据"。
 */
import { privacyStoreUnreadable } from './gateway-support.ts'
import { readPrivacySettings, recordPrivacyAudit, redactSensitiveText } from './query/privacy-audit.ts'

/** 出站点没说清自己在干什么时用的默认文案（也是改前那三处调用共用的字面量）。 */
export const DEFAULT_OUTBOUND_DETAIL = '把数据发送给模型'

/** 隐私闸的放行结果：放行时带回**可能被脱敏过**的文本。 */
export type PrivacyGateResult = { ok: true; texts: string[] } | { ok: false; error: string }

/**
 * 「出站拦截」当前是否开启。
 *
 * 与 `privacyBlockedAt` 的分工：那个是 LLM 出站点用的（要返回给用户看的文案），
 * 这里只回答一个是非问题 —— 批量头像会给远端 URL 兜底，而拉那张图属于出站，
 * 开关打开时就不该下发这类 URL。
 * @param decryptedDir - 已解密数据根（隐私设置所在的库）。
 * @returns 是否禁止出站。**读不到设置时返回 true**：这是权限判断，
 *   失败方向只能是拦下 —— 用户开着「出站拦截」而库恰好损坏/被锁时，静默放行是最糟的结果。
 */
export function outboundBlockedAt(decryptedDir: string): boolean {
  try {
    return readPrivacySettings(decryptedDir).blockOutbound
  } catch {
    return true
  }
}

/**
 * 「出站拦截」是否已开启；开启时返回给用户看的说明，否则 null。
 *
 * 为什么要单独有这个提前检查：出站调用点前面还有「未配置默认模型」这类**早退分支**，
 * 不开拦截时它是对的；但用户先把「禁止 AI 出网」打开、再点每日总结时，
 * 早退分支会先返回「AI 不可用（未配置默认模型）」，把隐私拦截真实生效这件事盖掉
 * （第 59 轮实测：开关明明写着「开」，总结里却完全不提拦截）。所以拦截要在**最前面**判。
 * @param decryptedDir - 已解密数据根。
 * @param feature - 功能名，出现在提示文案里。
 * @param detail - 这条出网在做什么。
 * @returns 被拦截时的文案，未拦截时 null。
 */
export function privacyBlockedAt(decryptedDir: string, feature: string, detail = DEFAULT_OUTBOUND_DETAIL): string | null {
  let blocked: boolean
  try {
    blocked = readPrivacySettings(decryptedDir).blockOutbound
  } catch {
    return privacyStoreUnreadable(feature, detail)
  }
  return blocked ? `隐私设置已开启「出站拦截」，已阻止「${feature}」${detail}` : null
}

/**
 * 隐私闸门：**所有**出站 LLM 调用都必须先过这里（第 59 轮）。
 *
 * 背景：`readPrivacySettings` / `recordPrivacyAudit` 这两个能力原本**谁都没调用** ——
 * 「出站拦截」「敏感字段脱敏」两个开关只写进 sqlite 就没人读，`privacy_audit` 表
 * 实测 0 行（运行期 bundle 里连 INSERT 都没有）。把闸门收敛成这一个函数，
 * 各处出站调用（问答／每日总结／群总结任务／周期总结…）统一走它，
 * 避免「以后加了新 AI 功能又忘了过隐私」这类漏网。
 * @param decryptedDir - 已解密数据根。
 * @param feature - 审计里的功能名（ask_wechat / daily_summary / summary_task / period_summary）。
 * @param stats - 本次出站涉及的数据量（会话数、消息数），写进审计。
 * @param texts - 即将发出去的文本；开启脱敏时返回脱敏后的副本。
 * @returns 允许出站时 `{ ok: true, texts }`；被拦截时 `{ ok: false, error }`。
 */
export function privacyGateAt(
  decryptedDir: string,
  feature: string,
  stats: { sessions: number; messages: number },
  texts: string[],
): PrivacyGateResult {
  const blocked = privacyBlockedAt(decryptedDir, feature)
  if (blocked !== null) return { ok: false, error: blocked }
  let settings: { redactSensitive: boolean; blockOutbound: boolean }
  try {
    settings = readPrivacySettings(decryptedDir)
  } catch {
    // 竞态兜底：上面那次读成功了、这一次失败（库刚被锁上或删掉）。
    // 方向同上 —— 判断不了就拦下，不能带着「默认不脱敏」把原文发出去。
    return { ok: false, error: privacyStoreUnreadable(feature, DEFAULT_OUTBOUND_DETAIL) }
  }
  const out = settings.redactSensitive ? texts.map(redactSensitiveText) : texts
  const chars = out.reduce((a, t) => a + t.length, 0)
  // 审计是 best-effort：recordPrivacyAudit 内部已是 try/catch，失败不影响功能本身
  recordPrivacyAudit(decryptedDir, feature, chars, stats.sessions, stats.messages)
  return { ok: true, texts: out }
}

/**
 * 接入会话的**展示层**打码（D-10）。
 *
 * 只在「敏感字段打码」开启时对**界面显示的文本**生效；库里始终是正文原文
 * （写入路径不做任何替换，见 PRIVACY.md 第三节）。
 *
 * 与后端 `query/privacy-audit.ts#redactSensitiveText`（出站脱敏，替换成 `[手机号]`）
 * **有意不同**：那是发出去给对方模型的，越难还原越好；这里是给自己看的，
 * 保留首尾（`138****6721`）既遮蔽又能让人认出「这是谁的号码」——
 * 功能表 D-10 的验收样例就是这一形态。五个模式的**长度口径与后端同源**，
 * 改那边要回来看这里（`clawbot-mask.spec.ts` 用样例把两边的主要口径钉住）。
 *
 * @module panels/clawbot-mask
 */

/** 手机号：11 位、以 1[3-9] 开头 → 保留前 3 后 4。 */
const PHONE = /\b1[3-9]\d{9}\b/g
/** 身份证：18 位（末位可为 X）→ 保留前 6 后 4。 */
const ID_CARD = /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g
/** 银行卡：62 开头的 16–19 位，或 4/5 开头的 16–19 位 → 保留前 4 后 4。 */
const BANK_CARD = /\b(?:62\d{14,17}|[45]\d{15,18})\b/g
/** 邮箱：本地部分只留首字符。 */
const EMAIL = /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g
/** 口令：`密码=xxxx` / `password: xxxx` 整段换掉（与后端同款「连值一起遮」）。 */
const SECRET = /((?:密码|口令|pwd|password|passwd)\s*[=:：]\s*)[A-Za-z0-9@#$%^&*!_.-]{4,32}/gi

/** 保留 `head` / `tail` 两端，中间全部换成 `*`（长度不足时返回原串）。 */
function keepEnds(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text
  return text.slice(0, head) + '*'.repeat(text.length - head - tail) + text.slice(-tail)
}

/**
 * 对一段文本做展示层打码。
 * @param text - 正文原文。
 * @returns 打码后的文本（未命中任何模式时原样返回）。
 */
export function maskSensitiveText(text: string): string {
  return text
    .replace(PHONE, (m) => keepEnds(m, 3, 4))
    .replace(ID_CARD, (m) => keepEnds(m, 6, 4))
    .replace(BANK_CARD, (m) => keepEnds(m, 4, 4))
    .replace(EMAIL, '$1***@$2')
    .replace(SECRET, '$1******')
}

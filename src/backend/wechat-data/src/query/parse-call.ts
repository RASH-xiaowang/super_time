/**
 * 通话/语音视频的解析（M21 拆分）：时长、接听状态、`room_type` 类别。**行为逐字节不变**。
 *
 * @module parse-call
 */


/* ------------------------------------------------------------------ *
 * 通话
 * ------------------------------------------------------------------ */

/**
 * Parse the duration out of a type-50 call `<msg>` text.
 *
 * 微信把通话时长写在**文本**里（「通话时长 00:21」「通话中断 01:08」），
 * 而 XML 的 `<duration>` 字段实测 **135/135 恒为 0** —— 读它会得到 0 秒。
 * 这是本项目里最容易踩的一个「字段存在但没值」的坑。
 * @param text - the `<msg>` text of a voip bubble.
 * @returns seconds, or undefined when the text carries no duration.
 */
export function parseCallDuration(text: string): number | undefined {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (!m) return undefined
  const a = Number(m[1] ?? 0)
  const b = Number(m[2] ?? 0)
  return m[3] === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(m[3])
}

/**
 * `<msg>` 文本表示「在其它设备上接通」的通话（没有本机时长，但确实接通了）。
 * 实测本机 135 条里只有这两字串的一种形态；`忙线未接听` 不含此模式。
 */
export const CALL_ANSWERED_ELSEWHERE = /已在其它设备接听/

/**
 * 通话结局 → 语义分类，界面据此选图标/配色。
 * @param status - the `<msg>` text of a voip bubble.
 * @param connected - whether the call was actually connected.
 * @returns one of connected / cancelled / rejected / no-answer / busy / interrupted / missed / unknown.
 */
export function classifyCallStatus(status: string, connected: boolean): string {
  const s = status || ''
  if (connected) return 'connected'
  if (s.includes('已取消') || s.includes('对方已取消')) return 'cancelled'
  if (s.includes('已拒绝')) return 'rejected'
  if (s.includes('未应答')) return 'no-answer'
  if (s.includes('忙线')) return 'busy'
  if (s.includes('中断')) return 'interrupted'
  if (s.includes('未接听') || s.includes('未接通')) return 'missed'
  return 'unknown'
}

/** 通话/语音视频的原始类型（微信 `<room_type>`：0 语音，1 视频）。 */
export type VoipKind = 'audio' | 'video' | ''

/**
 * 解析 `<room_type>`：**0 = 语音，1 = 视频**。
 *
 * 这里与上游 WeChatDataAnalysis 的结论（0=video、1=audio）相反，判据是本机数据的时长分布：
 *
 * | room_type | 条数 | 最长通话 | ≥30 分钟 | ≥10 分钟 |
 * | --- | --- | --- | --- | --- |
 * | 0 | 61 | **1 小时 40 分 10 秒** | 1 | 2 |
 * | 1 | 103 | 12 分 40 秒 | 0 | 1 |
 *
 * 100 分钟的视频通话不现实、语音通话很常见；且 25 个有通话的会话里 **12 个两种值都出现**，
 * 说明它是「每次通话」的属性（不是每会话固定），符合媒体类型标志的语义。
 * 另有用户核对：`<msg>=已在其它设备接听` 的那条（room_type=0）在微信里是语音通话。
 *
 * 本文件早前版本已在注释里指出「本机数据判不了」，`query/calls.ts` 也据此**刻意不给通话记录打标签**。
 * 现在有了时长分布这组证据，消息气泡才敢按它画图标与「语音通话 / 视频通话」文案。
 * 若将来拿到官方定义，以本表为准复核这里。
 *
 * @param roomType - raw `<room_type>` value as text.
 * @returns audio / video / '' when unknown.
 */
export function parseVoipKind(roomType: string): VoipKind {
  const v = (roomType ?? '').trim()
  if (v === '0') return 'audio'
  if (v === '1') return 'video'
  return ''
}


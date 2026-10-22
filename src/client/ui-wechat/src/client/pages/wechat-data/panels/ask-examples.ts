/**
 * 微信问答空态的示例问题。
 *
 * 示例不是检索评测集：第一条引用用户本机真实存在的最近会话，后两条分别覆盖
 * 「跟进承诺」和「核对转账」。集中在这里生成，避免面板继续硬编码虚构人名，
 * 也方便用纯逻辑用例锁住系统会话过滤和回退文案。
 */
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

/** 一张可点击填入的示例问题卡。 */
export interface AskExampleCard {
  tag: string
  question: string
}

/** 常见系统会话：它们不是「和谁聊过」的对象，不能拿来当回顾示例。 */
const SYSTEM_SESSION_NAMES = new Set([
  '文件传输助手',
  '微信团队',
  '微信支付',
  '服务通知',
  '订阅号消息',
  '折叠的群聊',
  '微信运动',
  '微信公众平台',
  '微信安全中心',
  '微信收款助手',
])

function sessionName(session: WechatSession): string {
  return String(session.displayName ?? '').replace(/\s+/g, ' ').trim()
}

/** 这个会话是否适合出现在「最近和谁聊过」的示例里。 */
export function isAskableSession(session: WechatSession): boolean {
  const name = sessionName(session)
  if (name.length < 2) return false
  if (session.username.startsWith('gh_')) return false
  if (session.accountKind === 'official' || session.accountKind === 'service' || session.accountKind === 'kefu') return false
  if (SYSTEM_SESSION_NAMES.has(name)) return false
  return session.type === 'private' || session.type === 'group'
}

function latestAskableSession(sessions: readonly WechatSession[]): WechatSession | undefined {
  let latest: WechatSession | undefined
  let latestTs = Number.NEGATIVE_INFINITY
  for (const session of sessions) {
    if (!isAskableSession(session)) continue
    const ts = Number(session.lastTimestamp)
    if (!Number.isFinite(ts) || ts <= latestTs) continue
    latest = session
    latestTs = ts
  }
  return latest
}

/**
 * 生成空态示例卡。
 *
 * @param sessions - 当前已拉取的会话列表。
 * @param preferredSession - 当前范围选中的会话显示名；为空时选最近的真实会话。
 * @returns 固定三张卡（回顾 / 跟进 / 核对），第一条随真实数据变化。
 */
export function buildAskExamples(
  sessions: readonly WechatSession[],
  preferredSession?: string,
): AskExampleCard[] {
  const preferred = String(preferredSession ?? '').trim()
  const matched = preferred
    ? sessions.find(session => isAskableSession(session) && (
      sessionName(session) === preferred || session.username === preferred
    ))
    : undefined
  const recent = matched ? undefined : latestAskableSession(sessions)
  const selected = matched ?? recent
  const name = selected ? sessionName(selected) : ''
  const recall = name === ''
    ? '最近一周我和谁聊得最多？'
    : selected?.type === 'group'
      ? `最近「${name}」里聊了些什么？`
      : `最近和「${name}」聊了些什么？`

  return [
    { tag: '回顾对话', question: recall },
    { tag: '跟进承诺', question: '最近谁说过要给我发资料？' },
    { tag: '核对转账', question: '最近谁给我转过账？' },
  ]
}

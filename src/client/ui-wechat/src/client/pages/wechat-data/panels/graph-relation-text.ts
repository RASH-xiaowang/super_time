/**
 * 把图谱边上的关系说成人话。
 *
 * 后端证据是 `source:ref#count`（例如 `message_reply:123@chatroom#4`）。
 * 详情如果原样贴出来，用户看到的是编号，不是「谁和谁、因为什么连在一起」。
 */
import { edgeRelationLabel, type GEdge, type GEdgeRelation } from './graph-model.ts'

const MACHINE = /^([a-z][a-z0-9_]*)(?::([^#]+))?(?:#(\d+))?$/

interface ParsedEvidence {
  source: string
  ref?: string
  count?: number
}

function parseEvidence(text: string): ParsedEvidence | null {
  const matched = MACHINE.exec(text.trim())
  const source = matched?.[1]
  if (!matched || source === undefined) return null
  const count = matched[3] !== undefined ? Number(matched[3]) : undefined
  const ref = matched[2]
  return {
    source,
    ...(ref !== undefined && ref !== '' ? { ref } : {}),
    ...(count !== undefined && Number.isFinite(count) ? { count } : {}),
  }
}

function placeName(ref: string | undefined, labelOf: (id: string) => string): string | undefined {
  if (ref === undefined || ref.trim() === '') return undefined
  const named = labelOf(ref).trim()
  if (named !== '' && named !== ref) return named
  if (/[\u4e00-\u9fff]/.test(ref) && !ref.includes('@')) return ref
  if (ref.includes('@chatroom')) return undefined
  if (ref.startsWith('wxid_') || ref.startsWith('gh_')) return undefined
  return ref.length <= 32 ? ref : undefined
}

function evidenceNames(relation: GEdgeRelation, labelOf: (id: string) => string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const item of relation.evidence ?? []) {
    const parsed = parseEvidence(item)
    const name = parsed ? placeName(parsed.ref, labelOf) : item.trim()
    if (name === undefined || name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function plainEvidence(relation: GEdgeRelation): string[] {
  return (relation.evidence ?? []).filter((item) => parseEvidence(item) === null && item.trim() !== '')
}

function quoted(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((name) => `「${name}」`).join('、')
  return names.length > 3 ? `${shown} 等 ${names.length} 处` : shown
}

/** 这条关系上能对上的次数。消息类没有 #count 时用权重。 */
export function relationCount(relation: GEdgeRelation): number {
  let max = 0
  for (const item of relation.evidence ?? []) {
    const parsed = parseEvidence(item)
    if (parsed?.count !== undefined && parsed.count > max) max = parsed.count
  }
  if (max > 0) return max
  const raw = relation.rawKind ?? relation.kind
  const counted = new Set([
    'direct_conversation', 'intimacy', 'group_activity', 'group_conversation',
    'reply', 'quote_reply', 'mention_user', 'call', 'moment_like', 'moment_comment',
    'moment_reply', 'transfer', 'redpacket',
  ])
  if (counted.has(raw)) return Math.max(0, Math.round(relation.weight))
  return 0
}

/** 关系芯片上的短句。一颗芯片只说清「这是什么关系」。 */
export function relationChip(relation: GEdgeRelation, labelOf: (id: string) => string): string {
  const raw = relation.rawKind ?? relation.kind
  const names = evidenceNames(relation, labelOf)
  const count = relationCount(relation)
  const where = names.length > 0 ? quoted(names) : ''
  switch (raw) {
    case 'friend': return '通讯录好友'
    case 'friend_request': return '好友申请'
    case 'direct_conversation':
      return count > 0 ? `消息 ${count} 条` : '有消息往来'
    case 'intimacy': {
      const plain = plainEvidence(relation)
      if (plain[0] !== undefined) return plain[0]
      return count > 0 ? `消息 ${count} 条` : '有消息往来'
    }
    case 'common_group':
    case 'common': return where !== '' ? `同在${where}` : `共同群 ${Math.max(1, Math.round(relation.weight))} 个`
    case 'common_member': return where !== '' ? `共同成员 ${where}` : '有共同成员'
    case 'group_membership': return where !== '' ? `在${where}` : '群成员'
    case 'group_owner': return where !== '' ? `${where}的群主` : '群主'
    case 'group_activity': return count > 1 ? `群里发言 ${count} 条` : '在群里发过言'
    case 'group_conversation': return count > 1 ? `群消息 ${count} 条` : '有群消息'
    case 'invite':
    case 'invitation': return where !== '' ? `邀请进${where}` : '邀请入群'
    case 'reply':
    case 'quote_reply': return count > 1 ? `回复 ${count} 次` : '回复过'
    case 'mention_user':
    case 'mention_member':
    case 'at_user': return count > 1 ? `@ ${count} 次` : '@ 过'
    case 'call': return count > 1 ? `通话 ${count} 次` : '有通话'
    case 'moment_like': return count > 1 ? `点赞 ${count} 次` : '点过赞'
    case 'moment_comment':
    case 'moment_reply': return count > 1 ? `评论 ${count} 次` : '评论过朋友圈'
    case 'transfer': return count > 1 ? `转账 ${count} 笔` : '有转账'
    case 'redpacket': return count > 1 ? `红包 ${count} 个` : '有红包'
    case 'class': return where !== '' ? `同属${where}` : '备注同属一组'
    case 'initial': return '名字首字相同'
    default: return edgeRelationLabel(relation)
  }
}

/** 一条视觉边上全部关系的短句，芯片放不下时只留前三种。 */
export function edgeChipText(edge: GEdge, labelOf: (id: string) => string): string {
  const relations = edge.relations ?? []
  if (relations.length === 0) return edgeKindFallback(edge)
  const bits = relations.slice(0, 3).map((relation) => relationChip(relation, labelOf))
  return relations.length > 3 ? `${bits.join(' · ')} 等 ${relations.length} 种` : bits.join(' · ')
}

function edgeKindFallback(edge: GEdge): string {
  return edge.kind === 'intimacy' ? '和我的消息' : edge.kind === 'common' ? '共同群' : '相连'
}

/**
 * 详情里的一整句。方向写在句子里，不再只给一个权重。
 * @param relation - 聚合后的一种关系。
 * @param labelOf - 节点或群 id → 显示名。对不上就原样返回，调用方应先把「我」和群名映射好。
 */
export function describeRelation(
  relation: GEdgeRelation,
  labelOf: (id: string) => string,
): { title: string; body: string } {
  const from = labelOf(relation.source)
  const to = labelOf(relation.target)
  const names = evidenceNames(relation, labelOf)
  const count = relationCount(relation)
  const where = names.length > 0 ? quoted(names) : ''
  const raw = relation.rawKind ?? relation.kind
  const title = edgeRelationLabel(relation)
  const body = relationBody(raw, relation, from, to, where, count)
  return { title, body }
}

function relationBody(
  raw: string,
  relation: GEdgeRelation,
  from: string,
  to: string,
  where: string,
  count: number,
): string {
  switch (raw) {
    case 'friend':
      return from === '我' ? `${to} 是通讯录好友。` : to === '我' ? `${from} 是通讯录好友。` : `${from} 和 ${to} 在通讯录里互为好友。`
    case 'friend_request':
      return `${from} 向 ${to} 发过好友申请。`
    case 'direct_conversation':
      return count > 0
        ? `${from} 和 ${to} 有 ${count} 条消息。这条线按消息量把人拉近。`
        : `${from} 和 ${to} 有直接消息往来。`
    case 'intimacy': {
      const plain = plainEvidence(relation)
      if (plain.length > 0) return `${plain.join('。')}。这条线按消息量把人拉近，不是另一种社交关系。`
      return count > 0
        ? `${from} 和 ${to} 有 ${count} 条消息。这条线按消息量把人拉近。`
        : `${from} 和 ${to} 有直接消息往来。`
    }
    case 'common_group':
    case 'common':
      return where !== ''
        ? `${from} 和 ${to} 同在 ${where}。`
        : `${from} 和 ${to} 有 ${Math.max(1, Math.round(relation.weight))} 个共同群，群名没有留在这条记录里。`
    case 'common_member':
      return where !== ''
        ? `${from} 和 ${to} 都有成员 ${where}。`
        : `${from} 和 ${to} 有共同成员。`
    case 'group_membership':
      return where !== '' ? `${from} 是 ${where} 的成员。` : `${from} 是 ${to} 的成员。`
    case 'group_owner':
      return where !== '' ? `${from} 是 ${where} 的群主。` : `${from} 是 ${to} 的群主。`
    case 'group_activity':
      return `${from} 在 ${where || `「${to}」`} 发过 ${count > 0 ? count : relation.weight} 条消息。`
    case 'group_conversation':
      return `${from} 和 ${to} 的群消息有 ${count > 0 ? count : relation.weight} 条。`
    case 'invite':
    case 'invitation':
      return where !== ''
        ? `${from} 邀请 ${to} 进入 ${where}。`
        : `${from} 邀请 ${to} 进过群。`
    case 'reply':
    case 'quote_reply':
      return `${from} 回复过 ${to}${count > 1 ? ` ${count} 次` : ''}${where !== '' ? `，发生在 ${where}` : ''}。`
    case 'mention_user':
    case 'mention_member':
    case 'at_user':
      return `${from} @ 过 ${to}${count > 1 ? ` ${count} 次` : ''}${where !== '' ? `，发生在 ${where}` : ''}。`
    case 'call':
      return `${from} 和 ${to} 有 ${count > 0 ? count : relation.weight} 次通话。`
    case 'moment_like':
      return `${from} 给 ${to} 的朋友圈点过赞${count > 1 ? `，${count} 次` : ''}。`
    case 'moment_comment':
    case 'moment_reply':
      return `${from} 评论过 ${to} 的朋友圈${count > 1 ? `，${count} 次` : ''}。`
    case 'transfer':
      return `${from} 向 ${to} 转过账${count > 1 ? `，${count} 笔` : ''}。`
    case 'redpacket':
      return `${from} 和 ${to} 之间有红包${count > 1 ? `，${count} 个` : ''}。`
    case 'class':
      return where !== ''
        ? `${from} 和 ${to} 的备注同属 ${where}。`
        : `${from} 和 ${to} 的备注带同一组编号。这是备注写法，不是聊天里发生过的事。`
    case 'initial':
      return `${from} 和 ${to} 的名字首字相同。这不能说明他们认识。`
    default:
      return where !== '' ? `${from} 与 ${to}：${where}。` : `${from} 与 ${to} 有这条关系。`
  }
}

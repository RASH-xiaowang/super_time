/**
 * Evidence-backed social-graph relation extraction.
 *
 * The graph query must not invent people from raw id fragments. Every edge is
 * therefore emitted only after both endpoints resolve to an actual graph node
 * (`self`, a contact/official account, or a known chatroom). Membership data
 * may mention unknown users; those users remain evidence-only and never become
 * synthetic name nodes.
 *
 * Derived pair edges (common groups / common members) are bounded by a global
 * edge cap and a deterministic pair-work budget. Membership itself is not
 * limited by `shared_members`; that field remains a compact detail payload.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  GraphEdge,
  GraphEdgeDirection,
  GraphEdgeEvidence,
  GraphEdgeType,
} from '../types.ts'
import { withDbAsync } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { parseSnsLikesComments } from './moments.ts'
import { yieldToLoop } from './search-build.ts'

/** Hard cap on the explicit edge payload returned to the renderer. */
export const GRAPH_MAX_OBSERVED_EDGES = 20_000
/** Deterministic CPU budget for pair derivation across all groups/members. */
export const GRAPH_PAIR_WORK_BUDGET = 250_000
/** Keep per-edge proofs small even when a relation repeats thousands of times. */
export const GRAPH_EDGE_EVIDENCE_CAP = 8

const SELF_ID = 'self'
const YIELD_EVERY_PAIRS = 8_192
const YIELD_EVERY_MOMENT_ROWS = 500
const YIELD_EVERY_FUND_ROWS = 500

export type GraphMembershipEvidence = 'chatroom_member' | 'chatroom_snapshot'

/** One locally observed membership; unknown actors are filtered by the extractor. */
export interface GraphMembershipRecord {
  username: string
  sources: readonly GraphMembershipEvidence[]
}

/** A structured inviter -> invitee observation from the group member snapshot. */
export interface GraphInviteRecord {
  group: string
  inviter: string
  invitee: string
}

/** A reply or group @ mention extracted from the bounded message window. */
export interface GraphMessageRelationRecord {
  group: string
  sender: string
  target: string
  /** Reply targets are ordered by confidence: chatusr first, fromusr fallback. */
  targets?: readonly string[]
  type: 'reply' | 'mention_user'
  count: number
}

/** Directed call activity between the logged-in account and one private peer. */
export interface GraphCallRelationRecord {
  /** 会话微信 ID —— 正名见 `WechatSession.username`。 */
  talker: string
  outgoing: number
  incoming: number
}

/** Audit data returned alongside the bounded observed-edge build. */
export interface GraphRelationCoverage {
  derived_pairs: {
    budget: number
    used: number
    truncated: boolean
    common_group: { candidates: number; emitted: number }
    common_member: { candidates: number; emitted: number }
  }
  dropped_edges: number
  dropped_by_type: Partial<Record<GraphEdgeType, number>>
  unresolved_actors: {
    membership: number
    owner: number
    invite: number
    message_relation: number
    total: number
  }
}

/** Inputs prepared by `queryGraph`; all identities are authoritative local ids. */
export interface GraphRelationInput {
  decryptedDir: string
  selfUsername?: string
  personIds: ReadonlySet<string>
  groupIds: ReadonlySet<string>
  friendIds: ReadonlySet<string>
  privateTalkers: ReadonlySet<string>
  /** Talkers still present in a live session row (evidence-only distinction). */
  sessionTalkers: ReadonlySet<string>
  /** Private or group conversations proven by a current session or message table. */
  sessionGroups: ReadonlySet<string>
  messageCounts: ReadonlyMap<string, number>
  groupSenderCounts: ReadonlyMap<string, ReadonlyMap<string, number>>
  membershipByGroup: ReadonlyMap<string, readonly GraphMembershipRecord[]>
  groupOwners: ReadonlyMap<string, string>
  invites: readonly GraphInviteRecord[]
  messageRelations: readonly GraphMessageRelationRecord[]
  callRelations: readonly GraphCallRelationRecord[]
}

interface EdgeInput {
  type: GraphEdgeType
  source: string
  target: string
  direction: GraphEdgeDirection
  weight: number
  evidence: readonly GraphEdgeEvidence[]
}

interface PairWorkBudget {
  used: number
}

type AccumulatedEdge = Omit<GraphEdge, 'evidence' | 'evidence_details'> & {
  evidence: GraphEdgeEvidence[]
}

const TYPE_ORDER: Readonly<Record<GraphEdgeType, number>> = {
  friend: 0,
  direct_conversation: 1,
  group_conversation: 2,
  group_membership: 3,
  group_owner: 4,
  group_activity: 5,
  common_group: 6,
  common_member: 7,
  invite: 8,
  reply: 9,
  mention_user: 10,
  call: 11,
  moment_like: 12,
  moment_comment: 13,
  moment_reply: 14,
  transfer: 15,
  redpacket: 16,
  friend_request: 17,
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(value)
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || value === 'boolean' || typeof value === 'bigint') return String(value)
  return ''
}

function cleanWxid(username: string): string {
  const match = username.match(/^(wxid_[A-Za-z0-9]+)(?:_[A-Za-z0-9]+)?$/)
  return match ? (match[1] ?? username) : username
}

function positiveWeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

function compactRef(value: string | undefined): string | undefined {
  const ref = (value ?? '').trim()
  return ref === '' ? undefined : ref.slice(0, 160)
}

function normalizeEvidence(item: GraphEdgeEvidence): GraphEdgeEvidence | null {
  const count = Number(item.count)
  const evidence: GraphEdgeEvidence = { source: item.source }
  const ref = compactRef(item.ref)
  if (ref !== undefined) evidence.ref = ref
  if (Number.isFinite(count) && count > 0) evidence.count = count
  return evidence
}

/**
 * Canonical, bounded edge map.
 *
 * Undirected endpoints are sorted before keying, so A-B and B-A collapse into
 * one edge. Directed edges keep their explicit direction. Evidence counters are
 * merged by `(source, ref)` and capped to keep IPC payloads bounded.
 */
class EdgeAccumulator {
  private readonly edges = new Map<string, AccumulatedEdge>()
  private readonly droppedByType = new Map<GraphEdgeType, number>()
  private dropped = 0

  get size(): number {
    return this.edges.size
  }

  get droppedCount(): number {
    return this.dropped
  }

  get droppedTypes(): Partial<Record<GraphEdgeType, number>> {
    return Object.fromEntries(this.droppedByType)
  }

  add(input: EdgeInput): boolean {
    let source = input.source
    let target = input.target
    if (!source || !target || source === target) return false
    if (input.direction === 'undirected' && source > target) {
      const swap = source
      source = target
      target = swap
    }
    const key = input.type + '\u0000' + input.direction + '\u0000' + source + '\u0000' + target
    const existing = this.edges.get(key)
    if (existing === undefined && this.edges.size >= GRAPH_MAX_OBSERVED_EDGES) {
      this.dropped += 1
      this.droppedByType.set(input.type, (this.droppedByType.get(input.type) ?? 0) + 1)
      return false
    }
    if (existing !== undefined) {
      existing.weight += positiveWeight(input.weight)
      mergeEvidence(existing.evidence, input.evidence)
      return true
    }
    const evidence: GraphEdgeEvidence[] = []
    mergeEvidence(evidence, input.evidence)
    this.edges.set(key, {
      source,
      target,
      weight: positiveWeight(input.weight),
      type: input.type,
      direction: input.direction,
      evidence,
    })
    return true
  }

  values(): GraphEdge[] {
    return [...this.edges.values()]
      .map((edge) => {
        const evidenceDetails = [...edge.evidence].sort(compareEvidence)
        return {
          ...edge,
          evidence: evidenceDetails.map(formatEvidence),
          evidence_details: evidenceDetails,
        }
      })
      .sort(compareEdges)
  }
}

function formatEvidence(item: GraphEdgeEvidence): string {
  const ref = item.ref === undefined ? '' : ':' + item.ref
  const count = item.count === undefined || item.count === 1 ? '' : '#' + String(item.count)
  return item.source + ref + count
}

function compareEvidence(a: GraphEdgeEvidence, b: GraphEdgeEvidence): number {
  return a.source.localeCompare(b.source)
    || (a.ref ?? '').localeCompare(b.ref ?? '')
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
    || b.weight - a.weight
    || a.source.localeCompare(b.source)
    || a.target.localeCompare(b.target)
}

function mergeEvidence(target: GraphEdgeEvidence[], additions: readonly GraphEdgeEvidence[]): void {
  for (const raw of additions) {
    const item = normalizeEvidence(raw)
    if (item === null) continue
    const existing = target.find((entry) => entry.source === item.source && entry.ref === item.ref)
    if (existing !== undefined) {
      if (item.count !== undefined) existing.count = (existing.count ?? 0) + item.count
      continue
    }
    if (target.length >= GRAPH_EDGE_EVIDENCE_CAP) continue
    target.push(item)
  }
}

/**
 * Resolve raw ids to stable graph ids.
 *
 * A contact row remains the source of truth for non-self identities. We only
 * use the stripped `wxid_*` form as a lookup alias; the emitted id stays the
 * original contact username. Ambiguous aliases are ignored instead of guessing.
 */
class ActorIndex {
  private readonly selfWxid: string
  private readonly personIds: ReadonlySet<string>
  private readonly byCleanId = new Map<string, string | null>()

  constructor(personIds: ReadonlySet<string>, selfUsername?: string) {
    this.personIds = personIds
    this.selfWxid = cleanWxid((selfUsername ?? '').trim())
    for (const id of personIds) {
      const alias = cleanWxid(id)
      if (alias === id) continue
      const current = this.byCleanId.get(alias)
      if (current === undefined) this.byCleanId.set(alias, id)
      else if (current !== id) this.byCleanId.set(alias, null)
    }
  }

  resolve(value: string | null | undefined): string | null {
    const raw = (value ?? '').trim()
    if (raw === '') return null
    if (raw === SELF_ID) return SELF_ID
    if (this.selfWxid !== '' && cleanWxid(raw) === this.selfWxid) return SELF_ID
    if (this.personIds.has(raw)) return raw
    return this.byCleanId.get(cleanWxid(raw)) ?? null
  }
}

function addFriendEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const id of input.friendIds) {
    const target = actors.resolve(id)
    if (target === null || target === SELF_ID) continue
    edges.add({
      type: 'friend',
      source: SELF_ID,
      target,
      direction: 'undirected',
      weight: 1,
      evidence: [{ source: 'contact', count: 1 }],
    })
  }
}

function addConversationEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const talker of input.privateTalkers) {
    const peer = actors.resolve(talker)
    if (peer === null || peer === SELF_ID) continue
    const count = Math.max(0, input.messageCounts.get(talker) ?? 0)
    const hasSession = input.sessionTalkers.has(talker)
    if (!hasSession && count === 0) continue
    edges.add({
      type: 'direct_conversation',
      source: SELF_ID,
      target: peer,
      direction: 'undirected',
      weight: Math.max(1, count),
      evidence: [
        ...(hasSession
          ? [{ source: 'session' as const, ref: talker, count: 1 }]
          : []),
        ...(count > 0 ? [{ source: 'message' as const, ref: talker, count }] : []),
      ],
    })
  }
  for (const group of input.sessionGroups) {
    if (!input.groupIds.has(group)) continue
    const count = Math.max(0, input.messageCounts.get(group) ?? 0)
    const hasSession = input.sessionTalkers.has(group)
    if (!hasSession && count === 0) continue
    edges.add({
      type: 'group_conversation',
      source: SELF_ID,
      target: group,
      direction: 'forward',
      weight: Math.max(1, count),
      evidence: [
        ...(hasSession
          ? [{ source: 'session' as const, ref: group, count: 1 }]
          : []),
        ...(count > 0 ? [{ source: 'message' as const, ref: group, count }] : []),
      ],
    })
  }
}

function membershipEvidence(
  group: string,
  sources: readonly GraphMembershipEvidence[],
): GraphEdgeEvidence[] {
  return sources.map((source) => ({ source, ref: group, count: 1 }))
}

function addMembershipEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const [group, records] of input.membershipByGroup) {
    if (!input.groupIds.has(group)) continue
    for (const record of records) {
      if (record.sources.length === 0) continue
      const member = actors.resolve(record.username)
      if (member === null) continue
      edges.add({
        type: 'group_membership',
        source: member,
        target: group,
        direction: 'forward',
        weight: 1,
        evidence: membershipEvidence(group, record.sources),
      })
    }
  }
}

function addGroupOwnerEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const [group, rawOwner] of input.groupOwners) {
    if (!input.groupIds.has(group)) continue
    const owner = actors.resolve(rawOwner)
    if (owner === null) continue
    edges.add({
      type: 'group_owner',
      source: owner,
      target: group,
      direction: 'forward',
      weight: 1,
      evidence: [{ source: 'chatroom_owner', ref: group, count: 1 }],
    })
  }
}

function addGroupActivityEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const [group, senders] of input.groupSenderCounts) {
    if (!input.groupIds.has(group)) continue
    for (const [username, count] of senders) {
      const member = actors.resolve(username)
      if (member === null || count <= 0) continue
      edges.add({
        type: 'group_activity',
        source: member,
        target: group,
        direction: 'forward',
        weight: count,
        evidence: [{ source: 'message', ref: group, count }],
      })
    }
  }
}

function addInviteEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const invite of input.invites) {
    if (!input.groupIds.has(invite.group)) continue
    const inviter = actors.resolve(invite.inviter)
    const invitee = actors.resolve(invite.invitee)
    if (inviter === null || invitee === null || inviter === invitee) continue
    edges.add({
      type: 'invite',
      source: inviter,
      target: invitee,
      direction: 'forward',
      weight: 1,
      evidence: [{ source: 'chatroom_inviter', ref: invite.group, count: 1 }],
    })
  }
}

function addMessageRelationEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const relation of input.messageRelations) {
    if (!input.groupIds.has(relation.group) && !input.privateTalkers.has(relation.group)) continue
    const count = Math.trunc(relation.count)
    if (!Number.isFinite(count) || count <= 0) continue
    const sender = actors.resolve(relation.sender)
    if (sender === null) continue
    const targetCandidates = relation.targets?.length ? relation.targets : [relation.target]
    const resolvedTargets = targetCandidates
      .map(value => actors.resolve(value))
      .filter((target): target is string => target !== null && target !== sender)
    // Reply targets are confidence-ordered aliases for the same person. A
    // mention list, however, contains independent people; only taking the
    // first resolvable target silently drops every later @ member.
    const targets = relation.type === 'reply'
      ? resolvedTargets.slice(0, 1)
      : [...new Set(resolvedTargets)]
    for (const target of targets) {
      edges.add({
        type: relation.type,
        source: sender,
        target,
        direction: 'forward',
        weight: count,
        evidence: [{
          source: relation.type === 'reply' ? 'message_reply' : 'message_mention',
          ref: relation.group,
          count,
        }],
      })
    }
  }
}

function addCallEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): void {
  for (const relation of input.callRelations) {
    if (!input.privateTalkers.has(relation.talker)) continue
    const peer = actors.resolve(relation.talker)
    if (peer === null || peer === SELF_ID) continue
    const outgoing = Math.trunc(relation.outgoing)
    const incoming = Math.trunc(relation.incoming)
    if (Number.isFinite(outgoing) && outgoing > 0) {
      edges.add({
        type: 'call',
        source: SELF_ID,
        target: peer,
        direction: 'forward',
        weight: outgoing,
        evidence: [{ source: 'message_call', ref: relation.talker, count: outgoing }],
      })
    }
    if (Number.isFinite(incoming) && incoming > 0) {
      edges.add({
        type: 'call',
        source: peer,
        target: SELF_ID,
        direction: 'forward',
        weight: incoming,
        evidence: [{ source: 'message_call', ref: relation.talker, count: incoming }],
      })
    }
  }
}

function knownPeopleInGroup(
  records: readonly GraphMembershipRecord[],
  actors: ActorIndex,
): string[] {
  const members = new Set<string>()
  for (const record of records) {
    if (record.sources.length === 0) continue
    const member = actors.resolve(record.username)
    if (member !== null && member !== SELF_ID) members.add(member)
  }
  return [...members]
}

interface FairPairTask {
  type: 'common_group' | 'common_member'
  candidates: number
  emitted: number
  next: () => EdgeInput | null
}

function pairCount(size: number): number {
  return size < 2 ? 0 : (size * (size - 1)) / 2
}

function makeFairPairTasks(
  input: GraphRelationInput,
  actors: ActorIndex,
): FairPairTask[] {
  const tasks: FairPairTask[] = []

  // One task per group prevents a large first group from starving every later
  // group. Each round-robin turn advances exactly one pair.
  for (const [group, records] of input.membershipByGroup) {
    if (!input.groupIds.has(group)) continue
    const members = knownPeopleInGroup(records, actors).sort((a, b) =>
      Number(input.friendIds.has(b)) - Number(input.friendIds.has(a))
      || (input.messageCounts.get(b) ?? 0) - (input.messageCounts.get(a) ?? 0)
      || a.localeCompare(b),
    )
    if (members.length < 2) continue
    const sourceKinds = new Set<GraphMembershipEvidence>()
    for (const record of records) {
      for (const source of record.sources) sourceKinds.add(source)
    }
    const evidence = membershipEvidence(group, [...sourceKinds].sort())
    let i = 0
    let j = 1
    tasks.push({
      type: 'common_group',
      candidates: pairCount(members.length),
      emitted: 0,
      next: () => {
        if (i >= members.length - 1) return null
        const a = members[i]
        const b = members[j]
        j += 1
        if (j >= members.length) {
          i += 1
          j = i + 1
        }
        if (a === undefined || b === undefined) return null
        return {
          type: 'common_group',
          source: a,
          target: b,
          direction: 'undirected',
          weight: 1,
          evidence,
        }
      },
    })
  }

  // One task per member gives each person's group-pairs a fair turn too.
  const byMember = new Map<string, Array<{ group: string; sources: GraphMembershipEvidence[] }>>()
  for (const [group, records] of input.membershipByGroup) {
    if (!input.groupIds.has(group)) continue
    for (const record of records) {
      if (record.sources.length === 0) continue
      const member = actors.resolve(record.username)
      if (member === null || member === SELF_ID) continue
      let groups = byMember.get(member)
      if (groups === undefined) {
        groups = []
        byMember.set(member, groups)
      }
      groups.push({ group, sources: [...record.sources] })
    }
  }
  for (const [member, rawGroups] of byMember) {
    const groups = [...rawGroups].sort((a, b) =>
      (input.messageCounts.get(b.group) ?? 0) - (input.messageCounts.get(a.group) ?? 0)
      || a.group.localeCompare(b.group),
    )
    if (groups.length < 2) continue
    let i = 0
    let j = 1
    tasks.push({
      type: 'common_member',
      candidates: pairCount(groups.length),
      emitted: 0,
      next: () => {
        if (i >= groups.length - 1) return null
        const a = groups[i]
        const b = groups[j]
        j += 1
        if (j >= groups.length) {
          i += 1
          j = i + 1
        }
        if (a === undefined || b === undefined) return null
        const sources = [...new Set([...a.sources, ...b.sources])].sort()
        return {
          type: 'common_member',
          source: a.group,
          target: b.group,
          direction: 'undirected',
          weight: 1,
          evidence: sources.map((source) => ({ source, ref: member, count: 1 })),
        }
      },
    })
  }
  return tasks
}

async function addCommonPairsFairly(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
  budget: PairWorkBudget,
  coverage: GraphRelationCoverage,
): Promise<void> {
  const tasks = makeFairPairTasks(input, actors)
  let active = tasks
  while (active.length > 0 && budget.used < GRAPH_PAIR_WORK_BUDGET && edges.size < GRAPH_MAX_OBSERVED_EDGES) {
    const nextActive: FairPairTask[] = []
    for (const task of active) {
      if (budget.used >= GRAPH_PAIR_WORK_BUDGET || edges.size >= GRAPH_MAX_OBSERVED_EDGES) break
      const pair = task.next()
      if (pair === null) continue
      nextActive.push(task)
      budget.used += 1
      if (budget.used % YIELD_EVERY_PAIRS === 0) await yieldToLoop()
      if (edges.add(pair)) {
        task.emitted += 1
        coverage.derived_pairs[task.type].emitted += 1
      }
    }
    active = nextActive
  }
  coverage.derived_pairs.truncated = active.length > 0
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name))
  } catch {
    return new Set()
  }
}

function momentDbPath(decryptedDir: string): string | null {
  for (const path of [
    join(decryptedDir, 'sns', 'db_sns', 'sns.db'),
    join(decryptedDir, 'sns', 'sns.db'),
  ]) {
    if (existsSync(path)) return path
  }
  return null
}

async function addMomentEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): Promise<void> {
  if (edges.size >= GRAPH_MAX_OBSERVED_EDGES) return
  const path = momentDbPath(input.decryptedDir)
  if (path === null) return
  try {
    await withDbAsync(path, async (db) => {
      const cols = tableColumns(db, 'SnsTimeLine')
      const userCol = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
      const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
      const tidCol = cols.has('tid') ? 'tid' : cols.has('Id') ? 'Id' : ''
      if (userCol === '' || contentCol === '') return
      const tidSelect = tidCol === '' ? "''" : `CAST(${tidCol} AS TEXT)`
      const rows = db.prepare(
        `SELECT ${userCol} AS u, ${contentCol} AS c, ${tidSelect} AS t FROM SnsTimeLine`,
      ).iterate() as Iterable<Record<string, unknown>>
      let seen = 0
      for (const row of rows) {
        if (seen > 0 && seen % YIELD_EVERY_MOMENT_ROWS === 0) await yieldToLoop()
        seen += 1
        if (edges.size >= GRAPH_MAX_OBSERVED_EDGES) return
        const author = actors.resolve(cellText(row['u']))
        if (author === null) continue
        const tid = cellText(row['t'])
        const ref = compactRef(tid)
        let social: ReturnType<typeof parseSnsLikesComments>
        try {
          social = parseSnsLikesComments(cellText(row['c']))
        } catch {
          continue
        }
        for (const like of social.likes) {
          const actor = actors.resolve(like.username)
          if (actor === null || actor === author) continue
          edges.add({
            type: 'moment_like',
            source: actor,
            target: author,
            direction: 'forward',
            weight: 1,
            evidence: [{
              source: 'sns_like',
              ...(ref === undefined ? {} : { ref }),
              count: 1,
            }],
          })
        }
        for (const comment of social.comments) {
          const actor = actors.resolve(comment.username)
          if (actor === null) continue
          if (actor !== author) {
            edges.add({
              type: 'moment_comment',
              source: actor,
              target: author,
              direction: 'forward',
              weight: 1,
              evidence: [{
                source: 'sns_comment',
                ...(ref === undefined ? {} : { ref }),
                count: 1,
              }],
            })
          }
          const replyTarget = actors.resolve(comment.to_username)
          if (replyTarget !== null && replyTarget !== actor) {
            edges.add({
              type: 'moment_reply',
              source: actor,
              target: replyTarget,
              direction: 'forward',
              weight: 1,
              evidence: [{
                source: 'sns_comment',
                ...(ref === undefined ? {} : { ref }),
                count: 1,
              }],
            })
          }
        }
      }
    })
  } catch {
    // Optional moments DB: malformed schema/content must not take down the graph.
  }
}

function selectedColumn(cols: ReadonlySet<string>, column: string): string {
  return cols.has(column) ? column : "''"
}

async function addFundEdges(
  edges: EdgeAccumulator,
  input: GraphRelationInput,
  actors: ActorIndex,
): Promise<void> {
  if (edges.size >= GRAPH_MAX_OBSERVED_EDGES) return
  const path = join(input.decryptedDir, 'general', 'general.db')
  if (!existsSync(path)) return
  try {
    await withDbAsync(path, async (db) => {
      const transferCols = tableColumns(db, 'transferTable')
      if (
        (transferCols.has('pay_payer') || transferCols.has('pay_receiver'))
        && transferCols.has('session_name')
      ) {
        try {
          const rows = db.prepare(
            `SELECT ${selectedColumn(transferCols, 'session_name')} AS session_name,
                    ${selectedColumn(transferCols, 'pay_payer')} AS pay_payer,
                    ${selectedColumn(transferCols, 'pay_receiver')} AS pay_receiver,
                    ${selectedColumn(transferCols, 'transfer_id')} AS transfer_id
             FROM transferTable`,
          ).iterate() as Iterable<Record<string, unknown>>
          let seen = 0
          for (const row of rows) {
            if (seen > 0 && seen % YIELD_EVERY_FUND_ROWS === 0) await yieldToLoop()
            seen += 1
            if (edges.size >= GRAPH_MAX_OBSERVED_EDGES) return
            const payer = actors.resolve(cellText(row['pay_payer']))
            const receiver = actors.resolve(cellText(row['pay_receiver']))
            if (payer === null || receiver === null || payer === receiver) continue
            const ref = compactRef(cellText(row['transfer_id'])) ?? compactRef(cellText(row['session_name']))
            edges.add({
              type: 'transfer',
              source: payer,
              target: receiver,
              direction: 'forward',
              weight: 1,
              evidence: [{
                source: 'general_transfer',
                ...(ref === undefined ? {} : { ref }),
                count: 1,
              }],
            })
          }
        } catch {
          // Schema drift in transferTable is isolated from red packets/graph nodes.
        }
      }

      const fMessageCols = tableColumns(db, 'FMessageTable')
      if (fMessageCols.has('user_name_')) {
        try {
          const rows = db.prepare(
            `SELECT ${selectedColumn(fMessageCols, 'user_name_')} AS user_name,
                    ${selectedColumn(fMessageCols, 'is_sender_')} AS is_sender,
                    ${selectedColumn(fMessageCols, 'timestamp_')} AS timestamp
             FROM FMessageTable`,
          ).iterate() as Iterable<Record<string, unknown>>
          let seen = 0
          for (const row of rows) {
            if (seen > 0 && seen % YIELD_EVERY_FUND_ROWS === 0) await yieldToLoop()
            seen += 1
            if (edges.size >= GRAPH_MAX_OBSERVED_EDGES) return
            const peer = actors.resolve(cellText(row['user_name']))
            if (peer === null || peer === SELF_ID) continue
            const sender = Number(row['is_sender']) === 1
            const ref = compactRef(cellText(row['timestamp']))
            edges.add({
              type: 'friend_request',
              source: sender ? SELF_ID : peer,
              target: sender ? peer : SELF_ID,
              direction: 'forward',
              weight: 1,
              evidence: [{
                source: 'general_fmessage',
                ...(ref === undefined ? {} : { ref }),
                count: 1,
              }],
            })
          }
        } catch {
          // A missing or schema-drifted FMessageTable must not affect funds.
        }
      }

      const packetCols = tableColumns(db, 'redEnvelopeTable')
      if (packetCols.has('sender_user_name') && packetCols.has('session_name')) {
        try {
          const rows = db.prepare(
            `SELECT ${selectedColumn(packetCols, 'session_name')} AS session_name,
                    sender_user_name AS sender_user_name
             FROM redEnvelopeTable`,
          ).iterate() as Iterable<Record<string, unknown>>
          let seen = 0
          for (const row of rows) {
            if (seen > 0 && seen % YIELD_EVERY_FUND_ROWS === 0) await yieldToLoop()
            seen += 1
            if (edges.size >= GRAPH_MAX_OBSERVED_EDGES) return
            const sessionName = cellText(row['session_name'])
            const sender = actors.resolve(cellText(row['sender_user_name']))
            const peer = actors.resolve(sessionName)
            if (sender === null || peer === null) continue
            if (sessionName.endsWith('@chatroom')) {
              if (sender === peer) continue
              edges.add({
                type: 'redpacket',
                source: sender,
                target: peer,
                direction: 'forward',
                weight: 1,
                evidence: [{
                  source: 'general_redpacket',
                  ref: compactRef(sessionName) ?? sessionName,
                  count: 1,
                }],
              })
              continue
            }
            // In a private red packet row `session_name` is the peer, not the
            // recipient field. The sender may be self or that same peer.
            const source = sender === peer ? peer : sender
            const target = sender === peer ? SELF_ID : peer
            if ((source !== SELF_ID && source !== peer) || source === target) continue
            edges.add({
              type: 'redpacket',
              source,
              target,
              direction: 'forward',
              weight: 1,
              evidence: [{
                source: 'general_redpacket',
                ref: compactRef(sessionName) ?? sessionName,
                count: 1,
              }],
            })
          }
        } catch {
          // Same isolation rule as transferTable.
        }
      }
    })
  } catch {
    // general.db is optional; absence of funds data is not a graph failure.
  }
}

/**
 * Build all explicit edges from locally verified evidence.
 *
 * @param input - stable node ids plus authoritative membership/session data.
 * @returns deduplicated, deterministically ordered edges.
 */
export async function buildObservedEdges(
  input: GraphRelationInput,
  coverage: GraphRelationCoverage = {
    derived_pairs: {
      budget: GRAPH_PAIR_WORK_BUDGET,
      used: 0,
      truncated: false,
      common_group: { candidates: 0, emitted: 0 },
      common_member: { candidates: 0, emitted: 0 },
    },
    dropped_edges: 0,
    dropped_by_type: {},
    unresolved_actors: {
      membership: 0,
      owner: 0,
      invite: 0,
      message_relation: 0,
      total: 0,
    },
  },
): Promise<GraphEdge[]> {
  const edges = new EdgeAccumulator()
  const actors = new ActorIndex(input.personIds, input.selfUsername)
  for (const [group, records] of input.membershipByGroup) {
    if (!input.groupIds.has(group)) continue
    for (const record of records) {
      if (actors.resolve(record.username) === null) coverage.unresolved_actors.membership += 1
    }
  }
  for (const owner of input.groupOwners.values()) {
    if (actors.resolve(owner) === null) coverage.unresolved_actors.owner += 1
  }
  for (const invite of input.invites) {
    if (actors.resolve(invite.inviter) === null || actors.resolve(invite.invitee) === null) {
      coverage.unresolved_actors.invite += 1
    }
  }
  for (const relation of input.messageRelations) {
    if (actors.resolve(relation.sender) === null || actors.resolve(relation.target) === null) {
      coverage.unresolved_actors.message_relation += 1
    }
  }
  coverage.unresolved_actors.total =
    coverage.unresolved_actors.membership
    + coverage.unresolved_actors.owner
    + coverage.unresolved_actors.invite
    + coverage.unresolved_actors.message_relation
  const pairBudget: PairWorkBudget = { used: 0 }
  addFriendEdges(edges, input, actors)
  addConversationEdges(edges, input, actors)
  addMembershipEdges(edges, input, actors)
  addGroupOwnerEdges(edges, input, actors)
  addGroupActivityEdges(edges, input, actors)
  addInviteEdges(edges, input, actors)
  addMessageRelationEdges(edges, input, actors)
  addCallEdges(edges, input, actors)
  // Explicit local evidence outranks derived membership pairs when the
  // payload cap is reached; common-* edges fill the remaining capacity.
  await addMomentEdges(edges, input, actors)
  await addFundEdges(edges, input, actors)
  // Candidate counts are independent of the budget; they make the truncation
  // visible instead of making a missing long-tail relation look absent.
  for (const [group, records] of input.membershipByGroup) {
    if (!input.groupIds.has(group)) continue
    const members = knownPeopleInGroup(records, actors)
    coverage.derived_pairs.common_group.candidates += pairCount(members.length)
  }
  const byMember = new Map<string, number>()
  for (const [group, records] of input.membershipByGroup) {
    if (!input.groupIds.has(group)) continue
    for (const record of records) {
      const member = actors.resolve(record.username)
      if (member !== null && member !== SELF_ID) byMember.set(member, (byMember.get(member) ?? 0) + 1)
    }
  }
  for (const count of byMember.values()) coverage.derived_pairs.common_member.candidates += pairCount(count)
  await addCommonPairsFairly(edges, input, actors, pairBudget, coverage)
  coverage.derived_pairs.used = pairBudget.used
  coverage.dropped_edges = edges.droppedCount
  coverage.dropped_by_type = edges.droppedTypes
  return edges.values()
}

/**
 * 社交图谱关系完整性守卫。
 *
 * 这组用例专门防止三类“界面还能出图、关系却已经丢了”的退化：
 *   ① 后端返回 typed edges，客户端仍只从 group_codes 自行猜边；
 *   ② 同一节点对有多类关系，`paired` 去重把后到的语义静默吞掉；
 *   ③ 详情只取前 12 条连接，却把截断后的数量当成完整关系数。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildGraph,
  connectedEdgesOf,
  DEFAULT_GRAPH_SETTINGS,
  edgeDirectionSymbol,
  edgeRelationLabel,
  edgeRelationLines,
  type GraphSettings,
} from './graph-model.ts'
import { selectEdges } from './graph-canvas.ts'

type RawNode = {
  id: string
  label: string
  kind: string
  is_friend?: boolean
  msg_count?: number
  group_count?: number
  member_count?: number
  group_codes?: string[]
  remark_group?: string
  shared_count?: number
  shared_members?: Array<{ username: string; name: string; is_friend: boolean; msg_count: number }>
}

type RawEdge = {
  source: string
  target: string
  weight: number
  kind?: string
  type?: string
  relation?: string
  label?: string
  bidirectional?: boolean
  directed?: boolean
  direction?: string
  evidence?: string | string[]
  evidences?: string[]
  evidence_details?: Array<{ source?: string; ref?: string; count?: number }>
  evidence_count?: number
  count?: number
}

const SELF: RawNode = { id: 'self', label: '我', kind: 'self' }
const SETTINGS: GraphSettings = {
  ...DEFAULT_GRAPH_SETTINGS,
  nodeLimit: 100,
  friendsOnly: false,
  firstChar: false,
  remarkClass: false,
}

function person(id: string, extra: Partial<RawNode> = {}): RawNode {
  return {
    id,
    label: id,
    kind: 'contact',
    is_friend: true,
    msg_count: 1,
    group_count: 0,
    group_codes: [],
    ...extra,
  }
}

function group(id: string, extra: Partial<RawNode> = {}): RawNode {
  return {
    id,
    label: id,
    kind: 'group',
    is_friend: false,
    msg_count: 0,
    member_count: 2,
    shared_count: 1,
    group_codes: [],
    shared_members: [],
    ...extra,
  }
}

function build(nodes: RawNode[], edges: RawEdge[] = [], settings: GraphSettings = SETTINGS) {
  return buildGraph({ nodes, edges } as never, settings)
}

describe('消费后端带类型观测边', () => {
  it('没有 group_codes 时仍保留后端边，并记录类型、证据与权威来源', () => {
    const g = build(
      [SELF, person('a'), person('b'), person('isolated')],
      [{ source: 'a', target: 'b', weight: 2, kind: 'common', evidence: ['项目群 A'] }],
    )
    const edge = g.edges.find(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edge, '后端 a-b 观测边被完整忽略').toBeDefined()
    expect(edge).toMatchObject({
      kind: 'common',
      weight: 2,
      authoritative: true,
      bidirectional: true,
      relationCount: 1,
    })
    expect(edge?.relations?.[0]).toMatchObject({
      kind: 'common',
      origin: 'backend',
      weight: 2,
      evidence: ['项目群 A'],
    })
    expect(g.nodes.map(n => n.id)).toContain('isolated')
  })

  it('同一关系重复上报会聚合权重、记录数和证据，而不是产生重复视觉边', () => {
    const g = build(
      [SELF, person('a'), person('b')],
      [
        { source: 'a', target: 'b', weight: 1, kind: 'common', evidence: '群 A' },
        { source: 'b', target: 'a', weight: 2, kind: 'common', evidence: '群 B', count: 2 },
      ],
    )
    const edges = g.edges.filter(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edges).toHaveLength(1)
    const relation = edges[0]?.relations?.[0]
    expect(relation).toMatchObject({
      kind: 'common',
      weight: 3,
      count: 3,
      evidenceCount: 2,
      origin: 'backend',
    })
    expect(relation?.evidence).toEqual(['群 A', '群 B'])
  })

  it('未知后端类型归入 custom，但保留原始 kind 与可读 label，不丢成共同群', () => {
    const g = build(
      [SELF, person('a'), person('b')],
      [{ source: 'a', target: 'b', weight: 4, kind: 'co_work', label: '同项目', evidence: ['项目 7'] }],
    )
    const edge = g.edges.find(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edge?.kind).toBe('custom')
    expect(edge?.relations?.[0]).toMatchObject({
      kind: 'custom',
      rawKind: 'co_work',
      label: '同项目',
      origin: 'backend',
    })
  })

  it('同一 pair 的 friend/direct_conversation/moment_like/transfer 全部保留并显示中文语义', () => {
    const g = build(
      [SELF, person('a')],
      [
        { source: 'self', target: 'a', weight: 1, type: 'friend', direction: 'undirected', evidence: ['contact'] },
        { source: 'self', target: 'a', weight: 7, type: 'direct_conversation', direction: 'undirected', evidence: ['message:A'] },
        { source: 'a', target: 'self', weight: 2, type: 'moment_like', direction: 'forward', evidence: ['sns_like:M1'] },
        { source: 'self', target: 'a', weight: 1, type: 'transfer', direction: 'forward', evidence: ['general_transfer:T1'] },
      ],
    )
    const edge = g.edges.find(e => [e.source, e.target].sort().join('|') === 'a|self')
    expect(edge).toBeDefined()
    expect(edge?.relations).toHaveLength(4)
    const byRawKind = new Map(edge?.relations?.map(relation => [relation.rawKind, relation]))
    expect(byRawKind.get('friend')).toMatchObject({ kind: 'social', bidirectional: true })
    expect(byRawKind.get('direct_conversation')).toMatchObject({
      kind: 'intimacy',
      bidirectional: true,
      weight: 7,
    })
    expect(byRawKind.get('moment_like')).toMatchObject({
      source: 'a',
      target: 'self',
      bidirectional: false,
      weight: 2,
    })
    expect(byRawKind.get('transfer')).toMatchObject({
      source: 'self',
      target: 'a',
      bidirectional: false,
      weight: 1,
    })
    expect(new Set(edge?.relations?.map(r => edgeRelationLines({ relations: [r] }, id => id)[0]))).toEqual(new Set([
      '好友 · self ↔ a · 权重 1 · 证据：contact',
      '单聊消息 · self ↔ a · 权重 7 · 证据：message:A',
      '朋友圈点赞 · a → self · 权重 2 · 证据：sns_like:M1',
      '转账 · self → a · 权重 1 · 证据：general_transfer:T1',
    ]))
  })

  it('同一 pair 的 common_group 与 common_member 共享视觉边但保留两种原始关系', () => {
    const g = build(
      [SELF, person('a'), person('b')],
      [
        { source: 'a', target: 'b', weight: 2, type: 'common_group', direction: 'undirected', evidence: ['群 A'] },
        { source: 'b', target: 'a', weight: 1, type: 'common_member', direction: 'undirected', evidence: ['共同成员 C'] },
      ],
    )
    const edge = g.edges.find(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edge?.relations).toHaveLength(2)
    expect(edge?.relations?.map(r => r.rawKind).sort()).toEqual(['common_group', 'common_member'])
    expect(edge?.relations?.map(edgeRelationLabel).sort()).toEqual(['共同成员', '共同群'])
  })

  it('group_owner/invite/reply/mention_user 保留为同一视觉边上的四种有向关系', () => {
    const g = build(
      [SELF, person('a'), person('b')],
      [
        {
          source: 'a',
          target: 'b',
          weight: 1,
          type: 'group_owner',
          evidence_details: [{ source: 'chatroom_snapshot', ref: 'room@chatroom', count: 1 }],
        },
        {
          source: 'a',
          target: 'b',
          weight: 1,
          type: 'invite',
          evidence_details: [{ source: 'message', ref: 'room@chatroom', count: 2 }],
        },
        {
          source: 'b',
          target: 'a',
          weight: 1,
          type: 'reply',
          evidence_details: [{ source: 'message', ref: 'room@chatroom', count: 3 }],
        },
        {
          source: 'a',
          target: 'b',
          weight: 1,
          type: 'mention_user',
          evidence_details: [{ source: 'message', ref: 'room@chatroom', count: 4 }],
        },
      ],
    )
    const edge = g.edges.find(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edge).toBeDefined()
    expect(edge?.relations).toHaveLength(4)
    const byRawKind = new Map(edge?.relations?.map(relation => [relation.rawKind, relation]))
    expect(byRawKind.get('group_owner')).toMatchObject({
      kind: 'common',
      source: 'a',
      target: 'b',
      bidirectional: false,
    })
    expect(byRawKind.get('invite')).toMatchObject({
      kind: 'social',
      source: 'a',
      target: 'b',
      bidirectional: false,
      evidenceCount: 2,
      evidence: ['message:room@chatroom#2'],
    })
    expect(byRawKind.get('reply')).toMatchObject({
      kind: 'social',
      source: 'b',
      target: 'a',
      bidirectional: false,
      evidenceCount: 3,
      evidence: ['message:room@chatroom#3'],
    })
    expect(byRawKind.get('mention_user')).toMatchObject({
      kind: 'social',
      source: 'a',
      target: 'b',
      bidirectional: false,
      evidenceCount: 4,
      evidence: ['message:room@chatroom#4'],
    })
    expect(edge?.relations?.every(relation => relation.bidirectional === false)).toBe(true)
    expect(edgeRelationLabel(byRawKind.get('group_owner')!)).toBe('群主')
    expect(edgeRelationLabel(byRawKind.get('reply')!)).toBe('回复')
  })

  it('综合网络保留真实 owner→group 与 member→group 跨类型端点', () => {
    const g = build(
      [
        SELF,
        person('owner', { group_codes: ['room@chatroom'] }),
        person('member', { group_codes: ['room@chatroom'] }),
        group('room@chatroom'),
      ],
      [
        {
          source: 'owner',
          target: 'room@chatroom',
          weight: 1,
          type: 'group_owner',
          direction: 'forward',
        },
        {
          source: 'member',
          target: 'room@chatroom',
          weight: 1,
          type: 'group_membership',
          direction: 'forward',
        },
        {
          source: 'owner',
          target: 'member',
          weight: 1,
          type: 'common_group',
          direction: 'undirected',
        },
      ],
      { ...SETTINGS, mode: 'all', friendsOnly: false, nodeLimit: 10 },
    )
    expect(g.nodes.map(n => n.id)).toEqual(expect.arrayContaining(['owner', 'member', 'room@chatroom']))
    expect(g.edges.some(e => e.relations?.some(r => r.rawKind === 'group_owner'
      && r.source === 'owner' && r.target === 'room@chatroom'))).toBe(true)
    expect(g.edges.some(e => e.relations?.some(r => r.rawKind === 'group_membership'
      && r.source === 'member' && r.target === 'room@chatroom'))).toBe(true)
    const personPair = g.edges.find(e => [e.source, e.target].sort().join('|') === 'member|owner')
    expect(personPair?.relations).toHaveLength(1)
    expect(personPair?.relations?.[0]).toMatchObject({
      rawKind: 'common_group',
      origin: 'backend',
    })
    expect(g.coverage?.derived?.commonSuppressedByAuthoritative).toBe(1)
    expect(g.coverage?.derived?.commonGeneratedPairs).toBe(0)
  })

  it('节点上限优先保留权威边端点，而不是只按消息量截断', () => {
    const g = build(
      [SELF, person('ordinary', { msg_count: 9999 }), person('owner', { msg_count: 1 }), group('room@chatroom')],
      [{ source: 'owner', target: 'room@chatroom', weight: 1, type: 'group_owner', direction: 'forward' }],
      { ...SETTINGS, mode: 'all', friendsOnly: false, nodeLimit: 2 },
    )
    expect(g.nodes.map(n => n.id).sort()).toEqual(['owner', 'room@chatroom', 'self'].sort())
    expect(g.coverage?.droppedNodes).toBe(1)
    expect(g.coverage?.droppedEdgeEndpoints).toBe(0)
  })

  it('客户端共同群推导超过每群成员预算时如实报告候选、已检查和跳过数量', () => {
    const people = Array.from({ length: 81 }, (_, i) =>
      person(`p${String(i).padStart(2, '0')}`, { group_codes: ['big@chatroom'] }))
    const g = build(
      [SELF, ...people],
      [],
      { ...SETTINGS, mode: 'people', nodeLimit: 100 },
    )
    expect(g.coverage?.derived?.commonGroup).toMatchObject({
      sources: 1,
      truncatedSources: 1,
      candidatePairs: 3240,
      consideredPairs: 3160,
      skippedPairs: 80,
    })
    expect(g.coverage?.derived?.commonGeneratedPairs).toBe(3160)
    expect(g.coverage?.derived?.commonDroppedByEdgeBudget).toBeGreaterThan(0)
    expect(g.coverage?.derived?.truncated).toBe(true)
    expect(g.coverage?.droppedEdges).toBeGreaterThan(0)
  })

  it('综合网络里共同群与共同成员推导同一点对时只生成一条视觉边', () => {
    const g = build(
      [
        SELF,
        person('member'),
        group('room-a@chatroom', {
          group_codes: ['parent@chatroom'],
          shared_members: [{ username: 'member', name: '成员', is_friend: true, msg_count: 1 }],
        }),
        group('room-b@chatroom', {
          group_codes: ['parent@chatroom'],
          shared_members: [{ username: 'member', name: '成员', is_friend: true, msg_count: 1 }],
        }),
      ],
      [],
      { ...SETTINGS, mode: 'all', friendsOnly: false, nodeLimit: 10 },
    )
    const pair = g.edges.filter(e =>
      [e.source, e.target].sort().join('|') === 'room-a@chatroom|room-b@chatroom')
    expect(pair).toHaveLength(1)
    expect(pair[0]?.relations).toHaveLength(1)
    expect(pair[0]?.relations?.[0]).toMatchObject({
      kind: 'common',
      origin: 'derived',
      weight: 2,
      evidenceCount: 2,
    })
    expect(g.coverage?.derived?.commonGeneratedPairs).toBe(1)
  })

  it('客户端共同群推导受全局 pair-work 预算约束时停止并留下可审计证据', () => {
    const groupCodes = Array.from({ length: 39 }, (_, i) => `g${i}@chatroom`)
    const people = Array.from({ length: 80 }, (_, i) => person(`p${i}`, { group_codes: groupCodes }))
    const g = build(
      [SELF, ...people],
      [],
      { ...SETTINGS, mode: 'people', nodeLimit: 100 },
    )
    expect(g.coverage?.derived).toMatchObject({
      pairMemberLimit: 80,
      pairWorkBudget: 120_000,
      pairWorkUsed: 120_000,
      pairWorkExhausted: true,
      truncated: true,
    })
    const groupCoverage = g.coverage?.derived?.commonGroup
    expect(groupCoverage?.candidatePairs).toBe(39 * 3160)
    expect(groupCoverage?.consideredPairs).toBe(120_000)
    expect(groupCoverage?.skippedPairs).toBe(39 * 3160 - 120_000)
    expect(groupCoverage?.truncatedSources).toBeGreaterThan(0)
  })

  it('详情文本同时给出关系类型、方向、权重与证据', () => {
    const g = build(
      [SELF, person('a'), person('b')],
      [{ source: 'a', target: 'b', weight: 4, kind: 'co_work', label: '同项目', evidence: ['项目 7'] }],
    )
    const edge = g.edges.find(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edge && edgeDirectionSymbol(edge)).toBe('↔')
    const lines = edgeRelationLines(edge!, id => id === 'a' ? '甲' : id === 'b' ? '乙' : id)
    expect(lines).toEqual(['同项目 · 甲 ↔ 乙 · 权重 4 · 证据：项目 7'])
  })
})

describe('同一点对聚合多种关系，不丢语义', () => {
  it('后端 custom 关系与推导出的共同群、同班、同首字合并到一条视觉边', () => {
    const nodes = [
      SELF,
      person('a', { label: '项目甲', group_codes: ['g1'], group_count: 1, remark_group: '项目组7' }),
      person('b', { label: '项目乙', group_codes: ['g1'], group_count: 1, remark_group: '项目组7' }),
    ]
    const g = build(
      nodes,
      [{ source: 'a', target: 'b', weight: 3, kind: 'co_work', label: '同项目', evidence: ['项目 7'] }],
      { ...SETTINGS, firstChar: true, remarkClass: true },
    )
    const edges = g.edges.filter(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edges).toHaveLength(1)
    const kinds = new Set(edges[0]?.relations?.map(r => r.kind))
    expect(kinds).toEqual(new Set(['custom', 'common', 'class', 'initial']))
    expect(edges[0]?.kind, '主关系不应被推导层覆盖').toBe('custom')
    expect(edges[0]?.relations?.[0]?.origin).toBe('backend')
  })

  it('后端双向 wiki 两条反向记录聚合后仍能看出两个方向', () => {
    const g = build(
      [SELF, person('a'), person('b')],
      [
        { source: 'a', target: 'b', weight: 1, kind: 'wiki', directed: true },
        { source: 'b', target: 'a', weight: 2, kind: 'wiki', directed: true },
      ],
    )
    const edge = g.edges.find(e => [e.source, e.target].sort().join('|') === 'a|b')
    expect(edge?.bidirectional).toBe(true)
    expect(edge?.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'wiki', source: 'a', target: 'b', bidirectional: false }),
      expect.objectContaining({ kind: 'wiki', source: 'b', target: 'a', bidirectional: false }),
    ]))
  })

  it('只有单向关系时保留原始 source → target，不被字典序改写', () => {
    const g = build(
      [SELF, person('a'), person('b')],
      [{ source: 'b', target: 'a', weight: 1, kind: 'wiki', directed: true }],
    )
    const edge = g.edges.find(e => e.kind === 'wiki')
    expect(edge).toMatchObject({ source: 'b', target: 'a' })
    expect(edge?.bidirectional).toBeUndefined()
  })
})

describe('稳定端点与关系列表完整性', () => {
  it('含 `|` 的 id 不会把两个不同点对拼成同一个键', () => {
    const g = build(
      [SELF, person('a'), person('b|c'), person('a|b'), person('c')],
      [
        { source: 'a', target: 'b|c', weight: 1, kind: 'common' },
        { source: 'a|b', target: 'c', weight: 1, kind: 'common' },
      ],
    )
    const authoritative = g.edges.filter(e => e.authoritative)
    expect(authoritative).toHaveLength(2)
    expect(authoritative.map(e => [e.source, e.target].sort().join('||'))).toEqual(expect.arrayContaining([
      ['a', 'b|c'].sort().join('||'),
      ['a|b', 'c'].sort().join('||'),
    ]))
  })

  it('端点被节点上限挡在图外时边被忽略，不保留悬空端点；孤立节点本身仍保留', () => {
    const g = build(
      [SELF, person('a'), person('b'), person('isolated')],
      [{ source: 'a', target: 'missing', weight: 5, kind: 'common' }],
    )
    const ids = new Set(g.nodes.map(n => n.id))
    expect(g.edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true)
    expect(ids.has('isolated')).toBe(true)
  })

  it('重复节点 id 只保留一个稳定节点，边仍落在同一 id 上', () => {
    const g = build([
      SELF,
      person('a', { label: '先出现' }),
      person('a', { label: '后出现' }),
      person('b'),
    ])
    expect(g.nodes.filter(n => n.id === 'a')).toHaveLength(1)
    expect(g.nodes.find(n => n.id === 'a')?.label).toBe('先出现')
    expect(g.edges.every(e => g.nodes.some(n => n.id === e.source) && g.nodes.some(n => n.id === e.target))).toBe(true)
  })

  it('节点上限排序不会因为 msg_count=0 忽略 group_count，把高连接节点误裁掉', () => {
    const g = build(
      [
        SELF,
        person('few-messages', { msg_count: 1, group_count: 0 }),
        person('many-groups', { msg_count: 0, group_count: 12 }),
      ],
      [],
      { ...SETTINGS, nodeLimit: 1 },
    )
    expect(g.nodes.filter(n => n.kind === 'person').map(n => n.id)).toEqual(['many-groups'])
  })

  it('connectedEdgesOf 默认返回全部连接，不再在 12 条处静默截断', () => {
    const nodes = [SELF, ...Array.from({ length: 15 }, (_, i) => person(`p${i}`))]
    const g = build(nodes)
    expect(connectedEdgesOf(g, 'self')).toHaveLength(15)
  })

  it('画布预算优先完整保留后端权威边，不以推导亲密度把它们挤掉', () => {
    const nodes = [SELF, ...Array.from({ length: 49 }, (_, i) => person(`p${i}`))]
    const edges: RawEdge[] = []
    for (let i = 0; i < nodes.length && edges.length < 301; i++) {
      for (let j = i + 1; j < nodes.length && edges.length < 301; j++) {
        const a = nodes[i]
        const b = nodes[j]
        if (a?.id === 'self' || b?.id === 'self') continue
        if (a && b) edges.push({ source: a.id, target: b.id, weight: 1, kind: 'common' })
      }
    }
    const g = build(nodes, edges, { ...SETTINGS, nodeLimit: 50 })
    expect(g.edges.filter(e => e.authoritative)).toHaveLength(301)
    const drawn = selectEdges(g.edges, g.nodes)
    expect(drawn.filter(e => e.authoritative)).toHaveLength(301)
    expect(drawn.some(e => e.kind === 'intimacy')).toBe(false)
  })
})

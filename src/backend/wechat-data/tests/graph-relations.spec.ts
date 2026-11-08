/**
 * Bounds and fault isolation for the backend observed-edge extractor.
 * @vitest-environment node
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildObservedEdges,
  GRAPH_MAX_OBSERVED_EDGES,
  type GraphRelationCoverage,
  type GraphRelationInput,
} from '../src/query/graph-relations.ts'
import { withTempWorkspace } from '../../tests/helpers/temp-db.ts'

function input(decryptedDir: string, personIds: Iterable<string>): GraphRelationInput {
  return {
    decryptedDir,
    selfUsername: 'wxid_self',
    personIds: new Set(personIds),
    groupIds: new Set(['room@chatroom']),
    friendIds: new Set(),
    privateTalkers: new Set(),
    sessionTalkers: new Set(['room@chatroom']),
    sessionGroups: new Set(['room@chatroom']),
    messageCounts: new Map(),
    groupSenderCounts: new Map(),
    membershipByGroup: new Map(),
    groupOwners: new Map(),
    invites: [],
    messageRelations: [],
    callRelations: [],
  }
}

describe('buildObservedEdges robustness', () => {
  it('returns an empty payload for empty input', async () => {
    await withTempWorkspace('graph-relations-empty', async (ws) => {
      await expect(buildObservedEdges({
        ...input(ws.dir, []),
        groupIds: new Set(),
        sessionGroups: new Set(),
      })).resolves.toEqual([])
    })
  })

  it('isolates malformed optional moment/funds databases', async () => {
    await withTempWorkspace('graph-relations-bad-db', async (ws) => {
      mkdirSync(join(ws.dir, 'sns', 'db_sns'), { recursive: true })
      mkdirSync(join(ws.dir, 'general'), { recursive: true })
      writeFileSync(join(ws.dir, 'sns', 'db_sns', 'sns.db'), 'not a sqlite database')
      writeFileSync(join(ws.dir, 'general', 'general.db'), 'not a sqlite database')
      const edges = await buildObservedEdges({
        ...input(ws.dir, ['wxid_a']),
        friendIds: new Set(['wxid_a']),
      })
      expect(edges.find((edge) => edge.type === 'friend')).toEqual({
        source: 'self',
        target: 'wxid_a',
        weight: 1,
        type: 'friend',
        direction: 'undirected',
        evidence: ['contact'],
        evidence_details: [{ source: 'contact', count: 1 }],
      })
    })
  })

  it('caps pair explosion before the renderer payload becomes unbounded', async () => {
    await withTempWorkspace('graph-relations-cap', async (ws) => {
      const people = Array.from({ length: 260 }, (_, index) => `wxid_p${String(index).padStart(3, '0')}`)
      const coverage: GraphRelationCoverage = {
        derived_pairs: {
          budget: 250_000,
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
      }
      const edges = await buildObservedEdges({
        ...input(ws.dir, people),
        membershipByGroup: new Map([
          ['room@chatroom', people.map((username) => ({ username, sources: ['chatroom_member'] as const }))],
        ]),
      }, coverage)
      expect(edges).toHaveLength(GRAPH_MAX_OBSERVED_EDGES)
      expect(edges.filter((edge) => edge.type === 'common_group')).toHaveLength(
        GRAPH_MAX_OBSERVED_EDGES - people.length - 1,
      )
      expect(coverage.derived_pairs.truncated).toBe(true)
      expect(coverage.dropped_edges).toBe(0)
    })
  })

  it('gives common-group and common-member derivation fair budget turns', async () => {
    await withTempWorkspace('graph-relations-fair-budget', async (ws) => {
      const people = Array.from({ length: 120 }, (_, index) => `wxid_fair_${String(index).padStart(3, '0')}`)
      const coverage: GraphRelationCoverage = {
        derived_pairs: {
          budget: 250_000,
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
      }
      const edges = await buildObservedEdges({
        ...input(ws.dir, people),
        groupIds: new Set(['room-a@chatroom', 'room-b@chatroom']),
        sessionGroups: new Set(['room-a@chatroom', 'room-b@chatroom']),
        membershipByGroup: new Map([
          ['room-a@chatroom', people.map(username => ({ username, sources: ['chatroom_member'] as const }))],
          ['room-b@chatroom', people.map(username => ({ username, sources: ['chatroom_member'] as const }))],
        ]),
      }, coverage)
      expect(edges.some(edge => edge.type === 'common_group')).toBe(true)
      expect(edges.some(edge => edge.type === 'common_member')).toBe(true)
      expect(coverage.derived_pairs.common_group.emitted).toBeGreaterThan(0)
      expect(coverage.derived_pairs.common_member.emitted).toBeGreaterThan(0)
    })
  })
})

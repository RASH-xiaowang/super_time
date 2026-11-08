/**
 * End-to-end coverage for evidence-backed social-graph edges.
 *
 * The fixture uses the same local schemas as the query layer:
 * `SessionTable` + `Msg_*` shards, contact/chatroom membership,
 * `SnsTimeLine`, and the funds tables in general.db.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP,
  queryGraph,
} from '../src/query/graph.ts'
import type { GraphEdge } from '../src/types.ts'
import { withTempWorkspace, type TempWorkspace } from '../../tests/helpers/temp-db.ts'

const A = 'wxid_alpha'
const B = 'wxid_beta'
const C = 'wxid_gamma'
const D = 'wxid_delta'
const SELF = 'wxid_self'
const UNKNOWN = 'wxid_unknown_room_member'
const G1 = '101@chatroom'
const G2 = '202@chatroom'
const G3 = '303@chatroom'
const G4_ROOM_ONLY = '404@chatroom'
const G5_SESSION_ONLY = '505@chatroom'
const G6_ROOM_NO_SNAPSHOT = '606@chatroom'
const G7_EMPTY_SNAPSHOT = '707@chatroom'
const P_MSG_ONLY = 'wxid_message_only'
const OPENIM_CONTACT = '25984982028166460@openim'
const G_OPENIM_ROOM = '25984981869673640@openim'
const OFFICIAL_HARDCODE = 'official_reader@hardcode'

const tableOf = (username: string): string =>
  'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')

function varint(value: number): Buffer {
  const out: number[] = []
  let n = Math.max(0, Math.trunc(value))
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

function lengthField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload])
}

/** Build chat_room.ext_buffer's repeated MemberInfo field. */
function roomSnapshot(
  members: ReadonlyArray<string | { username: string; inviter?: string }>,
): Buffer {
  return Buffer.concat(members.map((raw) => {
    const entry = typeof raw === 'string' ? { username: raw } : raw
    const fields = [lengthField(1, Buffer.from(entry.username, 'utf8'))]
    if (entry.inviter) fields.push(lengthField(4, Buffer.from(entry.inviter, 'utf8')))
    const member = Buffer.concat(fields)
    return lengthField(1, member)
  }))
}

/** A valid empty ext_buffer: only the trailing counter field, no members. */
function emptyRoomSnapshot(): Buffer {
  return Buffer.from([0x18, 0x00])
}

function shardTable(
  db: ReturnType<TempWorkspace['db']>,
  group: string,
  rows: ReadonlyArray<{ senderId: number; count: number }>,
): void {
  const table = tableOf(group)
  db.exec(`CREATE TABLE "${table}" (
    local_id INTEGER PRIMARY KEY,
    real_sender_id INTEGER,
    local_type INTEGER DEFAULT 1,
    create_time INTEGER DEFAULT 0,
    message_content TEXT,
    source TEXT
  )`)
  const insert = db.prepare(`INSERT INTO "${table}" (local_id, real_sender_id, message_content) VALUES (?, ?, ?)`)
  let localId = 1
  for (const row of rows) {
    for (let i = 0; i < row.count; i += 1) {
      insert.run(localId, row.senderId, '')
      localId += 1
    }
  }
}

function seed(ws: TempWorkspace): void {
  for (const dir of ['contact', 'session', 'message', 'sns/db_sns', 'general']) {
    mkdirSync(join(ws.dir, dir), { recursive: true })
  }

  const cdb = ws.db('contact/contact.db')
  cdb.exec(`CREATE TABLE contact (
    id INTEGER PRIMARY KEY,
    username TEXT,
    local_type INTEGER,
    delete_flag INTEGER,
    small_head_url TEXT,
    big_head_url TEXT,
    remark TEXT
  )`)
  const contact = cdb.prepare(
    'INSERT INTO contact (id, username, local_type, delete_flag, small_head_url, big_head_url, remark) VALUES (?, ?, ?, 0, \'\', \'\', \'\')',
  )
  contact.run(1, A, 1)
  contact.run(2, B, 3)
  contact.run(3, C, 1)
  cdb.exec('CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, owner TEXT, ext_buffer BLOB)')
  cdb.exec('CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)')
  const room = cdb.prepare('INSERT INTO chat_room (id, username, owner, ext_buffer) VALUES (?, ?, ?, ?)')
  room.run(10, G1, A, roomSnapshot([
    { username: B, inviter: C },
    { username: C, inviter: A },
    { username: UNKNOWN, inviter: A },
  ]))
  room.run(20, G2, UNKNOWN, null)
  room.run(30, G3, '', roomSnapshot([A, B]))
  room.run(40, G4_ROOM_ONLY, A, roomSnapshot([B]))
  room.run(60, G6_ROOM_NO_SNAPSHOT, A, null)
  room.run(70, G7_EMPTY_SNAPSHOT, A, emptyRoomSnapshot())
  const member = cdb.prepare('INSERT INTO chatroom_member (room_id, member_id) VALUES (?, ?)')
  member.run(10, 1)
  member.run(20, 1)
  member.run(20, 3)
  member.run(40, 2)

  const sdb = ws.db('session/session.db')
  sdb.exec('CREATE TABLE SessionTable (username TEXT)')
  const session = sdb.prepare('INSERT INTO SessionTable (username) VALUES (?)')
  for (const username of [A, D, G1, G2, G3, G5_SESSION_ONLY]) session.run(username)

  const mdb = ws.db('message/message_0.db')
  mdb.exec('CREATE TABLE Name2Id (user_name TEXT)')
  const name = mdb.prepare('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)')
  name.run(1, '')
  name.run(2, A)
  name.run(3, B)
  name.run(4, C)
  name.run(5, UNKNOWN)
  name.run(6, D)
  shardTable(mdb, A, [{ senderId: 2, count: 3 }])
  shardTable(mdb, D, [{ senderId: 2, count: 1 }])
  shardTable(mdb, G1, [
    { senderId: 2, count: 2 },
    { senderId: 3, count: 1 },
    { senderId: 5, count: 2 },
    { senderId: 1, count: 1 },
  ])
  shardTable(mdb, G2, [
    { senderId: 2, count: 1 },
    { senderId: 4, count: 1 },
  ])
  const relationMessage = mdb.prepare(
    `INSERT INTO "${tableOf(G1)}"
       (local_id, real_sender_id, local_type, create_time, message_content, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const replyXml = '<msg><appmsg><title>收到</title><type>57</type>'
    + `<refermsg><fromusr>${G1}</fromusr><chatusr>${B}</chatusr><displayname>Beta</displayname><content>原消息</content></refermsg>`
    + '</appmsg></msg>'
  relationMessage.run(7, 4, 49, 1_700_000_001, replyXml, null)
  const mentionSource = '<msgsource><atuserlist><![CDATA['
    + `${C},${D},${UNKNOWN},notify@all`
    + ']]></atuserlist></msgsource>'
  relationMessage.run(8, 3, 1, 1_700_000_002, '请看一下', mentionSource)
  const privateReply = mdb.prepare(
    `INSERT INTO "${tableOf(D)}"
       (local_id, real_sender_id, local_type, create_time, message_content, source)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
  privateReply.run(
    2,
    6,
    49,
    1_700_000_003,
    `<msg><appmsg><title>私聊收到</title><type>57</type><refermsg><fromusr>${A}</fromusr><displayname>Alpha</displayname><content>原消息</content></refermsg></appmsg></msg>`,
  )
  const privateCall = mdb.prepare(
    `INSERT INTO "${tableOf(D)}"
       (local_id, real_sender_id, local_type, create_time, message_content, source)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
  privateCall.run(3, 1, 50, 1_700_000_004, '')
  privateCall.run(4, 6, 50, 1_700_000_005, '')

  const sns = ws.db('sns/db_sns/sns.db')
  sns.exec('CREATE TABLE SnsTimeLine (user_name TEXT, content TEXT, tid TEXT)')
  const momentXml = [
    '<LocalExtraInfo><comment_user_list>',
    '<user_comment><comment_id>1</comment_id><username>', B, '</username><type>1</type></user_comment>',
    '<user_comment><comment_id>2</comment_id><username>', C, '</username><type>2</type><content>好看</content></user_comment>',
    '<user_comment><comment_id>3</comment_id><username>', A, '</username><type>2</type><content>谢谢</content><ref_comment_id>2</ref_comment_id></user_comment>',
    '</comment_user_list></LocalExtraInfo>',
  ].join('')
  sns.prepare('INSERT INTO SnsTimeLine (user_name, content, tid) VALUES (?, ?, ?)').run(A, momentXml, 'sns-1')

  const general = ws.db('general/general.db')
  general.exec('CREATE TABLE transferTable (session_name TEXT, pay_payer TEXT, pay_receiver TEXT, transfer_id TEXT)')
  general.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?)').run(B, SELF, B, 'tf-1')
  general.exec('CREATE TABLE redEnvelopeTable (session_name TEXT, sender_user_name TEXT)')
  general.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?)').run(B, B)
  general.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?)').run(B, SELF)
  // A group red packet has no uniquely attributable receiver; it must not guess one.
  general.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?)').run(G1, A)
  general.exec('CREATE TABLE FMessageTable (user_name_ TEXT, is_sender_ INTEGER, timestamp_ INTEGER)')
  general.prepare('INSERT INTO FMessageTable VALUES (?, ?, ?)').run(B, 0, 1_700_000_100)
}

function edge(
  edges: readonly GraphEdge[],
  type: GraphEdge['type'],
  source: string,
  target: string,
): GraphEdge | undefined {
  return edges.find((item) => item.type === type && item.source === source && item.target === target)
}

function undirectedEdge(
  edges: readonly GraphEdge[],
  type: GraphEdge['type'],
  a: string,
  b: string,
): GraphEdge | undefined {
  return edges.find((item) =>
    item.type === type
    && item.direction === 'undirected'
    && ((item.source === a && item.target === b) || (item.source === b && item.target === a)))
}

describe('queryGraph observed edges', () => {
  it('emits deduplicated typed evidence without inventing unknown members', async () => {
    await withTempWorkspace('graph-observed', async (ws) => {
      seed(ws)
      const snap = await queryGraph(ws.dir, SELF)
      const byId = new Map(snap.nodes.map((node) => [node.id, node]))

      expect(byId.has(UNKNOWN)).toBe(false)
      const room = byId.get(G1)
      expect(room).toMatchObject({ member_count: 4, shared_count: 3 })
      expect(room?.shared_members?.map((member) => member.username).sort()).toEqual([A, B, C])
      expect(byId.get(G4_ROOM_ONLY)).toMatchObject({
        membership_status: 'known',
        member_count: 1,
      })
      expect(byId.get(G5_SESSION_ONLY)).toMatchObject({
        membership_status: 'unknown',
      })
      expect(byId.get(G5_SESSION_ONLY)?.member_count).toBeUndefined()
      expect(byId.get(G6_ROOM_NO_SNAPSHOT)).toMatchObject({
        membership_status: 'unknown',
      })
      expect(byId.get(G6_ROOM_NO_SNAPSHOT)?.member_count).toBeUndefined()
      expect(byId.get(G7_EMPTY_SNAPSHOT)).toMatchObject({
        membership_status: 'known',
        member_count: 0,
        members_total: 0,
        members_returned: 0,
        members_truncated: false,
      })
      expect(byId.get(G2)).toMatchObject({
        membership_status: 'known',
        member_count: 2,
      })
      expect(byId.get(D)).toMatchObject({ kind: 'contact', is_friend: false, msg_count: 4 })

      expect(edge(snap.edges, 'friend', 'self', A)).toMatchObject({
        direction: 'undirected',
        weight: 1,
        evidence: ['contact'],
        evidence_details: [{ source: 'contact', count: 1 }],
      })
      expect(edge(snap.edges, 'direct_conversation', 'self', A)).toMatchObject({
        direction: 'undirected',
        weight: 3,
      })
      expect(edge(snap.edges, 'direct_conversation', 'self', D)).toMatchObject({
        direction: 'undirected',
        weight: 4,
      })
      expect(edge(snap.edges, 'group_conversation', 'self', G1)).toMatchObject({
        direction: 'forward',
        weight: 8,
      })
      expect(edge(snap.edges, 'group_conversation', 'self', G5_SESSION_ONLY)).toMatchObject({
        direction: 'forward',
        weight: 1,
        evidence_details: [{ source: 'session', ref: G5_SESSION_ONLY, count: 1 }],
      })

      expect(edge(snap.edges, 'group_membership', A, G1)?.evidence_details).toEqual([
        { source: 'chatroom_member', ref: G1, count: 1 },
      ])
      expect(edge(snap.edges, 'group_membership', B, G1)?.evidence_details).toEqual([
        { source: 'chatroom_snapshot', ref: G1, count: 1 },
      ])
      expect(snap.edges.some((item) => item.source === UNKNOWN || item.target === UNKNOWN)).toBe(false)

      expect(edge(snap.edges, 'group_activity', A, G1)?.weight).toBe(2)
      expect(edge(snap.edges, 'group_activity', B, G1)?.weight).toBe(2)
      expect(edge(snap.edges, 'group_activity', C, G1)?.weight).toBe(1)
      expect(edge(snap.edges, 'group_activity', 'self', G1)).toBeUndefined()
      expect(edge(snap.edges, 'group_owner', A, G1)?.evidence_details).toEqual([
        { source: 'chatroom_owner', ref: G1, count: 1 },
      ])
      expect(edge(snap.edges, 'group_owner', A, G4_ROOM_ONLY)).toBeDefined()
      expect(edge(snap.edges, 'group_membership', B, G4_ROOM_ONLY)).toBeDefined()
      expect(edge(snap.edges, 'group_owner', A, G2)).toBeUndefined()
      expect(edge(snap.edges, 'invite', C, B)?.evidence_details).toEqual([
        { source: 'chatroom_inviter', ref: G1, count: 1 },
      ])
      expect(edge(snap.edges, 'invite', A, C)?.direction).toBe('forward')
      expect(edge(snap.edges, 'reply', C, B)?.evidence_details).toEqual([
        { source: 'message_reply', ref: G1, count: 1 },
      ])
      expect(edge(snap.edges, 'reply', D, A)?.evidence_details).toEqual([
        { source: 'message_reply', ref: D, count: 1 },
      ])
      expect(edge(snap.edges, 'mention_user', B, C)?.evidence_details).toEqual([
        { source: 'message_mention', ref: G1, count: 1 },
      ])
      expect(edge(snap.edges, 'mention_user', B, D)?.evidence_details).toEqual([
        { source: 'message_mention', ref: G1, count: 1 },
      ])
      expect(edge(snap.edges, 'call', 'self', D)).toMatchObject({
        direction: 'forward',
        weight: 1,
        evidence_details: [{ source: 'message_call', ref: D, count: 1 }],
      })
      expect(edge(snap.edges, 'call', D, 'self')).toMatchObject({
        direction: 'forward',
        weight: 1,
        evidence_details: [{ source: 'message_call', ref: D, count: 1 }],
      })

      const commonAb = edge(snap.edges, 'common_group', A, B)
      expect(commonAb?.weight).toBe(2)
      expect(commonAb?.evidence_details.map((item) => `${item.source}:${item.ref ?? ''}`).sort()).toEqual([
        `chatroom_member:${G1}`,
        `chatroom_snapshot:${G1}`,
        `chatroom_snapshot:${G3}`,
      ])
      expect(
        edge(snap.edges, 'common_member', G1, G2)?.evidence_details
          .map((item) => `${item.source}:${item.ref ?? ''}`)
          .sort(),
      ).toEqual([
        `chatroom_member:${A}`,
        `chatroom_member:${C}`,
        `chatroom_snapshot:${C}`,
      ])

      expect(edge(snap.edges, 'moment_like', B, A)?.direction).toBe('forward')
      expect(edge(snap.edges, 'moment_comment', C, A)?.evidence_details[0]?.source).toBe('sns_comment')
      expect(edge(snap.edges, 'moment_reply', A, C)?.direction).toBe('forward')
      expect(edge(snap.edges, 'transfer', 'self', B)?.evidence_details[0]?.source).toBe('general_transfer')
      expect(edge(snap.edges, 'redpacket', B, 'self')?.evidence_details).toEqual([
        { source: 'general_redpacket', ref: B, count: 1 },
      ])
      expect(edge(snap.edges, 'redpacket', 'self', B)?.evidence_details).toEqual([
        { source: 'general_redpacket', ref: B, count: 1 },
      ])
      expect(edge(snap.edges, 'redpacket', A, G1)).toBeUndefined()
      expect(edge(snap.edges, 'friend_request', B, 'self')?.evidence_details[0]?.source).toBe('general_fmessage')
      expect(snap.coverage?.observed_edges).toMatchObject({
        cap: 20_000,
        returned: snap.edges.length,
        dropped: 0,
      })
      expect(snap.coverage?.message_relations).toMatchObject({
        per_scope_budget: GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP,
        window_per_scope_cap: GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP,
        record_budget: 50_000,
        dropped_records: 0,
      })
      expect(snap.coverage?.unresolved_actors).toEqual({
        membership: 1,
        owner: 1,
        invite: 1,
        message_relation: 1,
        total: 4,
      })
    })
  })

  it('invalidates the graph cache when an optional relation DB changes', async () => {
    await withTempWorkspace('graph-observed-cache', async (ws) => {
      seed(ws)
      const first = await queryGraph(ws.dir, SELF)
      expect(edge(first.edges, 'redpacket', B, 'self')?.weight).toBe(1)

      const general = ws.db('general/general.db')
      general.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?)').run(B, B)

      const second = await queryGraph(ws.dir, SELF)
      expect(edge(second.edges, 'redpacket', B, 'self')?.weight).toBe(2)
    })
  })

  it('keeps message-only chats and openim groups without duplicating group or self identities', async () => {
    await withTempWorkspace('graph-message-identities', async (ws) => {
      seed(ws)
      const cdb = ws.db('contact/contact.db')
      cdb.prepare(
        'INSERT INTO contact (id, username, local_type, delete_flag, small_head_url, big_head_url, remark) VALUES (?, ?, 1, 0, \'\', \'\', \'\')',
      ).run(80, OPENIM_CONTACT)
      cdb.prepare(
        'INSERT INTO contact (id, username, local_type, delete_flag, small_head_url, big_head_url, remark) VALUES (?, ?, 1, 0, \'\', \'\', \'\')',
      ).run(81, G_OPENIM_ROOM)
      cdb.prepare('INSERT INTO chat_room (id, username, owner, ext_buffer) VALUES (?, ?, ?, ?)')
        .run(81, G_OPENIM_ROOM, A, roomSnapshot([B]))

      const mdb = ws.db('message/message_0.db')
      const name = mdb.prepare('INSERT INTO Name2Id (rowid, user_name) VALUES (?, ?)')
      name.run(7, P_MSG_ONLY)
      name.run(8, OPENIM_CONTACT)
      name.run(9, OFFICIAL_HARDCODE)
      name.run(10, SELF)
      name.run(11, G_OPENIM_ROOM)
      shardTable(mdb, P_MSG_ONLY, [{ senderId: 7, count: 2 }])
      shardTable(mdb, OPENIM_CONTACT, [{ senderId: 8, count: 4 }])
      shardTable(mdb, G_OPENIM_ROOM, [{ senderId: 3, count: 3 }])
      shardTable(mdb, OFFICIAL_HARDCODE, [{ senderId: 9, count: 1 }])
      shardTable(mdb, SELF, [{ senderId: 10, count: 1 }])

      const snap = await queryGraph(ws.dir, SELF)
      const byId = new Map(snap.nodes.map((node) => [node.id, node]))

      expect(byId.get(P_MSG_ONLY)).toMatchObject({
        kind: 'contact',
        is_friend: false,
        msg_count: 2,
      })
      expect(undirectedEdge(snap.edges, 'direct_conversation', 'self', P_MSG_ONLY)?.evidence_details).toEqual([
        { source: 'message', ref: P_MSG_ONLY, count: 2 },
      ])

      expect(byId.get(OPENIM_CONTACT)).toMatchObject({
        kind: 'contact',
        is_friend: true,
        msg_count: 4,
      })
      expect(undirectedEdge(snap.edges, 'direct_conversation', 'self', OPENIM_CONTACT)?.evidence_details).toEqual([
        { source: 'message', ref: OPENIM_CONTACT, count: 4 },
      ])
      expect(edge(snap.edges, 'group_conversation', 'self', OPENIM_CONTACT)).toBeUndefined()

      expect(byId.get(G_OPENIM_ROOM)).toMatchObject({
        kind: 'group',
        membership_status: 'known',
        member_count: 1,
        msg_count: 3,
      })
      expect(byId.get(G_OPENIM_ROOM)?.is_friend).toBe(false)
      expect(edge(snap.edges, 'friend', 'self', G_OPENIM_ROOM)).toBeUndefined()
      expect(edge(snap.edges, 'group_conversation', 'self', G_OPENIM_ROOM)?.evidence_details).toEqual([
        { source: 'message', ref: G_OPENIM_ROOM, count: 3 },
      ])
      expect(edge(snap.edges, 'group_membership', B, G_OPENIM_ROOM)).toBeDefined()
      expect(edge(snap.edges, 'group_owner', A, G_OPENIM_ROOM)).toBeDefined()
      expect(edge(snap.edges, 'group_activity', B, G_OPENIM_ROOM)?.weight).toBe(3)

      expect(byId.get(OFFICIAL_HARDCODE)?.kind).toBe('official')
      expect(undirectedEdge(snap.edges, 'direct_conversation', 'self', OFFICIAL_HARDCODE)?.evidence_details).toEqual([
        { source: 'message', ref: OFFICIAL_HARDCODE, count: 1 },
      ])

      expect(snap.nodes.filter((node) => node.kind === 'self')).toHaveLength(1)
      expect(snap.nodes.some((node) => node.id === SELF)).toBe(false)
      expect(edge(snap.edges, 'direct_conversation', 'self', 'self')).toBeUndefined()
    })
  })

  it('only derives reply/@ edges from the bounded newest message window', async () => {
    await withTempWorkspace('graph-observed-window', async (ws) => {
      seed(ws)
      const mdb = ws.db('message/message_0.db')
      const insert = mdb.prepare(
        `INSERT INTO "${tableOf(G1)}"
           (local_id, real_sender_id, local_type, create_time, message_content, source)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      mdb.exec('BEGIN')
      try {
        for (let index = 0; index < GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP; index += 1) {
          insert.run(100 + index, 3, 1, 1_800_000_000 + index, '新消息')
        }
        mdb.exec('COMMIT')
      } catch (error) {
        mdb.exec('ROLLBACK')
        throw error
      }

      const snap = await queryGraph(ws.dir, SELF)
      expect(edge(snap.edges, 'reply', C, B)).toBeUndefined()
      expect(edge(snap.edges, 'mention_user', B, C)).toBeUndefined()
      expect(edge(snap.edges, 'group_owner', A, G1)).toBeDefined()
      expect(edge(snap.edges, 'invite', C, B)).toBeDefined()
    })
  })
})

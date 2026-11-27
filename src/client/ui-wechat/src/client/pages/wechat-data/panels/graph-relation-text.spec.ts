/**
 * 关系说明要把后端的 source:ref#count 说成谁和谁、因为什么。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { GEdgeRelation } from './graph-model.ts'
import { describeRelation, edgeChipText, relationChip } from './graph-relation-text.ts'

function relation(partial: Partial<GEdgeRelation> & Pick<GEdgeRelation, 'kind' | 'source' | 'target'>): GEdgeRelation {
  return {
    bidirectional: false,
    weight: 1,
    count: 1,
    origin: 'backend',
    ...partial,
  }
}

const names = (id: string): string => {
  if (id === 'self') return '我'
  if (id === 'room@chatroom') return '家人群'
  if (id === 'a') return '甲'
  if (id === 'b') return '乙'
  return id
}

describe('图谱关系说明', () => {
  it('回复依据写成发生在哪个群、几次，而不是 message_reply:群号', () => {
    const item = relation({
      kind: 'social',
      rawKind: 'reply',
      source: 'a',
      target: 'b',
      weight: 4,
      evidence: ['message_reply:room@chatroom#4'],
    })
    expect(relationChip(item, names)).toBe('回复 4 次')
    expect(describeRelation(item, names).body).toBe('甲 回复过 乙 4 次，发生在 「家人群」。')
  })

  it('共同群用群名，机器串里的群号不直接出现', () => {
    const item = relation({
      kind: 'common',
      rawKind: 'common_group',
      source: 'a',
      target: 'b',
      bidirectional: true,
      weight: 1,
      evidence: ['chatroom_member:room@chatroom'],
    })
    expect(relationChip(item, names)).toBe('同在「家人群」')
    expect(describeRelation(item, names).body).toContain('家人群')
    expect(describeRelation(item, names).body).not.toContain('chatroom_member')
  })

  it('已经是中文的证据原样保留', () => {
    const item = relation({
      kind: 'common',
      rawKind: 'common_group',
      source: 'a',
      target: 'b',
      bidirectional: true,
      weight: 1,
      evidence: ['项目群'],
    })
    expect(describeRelation(item, names).body).toBe('甲 和 乙 同在 「项目群」。')
  })

  it('和我的消息用推导时写好的句子，不把共同群个数说成亲密度', () => {
    const item = relation({
      kind: 'intimacy',
      source: 'self',
      target: 'a',
      bidirectional: true,
      weight: 1,
      origin: 'derived',
      evidence: ['和我的消息 0 条'],
    })
    expect(relationChip(item, names)).toBe('和我的消息 0 条')
    expect(describeRelation(item, names).body).toContain('和我的消息 0 条')
  })

  it('一条线上的多种关系都出现在短句里', () => {
    const text = edgeChipText({
      source: 'self',
      target: 'a',
      weight: 7,
      dist: 1,
      kind: 'intimacy',
      relations: [
        relation({ kind: 'intimacy', rawKind: 'direct_conversation', source: 'self', target: 'a', weight: 7, bidirectional: true }),
        relation({ kind: 'social', rawKind: 'moment_like', source: 'a', target: 'self', weight: 2 }),
        relation({ kind: 'social', rawKind: 'transfer', source: 'self', target: 'a', weight: 1 }),
      ],
    }, names)
    expect(text).toBe('消息 7 条 · 点赞 2 次 · 有转账')
  })
})

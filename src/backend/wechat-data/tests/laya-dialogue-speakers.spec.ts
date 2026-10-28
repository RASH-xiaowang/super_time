/**
 * 群聊分析上下文的发言者标签。
 *
 * 旧上下文把非本人消息一律写成「对方」。单聊没问题，群聊却会把多个成员压成同一个人，
 * 让模型误判「一个人连续说了这些话」。这里钉住优先级，并确认两条分析路径都接线。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dialogueSpeakerLabel } from '../src/laya/analysis.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('dialogueSpeakerLabel', () => {
  it('本人始终标成「我」，不受群昵称影响', () => {
    expect(dialogueSpeakerLabel('group@chatroom', {
      isSender: 1, sender: 'wxid_self', senderName: '我自己',
    })).toBe('我')
  })

  it('单聊沿用「对方」，不把联系人昵称塞进模型上下文', () => {
    expect(dialogueSpeakerLabel('wxid_friend', {
      isSender: 0, sender: 'wxid_friend', senderName: '小李',
    })).toBe('对方')
  })

  it('群聊优先用成员昵称，其次用 username，最后退到「群成员」', () => {
    expect(dialogueSpeakerLabel('group@chatroom', {
      isSender: 0, sender: 'wxid_li', senderName: ' 小李 ',
    })).toBe('小李')
    expect(dialogueSpeakerLabel('group@chatroom', {
      isSender: 0, sender: 'wxid_li', senderName: '   ',
    })).toBe('wxid_li')
    expect(dialogueSpeakerLabel('group@chatroom', { isSender: 0 })).toBe('群成员')
  })
})

describe('分析上下文的接线', () => {
  const source = readFileSync(join(HERE, '..', 'src', 'laya', 'analysis.ts'), 'utf8')

  it('会话分析与逐条分析都使用同一个发言者口径，不再硬编码「对方」', () => {
    expect(source).toContain('speaker: dialogueSpeakerLabel(talker, m)')
    expect(source).toContain('`${t.speaker}：${t.text}`')
    expect(source).toContain('lines.push(`${dialogueSpeakerLabel(talker, m)}：${t}`)')
  })
})

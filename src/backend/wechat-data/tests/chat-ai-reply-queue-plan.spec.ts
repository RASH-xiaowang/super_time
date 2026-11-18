// @vitest-environment node
/**
 * 入队计划与 @ 策略的单一决策点。
 *
 * 这里锁的是两条规则本身（不经数据库、不真出网）：
 *  · 私聊：target 是对方，永不 @；
 *  · 群聊：target 是提问者，且**同一批次只有首条 @ 他**。
 */
import { describe, expect, it } from 'vitest'
import {
  chatReplyQueueKind,
  isGroupMessageListRecord,
  mentionOfRecord,
  queueEntryOf,
} from '../src/query/ai-reply/queue-plan.ts'

const base = {
  chatName: '测试群',
  targetName: '张三',
  source: 'ai_reply',
  chatUsername: 'room@chatroom',
}

describe('会话类型判定', () => {
  it('只看 username 后缀，昵称里带「群」字不算群聊', () => {
    expect(chatReplyQueueKind('room@chatroom')).toBe('group')
    expect(chatReplyQueueKind('wxid_peer')).toBe('private')
    expect(chatReplyQueueKind('wxid_团购群')).toBe('private')
    expect(chatReplyQueueKind('')).toBe('private')
  })

  it('入站协议没有 username 时，仅 webhook 来源按「会话名 ≠ 触发对象」兜底', () => {
    expect(isGroupMessageListRecord({
      chatName: '项目群', targetName: 'Y.M', source: 'webhook', chatUsername: '',
    })).toBe(true)
    expect(isGroupMessageListRecord({
      chatName: '小王', targetName: '小王备注', source: 'webhook', chatUsername: '',
    })).toBe(true)
    // 同形状但来源不是 webhook：不能把手工私聊的备注差异猜成群聊。
    expect(isGroupMessageListRecord({
      chatName: '小王', targetName: '小王备注', source: 'manual', chatUsername: '',
    })).toBe(false)
  })
})

describe('群聊 @ 策略：同一批次只在首条点名提问者', () => {
  it('首条与无段号的记录照常 @', () => {
    expect(mentionOfRecord({ ...base, segmentIndex: 1 })).toBe('张三')
    expect(mentionOfRecord({ ...base, segmentIndex: 0 })).toBe('张三')
    expect(mentionOfRecord(base)).toBe('张三')
  })

  it('第 2 段起不再 @，避免一条长回复对同一个人 @ 多次', () => {
    expect(mentionOfRecord({ ...base, segmentIndex: 2 })).toBe('')
    expect(mentionOfRecord({ ...base, segmentIndex: 3 })).toBe('')
  })

  it('私聊任何段都不 @', () => {
    expect(mentionOfRecord({
      chatName: '小王', targetName: '小王', source: 'ai_reply', chatUsername: 'wxid_wang',
    })).toBe('')
    expect(mentionOfRecord({
      chatName: '小王', targetName: '小王', source: 'ai_reply', chatUsername: 'wxid_wang', segmentIndex: 2,
    })).toBe('')
  })

  it('触发对象与会话同名（没解析到提问者）时不 @ 整个群', () => {
    expect(mentionOfRecord({ ...base, targetName: '测试群', segmentIndex: 1 })).toBe('')
    expect(mentionOfRecord({ ...base, targetName: '', segmentIndex: 1 })).toBe('')
  })

  it('脏段号按首条处理：宁可多 @ 一次，也不要漏掉点名', () => {
    expect(mentionOfRecord({ ...base, segmentIndex: Number.NaN })).toBe('张三')
    expect(mentionOfRecord({ ...base, segmentIndex: -1 })).toBe('张三')
  })
})

describe('入队身份：私聊与群聊各一套', () => {
  it('私聊：发送目的与触发对象都是对方', () => {
    expect(queueEntryOf({
      chatUsername: 'wxid_wang',
      chatName: '小王',
      // 私聊即使误传了提问者也必须被忽略。
      mentionName: '张三',
      mentionUsername: 'wxid_asker',
    })).toEqual({
      chatName: '小王',
      chatUsername: 'wxid_wang',
      targetName: '小王',
      targetUsername: 'wxid_wang',
    })
  })

  it('群聊：发送目的是群，触发对象是提问者', () => {
    expect(queueEntryOf({
      chatUsername: 'room@chatroom',
      chatName: '测试群',
      mentionName: '张三',
      mentionUsername: 'wxid_asker',
    })).toEqual({
      chatName: '测试群',
      chatUsername: 'room@chatroom',
      targetName: '张三',
      targetUsername: 'wxid_asker',
    })
  })

  it('群聊没解析到提问者时回落群名，投递端据此不发 mention', () => {
    const entry = queueEntryOf({ chatUsername: 'room@chatroom', chatName: '测试群' })
    expect(entry.targetName).toBe('测试群')
    expect(mentionOfRecord({ ...entry, source: 'ai_reply', segmentIndex: 1 })).toBe('')
  })

  it('会话名为空时回落 username，不会写出空 target', () => {
    expect(queueEntryOf({ chatUsername: 'room@chatroom', chatName: '' }).chatName)
      .toBe('room@chatroom')
    expect(queueEntryOf({ chatUsername: 'wxid_wang', chatName: '  ' }).targetName)
      .toBe('wxid_wang')
  })
})

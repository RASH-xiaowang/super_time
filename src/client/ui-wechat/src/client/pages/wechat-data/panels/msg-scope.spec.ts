/**
 * 消息列表归属校验：单聊里出现第三种发送者 = 这份列表不是这个会话的。
 *
 * 背景见 `msg-scope.ts` 的文件头：缓存（`chat-msgs:<talker>`）被写坏时，服务端返回的
 * 是对的、界面显示的却是别人的消息 —— 读取时按这条硬不变量拦下来。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { cachedMessagesMatchTalker, messagesMatchTalker } from './msg-scope.ts'

const TALKER = 'wxid_peer'
const SELF = 'wxid_me'
const msg = (isSender: number, sender?: string) => ({ isSender, sender })

describe('messagesMatchTalker', () => {
  it('单聊：自己发的 + 对方发的 + 未解析出发送者的行 ⇒ 归属成立', () => {
    expect(messagesMatchTalker([msg(1), msg(0, TALKER), msg(0, ''), { isSender: 0 }], TALKER, SELF)).toBe(true)
  })

  it('单聊：出现第三方发送者 ⇒ 判伪（这就是要拦的形态）', () => {
    expect(messagesMatchTalker([msg(0, TALKER), msg(0, 'wxid_someone_else')], TALKER, SELF)).toBe(false)
  })

  it('单聊：把「自己」标成对方的旧数据 ⇒ 仍算归属（selfWxid 已知时）', () => {
    expect(messagesMatchTalker([msg(0, SELF)], TALKER, SELF)).toBe(true)
  })

  it('selfWxid 未知时不能据此判真——只有第三方才判伪', () => {
    expect(messagesMatchTalker([msg(0, TALKER)], TALKER, '')).toBe(true)
    expect(messagesMatchTalker([msg(0, 'wxid_x')], TALKER, '')).toBe(false)
  })

  it('群聊不适用这条判据（群里本来就有多个发送者）⇒ 恒真', () => {
    const group = '12345@chatroom'
    expect(messagesMatchTalker([msg(0, 'a'), msg(0, 'b'), msg(0, 'c')], group, SELF)).toBe(true)
  })

  it('空列表算「没缓存」而不是「归属成立」——两者在调用方都是重新取数', () => {
    expect(messagesMatchTalker([], TALKER, SELF)).toBe(true)
  })
})

describe('cachedMessagesMatchTalker（读渲染缓存时的更严判据）', () => {
  it('单聊缓存必须拿得出发送者证据：接收方向的行缺 sender ⇒ 不画（旧缓存/旧后端）', () => {
    // 2026-09 的脏缓存就是这种形态：整份列表没有 sender，宽松判据全放行。
    expect(cachedMessagesMatchTalker([{ isSender: 0 }, { isSender: 0 }], TALKER, SELF)).toBe(false)
    expect(cachedMessagesMatchTalker([msg(0), msg(0, TALKER)], TALKER, SELF), '掺了一行无证据的接收消息也不能冒险').toBe(false)
  })

  it('单聊：接收方向的行都带 sender 且只指向对端/自己 ⇒ 可用', () => {
    expect(cachedMessagesMatchTalker([msg(1), msg(0, TALKER), msg(0, SELF)], TALKER, SELF)).toBe(true)
  })

  it('单聊：出现第三方发送者 ⇒ 不可用（这就是串会话的缓存）', () => {
    expect(cachedMessagesMatchTalker([msg(0, TALKER), msg(0, 'wxid_other')], TALKER, SELF)).toBe(false)
  })

  it('只有自己发的行 ⇒ 无法证明归属，宁可不画（多取一次权威数据）', () => {
    expect(cachedMessagesMatchTalker([msg(1), msg(1)], TALKER, SELF)).toBe(false)
  })

  it('空列表仍算「没缓存」；群聊不适用发送者判据', () => {
    expect(cachedMessagesMatchTalker([], TALKER, SELF)).toBe(true)
    expect(cachedMessagesMatchTalker([msg(0, 'a'), msg(0, 'b')], '1@chatroom', SELF)).toBe(true)
  })
})

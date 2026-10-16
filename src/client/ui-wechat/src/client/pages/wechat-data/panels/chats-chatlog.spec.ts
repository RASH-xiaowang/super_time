// @vitest-environment node
/**
 * 聊天记录卡片读法的算术守卫（#19 第六刀：`chats-chatlog.ts`）。
 *
 * 五条规则里最该钉的是第 ③ 条：语音与视频的时长**单位不同**（20 毫秒一格 vs 毫秒），
 * 拿同一个除数处理两者不会报错、不会红类型，只会让用户看到一条 40 秒的语音。
 * 其余四条都是"界面一眼能看出错了"的那种，改前同样一条用例都没有。
 */
import { describe, expect, it } from 'vitest'
import {
  chatlogBodyOf, chatlogFallbackChar, chatlogKindOf, chatlogLinkOf,
  chatlogNestedCount, chatlogNestedLabel,
} from './chats-chatlog.ts'
import type { ChatlogRecord } from '@deepseek-ai/dsh-wechat-data/types'

const rec = (over: Partial<ChatlogRecord> = {}): ChatlogRecord =>
  ({ name: '甲', time: '2026-09-26 10:00', text: '正文', ...over }) as ChatlogRecord

describe('渲染种类', () => {
  it('renderType 说了算；缺省时只有 isImage 能顶一下，其余落文本', () => {
    expect(chatlogKindOf(rec({ renderType: 'voice' }))).toBe('voice')
    expect(chatlogKindOf(rec({ isImage: true }))).toBe('image')
    expect(chatlogKindOf(rec())).toBe('text')
    expect(chatlogKindOf(rec({ isImage: false }))).toBe('text')
    // renderType 与 isImage 同时在场时按 renderType（图片卡片被标成别的种类是有意的）
    expect(chatlogKindOf(rec({ renderType: 'emoji', isImage: true }))).toBe('emoji')
  })
})

describe('链接与嵌套', () => {
  it('链接地址按 link → url → 空 的优先级收成一个（空串就是"没有链接"）', () => {
    expect(chatlogLinkOf(rec({ link: 'https://a', url: 'https://b' }))).toBe('https://a')
    expect(chatlogLinkOf(rec({ url: 'https://b' }))).toBe('https://b')
    expect(chatlogLinkOf(rec())).toBe('')
  })

  it('没有 nested 字段时报 0 条（不是 undefined，也不能崩）', () => {
    expect(chatlogNestedCount(rec())).toBe(0)
    expect(chatlogNestedCount(rec({ nested: [] }))).toBe(0)
    expect(chatlogNestedCount(rec({ nested: [rec(), rec()] }))).toBe(2)
  })

  it('嵌套文案：有内层数据报条数，没有报「点击查看」，标题为空退到「聊天记录」', () => {
    expect(chatlogNestedLabel(rec({ text: '群聊记录', nested: [rec(), rec(), rec()] }))).toBe('📋 群聊记录（3 条）')
    expect(chatlogNestedLabel(rec({ text: '群聊记录' }))).toBe('📋 群聊记录（点击查看）')
    expect(chatlogNestedLabel(rec({ text: '' }))).toBe('📋 聊天记录（点击查看）')
  })
})

describe('时长换算（这一族最容易写反的一条）', () => {
  it('语音是 20 毫秒一格 ⇒ 除以 20；视频是毫秒 ⇒ 除以 1000', () => {
    expect(chatlogBodyOf(rec({ renderType: 'voice', duration: '100' }))).toBe('🎤 正文5"')
    expect(chatlogBodyOf(rec({ renderType: 'video', duration: '100000' }))).toBe('🎬 正文100s')
    expect(chatlogBodyOf(rec({ renderType: 'voice', duration: '30' }))).toBe('🎤 正文2"')
  })

  it('没有 duration ⇒ 尾巴整个没有（不是 NaN、也不是 0）；0 是合法值', () => {
    expect(chatlogBodyOf(rec({ renderType: 'voice' }))).toBe('🎤 正文')
    expect(chatlogBodyOf(rec({ renderType: 'voice', duration: '0' }))).toBe('🎤 正文0"')
    expect(chatlogBodyOf(rec({ renderType: 'voice', text: '' }))).toBe('🎤 [语音]')
    expect(chatlogBodyOf(rec({ renderType: 'video', text: '' }))).toBe('🎬 [视频]')
  })
})

describe('整行正文', () => {
  it('表情/图片/文本/嵌套各有自己的形状', () => {
    expect(chatlogBodyOf(rec({ renderType: 'emoji', text: '' }))).toBe('😀 [表情]')
    expect(chatlogBodyOf(rec({ renderType: 'emoji', text: '[坏表情]' }))).toBe('😀 [坏表情]')
    expect(chatlogBodyOf(rec({ isImage: true, datasize: '20480' }))).toBe('🖼️ [图片] (20480 字节)')
    expect(chatlogBodyOf(rec({ isImage: true }))).toBe('🖼️ [图片]')
    expect(chatlogBodyOf(rec({ renderType: 'chatHistory', text: '' }))).toBe('')
    expect(chatlogBodyOf(rec({ text: '' }))).toBe('')
  })

  it('链接那一支报"文案"（没有 text 时用地址自己顶上，JSX 只是把它包成 <a>）', () => {
    expect(chatlogBodyOf(rec({ renderType: 'link', text: '点我', url: 'https://b' }))).toBe('点我')
    expect(chatlogBodyOf(rec({ renderType: 'link', text: '', url: 'https://b' }))).toBe('https://b')
    expect(chatlogBodyOf(rec({ renderType: 'link', text: '' }))).toBe('')
  })

  it('头像回退字母：名字为空用 ?，非空取首字符（不能留空格子）', () => {
    expect(chatlogFallbackChar(rec({ name: '张三' }))).toBe('张')
    expect(chatlogFallbackChar(rec({ name: '' }))).toBe('?')
    expect(chatlogFallbackChar({ name: undefined } as unknown as ChatlogRecord)).toBe('?')
  })
})

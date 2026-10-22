/**
 * `@` 范围选择触发器的纯逻辑判据。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { detectScopeTrigger, removeScopeTrigger } from './ask-scope-trigger.ts'

describe('输入 @ 触发检索范围选择', () => {
  it('空输入输入 @ 会触发', () => {
    expect(detectScopeTrigger('', '@', 1, 'insertText')).toBe(0)
  })

  it('空白之后输入 @ 会触发', () => {
    expect(detectScopeTrigger('帮我查一下 ', '帮我查一下 @', 7, 'insertText')).toBe(6)
    expect(detectScopeTrigger('第一行\n', '第一行\n@', 5, 'insertText')).toBe(4)
  })

  it('紧贴字母时按邮箱片段处理，不触发', () => {
    expect(detectScopeTrigger('a', 'a@', 2, 'insertText')).toBeNull()
  })

  it('粘贴与删除都不会误触发', () => {
    expect(detectScopeTrigger('', '@', 1, 'insertFromPaste')).toBeNull()
    expect(detectScopeTrigger('@', '', 0, 'deleteContentBackward')).toBeNull()
  })

  it('只移除触发位置的 @，保留其他文本和邮箱', () => {
    expect(removeScopeTrigger('查一下 @最近谁找过我', 4)).toBe('查一下 最近谁找过我')
    expect(removeScopeTrigger('a@b.com', 3)).toBe('a@b.com')
    expect(removeScopeTrigger('查一下 @', 4)).toBe('查一下 ')
  })
})

/** AI answers must use customer-visible names, never raw WeChat identifiers. */
import { describe, expect, it } from 'vitest'
import type { AnswerRuntimeCitation } from '../src/query/answer-runtime/types.ts'
import {
  buildSynthRules,
  replaceAnswerIdentities,
} from '../src/remotes/ask-runtime-prompt.ts'

const citation: AnswerRuntimeCitation = {
  index: 1,
  evidenceId: 'msg:wxid_alice:7',
  source: 'msg',
  name: '房东老陈',
  time: '2026-11-01 10:00',
  snippet: '明天下午签合同',
  username: 'wxid_alice',
  local_id: 7,
  sender: '房东老陈',
  locator: {
    type: 'message',
    username: 'wxid_alice',
    localId: 7,
    key: 'wxid_alice:7',
  },
}

describe('AI answer identity sanitization', () => {
  it('returns the real remark for a cited contact and a neutral label for unknown IDs', () => {
    expect(replaceAnswerIdentities(
      'wxid_alice 说合同改到明天，wxid_unknown 也在群里，123456@chatroom 已确认。[1]',
      [citation],
    )).toBe('房东老陈 说合同改到明天，某位联系人 也在群里，该群聊 已确认。[1]')
  })

  it('prompts the synthesis model not to copy internal identifiers', () => {
    const rules = buildSynthRules('')
    expect(rules).toContain('先结论后要点')
    expect(rules).toContain('2-4 条关键事实')
    expect(rules).toContain('不要按消息逐条倾倒记录')
    expect(rules).toContain('联系人只用网名或备注')
    expect(rules).toContain('wxid_*')
    expect(rules).toContain('*@chatroom')
  })
})

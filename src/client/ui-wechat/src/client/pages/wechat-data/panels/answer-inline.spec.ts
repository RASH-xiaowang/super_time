/**
 * Inline answer formatting must stay safe and display model emphasis correctly.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { parseAnswerInline } from './answer-inline.ts'

describe('parseAnswerInline', () => {
  it('renders strong and emphasis instead of leaking asterisks', () => {
    expect(parseAnswerInline('**重点**和*补充*')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: '重点' }] },
      { kind: 'text', text: '和' },
      { kind: 'emphasis', children: [{ kind: 'text', text: '补充' }] },
    ])
  })

  it('keeps citations clickable inside emphasized text', () => {
    expect(parseAnswerInline('**结论**[1][2]')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: '结论' }] },
      { kind: 'cite', n: 1 },
      { kind: 'cite', n: 2 },
    ])
  })

  it('does not parse markers inside inline code', () => {
    expect(parseAnswerInline('执行 `a ** b`')).toEqual([
      { kind: 'text', text: '执行 ' },
      { kind: 'code', text: 'a ** b' },
    ])
  })

  it('leaves unmatched markers literal', () => {
    expect(parseAnswerInline('**未闭合')).toEqual([{ kind: 'text', text: '**未闭合' }])
  })

  it('does not treat non-citation brackets as citations', () => {
    expect(parseAnswerInline('见 [附录] 与 [1,2]')).toEqual([
      { kind: 'text', text: '见 [附录] 与 [1,2]' },
    ])
  })
})

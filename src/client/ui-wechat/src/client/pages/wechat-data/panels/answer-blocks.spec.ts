/**
 * Safe answer block parsing.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { parseAnswerBlocks } from './answer-blocks.ts'

describe('parseAnswerBlocks', () => {
  it('parses mixed Markdown in source order', () => {
    const source = [
      '# Answer',
      '',
      'First paragraph',
      'continues here.',
      '',
      '## Details',
      '- alpha',
      '* beta',
      '',
      '1. one',
      '2. two',
      '',
      '> quoted line',
      '> second line',
      '',
      '```ts',
      'const x = 1',
      'console.log(x)',
      '```',
      '',
      'Closing paragraph.',
    ].join('\n')

    expect(parseAnswerBlocks(source)).toEqual([
      { type: 'heading', level: 1, text: 'Answer' },
      { type: 'paragraph', text: 'First paragraph\ncontinues here.' },
      { type: 'heading', level: 2, text: 'Details' },
      { type: 'list', ordered: false, items: ['alpha', 'beta'] },
      { type: 'list', ordered: true, items: ['one', 'two'] },
      { type: 'quote', text: 'quoted line\nsecond line' },
      { type: 'code', language: 'ts', code: 'const x = 1\nconsole.log(x)' },
      { type: 'paragraph', text: 'Closing paragraph.' },
    ])
  })

  it('keeps fenced content literal and supports an unterminated fence', () => {
    const fenced = [
      '```html',
      '# not a heading',
      '- not a list',
      '> not a quote',
      '```',
    ].join('\n')

    expect(parseAnswerBlocks(fenced)).toEqual([{
      type: 'code',
      language: 'html',
      code: '# not a heading\n- not a list\n> not a quote',
    }])

    expect(parseAnswerBlocks('```\nremaining code')).toEqual([{
      type: 'code',
      language: '',
      code: 'remaining code',
    }])
  })

  it('keeps list markers and paragraph line breaks without truncation', () => {
    const source = [
      'Intro line',
      'second line',
      '',
      '- first',
      '- second',
      '',
      '1. ordered first',
      '2. ordered second',
    ].join('\n')

    expect(parseAnswerBlocks(source)).toEqual([
      { type: 'paragraph', text: 'Intro line\nsecond line' },
      { type: 'list', ordered: false, items: ['first', 'second'] },
      { type: 'list', ordered: true, items: ['ordered first', 'ordered second'] },
    ])
  })

  it('keeps HTML as plain text instead of interpreting it', () => {
    const source = [
      '<div onclick="alert(1)">hello</div>',
      '<script>alert(1)</script>',
    ].join('\n')

    expect(parseAnswerBlocks(source)).toEqual([{
      type: 'paragraph',
      text: '<div onclick="alert(1)">hello</div>\n<script>alert(1)</script>',
    }])
  })

  it('returns stable results for empty and plain text input', () => {
    expect(parseAnswerBlocks('')).toEqual([])
    expect(parseAnswerBlocks('\n \r\n\t')).toEqual([])
    expect(parseAnswerBlocks('plain text')).toEqual([
      { type: 'paragraph', text: 'plain text' },
    ])
  })

  it('does not silently truncate long paragraphs', () => {
    const longText = 'x'.repeat(20_000)
    expect(parseAnswerBlocks(longText)).toEqual([
      { type: 'paragraph', text: longText },
    ])
  })
})

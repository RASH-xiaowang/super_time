/**
 * Safe inline Markdown tokenizer for model answers.
 *
 * Supported inline forms are strong emphasis, emphasis, inline code and the
 * citation marker `[n]`. Every token is rendered through React text/element
 * nodes by the caller; the parser never produces HTML.
 */

export type AnswerInlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; n: number }
  | { kind: 'strong'; children: AnswerInlineToken[] }
  | { kind: 'emphasis'; children: AnswerInlineToken[] }
  | { kind: 'code'; text: string }

const MAX_NESTING = 12

function pushText(tokens: AnswerInlineToken[], text: string): void {
  if (text === '') return
  const last = tokens[tokens.length - 1]
  if (last?.kind === 'text') {
    last.text += text
    return
  }
  tokens.push({ kind: 'text', text })
}

/**
 * Tokenize one inline run while preserving the original order.
 *
 * Unmatched markers stay literal. Single `*` markers only open emphasis when
 * they are not part of a `**` pair, which avoids turning multiplication-like
 * prose into markup.
 */
export function parseAnswerInline(value: string, depth = 0): AnswerInlineToken[] {
  if (value === '') return []
  if (depth > MAX_NESTING) return [{ kind: 'text', text: value }]

  const tokens: AnswerInlineToken[] = []
  const marker = /(\*\*|`|\*|\[(\d{1,3})\])/g
  let textStart = 0
  let match: RegExpExecArray | null

  while ((match = marker.exec(value)) !== null) {
    const at = match.index
    const raw = match[0]
    let end = at + raw.length
    let token: AnswerInlineToken | null = null

    if (match[2] !== undefined) {
      token = { kind: 'cite', n: Number(match[2]) }
    } else if (raw === '`') {
      const close = value.indexOf('`', at + 1)
      if (close > at + 1) {
        token = { kind: 'code', text: value.slice(at + 1, close) }
        end = close + 1
      }
    } else if (raw === '**') {
      const close = value.indexOf('**', at + 2)
      if (close > at + 2) {
        token = {
          kind: 'strong',
          children: parseAnswerInline(value.slice(at + 2, close), depth + 1),
        }
        end = close + 2
      }
    } else if (
      raw === '*'
      && value[at - 1] !== '*'
      && value[at + 1] !== '*'
    ) {
      const close = value.indexOf('*', at + 1)
      if (close > at + 1 && value[close + 1] !== '*') {
        token = {
          kind: 'emphasis',
          children: parseAnswerInline(value.slice(at + 1, close), depth + 1),
        }
        end = close + 1
      }
    }

    if (token === null) continue
    pushText(tokens, value.slice(textStart, at))
    tokens.push(token)
    textStart = end
    marker.lastIndex = end
  }

  pushText(tokens, value.slice(textStart))
  return tokens
}

/**
 * Safe block parser for answer text.
 *
 * This module only classifies plain text. It never builds HTML or interprets
 * tags, so consumers must render every returned string through normal text
 * nodes. Unknown Markdown and HTML remain literal text.
 */

export interface AnswerHeadingBlock {
  type: 'heading'
  level: 1 | 2 | 3
  text: string
}

export interface AnswerParagraphBlock {
  type: 'paragraph'
  text: string
}

export interface AnswerListBlock {
  type: 'list'
  ordered: boolean
  items: string[]
}

export interface AnswerQuoteBlock {
  type: 'quote'
  text: string
}

export interface AnswerCodeBlock {
  type: 'code'
  language: string
  code: string
}

export type AnswerBlock =
  | AnswerHeadingBlock
  | AnswerParagraphBlock
  | AnswerListBlock
  | AnswerQuoteBlock
  | AnswerCodeBlock

interface HeadingMatch {
  level: 1 | 2 | 3
  text: string
}

interface FenceMatch {
  length: number
  language: string
}

interface ListMatch {
  ordered: boolean
  text: string
}

interface MatchResult<T> {
  value: T
  next: number
}

const HEADING_RE = /^ {0,3}(#{1,3})(?:[ \t]+(.*))?$/
const FENCE_START_RE = /^ {0,3}(`{3,})(.*)$/
const FENCE_END_RE = /^ {0,3}(`{3,})[ \t]*$/
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/
const UNORDERED_LIST_RE = /^ {0,3}[-*][ \t]+(.*)$/
const ORDERED_LIST_RE = /^ {0,3}\d+\.[ \t]+(.*)$/

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function matchHeading(line: string): HeadingMatch | null {
  const match = HEADING_RE.exec(line)
  if (!match) return null
  const hashes = match[1]
  if (!hashes) return null
  return {
    level: hashes.length as HeadingMatch['level'],
    text: match[2] ?? '',
  }
}

function matchFenceStart(line: string): FenceMatch | null {
  const match = FENCE_START_RE.exec(line)
  if (!match) return null
  const fence = match[1]
  if (!fence) return null
  return {
    length: fence.length,
    language: (match[2] ?? '').trim(),
  }
}

function isFenceEnd(line: string, minimumLength: number): boolean {
  const match = FENCE_END_RE.exec(line)
  const fence = match?.[1]
  return fence !== undefined && fence.length >= minimumLength
}

function matchQuote(line: string): string | null {
  const match = QUOTE_RE.exec(line)
  return match ? (match[1] ?? '') : null
}

function matchList(line: string): ListMatch | null {
  const unordered = UNORDERED_LIST_RE.exec(line)
  if (unordered) return { ordered: false, text: unordered[1] ?? '' }

  const ordered = ORDERED_LIST_RE.exec(line)
  if (ordered) return { ordered: true, text: ordered[1] ?? '' }

  return null
}

function isBlockStart(line: string): boolean {
  return matchHeading(line) !== null
    || matchFenceStart(line) !== null
    || matchQuote(line) !== null
    || matchList(line) !== null
}

function readCode(
  lines: readonly string[],
  start: number,
  fence: FenceMatch,
): MatchResult<AnswerCodeBlock> {
  const codeLines: string[] = []
  let index = start + 1

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (isFenceEnd(line, fence.length)) {
      index += 1
      break
    }
    codeLines.push(line)
    index += 1
  }

  return {
    value: {
      type: 'code',
      language: fence.language,
      code: codeLines.join('\n'),
    },
    next: index,
  }
}

function readQuote(
  lines: readonly string[],
  start: number,
): MatchResult<AnswerQuoteBlock> {
  const quoteLines: string[] = []
  let index = start

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const quoted = matchQuote(line)
    if (quoted === null) break
    quoteLines.push(quoted)
    index += 1
  }

  return {
    value: { type: 'quote', text: quoteLines.join('\n') },
    next: index,
  }
}

function readList(
  lines: readonly string[],
  start: number,
  first: ListMatch,
): MatchResult<AnswerListBlock> {
  const items = [first.text]
  let index = start + 1

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const item = matchList(line)
    if (!item || item.ordered !== first.ordered) break
    items.push(item.text)
    index += 1
  }

  return {
    value: { type: 'list', ordered: first.ordered, items },
    next: index,
  }
}

function readParagraph(
  lines: readonly string[],
  start: number,
): MatchResult<AnswerParagraphBlock> {
  const paragraphLines: string[] = []
  let index = start

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (isBlank(line) || isBlockStart(line)) break
    paragraphLines.push(line)
    index += 1
  }

  return {
    value: { type: 'paragraph', text: paragraphLines.join('\n') },
    next: index,
  }
}

/**
 * Parse supported answer Markdown into ordered, plain-text blocks.
 *
 * Supported blocks are ATX headings (# through ###), unordered lists (- or *),
 * ordered lists (1.), quotes (>), fenced code blocks (```), and paragraphs.
 * Blank lines separate paragraphs. CRLF and CR newlines are normalized to LF.
 *
 * The parser intentionally has no length limit and never drops trailing
 * content. Unterminated code fences are returned as code to the end of input.
 * Empty or whitespace-only input returns an empty array.
 */
export function parseAnswerBlocks(text: string): AnswerBlock[] {
  if (text.length === 0) return []

  const lines = text.split(/\r\n|\n|\r/)
  const blocks: AnswerBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (isBlank(line)) {
      index += 1
      continue
    }

    const fence = matchFenceStart(line)
    if (fence) {
      const result = readCode(lines, index, fence)
      blocks.push(result.value)
      index = result.next
      continue
    }

    const heading = matchHeading(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, text: heading.text })
      index += 1
      continue
    }

    if (matchQuote(line) !== null) {
      const result = readQuote(lines, index)
      blocks.push(result.value)
      index = result.next
      continue
    }

    const list = matchList(line)
    if (list) {
      const result = readList(lines, index, list)
      blocks.push(result.value)
      index = result.next
      continue
    }

    const result = readParagraph(lines, index)
    if (result.next === index) {
      // Defensive progress guard for future block detectors.
      blocks.push({ type: 'paragraph', text: line })
      index += 1
      continue
    }
    blocks.push(result.value)
    index = result.next
  }

  return blocks
}

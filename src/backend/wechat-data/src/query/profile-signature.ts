/**
 * Normalize contact signatures before they reach the UI.
 *
 * Enterprise WeChat may store a JSON profile envelope in the signature slot,
 * e.g. a `custom_info` array describing the source and company. That envelope
 * is metadata, not a personal signature. Only return a value when the JSON
 * explicitly labels or names a signature; otherwise callers should render the
 * field as unset.
 */

const MAX_SIGNATURE_LENGTH = 200
const INVISIBLE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g
const SIGNATURE_KEYS = ['signature', 'slogan', 'bio', '个性签名', '签名', '个人签名'] as const
const SIGNATURE_LABELS = new Set(SIGNATURE_KEYS.map((value) => value.toLowerCase()))
const VALUE_KEYS = ['desc', 'value', 'content', 'text', 'description'] as const
const LABEL_KEYS = ['title', 'label', 'name', 'key'] as const
const NESTED_KEYS = ['detail', 'details', 'custom_info', 'customInfo', 'fields', 'items'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textValue(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function isSignatureLabel(value: string): boolean {
  return SIGNATURE_LABELS.has(value.replace(/\s+/g, '').toLowerCase())
}

function isTechnicalText(value: string): boolean {
  return /^[{\[]/.test(value)
    || /^https?:\/\//i.test(value)
    || /@im\.wxwork\b/i.test(value)
    || /"custom_info"\s*:/i.test(value)
    || /^<[^>]+>/.test(value)
}

function cleanSignatureText(value: string): string {
  const text = value.replace(INVISIBLE_TEXT, '').replace(/\s+/g, ' ').trim()
  if (!text || isTechnicalText(text)) return ''
  return text.slice(0, MAX_SIGNATURE_LENGTH)
}

/** Depth-limited lookup for the value nested under an explicit signature label. */
function firstNestedText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstNestedText(item, depth + 1)
      if (text) return text
    }
    return ''
  }
  const obj = asRecord(value)
  if (!obj) return ''
  const direct = cleanSignatureText(textValue(obj, VALUE_KEYS))
  if (direct) return direct
  for (const key of NESTED_KEYS) {
    const text = firstNestedText(obj[key], depth + 1)
    if (text) return text
  }
  return ''
}

function signatureFromStructured(value: unknown, depth = 0): string {
  if (depth > 6) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = signatureFromStructured(item, depth + 1)
      if (text) return text
    }
    return ''
  }
  const obj = asRecord(value)
  if (!obj) return ''

  const direct = cleanSignatureText(textValue(obj, SIGNATURE_KEYS))
  if (direct) return direct
  if (isSignatureLabel(textValue(obj, LABEL_KEYS))) {
    const labelled = firstNestedText(obj)
    if (labelled) return labelled
  }
  for (const key of NESTED_KEYS) {
    const text = signatureFromStructured(obj[key], depth + 1)
    if (text) return text
  }
  return ''
}

/** Find the complete JSON value when protobuf/binary data surrounds it. */
function embeddedJsonSlice(raw: string, start: number): string {
  const opening = raw[start]
  const closing = opening === '{' ? '}' : opening === '[' ? ']' : ''
  if (!closing) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === opening) depth += 1
    else if (char === closing) {
      depth -= 1
      if (depth === 0) return raw.slice(start, index + 1)
    }
  }
  return ''
}

function parseEmbeddedJson(raw: string): { structured: boolean; value?: unknown } {
  const start = raw.search(/[\[{]/)
  if (start < 0) return { structured: false }
  const json = embeddedJsonSlice(raw, start)
  try {
    return { structured: true, value: JSON.parse(json) as unknown }
  } catch {
    // A quoted JSON string may itself contain the escaped profile object.
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'string' && /[\[{]/.test(parsed)) {
        return { structured: true, value: JSON.parse(parsed) as unknown }
      }
    } catch { /* not JSON */ }
    return { structured: true }
  }
}

/**
 * Return a human-readable signature, never the raw enterprise profile JSON.
 * @param raw - `contact.description` or `extra_buffer` field 4.
 * @returns cleaned signature text, or an empty string when the field has no
 *   explicit personal signature.
 */
export function readableProfileSignature(raw: string | undefined): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const parsed = parseEmbeddedJson(text)
  if (parsed.structured) return signatureFromStructured(parsed.value)
  return cleanSignatureText(text)
}

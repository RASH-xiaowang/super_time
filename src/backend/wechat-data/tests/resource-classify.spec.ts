/**
 * Shared resource classification: packed_info protobuf name parsing and
 * extension/type-domain category labelling for the overview/storage panels.
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { classifyPacked, classifyType, parsePackedName } from '../src/query/resource-classify.ts'

/** Encode a protobuf varint (unsigned, LEB128). */
function varint(n: number): number[] {
  const out: number[] = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return out
}

/** Encode a field-N, wire-2 length-delimited string. */
function field2String(field: number, s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s)
  const key = (field << 3) | 2
  return new Uint8Array([...varint(key), ...varint(bytes.length), ...bytes])
}

describe('parsePackedName', () => {
  it('returns empty for absent or empty blobs', () => {
    expect(parsePackedName(null)).toBe('')
    expect(parsePackedName(undefined)).toBe('')
    expect(parsePackedName(new Uint8Array(0))).toBe('')
  })

  it('extracts the field-2 file name', () => {
    expect(parsePackedName(field2String(2, 'a.jpg'))).toBe('a.jpg')
  })

  it('skips empty / whitespace field-2 strings', () => {
    expect(parsePackedName(field2String(2, ''))).toBe('')
    expect(parsePackedName(field2String(2, '   '))).toBe('')
  })

  it('ignores a length-delimited field other than 2', () => {
    expect(parsePackedName(field2String(1, 'other'))).toBe('')
  })

  it('skips wire-0 varints', () => {
    // field 1, wire 0, value 1
    expect(parsePackedName(new Uint8Array([0x08, 0x01]))).toBe('')
  })

  it('skips a multi-byte wire-0 varint value', () => {
    // field 1, wire 0, value 128 = varint 0x80 0x01
    expect(parsePackedName(new Uint8Array([0x08, 0x80, 0x01]))).toBe('')
  })

  it('skips wire-5 (32-bit) and wire-1 (64-bit) fields', () => {
    expect(parsePackedName(new Uint8Array([0x0d, 1, 2, 3, 4]))).toBe('')
    expect(parsePackedName(new Uint8Array([0x09, 1, 2, 3, 4, 5, 6, 7, 8]))).toBe('')
  })

  it('breaks on an unsupported wire type', () => {
    // field 3, wire 3 (group)
    expect(parsePackedName(new Uint8Array([0x1b]))).toBe('')
  })

  it('breaks on a malformed length that overruns the blob', () => {
    // field 2, wire 2, length 127 but only one trailing byte
    expect(parsePackedName(new Uint8Array([0x12, 0x7f, 0x41]))).toBe('')
  })

  it('reads a multi-byte varint tag before a later field-2 name', () => {
    // field 16 wire 2 ('X') then field 2 wire 2 ('a.jpg')
    const prefix = field2String(16, 'X')
    const name = field2String(2, 'a.jpg')
    expect(parsePackedName(new Uint8Array([...prefix, ...name]))).toBe('a.jpg')
  })

  it('stops when a varint repeats past the max shift', () => {
    // five continuation bytes exhaust the shift budget
    expect(parsePackedName(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80]))).toBe('')
  })
})

describe('classifyType', () => {
  it('classifies by extension first', () => {
    expect(classifyType(1, 'a.jpg')).toBe('图片')
    expect(classifyType(1, 'A.PNG')).toBe('图片')
    expect(classifyType(1, 'a.mp4')).toBe('视频')
    expect(classifyType(1, 'a.mp3')).toBe('音频')
    expect(classifyType(1, 'a.pdf')).toBe('文档')
    expect(classifyType(1, 'a.zip')).toBe('压缩包')
    expect(classifyType(1, 'a.exe')).toBe('程序')
  })

  it('falls back to the high type-domain bits', () => {
    expect(classifyType(0x10001, '')).toBe('图片')
    expect(classifyType(0x20001, '')).toBe('视频')
    expect(classifyType(0x30001, '')).toBe('视频')
    expect(classifyType(0x40001, '')).toBe('表情')
    expect(classifyType(0x00001, '')).toBe('其他')
  })

  it('labels unknown or extension-less names as other', () => {
    expect(classifyType(1, 'a.xyz')).toBe('其他')
    expect(classifyType(1, 'noext')).toBe('其他')
    expect(classifyType(1, '')).toBe('其他')
  })
})

describe('classifyPacked', () => {
  it('prefers the parsed extension when a name is embedded', () => {
    expect(classifyPacked(0x10001, field2String(2, 'a.mp4'))).toBe('视频')
  })

  it('falls back to the type domain when the blob is absent', () => {
    expect(classifyPacked(0x10001, null)).toBe('图片')
    expect(classifyPacked(0x40001, undefined)).toBe('表情')
  })

  it('falls back to the type domain when the embedded name is empty', () => {
    expect(classifyPacked(0x20001, field2String(2, ''))).toBe('视频')
  })
})

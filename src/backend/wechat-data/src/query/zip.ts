/**
 * Minimal ZIP writer (no external deps): STORE method with deflate via
 * node:zlib, used for .xlsx (OOXML) and export ZIP packaging.
 */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = ((): number[] => {
  const table = new Array<number>(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}

/** Build a ZIP archive from named entries (string or bytes payloads). */
export function zipFiles(entries: Array<{ name: string; data: string | Uint8Array }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const names = new Set<string>()
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    if (names.has(name)) continue
    names.add(name)
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
    const deflated = deflateRawSync(raw)
    // Prefer STORE (small files) when deflate does not help.
    const data = deflated.length >= raw.length ? raw : deflated
    const method = deflated.length >= raw.length ? 0 : 8
    const crc = crc32(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, data,
    ])
    locals.push(local)
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBuf,
    ]))
    offset += local.length
  }
  const centralStart = offset
  const central = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(centralStart), u16(0),
  ])
  return Buffer.concat([...locals, central, eocd])
}

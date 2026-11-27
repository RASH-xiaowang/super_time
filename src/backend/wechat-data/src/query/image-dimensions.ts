/**
 * 图片尺寸读取与朋友圈原图质量判定。
 *
 * 朋友圈落盘缓存里混着 `200x300`、`150x150` 这类预览图（真机归档实测），
 * 只凭「魔数是图片」把它们当原图会把低清图永久缓存下来。这里用纯 JS
 * 读取常见图片容器声明的宽高，再按 XML `<size>` 的期望尺寸判定是不是原图。
 *
 * 读不出尺寸时不能简单判成高清：HEIC 等容器优先尝试 ISO BMFF `ispe`，
 * 仍读不出时只在没有更可靠证据的情况下保留 legacy 兼容。
 *
 * @module query/image-dimensions
 */
import { jpegDimensions } from './jpeg-dimensions.ts'

/** 图片容器里的宽高。 */
export interface ImageDimensions {
  width: number
  height: number
}

/** 朋友圈 XML `<size>` 给出的原图预期（单位：像素 / 字节）。 */
export interface SnsOriginalExpectation {
  width?: number
  height?: number
  bytes?: number
}

/** 一张候选图片的质量判定结果。 */
export interface SnsOriginalEvaluation {
  bytes: number
  width?: number
  height?: number
  dimensionsKnown: boolean
  accepted: boolean
  reason?: string
}

/** 可供替换比较的最小质量形状。 */
export interface SnsOriginalQuality {
  bytes: number
  width?: number
  height?: number
}

/** 没有 XML 尺寸时，短边低于这个值的一律视为预览图。 */
export const SNS_ORIGINAL_MIN_SHORT_EDGE = 320
/** 没有 XML 尺寸时，长边低于这个值的一律视为预览图。 */
export const SNS_ORIGINAL_MIN_LONG_EDGE = 480
/**
 * 与 XML `<size>` 比对时，长短边至少要达到期望的这个比例。
 *
 * 微信朋友圈的「大图」经常正好是 XML `<size>` 的 75%（本机实测
 * 1926×1446 对 2568×1926、1440×1918 对 1920×2556）。旧的 85% 门槛把它们判掉，
 * 然后同一条调用再去 CDN 取回同一尺寸（1.0s / 2.6s），失败后又退到更小的缩略图。
 * 75% 收进这档大图，200×300 一类预览图仍然过不了。
 */
export const SNS_ORIGINAL_DIMENSION_TOLERANCE = 0.75
/** 尺寸读不出时，候选字节数至少要有 XML 声明大小的这个比例。 */
export const SNS_ORIGINAL_UNKNOWN_BYTES_RATIO = 0.5

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0)
  return out
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)
}

function u32be(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16)
    | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0
}

function u32le(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
    | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0
}

function validDimensions(width: number, height: number): ImageDimensions | null {
  return width > 0 && height > 0 ? { width, height } : null
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null
  if (ascii(bytes, 12, 4) !== 'IHDR') return null
  return validDimensions(u32be(bytes, 16), u32be(bytes, 20))
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null
  return validDimensions(u16le(bytes, 6), u16le(bytes, 8))
}

function bmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26) return null
  const width = Math.abs(u32le(bytes, 18) | 0)
  const height = Math.abs(u32le(bytes, 22) | 0)
  return validDimensions(width, height)
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    return validDimensions(1 + u24le(bytes, 24), 1 + u24le(bytes, 27))
  }
  if (chunk === 'VP8L') {
    if ((bytes[20] ?? 0) !== 0x2f) return null
    const bits = u32le(bytes, 21)
    return validDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8 ') {
    if ((bytes[23] ?? 0) !== 0x9d || (bytes[24] ?? 0) !== 0x01 || (bytes[25] ?? 0) !== 0x2a) return null
    return validDimensions(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff)
  }
  return null
}

const ISO_BMFF_CONTAINERS = new Set(['meta', 'iprp', 'ipco', 'iinf', 'iref'])

/**
 * 在 ISO BMFF 容器里找 `ispe`（Image Spatial Extents）。
 *
 * HEIC/AVIF 的缩略图和主图会各带一个 `ispe`，所以收集全部并取面积最大的那个；
 * 只看第一个会把缩略图尺寸误当成原图。
 */
function isoBmffDimensions(bytes: Uint8Array): ImageDimensions | null {
  const found: ImageDimensions[] = []
  const walk = (start: number, end: number, depth: number): void => {
    let pos = start
    while (pos + 8 <= end) {
      const size32 = u32be(bytes, pos)
      const type = ascii(bytes, pos + 4, 4)
      let header = 8
      let size = size32
      if (size32 === 1) {
        if (pos + 16 > end) return
        const high = u32be(bytes, pos + 8)
        const low = u32be(bytes, pos + 12)
        if (high > 0x1fffff) return
        size = high * 0x1_0000_0000 + low
        header = 16
      } else if (size32 === 0) {
        size = end - pos
      }
      if (size < header || pos + size > end) return
      const dataStart = pos + header
      const boxEnd = pos + size
      if (type === 'ispe') {
        if (dataStart + 12 <= boxEnd) {
          const dims = validDimensions(u32be(bytes, dataStart + 4), u32be(bytes, dataStart + 8))
          if (dims !== null) found.push(dims)
        }
      } else if (ISO_BMFF_CONTAINERS.has(type) && depth < 8) {
        walk(type === 'meta' ? dataStart + 4 : dataStart, boxEnd, depth + 1)
      }
      pos = boxEnd
    }
  }
  walk(0, bytes.length, 0)
  if (found.length === 0) return null
  found.sort((a, b) => b.width * b.height - a.width * a.height)
  return found[0] ?? null
}

/**
 * 读取图片宽高。支持 JPEG/PNG/WebP/GIF/BMP 与带 `ispe` 的 HEIC/AVIF。
 * @param bytes - 图片字节。
 * @returns 宽高；格式不支持或头部残缺时返回 `null`（不猜）。
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes)
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return pngDimensions(bytes)
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpDimensions(bytes)
  if (ascii(bytes, 0, 3) === 'GIF') return gifDimensions(bytes)
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return bmpDimensions(bytes)
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return isoBmffDimensions(bytes)
  }
  return null
}

/**
 * 判断一份字节是否够格当朋友圈原图。
 *
 * 规则：
 *   · 有 XML `<size>`：按长短边排序后与期望尺寸比较，允许横竖旋转，
 *     至少要有期望尺寸的 {@link SNS_ORIGINAL_DIMENSION_TOLERANCE}；
 *   · 没有 XML `<size>`：短边 < 320 或长边 < 480 的已知小图直接拒绝；
 *   · 读不出尺寸：有 XML 字节数时至少要有它的一半，否则保留 legacy 兼容。
 *
 * @param bytes - 候选图片字节。
 * @param expected - XML `<size>` 的预期；没有时按绝对下限判断。
 * @returns 是否接受及可读的拒绝原因。
 */
export function evaluateSnsOriginal(
  bytes: Uint8Array,
  expected: SnsOriginalExpectation = {},
): SnsOriginalEvaluation {
  const dims = readImageDimensions(bytes)
  const expectedWidth = positiveInt(expected.width)
  const expectedHeight = positiveInt(expected.height)
  const expectedBytes = positiveInt(expected.bytes)
  const base = {
    bytes: bytes.length,
    ...(dims !== null ? { width: dims.width, height: dims.height } : {}),
    dimensionsKnown: dims !== null,
  }

  if (dims !== null) {
    const actualLong = Math.max(dims.width, dims.height)
    const actualShort = Math.min(dims.width, dims.height)
    if (expectedWidth !== undefined && expectedHeight !== undefined) {
      const expectedLong = Math.max(expectedWidth, expectedHeight)
      const expectedShort = Math.min(expectedWidth, expectedHeight)
      const minLong = Math.ceil(expectedLong * SNS_ORIGINAL_DIMENSION_TOLERANCE)
      const minShort = Math.ceil(expectedShort * SNS_ORIGINAL_DIMENSION_TOLERANCE)
      if (actualLong < minLong || actualShort < minShort) {
        const slack = Math.round((1 - SNS_ORIGINAL_DIMENSION_TOLERANCE) * 100)
        return {
          ...base,
          accepted: false,
          reason: `尺寸 ${dims.width}x${dims.height} 小于原图期望 ${expectedWidth}x${expectedHeight}（容差 ${slack}%）`,
        }
      }
      return { ...base, accepted: true }
    }
    if (actualShort < SNS_ORIGINAL_MIN_SHORT_EDGE || actualLong < SNS_ORIGINAL_MIN_LONG_EDGE) {
      return {
        ...base,
        accepted: false,
        reason: `尺寸 ${dims.width}x${dims.height} 低于原图下限 ${SNS_ORIGINAL_MIN_SHORT_EDGE}x${SNS_ORIGINAL_MIN_LONG_EDGE}`,
      }
    }
    return { ...base, accepted: true }
  }

  if (expectedBytes !== undefined
    && bytes.length < expectedBytes * SNS_ORIGINAL_UNKNOWN_BYTES_RATIO) {
    return {
      ...base,
      accepted: false,
      reason: `读不出尺寸，且 ${bytes.length} 字节不足 XML 声明 ${expectedBytes} 字节的一半`,
    }
  }
  return {
    ...base,
    accepted: true,
    reason: '读不出尺寸，按 legacy 兼容放行',
  }
}

function areaOf(quality: SnsOriginalQuality): number {
  return (quality.width ?? 0) * (quality.height ?? 0)
}

/**
 * 比较两张候选图谁更适合作为原图缓存。
 * @returns 正数表示 `candidate` 更好，负数表示 `current` 更好，0 表示没有明确高下。
 */
export function compareSnsOriginalQuality(
  candidate: SnsOriginalQuality,
  current: SnsOriginalQuality,
): number {
  const candidateKnown = candidate.width !== undefined && candidate.height !== undefined
  const currentKnown = current.width !== undefined && current.height !== undefined
  if (candidateKnown && !currentKnown) return 1
  if (!candidateKnown && currentKnown) return -1
  if (candidateKnown && currentKnown) {
    const ca = areaOf(candidate)
    const ea = areaOf(current)
    if (ca > ea * 1.02) return 1
    if (ca < ea * 0.98) return -1
  }
  if (candidate.bytes > current.bytes * 1.05) return 1
  if (candidate.bytes < current.bytes * 0.95) return -1
  return 0
}

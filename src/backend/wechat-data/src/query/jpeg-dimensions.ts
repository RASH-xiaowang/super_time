/**
 * 从 JPEG 字节里读宽高（SOF 段）——纯 JS 实现，供 wxam-image / wxgf-ffmpeg 共用
 * （拆出来是为了避开两模块的环形依赖）。
 * @module query/jpeg-dimensions
 */
/** SOF0/1/2/3/5/6/7/9/10/11/13/14/15 都带尺寸；D8/01/RSTn 是无长度段的标记。 */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/**
 * 从 JPEG 字节里读宽高（SOF 段）。
 *
 * 为什么自己解析而不是调 `wxam_dec_getWXGFInfo_5`：那个导出的签名没验证过，
 * 调错会崩进程；而 JPEG 的 SOF 扫描是纯 JS、可单测、失败也只是返回 null。
 * @param bytes - JPEG 字节。
 * @returns 宽高，或数据不是可解析的 JPEG 时为 null。
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xff) { i += 1; continue }
    const marker = bytes[i + 1] ?? 0
    if (SOF.has(marker)) {
      const h = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0)
      const w = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0)
      return w > 0 && h > 0 ? { width: w, height: h } : null
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
    const segLen = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)
    if (segLen < 2) return null
    i += 2 + segLen
  }
  return null
}

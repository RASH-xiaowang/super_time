/**
 * Resource classification shared by the overview and storage aggregates.
 * `packed_info` is a protobuf blob, not a filename string, so the blob must be
 * parsed to a real file name before extension classification; the type-domain
 * fallback keeps labels stable when no name is recoverable.
 */

/**
 * 读一个 protobuf varint。
 * @param blob - 字节数组。
 * @param pos - 起始偏移。
 * @returns 值与下一个偏移；越界时返回 null。
 */
function readVarint(blob: Uint8Array, pos: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  let i = pos
  while (i < blob.length) {
    const b = blob[i] ?? 0
    i += 1
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: value >>> 0, next: i }
    shift += 7
    if (shift > 28) return null
  }
  return null
}

/** 该字符串是否「看起来是文本」：不含控制字符（换行/制表除外）且含至少一个可见字符。 */
function looksLikeText(s: string): boolean {
  if (!s) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) return false
  return /[\p{L}\p{N}]/u.test(s)
}

/**
 * 解析 `packed_info` 里的文件名。
 *
 * 结构与实测依据（第 43 轮修正）
 * ----------------------------
 * 旧实现只在**顶层**找 field 2，于是一律返回 ''。真实结构是嵌套的（对 3 条真实 blob 取 hex 验证）：
 *
 * ```
 * 0a <len>              ← 顶层 字段1，wire 2，值是嵌套消息
 *   { 0a <len> <文件名>   ← 内层 字段1：文件名（UTF-8）
 *     12 <len> <文件名> } ← 内层 字段2：同一文件名的副本
 * ```
 *
 * 例：`dsh-modified-src.zip` → `0a 2c 0a 14 "dsh-modified-src.zip" 12 14 "dsh-modified-src.zip"`；
 * `ipad协议过人脸教程.docx`、`企微SCRM介绍_零一数科 202410.pdf` 同构。
 *
 * 这一个 bug 同时造成两处可见错误，都实测到了：
 *   1. **存储分类错误**：拿不到文件名 → 退化成「类型域」映射表 → `0x33_0003`（实测 2,053 个
 *      **PDF**）被记成「视频」、`0x34_0003`（1,940 个 **docx**）被记成「表情」；
 *   2. **大文件名大量缺失**：`large_files` 的 `packedName` 恒为空 → 退到「按大小猜名字」
 *      （实测 30% 的大小有歧义）→ top-100 里 70 条显示 `(未知文件名)` 或纯类型标签。
 *
 * @param blob - 原始 packed_info 单元格，或 null/undefined。
 * @returns 文件名；无法解析时返回 ''。
 */
export function parsePackedName(blob: Uint8Array | null | undefined): string {
  if (!blob || blob.length === 0) return ''
  const found: Array<{ level: number; field: number; text: string }> = []
  const walk = (start: number, end: number, level: number): void => {
    let i = start
    while (i < end) {
      const tag = readVarint(blob, i)
      if (!tag) return
      i = tag.next
      const field = tag.value >>> 3
      const wire = tag.value & 7
      if (wire === 2) {
        const len = readVarint(blob, i)
        if (!len) return
        i = len.next
        const stop = i + len.value
        if (stop > end) return
        const text = new TextDecoder('utf-8', { fatal: false }).decode(blob.subarray(i, stop))
        if (looksLikeText(text)) found.push({ level, field, text: text.trim() })
        else if (level < 2) walk(i, stop, level + 1) // 嵌套消息：继续往里找
        i = stop
      } else if (wire === 0) {
        const v = readVarint(blob, i)
        if (!v) return
        i = v.next
      } else if (wire === 5) i += 4
      else if (wire === 1) i += 8
      else return
    }
  }
  walk(0, blob.length, 0)
  if (found.length === 0) return ''
  // 优先级：内层字段1（实测的主位置）→ 内层字段2（副本）→ 顶层字段2（旧的兼容读法）→ 第一个文本
  const pick = found.find(f => f.level === 1 && f.field === 1)
    ?? found.find(f => f.level === 1 && f.field === 2)
    ?? found.find(f => f.level === 0 && f.field === 2)
    ?? found[0]
  return pick ? pick.text : ''
}

/**
 * Classify a resource by file extension first, then by the high type-domain bits.
 * @param type - MessageResourceDetail type code.
 * @param fileName - the (already-decoded) file name, or '' when unavailable.
 * @returns the display category label.
 */
export function classifyType(type: number, fileName: string): string {
  // v8 ignore next -- String.split always yields a non-empty array, so pop() never returns undefined.
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext)) return '图片'
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'].includes(ext)) return '视频'
  if (['mp3', 'wav', 'm4a', 'silk', 'amr', 'ogg', 'flac', 'aac'].includes(ext)) return '音频'
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'wps', 'csv'].includes(ext)) return '文档'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '压缩包'
  if (['exe', 'msi', 'apk', 'bat', 'cmd'].includes(ext)) return '程序'
  const domain = type & 0xF0000
  if (domain === 0x10000) return '图片'
  if (domain === 0x20000 || domain === 0x30000) return '视频'
  if (domain === 0x40000) return '表情'
  return '其他'
}

/**
 * Classify a packed_info blob: parse its embedded file name (when present) and
 * classify by extension, falling back to the type-domain map.
 * @param type - MessageResourceDetail type code.
 * @param blob - the raw packed_info cell (protobuf), or null/undefined.
 * @returns the display category label.
 */
export function classifyPacked(type: number, blob: Uint8Array | null | undefined): string {
  return classifyType(type, parsePackedName(blob))
}

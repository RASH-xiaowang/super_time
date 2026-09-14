/**
 * Resource classification shared by the overview and storage aggregates.
 * `packed_info` is a protobuf blob, not a filename string, so the blob must be
 * parsed to a real file name before extension classification; the type-domain
 * fallback keeps labels stable when no name is recoverable.
 */
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
export declare function parsePackedName(blob: Uint8Array | null | undefined): string;
/**
 * Classify a resource by file extension first, then by the high type-domain bits.
 * @param type - MessageResourceDetail type code.
 * @param fileName - the (already-decoded) file name, or '' when unavailable.
 * @returns the display category label.
 */
export declare function classifyType(type: number, fileName: string): string;
/**
 * Classify a packed_info blob: parse its embedded file name (when present) and
 * classify by extension, falling back to the type-domain map.
 * @param type - MessageResourceDetail type code.
 * @param blob - the raw packed_info cell (protobuf), or null/undefined.
 * @returns the display category label.
 */
export declare function classifyPacked(type: number, blob: Uint8Array | null | undefined): string;

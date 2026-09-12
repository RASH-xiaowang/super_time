/**
 * Resource classification shared by the overview and storage aggregates.
 * `packed_info` is a protobuf blob, not a filename string, so the blob must be
 * parsed to a real file name before extension classification; the type-domain
 * fallback keeps labels stable when no name is recoverable.
 */
/**
 * Parse the field-2 UTF-8 string out of a packed_info protobuf blob.
 * @param blob - the raw packed_info cell (protobuf), or null/undefined when absent.
 * @returns the embedded display/file name, or '' when absent or unparseable.
 */
export function parsePackedName(blob) {
    if (!blob || blob.length === 0)
        return '';
    let i = 0;
    const readVarint = () => {
        let value = 0;
        let shift = 0;
        while (i < blob.length) {
            // v8 ignore next -- the i < blob.length guard keeps blob[i] in-bounds, so the ?? 0 fallback is unreachable.
            const b = blob[i] ?? 0;
            i += 1;
            value |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0)
                break;
            shift += 7;
            if (shift > 28)
                break;
        }
        return value >>> 0;
    };
    while (i < blob.length) {
        const tag = readVarint();
        const field = tag >> 3;
        const wire = tag & 7;
        if (wire === 2) {
            const len = readVarint();
            if (i + len > blob.length)
                break;
            const s = new TextDecoder('utf-8', { fatal: false }).decode(blob.subarray(i, i + len));
            i += len;
            if (field === 2 && s.trim() !== '')
                return s;
        }
        else if (wire === 0) {
            let b = 0;
            while (i < blob.length) {
                // v8 ignore next -- the i < blob.length guard keeps blob[i] in-bounds, so the ?? 0 fallback is unreachable.
                b = blob[i] ?? 0;
                if ((b & 0x80) === 0)
                    break;
                i += 1;
            }
            i += 1;
        }
        else if (wire === 5) {
            i += 4;
        }
        else if (wire === 1) {
            i += 8;
        }
        else {
            break;
        }
    }
    return '';
}
/**
 * Classify a resource by file extension first, then by the high type-domain bits.
 * @param type - MessageResourceDetail type code.
 * @param fileName - the (already-decoded) file name, or '' when unavailable.
 * @returns the display category label.
 */
export function classifyType(type, fileName) {
    // v8 ignore next -- String.split always yields a non-empty array, so pop() never returns undefined.
    const ext = (fileName.split('.').pop() ?? '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext))
        return '图片';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'].includes(ext))
        return '视频';
    if (['mp3', 'wav', 'm4a', 'silk', 'amr', 'ogg', 'flac', 'aac'].includes(ext))
        return '音频';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'wps', 'csv'].includes(ext))
        return '文档';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext))
        return '压缩包';
    if (['exe', 'msi', 'apk', 'bat', 'cmd'].includes(ext))
        return '程序';
    const domain = type & 0xF0000;
    if (domain === 0x10000)
        return '图片';
    if (domain === 0x20000 || domain === 0x30000)
        return '视频';
    if (domain === 0x40000)
        return '表情';
    return '其他';
}
/**
 * Classify a packed_info blob: parse its embedded file name (when present) and
 * classify by extension, falling back to the type-domain map.
 * @param type - MessageResourceDetail type code.
 * @param blob - the raw packed_info cell (protobuf), or null/undefined.
 * @returns the display category label.
 */
export function classifyPacked(type, blob) {
    return classifyType(type, parsePackedName(blob));
}
//# sourceMappingURL=resource-classify.js.map
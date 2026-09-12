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
//# sourceMappingURL=resource-classify.d.ts.map
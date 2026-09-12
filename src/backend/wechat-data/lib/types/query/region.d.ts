/** Decode a TEXT-or-BLOB cell to UTF-8 text. */
export declare function cellText(v: unknown): string;
/** Decode a varint (protobuf) from a buffer at idx. */
export declare function readVarint(buf: Buffer, idx: number): {
    value: number;
    next: number;
} | null;
/** Parsed contact.extra_buffer region + profile fields. */
export interface ContactExtra {
    signature?: string;
    country?: string;
    province?: string;
    city?: string;
    gender?: number;
    wordingId?: string;
}
/** Parse contact.extra_buffer protobuf: 2=性别, 4=签名, 5=国家, 6=省, 7=市. */
export declare function parseContactExtra(raw: Buffer): ContactExtra;
/** Resolve one region label: key -> Chinese (or Chinese -> key -> Chinese). */
export declare function regionLabel(category: 'country' | 'province' | 'city', value: string): string;
/** Build a compact region string (中国 → 省+市; abroad → 国家 省 市). */
export declare function buildRegion(country: string, province: string, city: string): string;
//# sourceMappingURL=region.d.ts.map
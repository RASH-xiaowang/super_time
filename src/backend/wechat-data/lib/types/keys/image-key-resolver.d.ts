/** V2 image magic. */
export declare const V2_MAGIC: Buffer<ArrayBuffer>;
/** V2 ciphertext starts at this offset. */
export declare const V2_CIPHERTEXT_START = 15;
/** AES block size. */
export declare const AES_BLOCK_SIZE = 16;
/** Derived image key pair. */
export interface DerivedImageKeys {
    /** XOR byte. */
    xorKey: number;
    /** 16-char ASCII AES key. */
    aesKey: string;
}
/** A V2 template file. */
export interface V2Template {
    /** Absolute template path. */
    path: string;
    /** First AES block of ciphertext. */
    ciphertext: Buffer;
    /** File mtime in ns. */
    mtimeNs: number;
    /** Inferred XOR key from the trailer (may be null). */
    tailXorKey: number | null;
    /** Raw 2-byte trailer. */
    tailBytes: Buffer;
}
/** Result of scanning for V2 templates. */
export interface TemplateScanResult {
    /** Templates found, newest first. */
    templates: V2Template[];
    /** Most common XOR key across trailers. */
    inferredXorKey: number | null;
    /** Whether the fallback traversal was used. */
    usedFallback: boolean;
    /** Files scanned. */
    filesScanned: number;
    /** Support count for the inferred XOR key. */
    xorSupport: number;
}
/** Resolved image key. */
export interface ImageKeyResolution {
    /** kvcomm code. */
    code: number;
    /** Clean wxid. */
    wxid: string;
    /** XOR byte. */
    xorKey: number;
    /** 16-char ASCII AES key. */
    aesKey: string;
    /** Verified against a real V2 image. */
    verified: boolean;
    /** Template path used for verification. */
    templatePath: string;
    /** Inferred XOR key (may be null). */
    inferredXorKey: number | null;
}
/**
 * Strip the data-directory suffix from a wxid (wxid_x_<suffix> → wxid_x).
 * @param value - raw account id.
 * @returns the cleaned wxid, or an empty string.
 */
export declare function cleanWxid(value: string | null | undefined): string;
/**
 * Derive WeFlow's XOR byte and 16-byte ASCII AES key.
 * @param code - kvcomm code (1..0xffffffff).
 * @param wxid - account wxid (suffix stripped).
 * @returns the derived key pair.
 * @throws when code or wxid are invalid.
 */
export declare function deriveImageKeys(code: number, wxid: string): DerivedImageKeys;
/**
 * Detect the image format of a decrypted V2 block.
 * @param plaintext - decrypted first block.
 * @returns the detected format (jpeg/png/webp/wxgf/gif), or null.
 */
export declare function detectImageFormat(plaintext: Buffer | null): string | null;
/**
 * Verify one AES key against the encrypted first block of a V2 image.
 * @param aesKey - 16-byte ASCII key (string or buffer).
 * @param ciphertext - first encrypted AES block.
 * @returns true when the block decrypts to a supported image signature.
 */
export declare function verifyAesKey(aesKey: string | Buffer, ciphertext: Buffer): boolean;
/**
 * Infer XOR from the most common raw trailer pair, matching WeFlow.
 * @param tails - raw 2-byte trailer pairs.
 * @returns the inferred XOR byte, or null.
 */
export declare function inferXorKeyFromV2Tails(tails: Iterable<Buffer>): number | null;
/**
 * Scan for recent V2 thumbnail templates under an account dir.
 * @param accountDir - WeChat account data dir (wxid_* folder).
 * @param limit - max templates to return.
 * @param maxFallbackDirs - cap for the fallback BFS.
 * @returns the template scan result.
 */
export declare function scanV2Templates(accountDir: string, limit?: number, maxFallbackDirs?: number): TemplateScanResult;
/**
 * Trusted XOR for a verified AES key across templates.
 * @param aesKey - candidate AES key.
 * @param templateData - V2 template scan or template list.
 * @returns the trusted XOR byte, or null.
 */
export declare function trustedXorForVerifiedAesKey(aesKey: string | Buffer, templateData: TemplateScanResult | V2Template[]): number | null;
/**
 * Enumerate kvcomm codes from `*_input.statistic` file names in the WeChat 4.x
 * kvcomm cache dir (`%APPDATA%/Tencent/xwechat/net/kvcomm`).
 * @param kvcommDir - kvcomm cache directory.
 * @returns unique codes, empty when none.
 */
export declare function kvcommCodesFromDir(kvcommDir: string): number[];
/**
 * Resolve the first code/wxid pair that passes real V2 AES validation.
 * @param opts - kvcomm dir, account dir and optional hints.
 * @returns the verified resolution, or null.
 */
export declare function resolveLocalImageKey(opts: {
    kvcommDir: string;
    accountDir: string;
    targetWxid?: string | null;
    account?: string | null;
    localNativeWxids?: Iterable<string> | string | null;
    templateLimit?: number;
    maxFallbackDirs?: number;
}): ImageKeyResolution | null;
//# sourceMappingURL=image-key-resolver.d.ts.map
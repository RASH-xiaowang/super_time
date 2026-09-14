/** One found internal-key candidate. */
export interface DllKeyCandidate {
    /** Virtual address of the signature start (hex string). */
    va: string;
    /** File offset of the signature start (hex string). */
    fileOffset: string;
    /** Space-separated uppercase hex bytes (display form). */
    key: string;
    /** Lowercase hex key (32 bytes → 64 chars). */
    keyHex: string;
}
/**
 * Extract all internal-key candidates from a Weixin.dll file.
 * @param dllPath - path to Weixin.dll.
 * @returns candidates sorted by virtual address.
 */
export declare function extractXorKeysFromDll(dllPath: string): DllKeyCandidate[];

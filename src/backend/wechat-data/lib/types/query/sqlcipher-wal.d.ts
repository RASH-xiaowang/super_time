export declare const WAL_HEADER_SZ = 32;
export declare const WAL_FRAME_HEADER_SZ = 24;
/**
 * Patch a decrypted DB file with valid frames from an encrypted WAL.
 * @param walPath - encrypted WAL file path.
 * @param outPath - decrypted DB file to patch in place.
 * @param encKey - derived 32-byte AES-256 key.
 * @returns the number of frames patched.
 */
export declare function decryptWalPatch(walPath: string, outPath: string, encKey: Buffer): Promise<number>;
/** True when at least one WAL frame's salt epoch matches the WAL header,
 * i.e. the frames can be decrypted with the current snapshot key. WeChat
 * rotates the salt on login/checkpoint; when it does, frames carry a different
 * epoch and cannot be patched — the next main-DB rewrite (mtime change)
 * triggers a clean full decrypt instead. */
export declare function walFramesPatchable(walPath: string): Promise<boolean>;

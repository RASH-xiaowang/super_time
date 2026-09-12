import type { DbKeyResult } from './types.ts';
/** 32-byte key length. */
declare const KEY_SIZE = 32;
/** Scan one memory chunk for the GetKeyAddrStub pattern (with 0x00 wildcards). */
/**
 * Scan a chunk for GetKeyAddrStub frames; address = u64 at the match offset.
 * @param chunk - memory chunk to scan.
 * @returns candidate key addresses found in the chunk.
 */
declare function findKeyAddresses(chunk: Buffer): number[];
/**
 * Entropy/printability prefilter for 32-byte key candidates.
 * @param key - 32-byte candidate.
 * @returns true when the candidate looks like random key material.
 */
declare function isPotentialKey(key: Buffer): boolean;
/**
 * Scan a process's committed private memory for candidate key addresses.
 * @param pid - WeChat process id.
 * @returns candidate 32-byte keys (deduplicated).
 */
export declare function scanProcessKeyCandidates(pid: number): Promise<Buffer[]>;
/**
 * Recover the V4 database key from a running WeChat process.
 * @param pid - WeChat main-process pid.
 * @param dbFilePath - path to one encrypted DB (first page used for verification).
 * @param internalDbKey - optional 32-byte internal key from Weixin.dll scanning (XOR mask).
 * @returns the recovered key as 64-hex, or an error.
 */
export declare function recoverDbKeyV4(pid: number, dbFilePath: string, internalDbKey?: Buffer | null): Promise<DbKeyResult>;
export { isPotentialKey, findKeyAddresses, KEY_SIZE };
//# sourceMappingURL=db-key-v4.d.ts.map
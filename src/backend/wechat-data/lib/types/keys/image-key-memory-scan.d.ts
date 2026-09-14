/**
 * Verified WeChat image-key recovery from Windows process memory, migrated
 * from WeChatDataAnalysis `image_key_memory_scan.py`. A memory candidate is
 * never returned until its first 16 ASCII bytes decrypt a real V2 image block
 * and the XOR evidence agrees.
 */
import { readProcessMemory } from './win32-memory.ts';
import { type TemplateScanResult } from './image-key-resolver.ts';
/** A verified memory key match. */
export interface ProcessMemoryKeyMatch {
    /** First 16 ASCII bytes of the AES key. */
    aesKey: string;
    /** Template path used for verification. */
    templatePath: string;
    /** Encoding the candidate was found in. */
    encoding: 'ascii' | 'utf-16le';
}
/**
 * Yield first-16-byte AES keys from exact 32-character memory runs.
 * @param data - memory chunk.
 * @returns candidate keys with their encoding.
 */
export declare function iterMemoryAesCandidates(data: Buffer): Array<{
    key: string;
    encoding: 'ascii' | 'utf-16le';
}>;
/**
 * Find the first candidate verified by the newest V2 template + XOR evidence.
 * @param data - memory chunk.
 * @param templateScan - V2 template scan with XOR evidence.
 * @returns the verified match, or null.
 */
export declare function findVerifiedAesKeyInChunk(data: Buffer, templateScan: TemplateScanResult): ProcessMemoryKeyMatch | null;
/**
 * Scan one process's committed writable regions for a verified image AES key.
 * @param pid - WeChat process id.
 * @param templateScan - V2 template scan (must contain XOR evidence).
 * @returns the verified key match, or null.
 */
export declare function scanProcessForImageKey(pid: number, templateScan: TemplateScanResult): Promise<ProcessMemoryKeyMatch | null>;
/**
 * Poll one process's memory once for the image key (synchronous convenience
 * wrapper around {@link scanProcessForImageKey}).
 * @param pid - WeChat process id.
 * @param templateScan - V2 template scan.
 * @returns the verified match or null.
 */
export declare function scanImageKeyOnce(pid: number, templateScan: TemplateScanResult): Promise<ProcessMemoryKeyMatch | null>;
export { readProcessMemory };

/**
 * Verified WeChat image-key recovery from Windows process memory, migrated
 * from WeChatDataAnalysis `image_key_memory_scan.py`. A memory candidate is
 * never returned until its first 16 ASCII bytes decrypt a real V2 image block
 * and the XOR evidence agrees.
 */
import { enumerateScannableRegions, readProcessMemory } from "./win32-memory.js";
import { trustedXorForVerifiedAesKey } from "./image-key-resolver.js";
/** Chunk size for memory reads. */
const MEMORY_CHUNK_SIZE = 4 * 1024 * 1024;
/** Overlap retained around 32-char runs across chunk boundaries. */
const MEMORY_CHUNK_OVERLAP = 68;
/**
 * Yield first-16-byte AES keys from exact 32-character memory runs.
 * @param data - memory chunk.
 * @returns candidate keys with their encoding.
 */
export function iterMemoryAesCandidates(data) {
    const seen = new Set();
    const out = [];
    // ASCII runs: [A-Za-z0-9]{32}
    let i = 0;
    while (i < data.length) {
        const byte = data[i] ?? 0;
        if ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) {
            let end = i + 1;
            while (end < data.length) {
                const b = data[end] ?? 0;
                if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122))
                    end += 1;
                else
                    break;
            }
            if (end - i === 32) {
                const key = data.subarray(i, i + 16).toString('ascii');
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ key, encoding: 'ascii' });
                }
            }
            i = end;
        }
        else {
            i += 1;
        }
    }
    // UTF-16LE runs: [A-Za-z0-9]\0{32}
    i = 0;
    while (i + 1 < data.length) {
        const byte = data[i] ?? 0;
        const isAsciiAlphaNum = (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
        if (isAsciiAlphaNum && data[i + 1] === 0) {
            let end = i + 2;
            while (end + 1 < data.length) {
                const b = data[end] ?? 0;
                const isAlphaNum = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
                if (isAlphaNum && data[end + 1] === 0)
                    end += 2;
                else
                    break;
            }
            if (end - i === 64) {
                const raw = Buffer.alloc(32);
                for (let j = 0; j < 32; j += 1)
                    raw[j] = data[i + j * 2] ?? 0;
                const key = raw.subarray(0, 16).toString('ascii');
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ key, encoding: 'utf-16le' });
                }
            }
            i = end;
        }
        else {
            i += 1;
        }
    }
    return out;
}
/**
 * Find the first candidate verified by the newest V2 template + XOR evidence.
 * @param data - memory chunk.
 * @param templateScan - V2 template scan with XOR evidence.
 * @returns the verified match, or null.
 */
export function findVerifiedAesKeyInChunk(data, templateScan) {
    const template = templateScan.templates[0];
    if (template === undefined)
        return null;
    for (const { key, encoding } of iterMemoryAesCandidates(data)) {
        if (trustedXorForVerifiedAesKey(key, templateScan) !== null) {
            return { aesKey: key, templatePath: template.path, encoding };
        }
    }
    return null;
}
/**
 * Scan one process's committed writable regions for a verified image AES key.
 * @param pid - WeChat process id.
 * @param templateScan - V2 template scan (must contain XOR evidence).
 * @returns the verified key match, or null.
 */
export async function scanProcessForImageKey(pid, templateScan) {
    if (templateScan.templates.length === 0)
        return null;
    if (!templateScan.templates.some(t => t.tailXorKey !== null))
        return null;
    const scan = await enumerateScannableRegions(pid);
    if (scan === null)
        return null;
    const { api, handle, regions } = scan;
    try {
        for (const region of regions) {
            let offset = 0;
            let trailing = Buffer.alloc(0);
            while (offset < region.size) {
                const requestSize = Math.min(MEMORY_CHUNK_SIZE, region.size - offset);
                const chunk = api.readMemory(handle, region.baseAddress + offset, requestSize);
                if (chunk.length === 0) {
                    trailing = Buffer.alloc(0);
                    offset += requestSize;
                    continue;
                }
                const fullRead = chunk.length === requestSize;
                const data = Buffer.concat([trailing, chunk]);
                const match = findVerifiedAesKeyInChunk(data, templateScan);
                if (match !== null)
                    return match;
                if (fullRead)
                    trailing = data.subarray(-MEMORY_CHUNK_OVERLAP);
                else
                    trailing = Buffer.alloc(0);
                offset += requestSize;
            }
        }
        return null;
    }
    finally {
        api.closeHandle(handle);
    }
}
/**
 * Poll one process's memory once for the image key (synchronous convenience
 * wrapper around {@link scanProcessForImageKey}).
 * @param pid - WeChat process id.
 * @param templateScan - V2 template scan.
 * @returns the verified match or null.
 */
export async function scanImageKeyOnce(pid, templateScan) {
    return scanProcessForImageKey(pid, templateScan);
}
// Re-export the read helper for tests that need a raw read.
export { readProcessMemory };
//# sourceMappingURL=image-key-memory-scan.js.map
/**
 * Effective image key pair for offline WeChat media decoding.
 * config.json wins; the DSH key store (keys.json, written by autoGetImageKey)
 * is the fallback so a verified key works even before the user saves config.
 */
import { join } from 'node:path';
import { getConfig } from "./config.js";
import { getAccountKeysFromStore } from "../keys/key-store.js";
/**
 * Resolve the effective image AES key + XOR byte.
 * @param decrypted - decrypted data root (locates config.json + keys.json).
 * @returns the effective image AES key ('' when absent) and XOR byte.
 */
export function resolveImageKeyPair(decrypted) {
    const cfg = getConfig(decrypted);
    let aesKey = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : '';
    let xorKey = Number(cfg['image_xor_key'] ?? 136);
    if (aesKey === '') {
        const stored = getAccountKeysFromStore('default', join(decrypted, '..'));
        if (typeof stored.image_aes_key === 'string' && stored.image_aes_key.trim() !== '') {
            aesKey = stored.image_aes_key.trim();
            const storedXor = Number(stored.image_xor_key);
            if (Number.isFinite(storedXor) && storedXor >= 0 && storedXor <= 255)
                xorKey = storedXor;
        }
    }
    return { aesKey, xorKey };
}
//# sourceMappingURL=image-key.js.map
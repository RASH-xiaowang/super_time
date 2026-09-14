/**
 * Resolve the effective image AES key + XOR byte.
 * @param decrypted - decrypted data root (locates config.json + keys.json).
 * @returns the effective image AES key ('' when absent) and XOR byte.
 */
export declare function resolveImageKeyPair(decrypted: string): {
    aesKey: string;
    xorKey: number;
};

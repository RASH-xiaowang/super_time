/**
 * 取当前生效的图片 AES 密钥与 XOR 字节。
 * @param decrypted - 解密数据根（定位 config.json / secrets.json / keys.json）。
 * @returns `aesKey` 为 `undefined` 表示「没有可用密钥」—— 解码方据此报未配置，
 *   而不是拿空密钥硬解；`xorKey` 恒有值（缺省用内置默认 136）。
 */
export declare function resolveImageKeyPair(decrypted: string): {
    aesKey: string | undefined;
    xorKey: number;
};

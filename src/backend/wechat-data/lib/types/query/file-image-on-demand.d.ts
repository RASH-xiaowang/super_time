/** 一次解密结果：`file` 是相对 decoded 根的路径（渲染层拼协议 URL），或可展示的错误。 */
export interface FileImageHit {
    file?: string;
    format?: string;
    /** true = 给的是缩略/中图那一档（对应 `.t.` 槽）。 */
    thumb?: boolean;
    error?: string;
}
/**
 * 附件文件名 → 解码键（= 解码缓存的 md5 槽位）。
 *
 * 微信附件的文件名本身就是内容 md5 前缀：`<md5>[_t|_h].dat`。
 * 客户端 `fileKey()` 与服务端这里必须是**同一套剥离规则**（少剥一个 `_h` 就会查错槽）。
 * @param fileName - `file_name` 列（如 `09da5c12…_h.dat`）。
 * @returns 32 位小写 md5；形状不对时为空串。
 */
export declare function fileImageKeyOf(fileName: string): string;
/**
 * 已解密缓存命中：先主槽（原图）再 `.t.` 缩略槽，返回相对 decoded 根的路径。
 * @param decodedDir - decoded_images 根。
 * @param key - {@link fileImageKeyOf} 的结果。
 * @returns 形如 `ab12….jpg` / `ab12….t.jpg`；未命中 null。
 */
export declare function decodedFileRel(decodedDir: string, key: string): string | null;
/**
 * 按解码键定位 `.dat` 候选（已按档位排序）。
 * @param rawBase - 微信账号原始根。
 * @param key - {@link fileImageKeyOf} 的结果。
 * @returns 候选绝对路径（可能为空数组）。
 */
export declare function locateFileDats(rawBase: string, key: string): Promise<string[]>;
/** 测试用：清掉模块内的 attach 索引缓存。 */
export declare function resetAttachIndexForTest(): void;
/**
 * 按需把文件库图片解到 decoded 缓存，并给出流式显示用的相对路径。
 *
 * @param args.decryptedDir - 解密数据根（定位配置/密钥）。
 * @param args.decodedDir - decoded_images 根。
 * @param args.rawBase - 微信账号原始根（`db_dir` 的父目录），空串表示未配置。
 * @param args.key - 解码键（客户端传的是 `fileKey()` 的结果，与 md5 槽位一致）。
 * @param args.aesKey - V2 AES key（字符串或字节）。
 * @param args.xorKey - XOR key。
 * @param args.thumbFirst - true 时优先用缩略档（`_t`），否则按原图档优先（灯箱用）。
 * @returns 命中/解密成功 `{file, format, thumb?}`；失败 `{error}`。
 */
export declare function ensureFileImageDecoded(args: {
    decryptedDir: string;
    decodedDir: string;
    rawBase: string;
    key: string;
    aesKey?: string | Uint8Array;
    xorKey?: number;
    thumbFirst?: boolean;
}): Promise<FileImageHit>;

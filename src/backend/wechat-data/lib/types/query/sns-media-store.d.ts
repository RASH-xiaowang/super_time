/** 落盘子目录名（在 `decoded_images` 之下，与 `article-covers` 同级）。 */
export declare const SNS_MEDIA_STORE_SUBDIR = "sns-media";
/**
 * 容量上限（字节）。默认 2 GB。
 *
 * 为什么按字节：朋友圈原图普遍 200–800 KB，按条数（哪怕 4000 条）也会上 GB。
 * 环境变量 `SUPERTIME_SNS_MEDIA_STORE_BYTES` 可覆盖（测试与「我想少留点」的场景）。
 */
export declare const SNS_MEDIA_STORE_BUDGET_BYTES: number;
/** 从字节头判格式；认不出返回 `null`（**不猜** —— 猜错会把坏字节当原图永久缓存）。 */
export declare function sniffOriginalExt(b: Uint8Array): string | null;
/** 该扩展名对应的 mime（供调用方直接拼 data URL，省得再判一次）。 */
export declare function mimeOfExt(ext: string): string;
/**
 * 查这张图的落盘原图。
 *
 * @param decodedDir - `decoded_images` 目录（`rc.dirs().decoded`）。
 * @param md5 - 32 位媒体 md5。
 * @returns 命中的字节与格式；没有则 `null`。
 */
export declare function lookupOriginal(decodedDir: string, md5: string): {
    bytes: Buffer;
    ext: string;
} | null;
/**
 * 按字节预算淘汰最旧的原图（`mtime` 升序先删）。
 *
 * 用 `mtime` 而不是 `atime`：原图写进去之后基本不会被再读（读的是内存缓存与前端缓存），
 * 而 Windows 的 `atime` 默认不可靠。`mtime` 至少稳定地代表「什么时候存的」。
 *
 * @returns 被删掉的张数。
 */
export declare function sweepOriginalStore(decodedDir: string, budgetBytes?: number): number;
/**
 * 把一份**确认是原图**的字节存下来。
 *
 * @param decodedDir - `decoded_images` 目录。
 * @param md5 - 32 位媒体 md5（缓存键，内容寻址 ⇒ 同名必同内容，重复写无害）。
 * @param bytes - 原图字节。
 * @returns 落盘的扩展名；**不是图片 / 参数不合法 / 写失败**一律返回 `null`。
 *          返回 `null` 只表示「这次没存上」，调用方照常返回本次结果，不得因此报错。
 */
export declare function saveOriginal(decodedDir: string, md5: string, bytes: Uint8Array): string | null;
/** 把落盘原图变成 data URL（省得调用方再拼一次 mime）。 */
export declare function originalAsDataUrl(hit: {
    bytes: Buffer;
    ext: string;
}): string;
/** 测试用：清掉淘汰节流的状态（否则两条用例之间会互相吞掉）。 */
export declare function forgetSweepStateForTest(): void;

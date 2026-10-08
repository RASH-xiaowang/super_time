/** V2 image magic. */
export declare const V2_MAGIC: Buffer<ArrayBuffer>;
/** V2 ciphertext starts at this offset. */
export declare const V2_CIPHERTEXT_START = 15;
/** AES block size. */
export declare const AES_BLOCK_SIZE = 16;
/** Derived image key pair. */
export interface DerivedImageKeys {
    /** XOR byte. */
    xorKey: number;
    /** 16-char ASCII AES key. */
    aesKey: string;
}
/** A V2 template file. */
export interface V2Template {
    /** Absolute template path. */
    path: string;
    /** First AES block of ciphertext. */
    ciphertext: Buffer;
    /** File mtime in ns. */
    mtimeNs: number;
    /** Inferred XOR key from the trailer (may be null). */
    tailXorKey: number | null;
    /** Raw 2-byte trailer. */
    tailBytes: Buffer;
}
/** Result of scanning for V2 templates. */
export interface TemplateScanResult {
    /** Templates found, newest first. */
    templates: V2Template[];
    /** Most common XOR key across trailers. */
    inferredXorKey: number | null;
    /** Whether the fallback traversal was used. */
    usedFallback: boolean;
    /** Files scanned. */
    filesScanned: number;
    /** Support count for the inferred XOR key. */
    xorSupport: number;
}
/** Resolved image key. */
export interface ImageKeyResolution {
    /** kvcomm code. */
    code: number;
    /** Clean wxid. */
    wxid: string;
    /** XOR byte. */
    xorKey: number;
    /** 16-char ASCII AES key. */
    aesKey: string;
    /** Verified against a real V2 image. */
    verified: boolean;
    /** Template path used for verification. */
    templatePath: string;
    /** Inferred XOR key (may be null). */
    inferredXorKey: number | null;
}
/**
 * Strip the data-directory suffix from a wxid (wxid_x_<suffix> → wxid_x).
 * @param value - raw account id.
 * @returns the cleaned wxid, or an empty string.
 */
export declare function cleanWxid(value: string | null | undefined): string;
/**
 * Derive WeFlow's XOR byte and 16-byte ASCII AES key.
 * @param code - kvcomm code (1..0xffffffff).
 * @param wxid - account wxid (suffix stripped).
 * @returns the derived key pair.
 * @throws when code or wxid are invalid.
 */
export declare function deriveImageKeys(code: number, wxid: string): DerivedImageKeys;
/**
 * Detect the image format of a decrypted V2 block.
 * @param plaintext - decrypted first block.
 * @returns the detected format (jpeg/png/webp/wxgf/gif), or null.
 */
export declare function detectImageFormat(plaintext: Buffer | null): string | null;
/**
 * Verify one AES key against the encrypted first block of a V2 image.
 * @param aesKey - 16-byte ASCII key (string or buffer).
 * @param ciphertext - first encrypted AES block.
 * @returns true when the block decrypts to a supported image signature.
 */
export declare function verifyAesKey(aesKey: string | Buffer, ciphertext: Buffer): boolean;
/**
 * Infer XOR from the most common raw trailer pair, matching WeFlow.
 * @param tails - raw 2-byte trailer pairs.
 * @returns the inferred XOR byte, or null.
 */
export declare function inferXorKeyFromV2Tails(tails: Iterable<Buffer>): number | null;
/**
 * 扫描的**可让出**实现（生成器）：在每个目录检查点 `yield`，由驱动方决定要不要交还控制权。
 *
 * ## 为什么做成生成器而不是直接 async
 *
 * 本函数有 4 个调用点（`keys/service.ts`、`keys/image-key-memory-scan.ts`、
 * `remotes/keysdec.ts` ×2），其中两个是同步上下文。直接改成 async 会把这 4 处
 * 一起拖下水（跨 5 个模块），而收益只落在网关那两条 `@Remote` 路径上。
 * 生成器把"算到哪"的状态留在内部：同步驱动原样保持同步（调用点零改动），
 * 异步驱动才能在每个检查点让出。
 *
 * ## 为什么需要让出
 *
 * 真实 `@Remote` 层探针（`working/probe-remote.txt`）实测 `verifyImageKey`
 * 冷跑 **1603ms 且一次都不让出** —— 后端是串行 worker，这 1.6 秒里
 * **所有面板都动不了**。成本就在这里：最多 500 个目录的 BFS，每个目录一次
 * `readdir` + `stat` 排序，全部同步。
 * @param accountDir - WeChat 账号数据目录（wxid_*）。
 * @param limit - 最多返回多少张模板。
 * @param maxFallbackDirs - 兜底 BFS 的目录上限。
 * @yields 每个目录检查点交出一次（调用方可选择让出事件循环再 `next()`）。
 * @returns 模板扫描结果。
 */
export declare function scanV2TemplatesSteps(accountDir: string, limit?: number, maxFallbackDirs?: number): Generator<void, TemplateScanResult, void>;
/**
 * 扫描 V2 缩略图模板（**同步版**，行为与改造前逐字节等价）。
 * @param accountDir - WeChat account data dir (wxid_* folder).
 * @param limit - max templates to return.
 * @param maxFallbackDirs - cap for the fallback BFS.
 * @returns the template scan result.
 */
export declare function scanV2Templates(accountDir: string, limit?: number, maxFallbackDirs?: number): TemplateScanResult;
/**
 * 扫描 V2 缩略图模板（**可让出版**）：给网关的 `@Remote` 路径用。
 *
 * 与 {@link scanV2Templates} 结果**逐字段相同**（同一个生成器的产物），
 * 区别只在每个检查点之间交给调用方一次机会去让出事件循环。
 *
 * 让出的"怎么让"故意留给调用方（`onStep`）：`keys/` 这一层不该依赖 `query/search-build.ts`
 * 的 `yieldToLoop`（那是查询层的让出原语）。网关侧传进来的就是 `yieldToLoop`。
 * @param accountDir - WeChat account data dir.
 * @param onStep - 每个目录检查点调用一次；返回 Promise 就等它（用于让出）。
 * @param limit - max templates to return.
 * @param maxFallbackDirs - cap for the fallback BFS.
 * @returns the template scan result.
 */
export declare function scanV2TemplatesAsync(accountDir: string, onStep: () => Promise<void>, limit?: number, maxFallbackDirs?: number): Promise<TemplateScanResult>;
/**
 * Trusted XOR for a verified AES key across templates.
 * @param aesKey - candidate AES key.
 * @param templateData - V2 template scan or template list.
 * @returns the trusted XOR byte, or null.
 */
export declare function trustedXorForVerifiedAesKey(aesKey: string | Buffer, templateData: TemplateScanResult | V2Template[]): number | null;
/**
 * Enumerate kvcomm codes from `*_input.statistic` file names in the WeChat 4.x
 * kvcomm cache dir (`%APPDATA%/Tencent/xwechat/net/kvcomm`).
 * @param kvcommDir - kvcomm cache directory.
 * @returns unique codes, empty when none.
 */
export declare function kvcommCodesFromDir(kvcommDir: string): number[];
/**
 * Resolve the first code/wxid pair that passes real V2 AES validation.
 * @param opts - kvcomm dir, account dir and optional hints.
 * @returns the verified resolution, or null.
 */
export declare function resolveLocalImageKey(opts: {
    kvcommDir: string;
    accountDir: string;
    targetWxid?: string | null;
    account?: string | null;
    localNativeWxids?: Iterable<string> | string | null;
    templateLimit?: number;
    maxFallbackDirs?: number;
}): ImageKeyResolution | null;

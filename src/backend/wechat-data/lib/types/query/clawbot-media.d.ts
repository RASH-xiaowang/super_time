import type { ClawbotMediaRef } from './clawbot-message.ts';
/** 腾讯 iLink 的 CDN 基址（唯一出网目的地；与 API 主机同属 weixin.qq.com 域）。 */
export declare const CLAWBOT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
/** 单份媒体的下载上限（字节）。语音/图片远小于它；视频/文件超限明确报错，不截断。 */
export declare const CLAWBOT_MEDIA_MAX_BYTES: number;
/** 下载超时（WeClaw 同值 60s）。 */
export declare const MEDIA_DOWNLOAD_TIMEOUT_MS = 60000;
/** 最小 fetch 形状（同 `clawbot-ilink.ts` 的注入约定：测试假 fetch，生产全局 fetch）。 */
export interface FetchLike {
    (url: string, init?: {
        method?: string;
        signal?: AbortSignal;
    }): Promise<{
        ok: boolean;
        status: number;
        headers?: {
            get(name: string): string | null;
        };
        arrayBuffer(): Promise<ArrayBuffer>;
    }>;
}
/** 注入点：假 fetch（测试）/ 假 silk 解码（测试无需真解码器）。 */
export interface MediaOptions {
    fetchImpl?: FetchLike;
    /** 语音解码覆盖（测试注假实现；生产缺省走 wx_silk）。 */
    toWav?: (silk: Buffer, wavPath: string) => {
        ok: boolean;
        error?: string;
    };
}
/** 取数结果：成功给出本机缓存路径与展示信息；失败给出可读中文（`permanent` = 重试无意义）。 */
export type ClawbotMediaOutcome = {
    ok: true;
    path: string;
    kind: ClawbotMediaRef['kind'];
    name: string | null;
    bytes: number;
} | {
    ok: false;
    error: string;
    permanent?: boolean;
};
/** 缓存目录：`<数据根>/clawbot-media/`（数据根 = decryptedDir 的父级，与 clawbot.db 同级）。 */
export declare function clawbotMediaDir(decryptedDir: string): string;
/** 图片字节 → data URL 的 MIME（与 {@link imageExt} 同一张魔数表）。 */
export declare function imageMimeOf(bytes: Buffer): string;
/**
 * 解密 AES-128-ECB + 去 PKCS7。
 *
 * 密钥两步解析：base64 → hex 字符串 → 16 字节（WeClaw 同名实现；跳过 hex 这一步会得到
 * 一个长度对不上、或解出乱码的「密钥」）。
 * @param ciphertext - 密文字节（长度必须是 16 的倍数）。
 * @param keyBase64 - 消息里的 `aes_key`。
 * @returns 明文字节。
 * @throws 密钥/密文形状不合法（调用方翻成可读错误）。
 */
export declare function decryptMediaBytes(ciphertext: Buffer, keyBase64: string): Buffer;
/**
 * 保证某条消息的媒体在本地有一份解密后的缓存；没有就下载。
 *
 * @param decryptedDir - 解密数据根。
 * @param id - 消息行 id。
 * @param opts - 注入点（测试用）。
 * @returns 缓存路径与展示信息；失败为可读中文错误（含「没有附件」「主机被拒」「超限」）。
 */
export declare function ensureClawbotMedia(decryptedDir: string, id: number, opts?: MediaOptions): Promise<ClawbotMediaOutcome>;
/** 读缓存字节（给「图片内联展示」用；只在确实需要时调，避免大文件进 IPC）。 */
export declare function readClawbotMediaBytes(path: string): Buffer;

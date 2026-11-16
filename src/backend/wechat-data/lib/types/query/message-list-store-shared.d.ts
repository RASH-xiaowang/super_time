import type { MessageListSource, MessageListStatus } from '../types.ts';
export declare const NAME_MAX = 200;
export declare const USERNAME_MAX = 255;
export declare const TEXT_MAX = 4000;
export declare const NOTE_MAX = 500;
export declare const WEBHOOK_MAX = 2048;
/**
 * 大肥鱼发送程序的真实请求契约。
 *
 * `api_server.cpp` 使用 `wchar_t target[128]` / `message[512]`，容量包含结尾
 * `\0`；UTF-8 body 上限为 8192 字节。这里按 Windows UTF-16 code unit 计数，
 * 不能用 Unicode code point 数替代。
 */
export declare const FEATHER_TARGET_MAX_UTF16 = 127;
export declare const FEATHER_MESSAGE_MAX_UTF16 = 511;
export declare const FEATHER_REQUEST_MAX_BYTES = 8192;
export declare const ERROR_MAX = 500;
export declare const RESPONSE_MAX = 500;
export declare const SOURCE_REF_MAX = 200;
export declare const JOB_ID_MAX = 128;
export declare const JOB_STATE_MAX = 80;
export declare const INTERRUPTED_DISPATCH_STALE_MS: number;
export declare const QUERY_DEFAULT = 200;
export declare const MESSAGE_LIST_QUERY_MAX = 500;
export declare const CURSOR_VERSION = "ml1";
export declare function textOf(value: unknown, max: number): string;
/**
 * 按 UTF-16 code unit 截断，但不把代理对拆成半个 emoji。
 *
 * 返回长度不会超过 `maxUnits`；追加后缀时，后缀本身也计入预算。
 */
export declare function truncateUtf16(value: string, maxUnits: number, suffix?: string): string;
/** Node 实际发送的 JSON UTF-8 字节数，用于对齐发送程序的 Content-Length 上限。 */
export declare function jsonUtf8Bytes(value: unknown): number;
export declare function numOf(value: unknown, fallback?: number): number;
export declare function positiveId(value: unknown): number;
export declare function errorText(e: unknown): string;
export declare function ensureParentDir(decryptedDir: string): void;
export declare function httpUrl(value: unknown, max?: number): string;
export declare function sourceOf(value: unknown): MessageListSource;
export declare function statusOf(value: unknown): MessageListStatus;
/** 只接受稳定枚举里的失败分类，拒绝调用方写入自由文本。 */
export declare function failureKindOf(value: unknown): string;
/** 下游任务状态是外部协议值，只在明确可证明时映射到本地投递状态。 */
export type MessageListJobPhase = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
export declare function messageListJobPhase(value: unknown): MessageListJobPhase;
/** 任务状态对应的本地投递状态；未知状态返回 undefined，避免猜测成功/失败。 */
export declare function messageListStatusForJobPhase(phase: MessageListJobPhase): MessageListStatus | undefined;
export declare function generateReplyId(): string;

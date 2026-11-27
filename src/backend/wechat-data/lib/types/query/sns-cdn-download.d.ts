/** SNS-only bounded HTTP body ownership. No host/auth policy lives here. */
export interface SnsDownloadOptions {
    signal?: AbortSignal;
    headerTimeoutMs?: number;
    bodyTimeoutMs?: number;
    maxBytes?: number;
}
export declare const SNS_DOWNLOAD_MAX_BYTES: number;
export declare const SNS_DOWNLOAD_HEADER_MS = 15000;
export declare const SNS_DOWNLOAD_BODY_MS = 30000;
/** Bounds headers and the entire body separately; aborts transport AND cancels its reader. */
export declare function downloadSnsBody(url: string, fetchImpl: typeof fetch, options?: SnsDownloadOptions): Promise<{
    response: Response;
    bytes: Buffer;
}>;

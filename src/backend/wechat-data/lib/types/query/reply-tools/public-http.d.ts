export interface PublicAddress {
    address: string;
    family: number;
}
export type ReplyLookup = (host: string) => Promise<PublicAddress[]>;
export declare function throwIfReplyAborted(signal: AbortSignal): void;
export declare function abortableReply<T>(work: Promise<T>, signal: AbortSignal): Promise<T>;
/** Exported pure boundary for contract tests; no runtime option can disable it. */
export declare function resolveReplyPublicUrl(raw: string, resolve?: ReplyLookup): Promise<{
    url: URL;
    address: PublicAddress;
}>;
export declare function readReplyPublicHttps(raw: string, options: {
    signal: AbortSignal;
    headers?: Record<string, string>;
    maxRedirects?: number;
}): Promise<{
    text: string;
    contentType: string;
}>;

import type { MomentItem } from '../types.ts';
import type { StreamControl, ZipFileWriter } from './zip.ts';
export type ExportMediaSource = 'local' | 'cdn';
export type ExportMediaByteKind = 'image' | 'video';
export interface ExportMediaType {
    kind: ExportMediaByteKind;
    format: 'jpg' | 'png' | 'webp' | 'avif' | 'heic' | 'heif' | 'gif' | 'bmp' | 'mp4' | 'mov' | 'm4v';
    ext: string;
    mime: string;
}
export interface SnsMediaInput {
    md5?: string;
    timelineId?: string;
    mediaId?: string;
    url?: string;
    token?: string;
    seed?: string;
    /** Public RPC alias used by the Moments UI; same value as `seed`. */
    key?: string;
}
export interface SnsMediaContext {
    /** Raw WeChat account root (the parent of `msg/`). */
    base?: string;
    /** `<data root>/decoded_images`. */
    decodedDir: string;
    aesKey?: string;
    xorKey: number;
    weixinVersion?: string;
}
export interface OriginalMediaBytes {
    bytes?: Buffer;
    source?: ExportMediaSource;
    format?: string;
    thumb?: boolean;
    error?: string;
}
export interface MomentsMediaResolver {
    resolve(kind: ExportMediaByteKind, input: SnsMediaInput): Promise<OriginalMediaBytes>;
}
export type MomentMediaResourceKind = 'image' | 'video' | 'live_photo_still' | 'live_photo_video';
export interface MomentMediaResource {
    id: string;
    kind: MomentMediaResourceKind;
    status: 'ok' | 'missing' | 'error';
    source?: ExportMediaSource;
    local: boolean;
    timelineId?: string;
    mediaId?: string;
    md5?: string;
    archivePath?: string;
    mime?: string;
    size?: number;
    pairId?: string;
    duration?: number;
    stillImageTimeMs?: number;
    error?: string;
}
export interface MomentsMediaManifest {
    version: 1;
    total: number;
    ok: number;
    missing: number;
    error: number;
    truncated: boolean;
    resources: MomentMediaResource[];
}
export interface MomentsMediaExportOptions {
    includeImages?: boolean;
    includeVideos?: boolean;
    includeLivePhotos?: boolean;
}
export interface WriteMomentsMediaArchiveOptions {
    zip: ZipFileWriter;
    items: readonly MomentItem[];
    ctx: SnsMediaContext;
    options?: MomentsMediaExportOptions;
    resolver?: MomentsMediaResolver;
    ctrl?: StreamControl;
    /** Test seam; production always uses {@link MAX_MOMENT_MEDIA}. */
    maxMedia?: number;
}
/**
 * Sniff the bytes as an image or video. The optional kind hint prevents a
 * generic ISO-BMFF container from being accepted in the wrong slot.
 */
export declare function sniffExportMediaBytes(bytes: Uint8Array, kindHint?: ExportMediaByteKind): ExportMediaType | null;
/**
 * Resolve a Moments still image using only original tiers:
 * long-term archive → decoded original cache → local non-thumb decode → CDN.
 */
export declare function loadSnsImageOriginalBytes(ctx: SnsMediaContext, input: SnsMediaInput): Promise<OriginalMediaBytes>;
/** Resolve a normal or Live Photo motion video from the verified byte loader. */
export declare function loadSnsVideoOriginalBytes(ctx: SnsMediaContext, input: SnsMediaInput): Promise<OriginalMediaBytes>;
export declare function productionMomentsMediaResolver(ctx: SnsMediaContext): MomentsMediaResolver;
/**
 * Stream original media entries into an already-open ZIP and return the
 * manifest. A failed resource is recorded and does not abort the archive.
 */
export declare function writeMomentsMediaArchive(args: WriteMomentsMediaArchiveOptions): Promise<MomentsMediaManifest>;

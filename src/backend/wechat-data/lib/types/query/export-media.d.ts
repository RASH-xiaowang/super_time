import type { WechatMessage } from '../types.ts';
import type { StreamControl } from './zip.ts';
import type { ZipFileWriter } from './zip.ts';
export type ExportMediaKind = 'image' | 'sticker' | 'video' | 'voice' | 'file';
export type ExportMediaStatus = 'ok' | 'missing' | 'error';
export type ExportMediaRole = 'content' | 'cover';
/** A resource reference used by formatters and the ZIP manifest. */
export interface ExportMediaEntry {
    id: string;
    kind: ExportMediaKind;
    role: ExportMediaRole;
    status: ExportMediaStatus;
    label: string;
    messageLocalId: number;
    messageLocalIds: number[];
    messageTime: number;
    sender: string;
    archivePath?: string;
    posterArchivePath?: string;
    sourcePath?: string;
    sourceName?: string;
    mime?: string;
    size?: number;
    error?: string;
    recordIndex?: number;
}
export type ExportMediaLinks = Map<number, ExportMediaEntry[]>;
export interface SessionMediaArchive {
    entries: ExportMediaEntry[];
    links: ExportMediaLinks;
    mediaCount: number;
    mediaMissingCount: number;
}
export interface PrepareSessionMediaOptions {
    decryptedDir: string;
    decodedDir: string;
    username: string;
    msgs: readonly WechatMessage[];
    /** Raw WeChat account root (the parent of `msg/`). */
    wechatBaseDir?: string;
    aesKey?: string;
    xorKey?: number;
    ctrl?: StreamControl;
}
/** Resolve all actual media files referenced by the selected transcript. */
export declare function prepareSessionMediaArchive(options: PrepareSessionMediaOptions): Promise<SessionMediaArchive>;
/**
 * Stream every resolved resource into the ZIP. A file that disappears between
 * planning and writing is downgraded to an `error` entry; only cancellation is
 * allowed to abort the complete archive.
 */
export declare function writeSessionMediaArchive(zip: ZipFileWriter, archive: SessionMediaArchive, ctrl?: StreamControl): Promise<void>;
/** Serialize the resource manifest while retaining the legacy `media` field. */
export declare function buildSessionMediaManifest(username: string, exportedAt: string, total: number, archive: SessionMediaArchive, chatlogMedia: Array<Record<string, unknown>>): string;
/** Empty plan used for non-ZIP exports and for handlers compiled before media support. */
export declare function emptySessionMediaArchive(): SessionMediaArchive;

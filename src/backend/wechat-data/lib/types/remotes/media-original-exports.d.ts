import { type StreamControl } from '../query/zip.ts';
import type { MediaOriginalExportResult } from '../types.ts';
import type { MediaRemoteCtx } from './media.ts';
/** Correct a media destination extension to the sniffed real container format. */
export declare function originalExportDestination(dest: string, format: string): string;
export interface OriginalMediaExportRemote {
    exportChatVideo: (options: {
        username: string;
        localId: number;
        dest: string;
        jobId?: string;
    }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>;
    exportChatFile: (options: {
        username: string;
        localId: number;
        dest: string;
        jobId?: string;
    }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>;
    exportFileImage: (options: {
        md5: string;
        dest: string;
        jobId?: string;
    }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>;
    exportFileVideo: (options: {
        md5: string;
        dest: string;
        jobId?: string;
    }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>;
    exportFileAttachment: (options: {
        fileName: string;
        size?: number;
        createTime?: number;
        md5?: string;
        dest: string;
        jobId?: string;
    }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>;
}
/** Build single-item original export handlers for chat and file-library media. */
export declare function createOriginalMediaExportRemotes(rc: MediaRemoteCtx): OriginalMediaExportRemote;

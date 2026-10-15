import { OperationCategory, OperationStatus, VoiceTranscribeResult, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
export interface createVoiceLlmRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    ctx: () => Context;
    getWhisperDownload: () => WhisperDownloadProgress | null;
    setWhisperDownload: (v: WhisperDownloadProgress | null) => void;
    getWhisperTranscribing: () => WhisperTranscribing;
    /** W3-5.5：下载的取消槽（由 gateway 持有）。 */
    whisperDownloadSignal: (jobId?: string) => {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    cancelWhisperDownloadJob: (jobId?: string) => boolean;
    setWhisperTranscribing: (v: WhisperTranscribing) => void;
}
export declare function createVoiceLlmRemotes(rc: createVoiceLlmRemotesInputs): {
    transcribeVoiceBatch(options?: {
        limit?: number;
    }): Promise<VoiceTranscribeResult>;
    installWhisperEngine(options?: {
        jobId?: string;
    }): Promise<WhisperDownloadResult>;
    downloadWhisperModel(options: {
        model: string;
        jobId?: string;
    }): Promise<WhisperDownloadResult>;
    /** W3-5.5：取消一次正在跑的下载。 */
    cancelWhisperDownload(options: {
        jobId?: string;
    }): {
        ok: boolean;
        message?: string;
    };
    getWhisperStatus(): WhisperStatus;
    listLlmModels(options: {
        provider: string;
    }): Promise<{
        models: Array<{
            id: string;
            name: string;
        }>;
    }>;
    listLlmProviders(): {
        providers: Array<{
            id: string;
            name: string;
        }>;
    };
};

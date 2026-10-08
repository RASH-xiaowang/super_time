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
    setWhisperTranscribing: (v: WhisperTranscribing) => void;
}
export declare function createVoiceLlmRemotes(rc: createVoiceLlmRemotesInputs): {
    transcribeVoiceBatch(options: {
        limit?: number;
    }): Promise<VoiceTranscribeResult>;
    installWhisperEngine(): Promise<WhisperDownloadResult>;
    downloadWhisperModel(options: {
        model: string;
    }): Promise<WhisperDownloadResult>;
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

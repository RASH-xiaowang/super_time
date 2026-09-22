import { KbVectorBuildResult, KbVectorIndexStatus } from '../query/kb-vectors.ts';
import { KbEntitySummary } from '../query/kb/extract.ts';
import { KbModelRole, KbModelSettings, ResolvedModel } from '../query/kb/model-config.ts';
import { EmbedFn } from '../query/retrieval/embedding.ts';
import { KbDeleteAction, KbFileAddResult, KbFileChunkPage, KbFileListSnapshot, KbFileMutationResult, KbListSnapshot, KbMutationResult, KbSearchResult, KbSummaryResult, OperationCategory, OperationStatus } from '../types.ts';
import { Context } from '@deepseek-ai/cordis';
/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface KbRemoteCtx {
    dirs: () => {
        decrypted: string;
    };
    ctx: Context;
    kbIndexJobs: Map<number, {
        done: number;
        total: number;
        startedAt: number;
        error: string;
    }>;
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    privacyBlocked: (feature: string, detail?: string) => string | null;
    privacyGate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => {
        ok: true;
        texts: string[];
    } | {
        ok: false;
        error: string;
    };
    makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => EmbedFn | undefined;
    globalModelName: (role: KbModelRole) => string;
    kbModel: (kbId: number, role: KbModelRole) => ResolvedModel;
    makeChatAsker: (kbId: number, feature: string) => ((prompt: string) => Promise<string>) | undefined;
}
export declare function createKbRemotes(rc: KbRemoteCtx): {
    getKbs(): KbListSnapshot;
    createKb(options: {
        name: string;
    }): KbMutationResult;
    renameKb(options: {
        id: number;
        name: string;
    }): KbMutationResult;
    deleteKb(options: {
        id: number;
        action: KbDeleteAction;
    }): KbMutationResult;
    getKbFiles(kbId: number, options?: {
        limit?: number;
        offset?: number;
    }): KbFileListSnapshot;
    getKbFileChunks(kbId: number, fileId: number, options?: {
        limit?: number;
        offset?: number;
    }): KbFileChunkPage;
    addKbFiles(options: {
        kbId: number;
        paths: string[];
        includeInRag?: boolean;
    }): KbFileAddResult;
    deleteKbFile(options: {
        kbId: number;
        id: number;
    }): KbFileMutationResult;
    setKbFileRag(options: {
        kbId: number;
        id: number;
        includeInRag: boolean;
    }): KbFileMutationResult;
    summarizeKbFile(options: {
        kbId: number;
        id: number;
    }): Promise<KbSummaryResult>;
    searchKb(options: {
        kbId: number;
        query?: string;
        topK?: number;
    }): Promise<KbSearchResult>;
    getKbModelConfig(options: {
        kbId: number;
    }): {
        kbId: number;
        settings: KbModelSettings;
        global: Record<KbModelRole, string>;
        resolved: Record<KbModelRole, ResolvedModel>;
        entities: KbEntitySummary;
    };
    setKbModelConfig(options: {
        kbId: number;
        chatRef?: string;
        embedRef?: string;
        rerankRef?: string;
    }): {
        ok: true;
        settings: KbModelSettings;
    } | {
        ok: false;
        error: string;
    };
    getKbVectorIndex(options: {
        kbId: number;
    }): {
        kbId: number;
        model: string;
        source: "inherit" | "inline";
        configured: boolean;
        status: KbVectorIndexStatus;
        job: {
            done: number;
            total: number;
            startedAt: number;
            error: string;
        } | null;
    };
    buildKbVectorIndex(options: {
        kbId: number;
        force?: boolean;
    }): Promise<KbVectorBuildResult & {
        ok: boolean;
        error?: string;
    }>;
    extractKbEntities(options: {
        kbId: number;
        fileIds?: number[];
        limit?: number;
    }): Promise<{
        ok: boolean;
        error?: string;
        files: number;
        saved: number;
        failed: Array<{
            id: number;
            error: string;
        }>;
        model: string;
    }>;
    suggestKbLinks(options: {
        kbId: number;
        text?: string;
        topK?: number;
        excludeTitle?: string;
    }): Promise<{
        ok: boolean;
        error?: string;
        candidates: Array<{
            label: string;
            kind: "note" | "entity";
            score: number;
        }>;
        pool: number;
        model: string;
        note?: string;
    }>;
};

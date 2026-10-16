import { KbModelRole, ResolvedModel } from '../query/kb/model-config.ts';
import { EmbedFn } from '../query/retrieval/embedding.ts';
import { KbDeleteAction, KbFileAddResult, KbFileChunkPage, KbFileListSnapshot, KbFileMutationResult, KbListSnapshot, KbMutationResult, KbSearchResult, KbSummaryResult, OperationCategory, OperationStatus } from '../types.ts';
import { KbExtractResult, KbLinkSuggestResult, KbModelConfigResult, KbModelConfigView, KbVectorBuildWireResult, KbVectorIndexView } from '../types-kb-wire.ts';
import { Context } from '@deepseek-ai/cordis';
import type { PrivacyGateFn } from '../gateway-privacy.ts';
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
    /** W3-11.5：本库向量构建的取消槽（与消息域的构建各占一格，互相不会打断）。 */
    kbIndexSignal: (jobId?: string) => {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /** W3-11.5：取消本库向量构建（与上面成对）。 */
    cancelKbIndexJob: (jobId?: string) => boolean;
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    privacyGate: PrivacyGateFn;
    makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => EmbedFn | undefined;
    globalModelName: (role: KbModelRole) => string;
    kbModel: (kbId: number, role: KbModelRole) => ResolvedModel;
    makeChatAsker: (kbId: number, feature: string) => ((prompt: string) => Promise<string>) | undefined;
}
/** 摘要输入的字符上限（随 KB 处理器一起搬来：只有这一域在用）。 */
/**
 * 文件摘要一次喂给模型的字符上限。
 *
 * 为什么是 8000：一份文件最多两万块、约一千万字（`kb/chunk.ts` 的
 * `CHUNK_MAX_CHARS × MAX_CHUNKS_PER_FILE`），全量根本进不了 prompt。8000 字与
 * 问答侧的上下文预算（`compress.maxChars` 6000）同一量级，够概括一份中等文档，
 * 又不至于让一次摘要吃掉整条上下文。截断是**必须被说出来**的 ——
 * 覆盖了多少字要落库并回给界面（见 `summarizeKbFile`）。
 */
/**
 * W3-6.6：实体抽取的并发上限。
 *
 * 与 `gateway-scheduler.ts` 的 `DUE_SUMMARY_CONCURRENCY` 同一份模式
 * （共享 next 下标原子认领 + 单任务失败不连坐）。
 * 上限小心地写小：每个工作者都是一次 LLM 请求，放开上限会
 * 把厂商的速率限制撞穻（而且反而更慢）。
 */
export declare const KB_EXTRACT_CONCURRENCY = 3;
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
    }): KbModelConfigView;
    setKbModelConfig(options: {
        kbId: number;
        chatRef?: string;
        embedRef?: string;
        rerankRef?: string;
    }): KbModelConfigResult;
    getKbVectorIndex(options: {
        kbId: number;
    }): KbVectorIndexView;
    buildKbVectorIndex(options: {
        kbId: number;
        force?: boolean;
        jobId?: string;
    }): Promise<KbVectorBuildWireResult>;
    /**
     * 停止本库正在跑的向量构建（W3-11.5）。
     *
     * 取消在〔认领下一批〕之前生效；两阶段构建的阶段二在全部批次之后，所以取消 ⇒
     * 一行都没写 ⇒ 旧索引原样。停不上的原因如实返回（已算完 / 标识不认识）。
     */
    cancelKbIndexBuild(options: {
        jobId?: string;
    }): {
        ok: boolean;
        message?: string;
    };
    extractKbEntities(options: {
        kbId: number;
        fileIds?: number[];
        limit?: number;
    }): Promise<KbExtractResult>;
    suggestKbLinks(options: {
        kbId: number;
        text?: string;
        topK?: number;
        excludeTitle?: string;
    }): Promise<KbLinkSuggestResult>;
};

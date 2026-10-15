import { KnowledgeSnapshotRead } from '../query/notes.ts';
import { EditMutationResult, OperationCategory, OperationStatus, SearchBuildResult, SearchSnapshot } from '../types.ts';
import { RetrievalEvalResult } from '../types-retrieval.ts';
export interface createGraphSearchRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    searchJobs: Map<string, AbortController>;
    searchSignal: (jobId?: string) => {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    /** W3-11.5：进度事件的出口（与 laya 分析同一套路）。 */
    ctx: () => {
        emit: (name: string, ...args: unknown[]) => void;
    };
    /**
     * W3-11.5：索引构建的取消槽。
     *
     * **不复用 `searchJobs`**：搜索与构建会同时在跑，共用一个 Map 的话两个毫不相干的
     * jobId 会互相顶掉对方的令牌，「停止构建」会打到正在跑的搜索上。
     */
    searchIndexSignal: (jobId?: string) => {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    cancelSearchIndexJob: (jobId?: string) => boolean;
}
export declare function createGraphSearchRemotes(rc: createGraphSearchRemotesInputs): {
    getKnowledgeGraph(kbId: number): KnowledgeSnapshotRead;
    searchMessages(options: {
        query: string;
        limit?: number;
        username?: string;
        jobId?: string;
    }): Promise<SearchSnapshot>;
    buildSearchIndex(options?: {
        force?: boolean;
        jobId?: string;
    }): Promise<SearchBuildResult>;
    /**
     * 停止一次正在跑的搜索索引构建（W3-11.5）。
     *
     * 取消只在分片边界（以及分片内每次让出）生效，且会 ROLLBACK ⇒ 旧索引原封不动。
     */
    cancelSearchIndexBuild(options: {
        jobId?: string;
    }): {
        ok: boolean;
        message?: string;
    };
    evaluateRetrieval(options?: {
        k?: number;
    }): RetrievalEvalResult;
    resetEditedMessage(options: {
        username: string;
        localId: number;
    }): EditMutationResult;
};

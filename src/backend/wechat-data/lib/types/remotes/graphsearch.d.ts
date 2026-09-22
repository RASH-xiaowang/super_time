import { KnowledgeSnapshotRead } from '../query/notes.ts';
import { EditMutationResult, OperationCategory, OperationStatus, SearchBuildResult, SearchSnapshot } from '../types.ts';
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
    }): Promise<SearchBuildResult>;
    evaluateRetrieval(options?: {
        k?: number;
    }): {
        report: string;
        hybrid: {
            precision: number;
            recall: number;
            mrr: number;
            ndcg: number;
            map: number;
            cases: number;
            hits: number;
        };
        sparseOnly: {
            precision: number;
            recall: number;
            mrr: number;
            ndcg: number;
            map: number;
            cases: number;
            hits: number;
        };
        intentAccuracy: {
            correct: number;
            total: number;
            accuracy: number;
        };
    };
    resetEditedMessage(options: {
        username: string;
        localId: number;
    }): EditMutationResult;
};

import { FeedbackRecord, IntentKind, RerankWeights } from '../query/retrieval/types.ts';
import { AskHistoryQuery, AskHistorySnapshot, OperationCategory, OperationStatus } from '../types.ts';
import { RetrievalConfig, RetrievalConfigPatch, RetrievalStatus } from '../types-retrieval.ts';
export interface createAskRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    askFeedbackSeen: Map<string, number>;
    askTrace: Map<string, {
        features: Map<string, RerankWeights>;
        citations: string[];
        question: string;
        answer: string;
        intent: IntentKind;
    }>;
}
export declare function createAskRemotes(rc: createAskRemotesInputs): {
    submitAskFeedback(options: {
        retrievalId?: string;
        rating: "up" | "down";
        useful?: number[];
        useless?: number[];
        question?: string;
        answer?: string;
    }): {
        ok: boolean;
        adaptedWeights?: RerankWeights;
        features?: string[];
        feedbackTotal?: number;
        message?: string;
    };
    listRetrievalFeedback(options?: {
        limit?: number;
    }): {
        items: FeedbackRecord[];
        stats: {
            total: number;
            up: number;
            down: number;
        };
    };
    getAskHistory(options?: AskHistoryQuery): AskHistorySnapshot;
    getRetrievalStatus(): RetrievalStatus;
    saveRetrievalConfig(options?: {
        patch?: RetrievalConfigPatch;
    } | RetrievalConfigPatch): {
        ok: boolean;
        config: RetrievalConfig;
    };
};

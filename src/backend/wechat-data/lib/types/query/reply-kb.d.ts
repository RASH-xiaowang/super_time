import type { EmbedFn } from './vector-math.ts';
export interface ReplyKbQuery {
    /** 原句上下文，优先交给语义向量通道。 */
    semantic: string;
    /** 去停用词后的内容词，交给 FTS5 稀疏通道。 */
    lexical: string;
}
export interface ReplyKbSnippetResult {
    snippets: string[];
    /** 未命中/降级原因；命中正常时为空串。 */
    note: string;
}
export interface CollectReplyKbSnippetsInput {
    decryptedDir: string;
    kbId: number;
    lines: readonly string[];
    latestPeer?: string;
    topK?: number;
    makeEmbedFn: (model: string, feature: 'kb_embed') => EmbedFn | undefined;
    kbModel: (kbId: number, role: 'embed') => {
        model: string;
    };
}
/**
 * 从推荐回复的对话上下文构造双通道查询。
 * @param lines - `collectReplyContext` 产出的“我/对方：...”行。
 * @param latestPeer - 对方最后一句（用于确保它不因上下文截断而丢失）。
 * @returns semantic/lexical 两种查询。
 */
export declare function buildReplyKbQuery(lines: readonly string[], latestPeer?: string): ReplyKbQuery;
/**
 * 使用与问答链路相同的知识库混合检索，为推荐回复取证据片段。
 * @param input - 会话上下文、目标库与模型注入。
 * @returns 最多 `topK` 段带文件名的片段，以及未命中时的真实原因。
 */
export declare function collectReplyKbSnippetsHybrid(input: CollectReplyKbSnippetsInput): Promise<ReplyKbSnippetResult>;

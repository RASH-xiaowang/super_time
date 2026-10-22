/**
 * 统一证据包的公共类型与预算常量。
 *
 * 这些声明被运行时的参数、引用映射与测试共同引用；从 `evidence.ts` 抽出只为
 * 控制单文件规模，不承载任何映射、合并、排序或状态判定逻辑。
 *
 * @module query/answer-runtime/evidence-types
 */
/** 证据来源域。 */
export type EvidenceSource = 'msg' | 'kb' | 'agg' | 'resource';
/** 证据的可点击/可回溯定位信息。 */
export type EvidenceLocator = {
    type: 'message';
    username: string;
    localId: number;
    key: string;
} | {
    type: 'kb';
    kbId: number;
    fileId: number;
    chunkId: number;
    key: string;
    fileName: string;
    fileExt: string;
    ordinal: number;
    page: number;
    heading: string;
} | {
    type: 'fact';
    tool: string;
    /** 旧版按数组下标定位；仅为兼容既有调用方保留。 */
    index?: number;
    /** 事实标题（已归一化前的人类可读标题）。 */
    title?: string;
    /** 正文摘要，用于把 key 映射回统计源。 */
    bodyDigest?: string;
    /** 与 {@link EvidenceItem.key} 相同的稳定键。 */
    key?: string;
} | {
    type: 'resource';
    tool: string;
    key: string;
    /** 稳定资源键；缺省时等于 `key`。 */
    stableKey?: string;
    resourceKind?: 'file' | 'favorite' | 'moment' | 'record';
    time?: string;
    session?: string;
    sourceId?: string;
    fileName?: string;
    size?: number;
    category?: string;
    md5?: string;
    thumbMd5?: string;
    fullMd5?: string;
    favoriteId?: number;
    serverId?: string;
    transferId?: string;
    messageServerId?: string;
    timelineId?: string;
    username?: string;
    mediaId?: string;
    /** 收藏媒体的实际类型；与朋友圈的 mediaId 区分。 */
    mediaKind?: string;
    url?: string;
    token?: string;
    seed?: string;
    recordType?: 'transfers' | 'redpackets';
};
/** 统一证据项。 */
export interface EvidenceItem {
    evidenceId: string;
    /** 证据类型：命中片段或确定性事实。 */
    kind: 'hit' | 'fact';
    /** 该证据的规范工具名（多个工具命中同一条时取字典序最小，保证结果稳定）。 */
    tool: string;
    /** 合并后所有产出过同一条证据的工具（去重、排序）。 */
    tools: string[];
    source: EvidenceSource;
    name: string;
    time: string;
    sender?: string;
    snippet: string;
    score?: number;
    /** 工具结果里的稳定键（事实证据使用 `fact:<tool>:<slug>`）。 */
    key: string;
    locator: EvidenceLocator;
    /** 可直接进入引用列表的可点击来源；资源类证据由 runtime 决定是否展示。 */
    citation?: CitationShape;
    /** 是否因字符预算截断了 snippet。 */
    truncated?: boolean;
    /** 是否为确定性统计事实。 */
    fact?: boolean;
}
/** 回答状态（主运行时约定）。 */
export type AnswerStatus = 'ok' | 'insufficient' | 'needs_clarification' | 'degraded' | 'blocked' | 'failed';
/** 证据充分性。 */
export type EvidenceSufficiency = 'missing' | 'insufficient' | 'sufficient';
/** 兼容别名。 */
export type EvidenceStatus = EvidenceSufficiency;
/** 证据充分性评估。 */
export interface EvidenceAssessment {
    status: EvidenceSufficiency;
    sufficient: boolean;
    usableItems: number;
    reason: string;
    /** 是否真正支撑「已充分」；`needsCitation` 表示还要等最终回答实际引用。 */
    needsCitation?: boolean;
}
/** 证据包统计。 */
export interface EvidenceBundleStats {
    /** 保留的证据总条数（与 total 相同，主运行时约定名）。 */
    count: number;
    /** 消息证据条数。 */
    messages: number;
    /** 知识库证据条数。 */
    kb: number;
    /** 去重后的消息会话数。 */
    sessions: number;
    /** 去重前的 hit + fact 条数。 */
    candidateCount: number;
    total: number;
    hitCount: number;
    factCount: number;
    duplicateCount: number;
    droppedByBudget: number;
    truncated: boolean;
    snippetChars: number;
    sourceCounts: Record<EvidenceSource, number>;
    toolCounts: Record<string, number>;
    failedTools: string[];
    /** 实际执行过的工具数。 */
    attemptedTools: number;
    /** 成功的工具数。 */
    successfulTools: number;
    /** 根字段或 hits/facts 容器形状非法的结果数。 */
    malformedResults?: number;
    /** 被拒绝的畸形 hit 数。 */
    malformedHits?: number;
    /** 被拒绝的畸形 fact 数。 */
    malformedFacts?: number;
    /** 可恢复归一（例如非法 source 回退为 msg）的诊断。 */
    normalizationWarnings?: string[];
    /** 成功返回但明确标记为「结果可能不完整」的工具次数。 */
    partialResults?: number;
    /** 部分结果的原因摘要（每项已截断，最多 8 条）。 */
    partialNotes?: string[];
    /** 输出侧边界拒绝的条数（跨会话消息、非知识库来源、错误 kbId）。 */
    rejectedCount?: number;
    /** 边界拒绝原因（已截断去重，最多 8 条）。 */
    rejectionNotes?: string[];
    /** 工具以范围错误（越权 / 未授权范围 / 数据面阻断）失败的结果数。 */
    scopeBlockedResults?: number;
    /**
     * 工具因“当前范围无法在该数据域执行”而失败的结果数。
     *
     * 与 {@link scopeBlockedResults} 分开：`unsupported_scope` 表示工具能力
     * 与范围不匹配（例如固定时间窗下查会话列表），没有返回任何越界内容，
     * 不能据此封锁整轮回答。
     */
    unsupportedScopeResults?: number;
}
/** 统一证据包。 */
export interface EvidenceBundle {
    items: EvidenceItem[];
    /** 确定性统计事实（与 items 中的 agg 证据同源）。 */
    facts: Array<{
        title: string;
        body: string;
    }>;
    /** 主运行时的回答状态。 */
    status: AnswerStatus;
    /** 缺失的证据/失败的来源（如工具名、`evidence`）。 */
    missing: string[];
    stats: EvidenceBundleStats;
    assessment: EvidenceAssessment;
}
/** 构建预算。 */
export interface BuildEvidenceOptions {
    /** 最多保留多少条证据（默认 60）。 */
    maxItems?: number;
    /** snippet 文本总字符预算（默认 12000）。 */
    maxChars?: number;
    /** 充分性判定：至少多少条可用证据（默认 1）。 */
    minItems?: number;
    /** 充分性判定：snippet 至少多少字符才算可用（默认 4；各来源还会取更高下限）。 */
    minSnippetChars?: number;
    /** 最终回答是否引用了至少一条证据；缺省表示尚未做引用复核。 */
    cited?: boolean;
    /** 本轮意图是否属于统计（聚合事实仅在统计意图下可作为充分证据）。 */
    aggregateIntent?: boolean;
    /** 显式覆盖回答状态（runtime 在澄清/阻断/降级时使用）。 */
    status?: AnswerStatus;
    /**
     * 只接受该会话的消息/资源证据（session-ask 的服务端硬边界）。
     *
     * 工具参数校验只能约束模型请求；工具实现或旧插件仍可能返回别的会话。
     * 证据层必须再做一次输出侧校验，越界条目不得进入引用列表。
     */
    allowedUsername?: string;
    /** 只接受知识库来源；消息、聚合、资源与事实全部拒绝（ClawBot kb-only）。 */
    kbOnly?: boolean;
    /** 只接受该知识库的 KB 证据；与 {@link kbOnly} 一起构成发送前复核。 */
    allowedKbId?: number;
}
/** 可直接进入引用列表的可点击来源。 */
export interface CitationShape {
    name: string;
    time: string;
    snippet: string;
    username: string;
    local_id: number;
    sender?: string;
    source: EvidenceSource;
    kb?: {
        kbId: number;
        fileId: number;
        fileName: string;
        fileExt: string;
        chunkId: number;
        ordinal: number;
        page: number;
        heading: string;
    };
    resourceKey?: string;
}
/** 默认预算（导出便于 runtime 展示与测试复用）。 */
export declare const EVIDENCE_BUDGET_DEFAULTS: {
    readonly maxItems: 60;
    readonly maxChars: 12000;
    readonly minItems: 1;
    readonly minSnippetChars: 4;
};
/**
 * 按来源的最小片段长度。
 *
 * 资源证据的 snippet 常常只是 `120 KB` 或一个标题；知识库块则必须足够长才能
 * 支撑事实陈述。显式传入的 `minSnippetChars` 仍然作为统一下限，两者取较大值。
 */
export declare const EVIDENCE_SOURCE_MIN_CHARS: Readonly<Record<EvidenceSource, number>>;
/** 各来源的最低分阈值；没有分值的旧工具结果按长度与结构判断。 */
export declare const EVIDENCE_SOURCE_MIN_SCORE: Readonly<Record<EvidenceSource, number | undefined>>;

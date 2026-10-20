/**
 * 问答**检索工具**的契约（2026-10-16 新增）。
 *
 * ## 为什么要有「工具」这一层
 *
 * 改造前，问答的检索是一条**写死的流水线**：意图路由 → 查询改写 → 三通道召回 →
 * RRF 融合 → 重排 → 压缩。它对「最近一次转账给谁」这类问题很好，但对
 * 「哪个群消息最多」「我一共收到多少笔转账」这类**需要不同数据操作**的问题
 * 只能硬凑 —— 实测答「14 条」（真实 282 条）或「判断不了」。
 *
 * 根因不是流水线写得不好，而是**它只有一种操作**（片段召回）。而问答真正需要的
 * 是一组**不同的数据操作**：关键词检索、语义检索、聚合统计、会话列表、联系人查询、
 * 朋友圈检索、收藏检索、文件检索、记录查询、知识库检索、上下文展开……
 *
 * 所以这里把它们做成**显式的工具**：每个工具有名字、说明、参数 schema 与结构化结果。
 * 好处有三：
 *   ① **可被模型调用**（tool use）：模型自己决定「这个问题该用哪个工具」，
 *      而不是靠一堆正则去猜意图；
 *   ② **可被流水线调用**：现有流水线可以逐步改成「按意图选工具」，
 *      不必一次性重写（渐进迁移，每一步都能单独验证）；
 *   ③ **可单独测试**：每个工具是纯函数（输入参数 → 输出结果），
 *      不必造一个完整问答就能验它对不对。
 *
 * ## 与 `dsh-llm` 的 `ToolSchema` 的关系
 *
 * `ToolSchema` 是**发给模型**的形状（`name` / `description` / `parameters`）。
 * 本模块的 {@link RetrievalTool} 在它之上多了一个 `run` —— 即「这个工具怎么执行」。
 * 两者刻意分开：`schema` 是给模型看的（措辞要面向模型），`run` 是给运行时用的
 * （实现要面向数据）。`toToolSchemas()` 负责把工具集投影成模型能看的清单。
 *
 * @module query/tools/types
 */
/** 工具名（稳定标识，模型按它调用；改动等于破坏兼容）。 */
export type ToolName = 'search_messages' | 'search_semantic' | 'aggregate_messages' | 'list_sessions' | 'get_session_messages' | 'get_message_context' | 'search_contacts' | 'get_contact_detail' | 'search_moments' | 'search_favorites' | 'search_files' | 'search_records' | 'search_kb';
/** 工具的分类（用于界面分组与「这次用了哪类工具」的展示）。 */
export type ToolCategory = 'message' | 'aggregate' | 'contact' | 'content' | 'kb';
/**
 * 工具的执行上下文。
 *
 * 为什么把 `decryptedDir` 等放在上下文而不是每个 `run` 的参数里：
 * 它们是**环境**（这次问答在哪个数据目录上跑），不是**这次调用的意图**。
 * 混在一起会让模型看到的参数 schema 里出现一堆它不该填的字段。
 */
export interface ToolContext {
    /** 解密数据根目录。 */
    decryptedDir: string;
    /** 当前知识库 id（不传 = 不检索知识库）。 */
    kbId?: number;
    /** 用户显式范围（硬过滤）。 */
    scope?: {
        username?: string;
        from?: string;
        to?: string;
    };
    /** 现在时刻（可注入，便于测试）。 */
    now?: Date;
    /** 已知实体名（联系人显示名），用于实体识别。 */
    knownEntities?: string[];
}
/** 工具执行结果里的一条「命中」。 */
export interface ToolHit {
    /** 稳定键（消息是 `username:local_id`，知识库是 `kb:<kbId>:<chunkId>`）。 */
    key: string;
    /** 展示名（会话名 / 文件名 / 联系人名）。 */
    name: string;
    /** 时间（`YYYY-MM-DD HH:mm`；没有发生时间的来源为空串）。 */
    time: string;
    /** 摘要（进上下文的那段文字）。 */
    snippet: string;
    /** 群聊里的发送者显示名（单聊为空）。 */
    sender?: string;
    /** 来源域（与 `RetrievedDoc.source` 同口径）。 */
    source?: 'msg' | 'kb' | 'agg';
    /** 该条在本次结果里的得分（各工具量纲不同，只用于排序展示）。 */
    score?: number;
}
/**
 * 工具执行结果。
 *
 * `facts` 与 `hits` 是**两类不同的东西**，刻意分开：
 *   · `hits` 是「找到的原文片段」—— 模型据此转述；
 *   · `facts` 是「算出来的确定性结论」（如「含『转账』282 条」）—— 模型据此直接回答。
 * 混在一个数组里会让模型分不清「这是原文」还是「这是统计」，而两者的可信度不同。
 */
export interface ToolResult {
    /** 工具名（回带，便于日志与界面展示）。 */
    tool: ToolName;
    /** 是否成功（false 时 `error` 说明原因，`hits`/`facts` 为空）。 */
    ok: boolean;
    /** 失败原因（`ok=false` 时）。 */
    error?: string;
    /** 找到的原文片段。 */
    hits: ToolHit[];
    /** 算出来的确定性结论（聚合类工具才有）。 */
    facts?: Array<{
        title: string;
        body: string;
    }>;
    /** 结果的一句话说明（写进过程时间线，如「召回 128 条 → 保留 24 条」）。 */
    note?: string;
    /** 耗时（毫秒）。 */
    elapsedMs?: number;
}
/**
 * 一个检索工具。
 *
 * `schema` 与 `run` 分开的理由见模块头注。
 */
export interface RetrievalTool {
    /** 工具名。 */
    name: ToolName;
    /** 分类（界面分组用）。 */
    category: ToolCategory;
    /** 面向模型的说明（写清「什么时候该用它」而不只是「它做什么」）。 */
    description: string;
    /** 参数 schema（JSON Schema 对象，直接发给模型）。 */
    parameters: Record<string, unknown>;
    /**
     * 执行。
     *
     * 约定：**不抛错**。失败时返回 `{ ok: false, error }` —— 一个工具失败不该让
     * 整次问答崩掉（与其余通道同策略：降级 + 如实说明）。
     * @param args - 模型给的参数（形状由 `parameters` 约束，但**必须按不可信输入处理**）。
     * @param ctx - 执行上下文。
     * @returns 结构化结果。
     */
    run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
/** 把工具集投影成「发给模型」的 schema 清单（`dsh-llm` 的 `ToolSchema` 形状）。 */
export declare function toToolSchemas(tools: readonly RetrievalTool[]): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}>;
/** 按名字取工具（找不到返回 undefined）。 */
export declare function findTool(tools: readonly RetrievalTool[], name: string): RetrievalTool | undefined;
/**
 * 从不可信参数里取字符串。
 *
 * 为什么需要：模型给的参数**形状不可信**（可能给数字、null、对象）。
 * 直接 `String(args.q)` 会把 `null` 变成 `"null"`、把对象变成 `"[object Object]"`，
 * 然后拿它去查库 —— 查不到还不报错，只是结果为空（最难查的一类问题）。
 * @param v - 原始值。
 * @param fallback - 取不到时的兜底。
 * @returns 字符串。
 */
export declare function argString(v: unknown, fallback?: string): string;
/**
 * 从不可信参数里取整数（带范围钳制）。
 * @param v - 原始值。
 * @param fallback - 取不到时的兜底。
 * @param min - 下限。
 * @param max - 上限。
 * @returns 钳制后的整数。
 */
export declare function argInt(v: unknown, fallback: number, min: number, max: number): number;
/**
 * 从不可信参数里取字符串数组。
 * @param v - 原始值。
 * @param cap - 最多取几个。
 * @returns 字符串数组（非数组时返回空数组）。
 */
export declare function argStringArray(v: unknown, cap: number): string[];

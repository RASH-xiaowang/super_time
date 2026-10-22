/**
 * 问答工具参数的统一归一化与校验。
 *
 * 模型给出的工具参数不可信：可能是 `null`、数字、对象，日期可能是「上周」，
 * 枚举可能写成「按消息数」，会话参数可能填显示名而不是 username。
 * 这些错误如果直接交给工具，最常见的表现不是报错，而是**静默查空**。
 *
 * 本模块只做纯逻辑：不读数据库、不调用模型。会话/联系人解析通过
 * {@link ArgumentNormalizationContext} 的目录或 resolver 注入，便于 runtime 装配。
 *
 * @module query/answer-runtime/arguments
 */
import type { ToolContext } from '../tools/types.ts';
export { parseDateExpression, type ParsedDateExpression } from './date-expression.ts';
/** 需要解析成 username 的实体类型。 */
export type ArgumentEntityKind = 'session' | 'contact';
/** 参数归一化失败的稳定分类。 */
export type ArgumentIssueCode = 'invalid_arguments_root' | 'missing_required' | 'invalid_type' | 'invalid_enum' | 'invalid_date' | 'invalid_format' | 'unresolved_entity' | 'ambiguous_entity';
/** 参数修复类型（用于过程展示与测试断言）。 */
export type ArgumentFixCode = 'arguments_coerced' | 'trimmed' | 'null_omitted' | 'array_normalized' | 'number_coerced' | 'integer_truncated' | 'range_clamped' | 'enum_alias' | 'date_normalized' | 'date_range_expanded' | 'date_swapped' | 'entity_resolved';
/** 一条结构化参数错误。 */
export interface ArgumentValidationIssue {
    code: ArgumentIssueCode;
    field: string;
    message: string;
    value?: unknown;
    expected?: string;
}
/** 一条可读的参数修复说明。 */
export interface ArgumentFix {
    code: ArgumentFixCode;
    field: string;
    message: string;
    from?: unknown;
    to?: unknown;
}
/** 会话或联系人目录项。 */
export interface ArgumentEntity {
    username: string;
    name?: string;
    aliases?: readonly string[];
}
/** 实体解析结果。 */
export type ArgumentEntityResolution = {
    status: 'resolved';
    entity: ArgumentEntity;
} | {
    status: 'ambiguous';
    candidates: readonly ArgumentEntity[];
} | {
    status: 'not_found';
};
/**
 * 参数归一化可用的扩展上下文。
 *
 * 这里不修改既有 `ToolContext`，而是用可选字段做结构化扩展；
 * 普通工具上下文传进来仍然合法。
 */
export interface ArgumentNormalizationContext extends ToolContext {
    sessionCatalog?: readonly ArgumentEntity[];
    contactCatalog?: readonly ArgumentEntity[];
    resolveArgumentEntity?: (value: string, kind: ArgumentEntityKind, context: ToolContext) => ArgumentEntityResolution | undefined;
}
/** 单个数值参数的安全范围。 */
export interface NumericArgumentPolicy {
    min?: number;
    max?: number;
    integer?: boolean;
}
/** 归一化入口的可选覆盖项（默认值来自工具名与 schema）。 */
export interface NormalizeToolArgumentsOptions {
    now?: Date;
    /** 显式指定某个字段解析成会话/联系人。 */
    entityFields?: Readonly<Record<string, ArgumentEntityKind>>;
    /** 覆盖工具默认的数值范围。 */
    numeric?: Readonly<Record<string, NumericArgumentPolicy>>;
    /** 覆盖工具默认的枚举别名。 */
    enumAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
/** 归一化成功结果。 */
export interface ArgumentNormalizationSuccess {
    ok: true;
    args: Record<string, unknown>;
    fixes: ArgumentFix[];
    preservedUnknownFields: string[];
}
/** 归一化失败结果；`args` 是已经成功修复的部分，调用方不要拿它直接执行。 */
export interface ArgumentNormalizationFailure {
    ok: false;
    args: Record<string, unknown>;
    errors: ArgumentValidationIssue[];
    fixes: ArgumentFix[];
    preservedUnknownFields: string[];
}
export type ArgumentNormalizationResult = ArgumentNormalizationSuccess | ArgumentNormalizationFailure;
/**
 * 主运行时直接使用的参数修复结果（保持字段名稳定）。
 */
export type ToolArgumentRepair = {
    ok: boolean;
    args: Record<string, unknown>;
    repairs: string[];
    error?: string;
    field?: string;
};
/** `repairToolArguments` 的选项。 */
export interface RepairToolArgumentsOptions {
    now?: Date;
    knownSessions?: string[];
    /** 结构化会话目录：把显示名/别名确定性解析成真实 username。 */
    knownSessionCatalog?: readonly ArgumentEntity[];
    knownContacts?: string[];
    /** 服务端强制范围；工具 schema 有 `username` 时无条件覆盖模型输入。 */
    forcedScope?: {
        username?: string;
    };
}
/**
 * 按工具的 JSON Schema 归一化参数。
 *
 * 约定：
 *   · 只校验 schema 中声明的字段；未知字段原样保留（兼容 runtime 注入的内部字段）；
 *   · 失败不抛异常，返回结构化错误；
 *   · 失败结果里的 `args` 只用于诊断，调用方不应执行。
 *
 * @param tool - 至少包含 `name` 与 `parameters` 的工具定义。
 * @param rawArgs - 模型给的不可信参数。
 * @param context - 工具上下文（含可选的目录/resolver 扩展）。
 * @param options - 可选覆盖项。
 * @returns 归一化结果。
 */
export declare function normalizeToolArguments(tool: {
    name: string;
    parameters: Record<string, unknown>;
}, rawArgs: unknown, context: ToolContext, options?: NormalizeToolArgumentsOptions): ArgumentNormalizationResult;
/**
 * 主运行时入口：按工具名修复参数。
 *
 * 与 {@link normalizeToolArguments} 的关系：
 *   · 本函数负责查找注册表中的工具 schema、注入已知会话/联系人并应用强制范围；
 *   · 具体校验仍走同一套归一化实现，避免两条路径行为分叉。
 *
 * @param name - 工具名。
 * @param raw - 模型给出的不可信参数。
 * @param opts - 当前时刻、已知实体、强制范围。
 * @returns 可直接给工具执行的参数与可读修复说明。
 */
export declare function repairToolArguments(name: string, raw: unknown, opts?: RepairToolArgumentsOptions): ToolArgumentRepair;

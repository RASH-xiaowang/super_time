import { type RetrievalTool } from './types.ts';
/**
 * 群资料与活跃度。
 *
 * 返回 `hits: []`：群资料没有消息定位；`facts` 固定包含「群资料」与「群活跃」两条，
 * `includeActivity=false` 时后者如实写「未统计」而不是假装 0。
 */
export declare const getGroupDetailTool: RetrievalTool;
/** 群资料类工具集。 */
export declare const GROUP_TOOLS: readonly RetrievalTool[];

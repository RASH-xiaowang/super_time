/**
 * 问答检索工具集（2026-10-16 新增）。
 *
 * 对外只暴露三样东西：**工具集**、**执行入口**、**契约类型**。
 * 各工具的实现文件（`*-tools.ts`）不从这里转发 —— 调用方不该关心
 * 「`search_messages` 在哪个文件里」，那是实现细节。
 *
 * @module query/tools
 */
export {
  buildTools, allTools, runTool, toolSchemas, TOOL_NAMES,
} from './registry.ts'
export type {
  RetrievalTool, ToolContext, ToolResult, ToolHit, ToolName, ToolCategory, ToolErrorCode,
} from './types.ts'
export { findTool, toToolSchemas, argString, argInt, argStringArray } from './types.ts'
export {
  ANSWER_PROFILES,
  ALL_ANSWER_PROFILES,
  getAnswerProfile,
  isToolAllowed,
  filterToolsForProfile,
  filterToolsForScope,
  enforceProfileScope,
  buildProfileTools,
  runProfileTool,
  profileDataScope,
} from './profiles.ts'
export type { AnswerProfile, AnswerProfileId, ProfileScopeDecision } from './profiles.ts'
export { makeSearchHybridTool } from './search-hybrid-tool.ts'
export type {
  HybridSearchMode,
  HybridSearchRequest,
  HybridSearchExecution,
  HybridSearchExecutor,
  HybridSearchCitation,
  HybridSearchChunk,
  HybridSearchFact,
  HybridSearchExecutionError,
} from './search-hybrid-tool.ts'

import { type RetrievalTool } from './types.ts';
/** 联系人检索（复用成员搜索，自动兼容 contact_fts 新旧 schema 与 LIKE 降级）。 */
export declare const searchContactsTool: RetrievalTool;
/** 联系人详情（备注/标签/共同群/最近互动）。 */
export declare const getContactDetailTool: RetrievalTool;
/** 联系人类工具集。 */
export declare const CONTACT_TOOLS: readonly RetrievalTool[];

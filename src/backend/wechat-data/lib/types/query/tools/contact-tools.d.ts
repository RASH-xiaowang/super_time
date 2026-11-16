import { type RetrievalTool } from './types.ts';
/**
 * 联系人检索（复用成员搜索，自动兼容 contact_fts 新旧 schema 与 LIKE 降级）。
 *
 * 新增的 `region` / `enterprise` / `kind` 都是**后置过滤**：搜索仍然由
 * `searchMembers` 完成（它负责拼音/FTS/降级），过滤只作用于已命中的联系人。
 * 带过滤时多取一些再筛（最多 200），避免「前 20 条恰好没有目标地区」导致
 * 明明有结果却返回空。
 */
export declare const searchContactsTool: RetrievalTool;
/**
 * 联系人详情（备注/地区/共同群/互动统计/资金往来）。
 *
 * 描述不再承诺「标签」：本机 contact.db 只有标签定义表（contact_label），
 * `contact` 没有标签列，也没有联系人↔标签映射 —— 编造一个永远为空的
 * 「标签」字段只会让模型答「没有标签」，而用户以为数据丢了。
 */
export declare const getContactDetailTool: RetrievalTool;
/** 联系人类工具集。 */
export declare const CONTACT_TOOLS: readonly RetrievalTool[];

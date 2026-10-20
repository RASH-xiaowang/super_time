import { type EmbedFn } from '../retrieval/embedding.ts';
import { type RetrievalTool } from './types.ts';
/** 知识库文件检索。 */
export declare const searchKbTool: RetrievalTool;
/**
 * 语义检索（向量）。
 *
 * `embedFn` 由调用方注入（它含隐私闸门）—— 工具本身**不构造** embedding 函数：
 * 那需要读配置、过闸门、写审计，属于装配层的事，不该藏在工具里。
 * 没注入时如实返回「未配置向量模型」，而不是静默退化成关键词检索
 * （静默退化会让「语义检索没生效」变成一个查不出来的问题）。
 */
export declare function makeSearchSemanticTool(embedFn?: EmbedFn, embedModel?: string): RetrievalTool;
/** 知识库工具集（语义检索需要注入 embedFn，所以由调用方组装）。 */
export declare const KB_TOOLS: readonly RetrievalTool[];

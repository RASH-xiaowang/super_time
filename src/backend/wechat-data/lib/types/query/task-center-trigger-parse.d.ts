/**
 * 触发记录里 `images` / `texts` 两列的 JSON 解析。
 *
 * 为什么单独一个文件（2026-11-24）：`query/task-center.ts` 已贴着 M21 的 1000 行上限，
 * 而这两段是**纯解析**（读一列 JSON、逐项校验形状、坏项丢弃），与 CRUD/校验无关。
 * 搬出来之后主文件回到上限以内，解析规则也集中在一处 —— 图片与文本的容错口径
 * 本来就该并排看（两者都是「坏一条不影响其余」）。
 *
 * 两个函数都**不抛错**：任务配置坏掉不等于整个任务不可用，坏项直接丢。
 *
 * @module query/task-center-trigger-parse
 */
import type { TaskTriggerImage, TaskTriggerText } from '../types.ts';
/** 触发图片数组解析（逐项校验形状，坏项丢弃）。 */
export declare function parseTriggerImages(raw: unknown): TaskTriggerImage[];
/** 触发文本数组解析（逐项校验形状，坏项丢弃）。只接受有正文的条目。 */
export declare function parseTriggerTexts(raw: unknown): TaskTriggerText[];

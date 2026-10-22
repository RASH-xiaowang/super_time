/**
 * 问答状态的确定性兜底文案。
 *
 * 模型调用、工具循环或综合生成都可能失败，但入口不能把空字符串直接交给用户
 * 或自动回复通道。这里只放与数据无关、不会编造事实的可读回复，供运行时与
 * 生产编排层共用，避免三个入口各自维护一套话术而逐渐漂移。
 *
 * @module query/answer-runtime/replies
 */
import type { AnswerProfileId } from '../tools/profiles.ts';
/** 需要澄清时的具体追问；优先点明缺的是参数、对象还是范围。 */
export declare function clarificationReply(reason?: string, profile?: AnswerProfileId): string;
/** 检索正常执行但没有可用证据时的说明；不能暗示成系统故障。 */
export declare function insufficientReply(profile?: AnswerProfileId): string;
/** 检索或模型链路暂时失败时的说明；必须与“没有数据”区分开。 */
export declare function failedReply(profile?: AnswerProfileId): string;
/** 请求在进入检索前就被范围门禁拦截时的可读原因。 */
export declare function blockedReply(reason: string | undefined): string;

/**
 * 意图到工具优先级的纯映射。
 *
 * @module query/answer-runtime/intent-tool-hints
 */
import type { AnswerIntentKind } from './intent.ts';
/** 联系人属性问法；意图层也用它判断“是在问某人的资料”。 */
export declare const ENTITY_ATTR_RE: RegExp;
export interface ToolHintContext {
    q: string;
    hasMessageRef: boolean;
    hasTime: boolean;
    hasMedia: boolean;
    hasContact: boolean;
    hasSession: boolean;
    hasAggregate: boolean;
}
export declare function toolHintsFor(kind: AnswerIntentKind, ctx: ToolHintContext): string[];

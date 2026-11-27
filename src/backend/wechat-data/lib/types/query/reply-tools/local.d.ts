/** Deterministic tools: no eval, shell, file, or network access. */
export declare function calculateReplyExpression(expression: string): number;
export declare function convertReplyUnits(value: number, from: string, to: string): number;
export declare function replyDate(now: Date, timezone: string, offsetDays?: number): string;
/** 把目标消息里的相对日期换成具体日期。不联网，也不猜消息里没写的日子。 */
export declare function resolveReplyDate(expression: string, now: Date, timezone: string): {
    date: string;
    weekday: string;
    offsetDays: number;
    weekend: boolean;
};
export declare const REPLY_UNIT_NAMES: string[];

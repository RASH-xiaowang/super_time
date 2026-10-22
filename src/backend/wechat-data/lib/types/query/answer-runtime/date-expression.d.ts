/** 解析后的日期表达式。`from`/`to` 都是本地日历日 `YYYY-MM-DD`。 */
export interface ParsedDateExpression {
    from: string;
    to: string;
    /** true = 相对日历表达（今天/本周/上个月…），单字段出现时可按整段范围展开。 */
    relative: boolean;
    /** true = 表达只给出结束日，需要调用方补齐起始日（如「截至本周」）。 */
    endOnly?: boolean;
    /** true = 表达只给出起始日，需要调用方补齐结束日（如「本周以来」）。 */
    startOnly?: boolean;
    /** 原样输入，便于生成修复说明。 */
    label: string;
}
/** 用当前时间兜底非法/缺失日期，避免参数归一化被时钟输入拖垮。 */
export declare function normalizeDateInput(value: Date | undefined): Date;
/**
 * 解析单个日期/日期段表达。
 *
 * 支持：今天、昨天、前天、本周、这周、上周、本月、这个月、上个月、
 * `YYYY-MM-DD`、`YYYY/M/D`、`YYYY年M月D日`、`M月D日`、中文数字日期，
 * 以及 `上周三` / `本周一` 这类带星期的表达。周以周一为第一天。
 *
 * @param value - 原始日期文本。
 * @param nowInput - 当前时刻（测试可注入）。
 * @returns 解析结果；无法识别或日期不存在时返回 undefined。
 */
export declare function parseDateExpression(value: string, nowInput?: Date): ParsedDateExpression | undefined;

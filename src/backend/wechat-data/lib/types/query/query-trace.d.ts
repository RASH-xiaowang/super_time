/**
 * 开始一次查询的分段计时。
 * @param name - 查询名（`overview` / `insights`）。
 */
export declare function queryTraceBegin(name: string): void;
/**
 * 打一条查询分段。
 * @param name - 查询名（与 begin 一致）。
 * @param label - 阶段名（固定词表，便于日志侧统计）。
 * @param n - 可选计数（行数/条目数），用于判断「慢在量上还是常数开销」。
 */
export declare function queryTraceMark(name: string, label: string, n?: number): void;

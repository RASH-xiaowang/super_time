/**
 * 后端唯一的「给人看」格式化（P3-1 / P3-2 / CODE-AUDIT-2026-09-26 第一批 #8）。
 *
 * 为什么要专门有一个文件：字节体积与时间在 `query/**` 与 `laya/**` 里各被实现过一遍，
 * 口径互不相同（同一份 1.4MB 在「知识库文件」里是 `1.4 MB`、在 laya 里是 `1428.6 KB`、
 * 在 kb-files-store 里封顶 MB），而时间那几份**连单位都不一样**（有的收秒、有的收毫秒，
 * 类型都是 number ⇒ 传错了不报错，只是整片显示成 1970 年）。
 * 前端已有 `utils/format.ts` 这个唯一出处，这里补齐后端那一半，口径与前端逐字一致。
 * 唯一的实现 + 单位写进名字，由 `src/backend/tests/format-single-source.spec.ts` 守着。
 */
/**
 * 字节数 → 人类可读体积（与前端 `utils/format.ts#fmtBytes` 同一口径）。
 * B 不省略；KB/MB 取 1 位小数；GB/TB 取 2 位；逐级进位。
 * @param n - 字节数（null / NaN / 负数一律视作 0）。
 */
export declare function fmtBytes(n: number | null | undefined): string;
/**
 * **秒级**时间戳 → `YYYY-MM-DD HH:mm`。
 * @param ts - unix 秒（不是毫秒！毫秒传进来会得到 1970 年）。
 * @param placeholder - 空值/非法值时的占位。
 */
export declare function fmtDateTimeSec(ts: number | null | undefined, placeholder?: string): string;
/**
 * 朋友圈那种相对时间标签（**秒级**时间戳）：今天/昨天带钟点，再往前按天、按月。
 * @param ts - unix 秒。
 */
export declare function fmtRelativeDaySec(ts: number): string;

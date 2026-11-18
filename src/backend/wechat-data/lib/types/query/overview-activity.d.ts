/**
 * 总览趋势用的「会话 × 日」条数。
 *
 * 洞察扫描的 `GROUP BY` 已经按 `create_time / 86400` 出了日桶。把这份桶留在分片
 * 缓存里，趋势就不必再打开同一批消息库。日桶是数据本身，和「现在」无关；
 * 7/30/90 天窗口在加总时才套上。
 */
/** talker → 日序号（`create_time / 86400`）→ 条数。 */
export type TalkerDayCounts = Map<string, Map<number, number>>;
/** 磁盘缓存里的按日条数。 */
export type PackedTalkerDays = Array<[string, Array<[number, number]>]>;
export declare function addTalkerDay(days: TalkerDayCounts, talker: string, day: number, n: number): void;
export declare function mergePackedTalkerDays(into: TalkerDayCounts, packed: PackedTalkerDays | undefined): void;
export declare function freezeTalkerDays(days: TalkerDayCounts): PackedTalkerDays;
export declare function dayKeyOf(sec: number): string;
/** 与原先 extras 循环同一套窗口：日桶起点对比 `now` 往前的 7/14/30/60/90 天。 */
export interface ActivityRollup {
    dayCounts: Map<string, number>;
    m7: number;
    m30: number;
    m60: number;
    prev7: number;
    prev30: number;
    contactActive7: Set<string>;
    contactActive30: Set<string>;
    groupActive7: Set<string>;
    groupActive30: Set<string>;
    lastSync: number;
}
export declare function rollupTalkerDays(days: TalkerDayCounts, nowSec: number): ActivityRollup;

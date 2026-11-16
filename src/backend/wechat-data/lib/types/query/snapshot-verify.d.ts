/** 发布前完整性判定：可发布 / 损坏 / 本机检不了（不是损坏）。 */
export type SnapshotVerdict = {
    state: 'ok';
} | {
    state: 'corrupt';
    detail: string;
} | {
    state: 'uncheckable';
    detail: string;
};
/**
 * 用一个只读连接跑 `PRAGMA quick_check`，把结果分成三态。
 *
 * `quick_check` 与 `integrity_check` 的口径差在「不逐条校验索引与 UNIQUE 约束」，
 * 但对本路径关心的页结构/表树损坏足够，且快得多；发布前每次全量解密都要跑，不能选重的。
 * @param file - 待判定的解密产物（staging 文件）路径。
 * @returns 三态结论；`corrupt.detail` 为前 3 条 SQLite 判词（或错误原文）。
 */
export declare function verifySnapshot(file: string): SnapshotVerdict;
/**
 * 发布闸门：`corrupt` 抛错阻止 `atomicReplace`；`uncheckable` 告警后放行；`ok` 放行。
 *
 * 抛错文案是调用方（修复链路）能直接展示给用户的约定句子，不要在调用点再包一层。
 * @param file - 待发布的解密产物（staging 文件）路径。
 * @throws `corrupt` 时抛出 `解密结果完整性校验未通过：<detail>`。
 */
export declare function assertPublishable(file: string): void;

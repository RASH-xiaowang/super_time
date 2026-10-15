/**
 * `atomic-json.js` 的类型面 —— **手写**声明，不是构建产物。
 *
 * 宿主层 CommonJS 模块不参与现有的 TypeScript 构建，因此这份文件只描述模块真正
 * 对外提供的值：原子写、损坏告警、损坏备份保留数与覆盖前保全。它和
 * `wechat-paths.d.ts`、`update.d.ts` 同族，由 `tests/host-decl-alignment.spec.ts`
 * 对 `module.exports` 与这里的值导出做双向差集，防止「地图缺一块」或「发明成员」。
 * 实现内部细节（重试、备份剪枝）不在这里露面。
 */

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * rename 在同一卷上是原子的：要么是旧文件，要么是完整的新文件；Windows 上目标被
 * 杀软、备份工具或其它句柄瞬态占用时会做有界重试，仍失败则抛出原始错误。
 * @param target 目标文件绝对路径。
 * @param text 要写入的文本。
 */
export function writeFileAtomic(target: string, text: string): void;

/**
 * 对一个损坏配置告警一次（同路径 + 大小 + 修改时间只报一次，ENOENT 不报）。
 * @param file 配置文件路径。
 * @param err 读取或解析错误；可为 null/undefined。
 */
export function warnCorruptOnce(file: string, err: unknown): void;

/** 损坏备份的保留份数：超过就删最旧，避免磁盘随损坏次数线性增长。 */
export const MAX_CORRUPT_BACKUPS: number;

/**
 * 覆盖前先保住「解析不了的原文件」：内容不是合法 JSON 时先改名留存并告警，
 * 再允许调用方写入新内容。文件不存在或读不到时直接返回。
 * @param target 目标文件绝对路径。
 */
export function preserveIfUnparseable(target: string): void;

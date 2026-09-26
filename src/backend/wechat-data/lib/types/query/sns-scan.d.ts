/** 扫描期间「这一处没读到」的说明；空数组 = 扫全是完整的。 */
export type ScanNotes = string[];
/** 一个月度媒体根目录（带签名，用于增量判断）。 */
export interface SnsMonthRoot {
    month: string;
    root: string;
    mtimeMs: number;
    size: number;
}
/** 记一条「没读到」，并把异常收成一句人话（导出版给本目录之外的扫描口复用）。 */
export declare function noteScan(notes: ScanNotes | undefined, dir: string, e: unknown): void;
/**
 * 列出 `cache/<月份>/Sns/<kind>` 这些根目录，按月份由新到旧。
 * @param wechatBaseDir - 微信账号根目录（raw wechat base）。
 * @param kind - `Img` 或 `Video`（图片与视频的缓存子目录同名规则）。
 * @param notes - 传入则把每处读不到的目录记进这里（不传 = 老的「咽掉」行为，仅用于
 *   「扫不全也无所谓」的探针路径）。
 * @returns 带签名的月份根目录。
 */
export declare function snsMonthRoots(wechatBaseDir: string, kind: 'Img' | 'Video', notes?: ScanNotes): SnsMonthRoot[];
/**
 * 只列根目录、不带签名的版本（用于「按已知文件名直接探测是否存在」的路径）。
 * @param wechatBaseDir - 微信账号根目录。
 * @param kind - `Img` 或 `Video`。
 * @param notes - 见 {@link snsMonthRoots}。
 * @returns 存在的媒体根目录路径。
 */
export declare function snsLeafRoots(wechatBaseDir: string, kind: 'Img' | 'Video', notes?: ScanNotes): string[];
/**
 * 目录列举失败时回空数组，**并把失败记进 notes**。
 * @param dir - 要列的目录。
 * @param notes - 可选的注记收集器。
 * @returns 目录里的条目名（读不到时为空）。
 */
export declare function safeReaddir(dir: string, notes?: ScanNotes): string[];
/**
 * 把「扫不全」的原因并进一句本来要说「本机没有」的话里。
 * @param msg - 原句（例如「本机缓存里没有这条视频」）。
 * @param notes - 扫描注记。
 * @returns notes 为空时原句；否则原句 + 原因（最多三条，多了没人看）。
 */
export declare function missWithScanNotes(msg: string, notes: ScanNotes): string;

/** Windows 上会被「双击即执行」的扩展名（`Invoke-Item` 对它们走的是执行路径）。 */
export declare const EXECUTABLE_EXTS: ReadonlySet<string>;
/** 记录一个目录为「应用产出过东西、随后可被打开」。幂等，保序（新的放最后）。 */
export declare function grantRoot(dir: string): void;
/** 当前被授予的目录列表（只读快照，给测试与诊断用）。 */
export declare function grantedRootList(): string[];
/** `child` 是否等于 `root` 或在其之下（按路径段比，不比字符串前缀）。 */
export declare function isInsideRoot(child: string, root: string): boolean;
/**
 * 「交给系统打开」的拒绝理由（返回 null = 允许）。
 * @param target - 要打开的路径（文件或目录）。
 * @param dataRoot - 数据根（`dirname(decryptedDir)`）—— 应用自己的产出都在这里。
 * @returns 给用户看的中文理由，或 null。
 */
export declare function openDenialReason(target: string, dataRoot: string): string | null;
/**
 * 「往这里写」的拒绝理由（返回 null = 允许）。
 * @param target - 目标**文件**路径。
 * @param dataRoot - 数据根（用于日志与文案，不做白名单，见文件头）。
 * @returns 理由或 null。
 */
export declare function writeDenialReason(target: string, dataRoot: string): string | null;

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
 * @param extraRoots - 额外的允许根（2026-10-17 新增）。
 *
 *   **为什么需要它**：应用有**两个**自己的数据目录，它们是兄弟关系：
 *     · `<userData>/wechat-data/` —— 解密快照、导出、缓存（= `dataRoot`）；
 *     · `<userData>/wechat/` —— `config.json` / `llm.json` / `logs/`（配置与日志）。
 *   而设置弹窗底部那个「配置: wechat/config.json ↗」要打开的是**后者** ——
 *   它不在 `dataRoot` 之下，于是被这条政策拒掉，用户看到的就是「点了没反应」
 *   （真机实测：`openPath` 返回 `ok:false` + 「只能打开应用自己数据目录内的文件」）。
 *   两者都是应用自己产出的东西，安全口径完全一致，所以由调用方把配置目录传进来。
 * @returns 给用户看的中文理由，或 null。
 */
export declare function openDenialReason(target: string, dataRoot: string, extraRoots?: readonly string[]): string | null;
/**
 * 「往这里写」的拒绝理由（返回 null = 允许）。
 * @param target - 目标**文件**路径。
 * @param dataRoot - 数据根（用于日志与文案，不做白名单，见文件头）。
 * @returns 理由或 null。
 */
export declare function writeDenialReason(target: string, dataRoot: string): string | null;

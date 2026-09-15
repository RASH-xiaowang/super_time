/**
 * WeChat 安装位置与账号目录的发现（配置层的一部分）。
 *
 * 为什么放在这一层（M24）：它读的是「本机配置」——`%APPDATA%/Tencent/xwechat/config/*.ini`、
 * 注册表 `HKCU\Software\Tencent\Weixin\InstallPath` 与磁盘上的 `db_storage` 目录 —— 而且
 * `keys/service.ts`（从进程内存取图密钥时要拿本机 wxid 清单）与 `query/config.ts`（解析自身
 * wxid）都要用。它必须在 keys 之下、且不 import 包内任何模块，否则双向依赖又会回来。
 */
/**
 * WeChat 4.x install path from `HKCU\Software\Tencent\Weixin\InstallPath`
 * (Windows only; '' elsewhere). The install dir is also a valid data base when
 * the user kept the default data layout.
 */
export declare function weixinInstallPath(): string;
/**
 * WeChat version folder name inside the install dir.
 * @param installDir - install path (defaults to the registry InstallPath).
 * @returns the version, or '' when the install dir is unknown.
 */
export declare function weixinVersion(installDir?: string): string;
/**
 * Collect the `xwechat_files` roots to scan: default data bases, per-user
 * config ini files, and the registry install path, deduped
 * case-insensitively. A configured base may itself already be the
 * `xwechat_files` dir, so both join forms are added; the account loop filters
 * by `db_storage` presence.
 * @returns absolute candidate roots (existence caller-checked).
 */
export declare function collectScanRoots(): string[];
/**
 * Detect installed WeChat 4.x accounts by scanning `xwechat_files` roots.
 * @param roots - explicit scan roots; defaults to {@link collectScanRoots}.
 * @returns detected accounts with db_dir, last active and db file count.
 */
export declare function detectWechatAccounts(roots?: readonly string[]): Array<{
    wxid: string;
    db_dir: string;
    last_active?: number;
    db_files?: number;
}>;
/**
 * Normalize a WeChat account dir name to the real wxid (strip instance suffix).
 * Account dirs look like `wxid_xxxxxx` or `wxid_xxxxxx_f312`; the wxid itself
 * has no underscore, so everything after the second underscore is the instance
 * id (mirrors st_control config/paths.rs normalize_wxid_dir).
 * @param name - account directory name (e.g. wxid_a1z2r51mzqlf22_63e5).
 * @returns the real wxid (input unchanged when it is not a wxid_ name).
 */
export declare function normalizeWxidDir(name: string): string;
/** Recursively collect .db files under a dir (depth-limited). */
export declare function scanDbFiles(dir: string, depth?: number): string[];

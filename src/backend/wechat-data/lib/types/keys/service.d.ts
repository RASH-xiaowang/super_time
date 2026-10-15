import type { DbKeyResult, ImageKeyResult } from './types.ts';
/** `keys.json` 里自动获取结果所在的全局槽（老库与无归属记录用）。 */
export declare const DEFAULT_KEY_SLOT = "default";
/**
 * 自动数据库密钥该写进哪个账号槽（W2-2.2 的 db_key 侧）。
 *
 * 与图片密钥同因：db_key 也是每账号的，写全局槽会让后一个账号覆盖前一个。能确定当前
 * 账号就写自己的槽，确定不了（老别名目录、没有 config/all_keys）就继续写 `default`。
 * @param decrypted - 解密数据根，用于解析当前账号。
 * @returns 槽名；无法归属时是 `'default'`。
 */
export declare function dbKeySlotFor(decrypted: string): string;
/**
 * Find the running WeChat main-process pid via tasklist.
 * @returns the first matching pid, or null.
 */
export declare function findWechatPid(): number | null;
/**
 * Scan Weixin.dll for the internal DB key used to unmask V4 candidates.
 * @param wechatInstallDir - optional explicit install dir (may be the version
 * folder or its parent; version subdirectories are probed too).
 * @returns the first 32-byte internal key, or null.
 */
export declare function scanDllInternalKey(wechatInstallDir?: string): Buffer | null;
/**
 * Recover the V4 database key for the running WeChat process.
 *
 * 顺序很重要：**先试已经知道的密钥，再扫内存**（见 `findSavedDbKey` 的注释）。
 * 这也顺带修好了"微信没开时无法确认密钥"的老形状 —— 只要已存的密钥能通过页 1 校验，
 * 微信开没开都不影响这一步。
 * @param opts - optional db probe path and install dir.
 * @returns the recovered key result.
 */
export declare function fetchDbKey(opts?: {
    dbPath?: string;
    wechatInstallDir?: string;
}): Promise<DbKeyResult>;
/**
 * Coerce the account dir to the wxid_* account root: a db_dir pointing at
 * `db_storage` is lifted to its parent, because the V2 template cache lives
 * under `<root>/msg/attach` (not under db_storage).
 * @param accountDir - as passed by callers (db_dir or account root).
 * @returns the account root, '' when nothing usable.
 */
export declare function normalizeAccountDir(accountDir: string): string;
/**
 * WeChat 4.x kvcomm cache dir. The image key is derived from the kvcomm code
 * (`md5(code + clean_wxid)[:16]`, XOR = `code & 0xFF`), and the codes are the
 * decimal prefixes of `*_input.statistic` file names under this dir.
 * @returns the kvcomm cache dir, '' when unavailable.
 */
export declare function kvcommCacheDir(): string;
/**
 * 自动图片密钥该写进哪个**账号槽**（W2-2.2 写入侧）。
 *
 * ## 为什么原来那个全局 `'default'` 槽是错的
 *
 * 图片密钥是**每账号**的：甲账号的图密钥解乙账号的图不会报错，只会解出一张垃圾图。
 * 而三类自动取钥路径（kvcomm 派生 / 内存扫描）都把结果写进同一个 `'default'` 槽 ——
 * 于是一台机器上两个微信账号，**乙跑一次自动取钥就把甲的记录覆盖掉**。
 * 读取侧的归属校验（`query/image-key.ts` 的 `storedKeyOwnedBySelf`）这时候会正确地
 * 拒绝这把钥匙，表现就是「甲本来能用的图突然都要重新配钥」—— 不报错，也归因不到
 * 「乙用过一次」。
 *
 * ## 口径
 *
 * 能确定归属就写进归属者的槽（`wxid_…`）；确定不了（老账号目录用别名、扫描路径只拿到
 * 目录名）就**继续写 `'default'`** —— 那条路上归属校验仍然兜着，而为了分槽把记录丢掉
 * 比不分槽更糟。形状必须真的是 `wxid_…`：拿目录名当槽名会把「别名目录」也算成一个账号。
 *
 * @param derivedWxid - kvcomm 路径给出的派生 wxid（可空）。
 * @param sourceDirName - 内存扫描路径给出的账号目录名（可空）。
 * @returns 槽名；无法归属时是 `'default'`。
 */
/** 把一个候选账号名归一化成槽名；不是 wxid 形状就退回全局槽。 */
export declare function accountKeySlotFor(candidate?: string): string;
export declare function imageKeySlotFor(derivedWxid?: string, sourceDirName?: string): string;
/**
 * Recover the image key: kvcomm-cache derivation first (WeChat 4.x on-disk
 * cache, no injection), then the V2-verified process memory scan.
 * @param opts - account dir (wxid folder) and optional pid.
 * @returns the verified image key result.
 */
export declare function fetchImageKey(opts?: {
    accountDir?: string;
    pid?: number;
}): Promise<ImageKeyResult>;

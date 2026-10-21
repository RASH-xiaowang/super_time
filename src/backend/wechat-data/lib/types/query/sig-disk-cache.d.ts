/**
 * 读取「签名匹配」的缓存值。
 * @param path - 缓存文件路径。
 * @param sig - 当前数据的指纹。
 * @returns 命中返回值；未命中/损坏/签名不符返回 null。
 */
export declare function loadSigCached<T>(path: string, sig: string): T | null;
/**
 * 原子写入「签名 + 值」。
 * @param path - 缓存文件路径。
 * @param sig - 当前数据的指纹。
 * @param value - 可 JSON 序列化的结果。
 * @returns true = 成功；失败只返回 false，不抛。
 */
export declare function saveSigCached<T>(path: string, sig: string, value: T): boolean;

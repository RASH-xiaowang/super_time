import type { LocalToolConfig, LocalToolConfigInput, LocalToolConfigSaveResult } from '../types-local-tools.ts';
/** 读当前配置快照（密钥只回是否已保存）。 */
export declare function readLocalToolConfig(decryptedDir: string): LocalToolConfig;
/** 保存结果（形状在共享契约里，与 Remote 的返回类型同一份）。 */
export type { LocalToolConfigSaveResult };
/**
 * 保存配置。
 *
 * 只处理**出现**的字段：`undefined` 表示「这次不改」。空串对 provider/access 是合法值
 * （= 取消选择），对 API Key 则不是 —— 密钥字段空串按「没改」处理（见模块头）。
 * @param decryptedDir - 解密数据根。
 * @param input - 要写入的字段（不可信）。
 * @returns 保存结果（成功时带新快照）。
 */
export declare function saveLocalToolConfig(decryptedDir: string, input: LocalToolConfigInput | undefined): LocalToolConfigSaveResult;

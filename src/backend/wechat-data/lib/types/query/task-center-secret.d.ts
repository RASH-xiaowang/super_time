import type { TaskTriggerSecretRevealResult } from '../types.ts';
/**
 * 读取某任务已保存的凭据原文（唯一回读入口）。
 * @param decryptedDir - 解密数据根。
 * @param id - 任务 id。
 * @returns 触发方式 + 凭据字段原文；任务不存在/库读不了时 `ok=false` + 可读错误。
 */
export declare function revealTaskTriggerSecret(decryptedDir: string, id: unknown): TaskTriggerSecretRevealResult;

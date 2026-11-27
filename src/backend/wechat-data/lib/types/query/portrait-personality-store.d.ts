import type { PortraitPersonalityResult } from '../types.ts';
/** 存档目录：解密库的兄弟目录，换数据根时跟账号走。 */
export declare function portraitPersonalityDir(decryptedDir: string): string;
/** 读取已保存的性格速写。旧版式也直接返回，不在读取时重新生成。 */
export declare function readPortraitPersonality(decryptedDir: string, username: string): PortraitPersonalityResult | undefined;
/**
 * 把一次成功的性格速写写到硬盘。
 * @returns 写入时间（Unix 秒）。写失败时 undefined，调用方仍可把这次结果展示出来。
 */
export declare function savePortraitPersonality(decryptedDir: string, username: string, result: PortraitPersonalityResult): number | undefined;

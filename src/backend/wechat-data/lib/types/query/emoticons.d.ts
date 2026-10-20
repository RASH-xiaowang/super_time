import type { EmoticonsSnapshot } from '../types.ts';
/**
 * Read custom emoticons + store packages.
 * @param decryptedDir - decrypted data root.
 * @param limit - max custom rows.
 * @param offset - pagination offset.
 * @param wechatBaseDir - 原始微信目录（找 `msg/attach` 下的表情 `.dat` 用）。
 *   不传时「其他表情包」为空 —— 没有它就无法判断哪些表情本地还有图。
 * @returns the emoticons snapshot.
 */
export declare function queryEmoticons(decryptedDir: string, limit?: number, offset?: number, wechatBaseDir?: string): EmoticonsSnapshot;

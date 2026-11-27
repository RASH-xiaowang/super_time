import type { EmoticonsSnapshot } from '../types.ts';
/**
 * Read custom emoticons + store packages.
 * @param decryptedDir - decrypted data root.
 * @param limit - max custom rows.
 * @param offset - pagination offset.
 * @param wechatBaseDir - 原始微信目录（找 `msg/attach` 下的表情 `.dat` 用）。
 *   不传时「其他表情包」为空 —— 没有它就无法判断哪些表情本地还有图。
 * @param includeOthers - 传 `false` 时不扫消息库。个人表情页用这个先出列表；
 *   不传时仍在第一页附带「其他表情」，和原来的调用兼容。
 * @param decodedDir - `decoded_images` 目录。给了它才把其他表情清单和图片落到硬盘。
 * @returns the emoticons snapshot.
 */
export declare function queryEmoticons(decryptedDir: string, limit?: number, offset?: number, wechatBaseDir?: string, includeOthers?: boolean, decodedDir?: string): Promise<EmoticonsSnapshot>;

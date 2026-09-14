import type { EmoticonsSnapshot } from '../types.ts';
/**
 * Read custom emoticons + store packages.
 * @param decryptedDir - decrypted data root.
 * @param limit - max custom rows.
 * @returns the emoticons snapshot.
 */
export declare function queryEmoticons(decryptedDir: string, limit?: number, offset?: number): EmoticonsSnapshot;

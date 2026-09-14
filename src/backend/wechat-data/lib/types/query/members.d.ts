import type { MemberSearchSnapshot } from '../types.ts';
/**
 * Search contacts / group members.
 * @param decryptedDir - decrypted data root.
 * @param q - search term (name/remark/username/alias/pinyin).
 * @param opts - optional limit and room scope (roomUsername).
 * @returns matching members + total + source.
 */
export declare function searchMembers(decryptedDir: string, q: string, opts?: {
    limit?: number;
    roomUsername?: string;
}): MemberSearchSnapshot;

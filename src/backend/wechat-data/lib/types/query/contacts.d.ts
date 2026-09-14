import type { WechatContact } from '../types.ts';
/**
 * Read the contact book.
 * @param decryptedDir - decrypted data root.
 * @returns the contacts snapshot (contacts + per-category stats).
 */
export interface ContactsPageOptions {
    limit?: number;
    offset?: number;
}
export declare function queryContacts(decryptedDir: string, options?: ContactsPageOptions): {
    contacts: WechatContact[];
    total: number;
    stats: Record<string, number>;
};

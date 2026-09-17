import type { WechatContact } from '../types.ts';
/**
 * Read the contact book.
 * @param decryptedDir - decrypted data root.
 * @returns the contacts snapshot (contacts + per-category stats).
 */
export interface ContactsPageOptions {
    limit?: number;
    offset?: number;
    /**
     * 只返回该分类的联系人（friend/group/official/service/enterprise/member/system/deleted）。
     *
     * **必须在分页之前过滤**：界面的分类页签（"联系人(282)"）如果靠渲染层在已分页的
     * 结果上再 filter，那么当全局排序（字母 + 全拼）的前 N 条里恰好没有该类目时，
     * 页签看起来就是空的 —— 明明有 282 个联系人却显示"暂无联系人"。把过滤下沉到这里，
     * `total` 与分页切片都按同一口径计算，页签才能显示完整。
     *
     * 未传（或传 `all`）时行为与之前完全一致。
     */
    category?: string;
}
export declare function queryContacts(decryptedDir: string, options?: ContactsPageOptions): {
    contacts: WechatContact[];
    total: number;
    stats: Record<string, number>;
};

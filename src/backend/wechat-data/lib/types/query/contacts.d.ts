import type { WechatContact } from '../types.ts';
/**
 * 联系人类别判定（对外只读口径）。
 *
 * 为什么要把私有函数暴露出来：问答的 `search_contacts` 支持 `kind`
 * （all/person/group/enterprise）过滤，如果它自己再写一份判据，
 * 同一个账号在「找人」与「通讯录」里就可能落到不同类目 ——
 * 用户按「人」筛却看不到通讯录里明明标为「联系人」的账号。
 * @param localType - contact.local_type。
 * @param username - 联系人/群 username。
 * @param deleteFlag - contact.delete_flag。
 * @returns 分类键（friend/enterprise/group/official/service/member/system/deleted）。
 */
export declare function contactCategoryOf(localType: number, username: string, deleteFlag?: number): string;
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
    /**
     * 可选的搜索词：大小写不敏感地匹配 username / 备注 / 昵称 / 别名 / 全拼列。
     *
     * 与 `category` 一起在 **SQL 里**过滤，再分页 —— 否则「搜索 + 翻页」只能搜到当前
     * 已加载的那一页。`stats` 仍是全量口径（页签计数不随搜索变化）。
     */
    search?: string;
    /** 多分类一次查出（客户画像）。与单个 `category` 二选一，此项优先。 */
    categories?: readonly string[];
}
/** 总览只要分类计数。不走 `queryContacts`：那条不传 limit 时会把整张通讯录解码并拼群。 */
export declare function queryContactStats(decryptedDir: string): Record<string, number>;
export declare function queryContacts(decryptedDir: string, options?: ContactsPageOptions): {
    contacts: WechatContact[];
    total: number;
    stats: Record<string, number>;
};

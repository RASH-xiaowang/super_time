/**
 * Navigation configuration for the WeChat data panel shell: group order,
 * per-item label/icon, and the closed tab union. Keeping this in its own
 * module lets the panel import the config and lets tests assert the IA
 * without rendering the full shell.
 *
 * Hidden items stay routable (deep links / cross-panel navigation) but are not
 * shown in the sidebar; the visible parent item exposes them via in-panel
 * filters (e.g. 聊天会话 → 公众号/服务号/客服).
 */
export type WechatTab = 'overview' | 'ask' | 'chats' | 'graph' | 'monitor' | 'contacts' | 'moments' | 'favorites' | 'emoticons' | 'files' | 'records' | 'ledger' | 'storage' | 'bizchats' | 'servicechats' | 'kefu' | 'annual' | 'period' | 'dailysummary' | 'hook' | 'privacy' | 'revoked' | 'backup' | 'settings' | 'oplog' | 'tasks' | 'groupinsights' | 'health' | 'momentsinsights' | 'privacytrust' | 'assetinsights' | 'officialassets' | 'mediaassets';
export interface NavItem {
    tab: WechatTab;
    label: string;
    icon: string;
    /** Routable but not rendered in the sidebar; exposed by a parent item. */
    hidden?: boolean;
}
export declare const NAV_GROUPS: ReadonlyArray<{
    label: string;
    items: ReadonlyArray<NavItem>;
}>;
export declare const TAB_LABELS: Record<WechatTab, string>;
//# sourceMappingURL=nav-config.d.ts.map
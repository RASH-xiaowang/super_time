/**
 * Module-level open state for the 私人微信 dashboard, shared by the sidebar
 * footer trigger (open/toggle) and the panel content seat (open/close). The
 * panel itself also imports {@link closeWechat} to render its own close action.
 */
export declare function subscribeOpen(listener: () => void): () => void;
export declare function getOpen(): boolean;
export declare function openWechat(): void;
export declare function closeWechat(): void;
export declare function toggleWechat(): void;
//# sourceMappingURL=wechat-state.d.ts.map
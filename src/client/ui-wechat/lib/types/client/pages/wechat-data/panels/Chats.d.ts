/** One image entry in the viewer strip. */
export interface ViewerImage {
    username: string;
    localId: number;
}
/**
 * Render the chats panel.
 * @returns the chats element tree.
 */
/** Which session view to show: all chats, official accounts, service accounts, or kefu. */
export type ChatView = 'chats' | 'bizchats' | 'servicechats' | 'kefu';
/** External navigation target: open a session and (optionally) locate a message. */
export interface ChatTarget {
    username: string;
    localId?: number;
    /** Monotonic nonce so the same session can be re-targeted. */
    nonce: number;
}
/** Enterprise-WeChat conversation detection (@openim / @weclaw / kefu). */
export declare function isEnterpriseChat(u: string): boolean;
/**
 * Render the chats panel.
 * @param props - optional view filter for subscription tabs and an external
 *   navigation target (records/privacy/ask jump into a session + message).
 * @returns the chats element tree.
 */
export declare function ChatsPanel({ initialView, initialTarget }: {
    initialView?: ChatView;
    initialTarget?: ChatTarget | null;
}): React.JSX.Element;
//# sourceMappingURL=Chats.d.ts.map
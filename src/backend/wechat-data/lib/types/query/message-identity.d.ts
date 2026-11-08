/**
 * Canonical message-table identity resolution.
 *
 * WeChat 4.x stores a talker's messages in `Msg_<md5(username)>`. A table name
 * is therefore not a username. Some conversations (notably older groups) no
 * longer exist in `SessionTable` or `contact`, but their real username is still
 * present in each message shard's `Name2Id` and in `ChatName2Id`.
 *
 * All scanners should resolve through this module instead of rebuilding the
 * reverse map from only the contact/session tables.
 */
/** Whether a value is a raw table hash or a complete `Msg_<hash>` table name. */
export declare function isMessageTableHash(value: string): boolean;
/** `username` -> `Msg_<md5(username)>` suffix. */
export declare function messageTableHash(username: string): string;
/** `username` -> complete message table name. */
export declare function messageTableName(username: string): string;
/** Cached identity maps for every message shard in the selected directories. */
export interface MessageIdentityIndex {
    /** 32-char table hash -> real WeChat username. */
    hashToUsername: ReadonlyMap<string, string>;
    /** `Msg_<hash>` -> real WeChat username. */
    tableToUsername: ReadonlyMap<string, string>;
    /** Every real username discovered from shards/contact/session/resource DBs. */
    usernames: ReadonlySet<string>;
}
/** Canonical chat identity resolved from a username or a legacy message-table reference. */
export interface ChatIdentity {
    /** Original caller input. */
    input: string;
    /** Real WeChat username, or empty when a legacy hash cannot be resolved. */
    username: string;
    /** Human-readable name that never exposes a message-table hash. */
    displayName: string;
    type: 'private' | 'group';
    /** Whether the input was a legacy 32-char hash / Msg_<hash> table name. */
    legacyHash: boolean;
    /** False only for unresolved legacy hashes and empty input. */
    resolved: boolean;
}
/** Canonical username + physical message table resolved from one caller input. */
export interface ResolvedMessageTable {
    identity: ChatIdentity;
    username: string;
    table: string;
}
/** Result of normalizing a caller-supplied chat reference at a mutation boundary. */
export interface CanonicalChatReference {
    username: string;
    displayName: string;
    type: 'private' | 'group';
    legacyHash: boolean;
    error?: string;
}
/**
 * Resolve a caller-supplied chat reference before any message-table lookup.
 *
 * This is the boundary that prevents `Msg_<md5(username)>` suffixes from
 * flowing through the app as if they were usernames. Known legacy hashes are
 * converted back to their real username; unknown hashes are explicitly marked
 * unresolved and never echoed as a display name.
 * @param decryptedDir - decrypted data root.
 * @param value - username, raw table hash, or complete Msg_<hash> table name.
 * @param dirs - message shard directories.
 * @returns canonical identity plus display metadata.
 */
export declare function resolveChatIdentity(decryptedDir: string, value: string, dirs?: ReadonlyArray<string>): ChatIdentity;
/**
 * Normalize a public mutation boundary.
 *
 * A resolved legacy hash is converted to the real username. An unknown legacy
 * hash is rejected instead of being persisted as an empty or fake chat. Normal
 * usernames (including ids not present in the metadata tables) pass through.
 * @param decryptedDir - decrypted data root.
 * @param value - username or legacy message-table hash.
 * @param label - user-facing field label used in the error.
 * @returns canonical identity or an error to return before writing.
 */
export declare function canonicalChatReference(decryptedDir: string, value: string | null | undefined, label?: string): CanonicalChatReference;
/**
 * Load the cached identity index.
 * @param decryptedDir - decrypted data root.
 * @param dirs - message shard directories (default: message + bizchat).
 * @returns hash/table/username maps invalidated by any source DB change.
 */
export declare function messageIdentityIndex(decryptedDir: string, dirs?: ReadonlyArray<string>): MessageIdentityIndex;
/** Resolve a raw 32-char table hash to its username; normal usernames pass through. */
export declare function resolveTalkerUsername(decryptedDir: string, value: string, dirs?: ReadonlyArray<string>): string;
/** Resolve a complete `Msg_<hash>` table name to its username. */
export declare function resolveMessageTableUsername(decryptedDir: string, table: string, dirs?: ReadonlyArray<string>): string;
/**
 * Resolve a chat reference and derive its physical message table in one step.
 *
 * Use this at public query boundaries instead of hashing the raw argument:
 * old navigation targets may be `Msg_<hash>` suffixes, which would otherwise
 * become `Msg_<md5(hash)>` and silently address a non-existent table.
 * @param decryptedDir - decrypted data root.
 * @param value - canonical username, raw hash, or `Msg_<hash>`.
 * @param dirs - message shard directories.
 * @returns canonical identity/table, or null when a legacy hash is unresolved.
 */
export declare function resolveMessageTable(decryptedDir: string, value: string, dirs?: ReadonlyArray<string>): ResolvedMessageTable | null;
/** Human-readable fallback that never leaks a table hash. */
export declare function fallbackChatDisplayName(username: string): string;
/**
 * Contact display name with a safe non-ID fallback.
 * @param username - canonical WeChat username.
 * @param names - contact/session display-name map.
 * @param preferred - optional metadata name used when the map has no entry.
 * @returns the mapped name, or a readable fallback that never exposes raw IDs.
 */
export declare function displayNameForUsername(username: string, names?: ReadonlyMap<string, string>, preferred?: string): string;
/** Whether a value is an internal WeChat identifier rather than a display label. */
export declare function isInternalWechatId(value: string): boolean;
/**
 * Return a user-facing name only when it is safe to show to the model/user.
 *
 * Contact maps can contain generated fallbacks such as `群聊 123`; those are
 * useful inside the app, but must not be mistaken for a real customer name in
 * an AI answer.
 */
export declare function readableIdentityLabel(value: string, raw?: string): string;
/**
 * Replace internal IDs embedded in message text with human-readable labels.
 *
 * Group message bodies and quoted XML occasionally retain `wxid_*` or
 * `...@chatroom` tokens. Resolving them at the tool boundary prevents the
 * synthesis model from copying implementation details into the final answer.
 */
export declare function replaceWechatIds(text: string, labelOf: (id: string) => string | undefined, fallbackOf: (id: string) => string): string;
/** Session titles are the best readable fallback for groups absent from contact DBs. */
export declare function sessionDisplayNames(decryptedDir: string): ReadonlyMap<string, string>;
/**
 * Merge contact, session-title and readable fallback names.
 *
 * Priority: contact remark/nick > session title > readable fallback. Passing
 * the identity index from a scanner avoids rebuilding it once per row.
 */
export declare function mergeDisplayNames(decryptedDir: string, knownUsernames?: Iterable<string>): Map<string, string>;

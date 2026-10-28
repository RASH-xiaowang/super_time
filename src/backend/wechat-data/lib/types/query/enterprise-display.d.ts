import type { ChatlogRecord, FavItemPart } from '../types.ts';
/** Contact metadata indexes used only for display-time enterprise suffixes. */
export interface EnterpriseDisplayIndex {
    byUsername: ReadonlyMap<string, string>;
    byDisplayName: ReadonlyMap<string, string>;
}
/** Build a display index without guessing when a display name is ambiguous. */
export declare function createEnterpriseDisplayIndex(contactNames: ReadonlyMap<string, string>, enterpriseNames: ReadonlyMap<string, string>): EnterpriseDisplayIndex;
/** Resolve an enterprise name only from a username, or from a unique display name. */
export declare function enterpriseNameFor(index: EnterpriseDisplayIndex, username?: string, displayName?: string): string | undefined;
/** Enrich merged chat-log senders recursively for display only. */
export declare function withChatlogEnterprise(records: readonly ChatlogRecord[], index: EnterpriseDisplayIndex): ChatlogRecord[];
/** Enrich favorite chat-log senders for display only. */
export declare function withFavoritePartEnterprise(parts: readonly FavItemPart[], index: EnterpriseDisplayIndex): FavItemPart[];

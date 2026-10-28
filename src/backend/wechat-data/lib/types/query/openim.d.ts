/**
 * Enterprise-WeChat contact metadata from `contact.db`.
 *
 * An enterprise-WeChat user is stored as `<id>@openim`. Its `extra_buffer`
 * protobuf field 2 holds an enterprise wording id, while `openim_wording`
 * maps that id to the human-readable enterprise name:
 *
 *   extra_buffer[2] = 46A0...@im.wxwork
 *   openim_wording(wording_id=46A0...@im.wxwork, wording=企业名称)
 *
 * Keep this parsing in one place so contacts, sessions, group members,
 * customer profiles, and search all resolve the same name.
 */
import type { DatabaseSync } from './db-open.ts';
/** Maps loaded from one contact.db snapshot. */
export interface OpenimDirectory {
    /** `openim_wording.wording_id` -> enterprise name. */
    wordingNames: Map<string, string>;
    /** Enterprise-WeChat username -> enterprise name. */
    enterpriseNames: Map<string, string>;
}
/** Whether a username is an enterprise-WeChat user (not a kefu/service account). */
export declare function isEnterpriseWechatUser(username: string): boolean;
/** Resolve an enterprise name from one `contact.extra_buffer` value. */
export declare function enterpriseNameFromExtra(extraBuffer: unknown, wordingNames: ReadonlyMap<string, string>): string | undefined;
/** Load `openim_wording`; a missing table is a normal legacy snapshot. */
export declare function loadOpenimWordingNames(db: DatabaseSync): Map<string, string>;
/** Load both enterprise names and their wording-id map from one connection. */
export declare function loadOpenimDirectoryFromDb(db: DatabaseSync): OpenimDirectory;
/** Load only username -> enterprise name from one connection. */
export declare function loadOpenimEnterpriseNamesFromDb(db: DatabaseSync): Map<string, string>;

import type { GroupInfoSnapshot } from '../types.ts';
/** One parsed chat_room.ext_buffer member-snapshot entry. */
export interface ChatRoomSnapshotMember {
    username: string;
    /** Protobuf field 3: membership flag (1=member; elevated values reserved). */
    roleFlag?: number;
    /** Protobuf field 4: inviter/operator username, when present. */
    inviter?: string;
}
/**
 * Parse the chat_room.ext_buffer member snapshot (protobuf).
 * Outer message = repeated field-1 MemberInfo entries; each entry has field 1
 * (member username), field 3 (role flag varint) and field 4 (inviter username);
 * trailing outer fields 3/4/5 are counters/status and are ignored.
 */
export declare function parseChatRoomExtBuffer(raw: Buffer): ChatRoomSnapshotMember[];
/**
 * Load group info for one chatroom.
 * @param decryptedDir - st_control decrypted data root.
 * @param username - chatroom username (e.g. 123456789@chatroom).
 * @param selfUsername - logged-in account wxid (instance suffix tolerated).
 * @returns snapshot with the group (null when the chatroom is unknown).
 */
export declare function queryGroupInfo(decryptedDir: string, username: string, selfUsername?: string): GroupInfoSnapshot;

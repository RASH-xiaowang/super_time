export interface RedpacketEvidence {
    /** Current account explicitly claimed the packet. */
    selfClaimed: ReadonlySet<string>;
    /** Another participant explicitly claimed a packet sent by this account. */
    otherClaimed: ReadonlySet<string>;
    /** A local system message explicitly states that a packet was returned. */
    returned: ReadonlySet<string>;
    /** A local system message explicitly states that an outgoing packet was exhausted. */
    exhausted: ReadonlySet<string>;
}
/**
 * Read explicit red-packet claim/return evidence once per message-shard
 * signature. The scan is intentionally limited to local system-message types;
 * ordinary chat text is never treated as payment proof.
 * @param decryptedDir - Decrypted WeChat data root.
 * @returns Sets of red-packet `sendid` values backed by local messages.
 */
export declare function readRedpacketEvidence(decryptedDir: string): Promise<RedpacketEvidence>;

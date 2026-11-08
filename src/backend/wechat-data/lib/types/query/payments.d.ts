export interface PaymentStatus {
    found: boolean;
    kind?: 'transfer' | 'redpacket';
    serverId?: string;
    /** transferTable */
    transfer?: {
        transferId: string;
        /** The id that actually matched (primary or secondary card). */
        matchedServerId: string;
        paySubType: number;
        receiver: string;
        payer: string;
        beginTime: number;
        lastModifiedTime: number;
        invalidTime: number;
        delayConfirm: boolean;
    };
    /** redEnvelopeTable */
    redpacket?: {
        sender: string;
        senderName?: string;
        senderEnterpriseName?: string;
        hbStatus: number;
        hbType: number;
        receiveStatus: number;
        sendId: string;
        /**
         * Claim state proved by a local system message. When absent, the UI must
         * show the raw pair `(hbStatus, receiveStatus)` instead of guessing.
         */
        claimEvidence?: 'self-claimed' | 'other-claimed' | 'returned';
    };
}
/**
 * Look up one payment record by its message server_id.
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string (may exceed 2^53).
 * @returns authoritative status (found=false when absent).
 */
export declare function queryPaymentStatus(decryptedDir: string, serverId: string): Promise<PaymentStatus>;

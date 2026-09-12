export interface PaymentStatus {
    found: boolean;
    kind?: 'transfer' | 'redpacket';
    serverId?: string;
    /** transferTable */
    transfer?: {
        transferId: string;
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
        hbStatus: number;
        hbType: number;
        receiveStatus: number;
        sendId: string;
    };
}
/**
 * Look up one payment record by its message server_id.
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string (may exceed 2^53).
 * @returns authoritative status (found=false when absent).
 */
export declare function queryPaymentStatus(decryptedDir: string, serverId: string): PaymentStatus;
//# sourceMappingURL=payments.d.ts.map
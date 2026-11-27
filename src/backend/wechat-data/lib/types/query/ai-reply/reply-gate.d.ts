export declare function replyNeedsConfirmation(group: boolean, kbEnabled: boolean): boolean;
export declare const GROUP_KB_HOLD_REASON = "\u7FA4\u804A\u56DE\u590D\u7528\u4E86\u77E5\u8BC6\u5E93\uFF0C\u4E0D\u80FD\u5728\u65E0\u4EBA\u786E\u8BA4\u65F6\u53D1\u5230\u7FA4\u91CC";
/** Recheck current conversation settings on automatic retries. Explicit single resend is separate. */
export declare function automaticReplyBlock(decryptedDir: string, sourceRef: string | undefined, chatUsername: string): {
    action: 'hold' | 'defer';
    reason: string;
} | undefined;

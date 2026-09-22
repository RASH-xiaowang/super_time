import { AutoImageKeyResult, DecryptAllResult, DecryptImagesResult, DecryptStatus, OperationCategory, OperationStatus, VerifyImageKeyResult } from '../types.ts';
export interface createKeysDecryptRemotesInputs {
    rawWechatBase: (decrypted: string) => string;
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    decryptState: DecryptStatus;
}
export declare function createKeysDecryptRemotes(rc: createKeysDecryptRemotesInputs): {
    autoGetImageKey(options: {
        accountDir?: string;
        pid?: number;
    }): Promise<AutoImageKeyResult>;
    verifyImageKey(): VerifyImageKeyResult;
    decryptAllDatabases(): Promise<DecryptAllResult>;
    decryptAllImages(options: {
        concurrency?: number;
    }): Promise<DecryptImagesResult>;
};

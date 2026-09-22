import { AutoDbKeyResult, ConfigSnapshot, DbHealthSnapshot, DbStatusSnapshot, DecryptStatus, GenerateKeysResult, KeysInfoResult, OperationCategory, OperationStatus, SimpleResult, WechatConfigFull, WechatConfigPatch } from '../types.ts';
export interface createConfigRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    decryptState: DecryptStatus;
}
/** Remote-only service exposing WeChat data queries. */
export declare function createConfigRemotes(rc: createConfigRemotesInputs): {
    getWechatConfig(): ConfigSnapshot;
    getWechatConfigFull(): WechatConfigFull;
    saveWechatConfig(options: {
        patch: WechatConfigPatch;
    }): SimpleResult;
    openConfig(signal: AbortSignal): Promise<{
        ok: boolean;
        path: string;
    }>;
    getWechatKeysInfo(): KeysInfoResult;
    generateKeysFile(options: {
        dbDir: string;
        keysFile: string;
        encKeyHex: string;
        keyFormat?: string;
    }): GenerateKeysResult;
    autoGetDbKey(options: {
        dbPath?: string;
        wechatInstallDir?: string;
    }): Promise<AutoDbKeyResult>;
    getDecryptStatus(): DecryptStatus;
    getDbStatus(): DbStatusSnapshot;
    getDbHealth(): DbHealthSnapshot;
};

import { AutoDbKeyResult, ConfigSnapshot, DbHealthSnapshot, DbIntegrityResult, DbStatusSnapshot, DecryptStatus, GenerateKeysResult, KeysInfoResult, OperationCategory, OperationStatus, SimpleResult, WechatConfigFull, WechatConfigPatch } from '../types.ts';
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
    openConfig(signal?: AbortSignal): Promise<{
        ok: boolean;
        path: string;
        error?: string;
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
    /**
     * 逐库完整性体检（`PRAGMA integrity_check`）—— **按需显式动作**，与
     * `getDbHealth` 的大小统计分开：后者被「原图链路自检」等面板启动时顺带读取，
     * 挂上全库扫描会让每次挂载多几秒阻塞。
     *
     * 「库文件已损坏」那条处方（wechat-host.js）指的就是这个结果：修不修、
     * 修哪些，看这里的 `corrupted`。
     * @returns DbIntegrityResult：checked/corrupted（可重解密修复）/ unreadable（占用等）。
     */
    checkDbIntegrity(): Promise<DbIntegrityResult>;
    getDbHealth(): DbHealthSnapshot;
};

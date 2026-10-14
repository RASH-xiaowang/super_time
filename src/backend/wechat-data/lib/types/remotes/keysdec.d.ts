import { AutoImageKeyResult, DecryptAllResult, DecryptImagesResult, DecryptStatus, DbRepairResult, ImageUpgradeResult, OperationCategory, OperationStatus, VerifyImageKeyResult } from '../types.ts';
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
    verifyImageKey(): Promise<VerifyImageKeyResult>;
    decryptAllDatabases(): Promise<DecryptAllResult>;
    /**
     * 修复损坏的库（W3-11.7）：体检 → 只重解密损坏的那几个 → 复检。
     *
     * 与 `decryptAllDatabases` 的关系：那条是「立即解密」—— **全库**重解（22 个库一律
     * 重来，分钟级）；本方法是「坏了哪个修哪个」。它存在的理由就是 wechat-host.js
     * 那条处方（「必要时对该库重新解密」）此前没有对应动作：用户即使知道坏的是哪个，
     * 也只能整库重解或者干等。实现见 `query/db-repair.ts`。
     *
     * 共用同一条忙闲闸门（`decryptState.active`）：两类动作都动同一批文件，
     * 同时跑只会互相替换快照。进度走 `op = 'databases'`（它确实是数据库解密，
     * 实时同步与全量解密共用这一个状态枚举，不为它单开一档）。
     * @returns DbRepairResult：found/repaired/stillCorrupted + 修不了的与原因。
     */
    repairCorruptDbs(): Promise<DbRepairResult>;
    decryptAllImages(options: {
        concurrency?: number;
    }): Promise<DecryptImagesResult>;
    /**
     * 升级老缓存：把 `<decoded>/<md5>.<ext>` 里由低档 `.dat`（聊天版 / 缩略图）解出来的图，
     * 用本机现存最好的一档（`_h` 原图，含 wxgf 转码）重解一遍。
     *
     * 为什么不能自动做：判「本机有没有更好的一份」要扫 `msg/attach`，那是每张图一次目录遍历
     * （`decodeImageDataUrl` 只在缓存**未命中**时才付这个代价），而读图是虚拟列表里一屏几十张的
     * 高频路径。做成显式动作后，这一次性的成本换的是**之后所有渲染**都命中升级后的缓存。
     *
     * 与 `decryptAllImages` 共用同一条忙闲闸门（`decryptState.active`）：两者都是
     * 「读 attach、写 decoded 缓存」，同时跑只会互相踩槽位。
     * @returns ImageUpgradeResult：检查/已升级/无需升级/无源/失败 计数 + 明细。
     */
    upgradeDecodedImages(): Promise<ImageUpgradeResult>;
};

import type { VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from '../types.ts';
/** 语音/视频入口只需要数据根与原目录解析。 */
export interface VoiceVideoRemoteCtx {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    rawWechatBase: (decrypted: string) => string;
}
/**
 * 构造语音/视频 Remote。
 * @param rc - 运行上下文（`dirs()` / `rawWechatBase()`）。
 * @returns 三个方法与拆分前完全一致。
 */
export declare function createVoiceVideoRemotes(rc: VoiceVideoRemoteCtx): {
    getVoiceInfo: (options: {
        username: string;
        localId: number;
    }) => VoiceInfoResult;
    getVoiceDataUrl: (options: {
        username?: string;
        localId?: number;
        svrId?: string;
    }) => Promise<VoiceDataUrlResult>;
    getVideoInfo: (options: {
        username: string;
        localId: number;
    }) => VideoInfoResult;
};

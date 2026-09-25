import type { LayaAnalysisView, LayaDownloadOutcome, LayaDownloadProgress, LayaStatus } from '../types-laya.ts';
import type { OperationCategory, OperationStatus } from '../types.ts';
/** 测试注入点：替换下载进度槽（生产路径不调用）。 */
export declare function __setLayaDownloadForTest(v: LayaDownloadProgress | null): void;
export interface createLayaRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    selfUsername: () => string;
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
}
export declare function createLayaRemotes(rc: createLayaRemotesInputs): {
    /**
     * 分析一个会话：取上下文 → 本地推理 → 返回逐命题的判断。
     *
     * 纯本地、不出网（走的是 onnxruntime，不经过 `privacyGate` 的出网闸门）。
     */
    analyzeMessages(options: {
        talker?: string;
        contextLimit?: number;
    }): Promise<LayaAnalysisView>;
    /** 模型与运行时状态（前端轮询）。 */
    getLayaStatus(): LayaStatus;
    /**
     * 下载模型（幂等；已有任务时拒绝并发，与 whisper 同款）。
     *
     * 下载源由宿主方托管（`DSH_WECHAT_LAYA_MIRROR` / `DSH_WECHAT_LAYA_REPO` 可覆盖）。
     */
    downloadLayaModel(): Promise<LayaDownloadOutcome>;
    /** 接管一份用户已下好的模型目录（避免重复下载 1.26 GB）。 */
    adoptLayaModel(options: {
        sourceDir: string;
    }): LayaStatus;
    /** 卸载模型，释放约 1.2 GB 常驻内存（下次分析会自动重新加载）。 */
    unloadLaya(): {
        ok: boolean;
    };
    /** 期望的模型目录（UI 提示用户「把文件放这里」用）。 */
    getLayaModelDir(): string;
    /** 期望的 tokenizer 目录（排查用）。 */
    getLayaTokenizerDir(): string;
};

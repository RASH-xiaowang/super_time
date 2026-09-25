/**
 * laya 本地决策分析（分析会话消息、模型状态/下载/接管/卸载） 的 @Remote 处理器。
 *
 * 机制照 `remotes/voicellm.ts`：类里保留 @Remote 装饰器与签名（协议层按名字枚举），
 * 方法体一行转发；处理器体在这里，依赖由 `rc` 显式给出。
 *
 * **下载进度为什么不挂在 gateway 字段上**：与 whisper 不同，laya 的进度用不着跨方法共享
 * 生命周期（`getLayaStatus` 与 `downloadLayaModel` 都在本模块里），所以放在模块级。
 * 代价是多实例场景会共享——测试需要隔离时用 `__setLayaDownloadForTest()` 注入。
 */
import { type LayaVisibleAnalysisResult } from '../laya/analysis.ts';
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
    /**
     * 逐条分析一批消息（消息流**可见窗口**驱动）：每条 → 取该消息及之前的上下文 →
     * （语音先转写成文本）→ 本地推理。
     *
     * 结果落 `<数据根>/laya_analysis.db` 缓存，同一条消息（同一模型）只算一次；
     * 语音转写优先命中 whisper 自己的磁盘缓存，只有没转写过的才真调引擎。
     */
    analyzeVisibleMessages(options: {
        talker?: string;
        targets?: Array<{
            localId: number;
            sortSeq: number;
        }>;
    }): Promise<LayaVisibleAnalysisResult>;
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

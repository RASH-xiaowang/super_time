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
    /** W3-11.5：进度事件的出口（ Cordis Context 的 emit）。 */
    ctx: () => {
        emit: (name: string, ...args: unknown[]) => void;
    };
    /**
     * W3-11.5：逐条分析的取消槽（由 gateway 的 `_layaJobs` 提供）。
     *
     * 槽位为什么归 gateway：与问答取消（`remotes/ask-cancel.ts`）同一条纪律 ——
     * 「谁持有取消令牌」不允许出现第二个出处。本模块只消费。
     */
    layaSignal: (jobId?: string) => {
        signal: AbortSignal;
        done: () => void;
    } | undefined;
    cancelLayaJob: (jobId?: string) => boolean;
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
        /** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
        talker?: string;
        targets?: Array<{
            localId: number;
            sortSeq: number;
        }>;
        /** 本批的进度标识（W3-11.5）：带上它才会推送 laya-analysis/progress 事件。 */
        jobId?: string;
    }): Promise<LayaVisibleAnalysisResult>;
    /**
     * 停止一批正在跑的逐条分析（W3-11.5）。
     *
     * 找不到在跑的那批时返回 `{ok:false, message}` 而不是静默 true ——
     * 用户点「停止分析」后必须知道停没停上；停不上的常见原因是那一批已经算完了（点晚了）。
     */
    cancelAnalysis(options: {
        jobId?: string;
    }): {
        ok: boolean;
        message?: string;
    };
    /** 模型与运行时状态（前端轮询）。 */
    getLayaStatus(): LayaStatus;
    /**
     * 下载模型（幂等；已有任务时拒绝并发，与 whisper 同款）。
     *
     * 下载源由宿主方托管（`DSH_WECHAT_LAYA_MIRROR` / `DSH_WECHAT_LAYA_REPO` 可覆盖）。
     */
    downloadLayaModel(options?: {
        jobId?: string;
    }): Promise<LayaDownloadOutcome>;
    /**
     * W2-11.5：取消正在进行的模型下载。
     *
     * 与 `cancelAnalysis` 共用同一个槽（`cancelLayaJob`）—— 「谁持有取消令牌」不允许
     * 出现第二个出处。**不删 `.part`**：下次点击从断点续接。
     * @param options - jobId。
     * @returns 是否真的取消到一个在飞的任务。
     */
    cancelLayaDownload(options: {
        jobId?: string;
    }): {
        ok: boolean;
        message?: string;
    };
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

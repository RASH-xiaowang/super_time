/**
 * laya 模型的**落点解析与分发**（纯文件层，不碰推理）。
 *
 * 与 whisper 的分工完全对应（`query/whisper.ts` 是这里的模板）：
 *   · 目录约定：`<数据根>/laya`（whisper 是 `<数据根>/whisper`）
 *   · 下载：**复用 whisper 的流式下载器**（`streamUrlToFile`：Range 续传 + `.part` 原子发布 +
 *     完成后长度校验），不重造一套
 *   · 进度：调方把进度写进 gateway 单例字段，前端 500ms 轮询（与 whisper 同款）
 *
 * **为什么是「两个文件」**：ONNX 计算图只是一半，另一半是 tokenizer——模型按 token 序列工作，
 * 没有 tokenizer 就无法把中文变成输入。两者都**不进安装包**（合计约 1.26 GB），
 * 由用户手动放置或首启下载；下载源用 `DSH_WECHAT_LAYA_MIRROR` / `DSH_WECHAT_LAYA_REPO` 覆盖。
 */
import { fmtBytes } from '../format.ts';
/** 显式指定模型目录（优先级最高；开发机/测试用）。指向含 `laya-decision.onnx` 的目录。 */
export declare const LAYA_DIR_ENV = "DSH_WECHAT_LAYA_DIR";
/** 下载镜像基址（与 whisper 的 `DSH_WECHAT_WHISPER_MIRROR` 同款）。 */
export declare const LAYA_MIRROR_ENV = "DSH_WECHAT_LAYA_MIRROR";
/** 下载仓库路径（`<base>/<repo>/resolve/main/<file>`）。 */
export declare const LAYA_REPO_ENV = "DSH_WECHAT_LAYA_REPO";
/** 默认下载仓库路径（宿主方把 `tools/laya/export-onnx.py` 的产物与 tokenizer 传到此处）。 */
export declare const LAYA_DEFAULT_REPO = "super-time/super-time-models";
/**
 * 推理必需的文件清单。`minBytes` 是**下界**而不是精确大小：同一模型可以有
 * fp32 / fp16 / int8 多种量化产物，卡死精确字节会让量化版全被判为「未安装」；
 * 这里只挡住「截断的半成品」（本机 fp32 产物实测 1228.6 MB）。
 */
export declare const LAYA_ASSETS: ReadonlyArray<{
    file: string;
    rel: string;
    minBytes: number;
    label: string;
}>;
/** 主模型文件（状态展示用）。 */
export declare const LAYA_MODEL_FILE = "laya-decision.onnx";
export interface LayaModelStatus {
    installed: boolean;
    /** 模型目录（未安装时也给出「期望路径」，便于 UI 告诉用户放哪）。 */
    dir: string;
    /** 模型文件路径。 */
    path: string;
    bytes: number;
    source: 'configured' | 'env' | 'data-dir';
    /** 缺失/不完整的逐项说明（已安装时为空数组）。 */
    missing: string[];
}
/** `<数据根>/laya`。数据根取 `decryptedDir` 的父目录（与 whisper 的取法一致）。 */
export declare function layaModelsDir(decryptedDir?: string): string;
/** 解析模型目录，不读盘。 */
export declare function resolveLayaModelsDir(configured?: string, decryptedDir?: string): {
    dir: string;
    source: LayaModelStatus['source'];
};
/** 模型是否可用（三个必需文件都在且过下界）。 */
export declare function layaModelStatus(configured?: string, decryptedDir?: string): LayaModelStatus;
/** tokenizer 目录（`@huggingface/transformers` 从这里加载）。 */
export declare function layaTokenizerDir(dir: string): string;
/**
 * 人类可读体积（P3-2：口径统一到 `src/format.ts`）。
 *
 * 旧实现 KB 取 0 位小数、其余取 1/2 位 —— 与界面其它各处不一样，
 * 同一个文件在「设置 → 模型」里是 `1428.6 KB`、在知识库里是 `1.4 MB`。
 */
export declare const formatBytes: typeof fmtBytes;
/** 下载源基址候选（env 钉的 → 国内镜像 → 官方；与 whisper 的轮换顺序一致）。 */
export declare function layaDownloadBases(): string[];
/** 下载仓库路径。 */
export declare function layaDownloadRepo(): string;
export interface LayaDownloadResult {
    ok: boolean;
    /** 已完成的文件（相对路径）。 */
    files?: string[];
    bytes?: number;
    error?: string;
}
/**
 * 下载缺失的文件到 `dir`（幂等：已存在且大小过下界的文件直接跳过）。
 * 任一文件失败即中止并返回错误；已下好的部分**保留**，重试时天然续传。
 */
export declare function layaDownloadModel(dir: string, onProgress: (received: number, total: number, file: string) => void): Promise<LayaDownloadResult>;
/**
 * 把「用户自己下好的模型目录」接管进数据目录（避免重复下 1.26 GB）。
 * 同盘用 rename（瞬时），跨盘退化为拷贝。
 */
export declare function layaAdoptModelDir(sourceDir: string, decryptedDir?: string): LayaModelStatus;

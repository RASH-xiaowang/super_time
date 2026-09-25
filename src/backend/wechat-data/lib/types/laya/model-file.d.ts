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
/** 人类可读体积。 */
export declare function formatBytes(n: number): string;
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
